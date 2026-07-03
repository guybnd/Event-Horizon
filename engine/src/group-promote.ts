import fs from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import { getGroupStoreDir, type GroupContext } from './group.js';
import { syncGroup, type GitRunner, type GroupSyncResult } from './group-sync.js';
import { submitGroupEdit } from './group-edit.js';
// FLUX-1000 (epic FLUX-996): defaultGitRunner used to be a bare execFileAsync (via dynamic
// import) — no timeout, no non-interactive env — so the doc-promotion cascade (git rm/commit on
// main + the fan-out it triggers via syncGroup) could hang POST /api/group/promote-docs/apply
// forever. Route through the S1 runner.
import { runGit } from './git-exec.js';

/**
 * Promote existing `.docs/` into the group store (FLUX-404).
 *
 * A repo's cross-project docs live in `.docs/` on the repo's main branch, but the
 * shared knowledge base lives on the `flux-group-docs` orphan branch under
 * `.flux-group/`. This module bridges the two with **move semantics** (mirroring
 * the ticket-migration precedent in `storage-sync.ts`): a promoted doc is written
 * into the canonical store and **removed from main**, becoming single-source-of-
 * truth in the group. A moved doc is therefore no longer visible via plain
 * GitHub/IDE browsing of main — only through EH group mode / fan-out.
 *
 * Selection is **per-file opt-in**: `.docs/` holds both repo-local docs (stay put)
 * and cross-project docs (promote), so nothing is moved in bulk.
 *
 * Promotion runs from either side of the group:
 * - **Parent** (`applyDocsPromotion`): writes its own `.docs/` straight into the
 *   canonical store worktree, `git rm`s from its main, then `syncGroup` fans out.
 * - **Member** (`applyMemberDocsPromotion`): reads its own `.docs/`, pushes the
 *   content into the store **through the parent** (`submitGroupEdit`, the same
 *   push-through-parent path member doc edits use), then `git rm`s from the
 *   member's own main. The doc returns to the member as a read-only group doc.
 */

const DOCS_DIRNAME = '.docs';

/** A `.docs/` file that can be promoted, with a proposed target in the store. */
export interface PromotionCandidate {
  /** Repo-relative source path, e.g. `.docs/architecture/payments.md`. */
  source: string;
  /** Proposed store-relative target, e.g. `features/payments.md`. Retargetable. */
  target: string;
}

export interface DocsPromotionPlan {
  parentRoot: string;
  /** Every promotable `.docs/` file with its default target. Empty when no `.docs/`. */
  candidates: PromotionCandidate[];
}

/** A user-confirmed promotion: a source under `.docs/` and its chosen store target. */
export interface PromotionSelection {
  source: string;
  target: string;
}

export interface PromotionOutcome {
  source: string;
  target: string;
  ok: boolean;
  error?: string;
}

export interface DocsPromotionResult {
  /** Store-relative targets that were written + removed from main. */
  promoted: string[];
  /** Per-file failures (path rejected, missing source, git rm failed). */
  failed: PromotionOutcome[];
  /** The fan-out result from the re-sync triggered by this promotion. */
  sync: GroupSyncResult;
}

/** Reject absolute paths, `..` traversal, and writes into the worktree's `.git`. */
function resolveSafe(rootDir: string, rel: string, label: string): string {
  if (typeof rel !== 'string' || rel.trim().length === 0) {
    throw new Error(`${label} path must be a non-empty string`);
  }
  if (path.isAbsolute(rel)) {
    throw new Error(`${label} path must be relative: ${rel}`);
  }
  const root = path.resolve(rootDir);
  const resolved = path.resolve(root, rel);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new Error(`${label} path escapes ${label === 'target' ? 'the group store' : 'the .docs directory'}: ${rel}`);
  }
  if (path.relative(root, resolved).split(path.sep)[0] === '.git') {
    throw new Error(`${label} path may not touch the git dir: ${rel}`);
  }
  return resolved;
}

/** Recursively list every file under `dir`, returned as paths relative to `dir`. */
async function walkFiles(dir: string, prefix = ''): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  const out: string[] = [];
  for (const entry of entries) {
    if (entry.name === '.git') continue;
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      out.push(...(await walkFiles(path.join(dir, entry.name), rel)));
    } else if (entry.isFile()) {
      out.push(rel);
    }
  }
  return out;
}

/**
 * Map a `.docs/`-relative path onto the curated store shape. The store is
 * organized as `features/`, `contracts/`, `topology.md`, `index.md`; promoted
 * docs default into `features/<basename>` and the user can retarget in the UI.
 */
function defaultTarget(relFromDocs: string): string {
  return `features/${path.basename(relFromDocs)}`;
}

/**
 * Plan a promotion: walk `.docs/` and propose a store target for each file.
 * Zero git mutation — pure discovery, safe to call for a preview.
 */
export async function planDocsPromotion(parentRoot: string): Promise<DocsPromotionPlan> {
  const docsDir = path.join(parentRoot, DOCS_DIRNAME);
  if (!existsSync(docsDir)) {
    return { parentRoot, candidates: [] };
  }
  const files = await walkFiles(docsDir);
  files.sort();
  const candidates: PromotionCandidate[] = files.map((rel) => ({
    source: `${DOCS_DIRNAME}/${rel}`,
    target: defaultTarget(rel),
  }));
  return { parentRoot, candidates };
}

interface CollectedPromotion {
  source: string;
  target: string;
  content: string;
}

/**
 * Validate every selection and read its content — pure filesystem work, no git,
 * so it's unit-testable on its own. Validates all paths up front so a single bad
 * selection aborts the batch before anything is written or removed.
 *
 * `sourceRoot` is the repo whose `.docs/` holds the sources (the parent for a
 * parent-origin promotion, the member for a member-origin one). `storeDir`
 * defaults to that repo's store, but a member passes the **parent's** store so
 * targets validate against the real canonical layout.
 */
export async function collectPromotions(
  sourceRoot: string,
  selections: PromotionSelection[],
  storeDir: string = getGroupStoreDir(sourceRoot),
): Promise<CollectedPromotion[]> {
  if (!Array.isArray(selections) || selections.length === 0) {
    throw new Error('at least one selection is required');
  }
  const docsDir = path.join(sourceRoot, DOCS_DIRNAME);

  // Validate every path first (source under .docs/, target under the store).
  const targets = selections.map((sel) => {
    // A source must be a `.docs/`-relative path; strip the leading `.docs/`.
    const rel = sel.source.replace(/\\/g, '/');
    const withinDocs = rel.startsWith(`${DOCS_DIRNAME}/`) ? rel.slice(DOCS_DIRNAME.length + 1) : rel;
    const sourceAbs = resolveSafe(docsDir, withinDocs, 'source');
    const targetAbs = resolveSafe(storeDir, sel.target.replace(/\\/g, '/'), 'target');
    return { sel, sourceAbs, targetAbs };
  });

  const collected: CollectedPromotion[] = [];
  for (const { sel, sourceAbs, targetAbs } of targets) {
    if (!existsSync(sourceAbs)) {
      throw new Error(`source does not exist: ${sel.source}`);
    }
    const content = await fs.readFile(sourceAbs, 'utf8');
    collected.push({
      source: `${DOCS_DIRNAME}/${path.relative(docsDir, sourceAbs).split(path.sep).join('/')}`,
      target: path.relative(storeDir, targetAbs).split(path.sep).join('/'),
      content,
    });
  }
  return collected;
}

const defaultGitRunner: GitRunner = (cwd, args) => runGit(args, { cwd });

/**
 * Remove a promoted source from its repo's working tree. `git rm` stages the
 * deletion; an untracked file (no pathspec match) is removed from disk directly
 * so an as-yet-uncommitted doc still moves.
 */
async function removeSourceFromMain(runner: GitRunner, repoRoot: string, sourceRel: string): Promise<void> {
  const sourceAbs = path.join(repoRoot, sourceRel);
  await runner(repoRoot, ['rm', '--quiet', '--', sourceRel]).catch(async (err: any) => {
    if (/did not match any files|pathspec/i.test(String(err?.message ?? err))) {
      await fs.rm(sourceAbs, { force: true });
      return;
    }
    throw err;
  });
}

/** Commit staged `.docs/` removals on a repo's main (best-effort, idempotent). */
async function commitDocsRemovals(runner: GitRunner, repoRoot: string, count: number): Promise<void> {
  if (count <= 0) return;
  const { stdout } = await runner(repoRoot, ['status', '--porcelain']).catch(() => ({ stdout: '' }));
  if (!stdout.trim()) return;
  await runner(repoRoot, ['add', '-A', '--', DOCS_DIRNAME]).catch(() => undefined);
  await runner(repoRoot, ['commit', '-m', `docs: promote ${count} doc(s) into group store`]).catch(() => undefined);
}

/**
 * Promote selected `.docs/` files into the canonical store with move semantics:
 * write each into the `.flux-group` worktree, `git rm` it from main, commit the
 * removals on main, then `syncGroup` to commit the store additions on
 * `flux-group-docs` and fan out. Per-file isolation — one file's git failure is
 * recorded and never aborts the rest (paths are pre-validated by collect).
 */
export async function applyDocsPromotion(
  group: GroupContext,
  selections: PromotionSelection[],
  opts: { gitRunner?: GitRunner; allowLocalRemotes?: boolean } = {},
): Promise<DocsPromotionResult> {
  const runner = opts.gitRunner ?? defaultGitRunner;
  const parentRoot = group.parentRoot;
  const storeDir = getGroupStoreDir(parentRoot);

  const collected = await collectPromotions(parentRoot, selections);

  const promoted: string[] = [];
  const failed: PromotionOutcome[] = [];

  for (const item of collected) {
    try {
      // 1. Write into the canonical store worktree.
      const targetAbs = path.join(storeDir, item.target);
      await fs.mkdir(path.dirname(targetAbs), { recursive: true });
      await fs.writeFile(targetAbs, item.content, 'utf8');

      // 2. Remove from main (git rm stages the deletion; the commit follows).
      const sourceRel = item.source.split('/').join(path.sep);
      await removeSourceFromMain(runner, parentRoot, sourceRel);

      promoted.push(item.target);
    } catch (err: any) {
      failed.push({ source: item.source, target: item.target, ok: false, error: String(err?.message ?? err) });
    }
  }

  // 3. Commit the removals on main (best-effort — nothing to commit is fine).
  await commitDocsRemovals(runner, parentRoot, promoted.length);

  // 4. Commit the store additions on flux-group-docs and fan out to members.
  const sync = await syncGroup(group, {
    gitRunner: opts.gitRunner,
    allowLocalRemotes: opts.allowLocalRemotes,
    message: `group: promote docs (${promoted.join(', ') || 'none'})`,
  });

  return { promoted, failed, sync };
}

/**
 * Member-origin promotion (push-through-parent). Reads the **member's** own
 * `.docs/`, writes the content into the canonical store **through the parent**
 * (`submitGroupEdit` — the same serialized intake member doc edits use, which
 * commits on `flux-group-docs` and fans out), then `git rm`s each source from
 * the member's own main. After fan-out the doc returns to the member as a
 * read-only group doc, completing the move.
 *
 * Targets are validated against the parent's real store layout; sources are read
 * from `memberRoot/.docs/`. Unlike the parent path the store write is a single
 * atomic `submitGroupEdit` batch — if any target path is invalid nothing is
 * written — after which the local `git rm`s are per-file isolated.
 */
export async function applyMemberDocsPromotion(
  memberRoot: string,
  parentGroup: GroupContext,
  selections: PromotionSelection[],
  opts: { gitRunner?: GitRunner; allowLocalRemotes?: boolean } = {},
): Promise<DocsPromotionResult> {
  const runner = opts.gitRunner ?? defaultGitRunner;
  const parentStoreDir = getGroupStoreDir(parentGroup.parentRoot);

  // Read + validate the member's sources against the parent's store layout.
  const collected = await collectPromotions(memberRoot, selections, parentStoreDir);

  // 1. Write every source into the canonical store through the parent (commits
  //    on flux-group-docs + fans out). Atomic: a bad path aborts before writes.
  const edit = await submitGroupEdit(
    parentGroup,
    collected.map((item) => ({ path: item.target, content: item.content })),
    {
      gitRunner: opts.gitRunner,
      allowLocalRemotes: opts.allowLocalRemotes,
      message: `group: promote member docs (${collected.map((c) => c.target).join(', ')})`,
    },
  );

  // 2. Remove each promoted source from the member's own main (per-file isolated).
  const promoted: string[] = [];
  const failed: PromotionOutcome[] = [];
  for (const item of collected) {
    try {
      await removeSourceFromMain(runner, memberRoot, item.source.split('/').join(path.sep));
      promoted.push(item.target);
    } catch (err: any) {
      failed.push({ source: item.source, target: item.target, ok: false, error: String(err?.message ?? err) });
    }
  }

  // 3. Commit the removals on the member's main (best-effort).
  await commitDocsRemovals(runner, memberRoot, promoted.length);

  return { promoted, failed, sync: edit.sync };
}
