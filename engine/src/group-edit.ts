import fs from 'fs/promises';
import path from 'path';
import { getGroupStoreDir, type GroupContext } from './group.js';
import { syncGroup, type GitRunner, type GroupSyncResult } from './group-sync.js';

/**
 * Push-through-parent edits (FLUX-397).
 *
 * Implements the parent-side intake of the spec's "Edit round-trip": a sub-repo
 * dev's doc change arrives here as a set of file edits (never a push), the parent
 * applies it into the canonical `.flux-group/` worktree, commits on
 * `flux-group-docs`, and re-fans-out (FLUX-396). Because no member ever advanced
 * the branch, every fan-out push stays fast-forward.
 *
 * Submissions are **serialized** (the parent is the sole writer), so concurrent
 * edits apply in order without interleaving on the shared worktree.
 *
 * Member-side fast-forward of the local mirror (step 4 of the round-trip) depends
 * on member-side worktree attach, deferred as decision C2 — see the spec.
 */

export interface GroupEditFile {
  /** Path relative to the `.flux-group/` store root. */
  path: string;
  /** New file content (create/update). Ignored when `delete` is true. */
  content?: string;
  /** Delete the file instead of writing it. */
  delete?: boolean;
}

export interface GroupEditResult {
  /** Store-relative paths that were written or deleted. */
  applied: string[];
  /** The fan-out result from the re-sync triggered by this edit. */
  sync: GroupSyncResult;
}

/** Reject absolute paths, `..` traversal, and writes into the worktree's `.git`. */
function resolveSafe(storeDir: string, rel: string): string {
  if (typeof rel !== 'string' || rel.trim().length === 0) {
    throw new Error('edit path must be a non-empty string');
  }
  if (path.isAbsolute(rel)) {
    throw new Error(`edit path must be relative: ${rel}`);
  }
  const root = path.resolve(storeDir);
  const resolved = path.resolve(root, rel);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new Error(`edit path escapes the group store: ${rel}`);
  }
  const fromRoot = path.relative(root, resolved);
  if (fromRoot.split(path.sep)[0] === '.git') {
    throw new Error(`edit path may not touch the worktree git dir: ${rel}`);
  }
  return resolved;
}

// In-process serialization: the parent is the only writer, so a single promise
// chain guarantees submissions apply (and re-fan-out) one at a time.
let editChain: Promise<unknown> = Promise.resolve();

function serialize<T>(fn: () => Promise<T>): Promise<T> {
  const run = editChain.then(fn, fn);
  editChain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/**
 * Apply edits into the canonical store and return the store-relative paths
 * written/deleted. Pure filesystem work — no git — so it's unit-testable on its
 * own. Validates every path up front so a bad edit aborts before any write.
 */
export async function applyEditsToStore(storeDir: string, edits: GroupEditFile[]): Promise<string[]> {
  if (!Array.isArray(edits) || edits.length === 0) {
    throw new Error('at least one edit is required');
  }
  // Validate every path first so a single bad edit aborts before any write.
  const targets = edits.map((e) => ({ edit: e, abs: resolveSafe(storeDir, e.path) }));

  const applied: string[] = [];
  for (const { edit, abs } of targets) {
    if (edit.delete) {
      await fs.rm(abs, { force: true });
    } else {
      if (typeof edit.content !== 'string') {
        throw new Error(`edit for ${edit.path} needs string content`);
      }
      await fs.mkdir(path.dirname(abs), { recursive: true });
      await fs.writeFile(abs, edit.content, 'utf8');
    }
    applied.push(path.relative(storeDir, abs).split(path.sep).join('/'));
  }
  return applied;
}

/**
 * Apply a sub-repo doc edit into the canonical store, commit, and re-fan-out.
 * Serialized so concurrent submissions never interleave on the worktree.
 */
export function submitGroupEdit(
  group: GroupContext,
  edits: GroupEditFile[],
  opts: { gitRunner?: GitRunner | undefined; allowLocalRemotes?: boolean | undefined; message?: string | undefined } = {},
): Promise<GroupEditResult> {
  return serialize(async () => {
    const storeDir = getGroupStoreDir(group.parentRoot);
    const applied = await applyEditsToStore(storeDir, edits);

    const sync = await syncGroup(group, {
      gitRunner: opts.gitRunner,
      allowLocalRemotes: opts.allowLocalRemotes,
      message: opts.message ?? `group: sub-repo edit (${applied.join(', ')})`,
    });

    return { applied, sync };
  });
}

