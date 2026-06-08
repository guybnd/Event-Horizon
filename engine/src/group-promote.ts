import fs from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import { getGroupStoreDir, type GroupContext } from './group.js';
import { syncGroup, type GitRunner, type GroupSyncResult } from './group-sync.js';

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
 * and cross-project docs (promote), so nothing is moved in bulk. Promotion is
 * **parent-only** — only the parent owns the canonical store; the route enforces
 * this by resolving `getGroupContext()` (unset on a member workspace).
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
 */
export async function collectPromotions(
  parentRoot: string,
  selections: PromotionSelection[],
): Promise<CollectedPromotion[]> {
  if (!Array.isArray(selections) || selections.length === 0) {
    throw new Error('at least one selection is required');
  }
  const docsDir = path.join(parentRoot, DOCS_DIRNAME);
  const storeDir = getGroupStoreDir(parentRoot);

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

const defaultGitRunner: GitRunner = async (cwd, args) => {
  const { execFile } = await import('child_process');
  const { promisify } = await import('util');
  return promisify(execFile)('git', args, { cwd, windowsHide: true });
};

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
      const sourceAbs = path.join(parentRoot, sourceRel);
      await runner(parentRoot, ['rm', '--quiet', '--', sourceRel]).catch(async (err: any) => {
        // Untracked file: git rm won't match it, so remove it from disk directly.
        if (/did not match any files|pathspec/i.test(String(err?.message ?? err))) {
          await fs.rm(sourceAbs, { force: true });
          return;
        }
        throw err;
      });

      promoted.push(item.target);
    } catch (err: any) {
      failed.push({ source: item.source, target: item.target, ok: false, error: String(err?.message ?? err) });
    }
  }

  // 3. Commit the removals on main (best-effort — nothing to commit is fine).
  if (promoted.length > 0) {
    const { stdout } = await runner(parentRoot, ['status', '--porcelain']).catch(() => ({ stdout: '' }));
    if (stdout.trim()) {
      await runner(parentRoot, ['add', '-A', '--', DOCS_DIRNAME]).catch(() => undefined);
      await runner(parentRoot, ['commit', '-m', `docs: promote ${promoted.length} doc(s) into group store`]).catch(() => undefined);
    }
  }

  // 4. Commit the store additions on flux-group-docs and fan out to members.
  const sync = await syncGroup(group, {
    gitRunner: opts.gitRunner,
    allowLocalRemotes: opts.allowLocalRemotes,
    message: `group: promote docs (${promoted.join(', ') || 'none'})`,
  });

  return { promoted, failed, sync };
}
