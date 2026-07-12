// Working-tree discard (FLUX-1333): restore selected files to their checkout's HEAD state — the
// engine side of the portal's per-file "Discard change" control (chat diff panel, Changes window,
// uncommitted stoplight). UNCOMMITTED changes only: a committed-only file yields a per-file error,
// never any history rewrite. This module MUTATES the working tree, so unlike diff-aggregator's
// bare runner it deliberately goes through the hardened `runGit` wrapper (timeout, non-interactive
// env, process-tree kill).
import fs from 'node:fs/promises';
import path from 'node:path';
import { runGit } from './git-exec.js';
import { parseStatusPorcelain, type PorcelainEntry } from './diff-aggregator.js';

export interface DiscardFileResult {
  file: string;
  ok: boolean;
  error?: string;
}

function errText(err: unknown, fallback: string): string {
  const e = err as Error & { stderr?: string };
  return (e?.stderr || e?.message || fallback).toString().trim();
}

/**
 * Discard the uncommitted changes to `files` (repo-relative) in the checkout at `root`,
 * independently per file — one failure never aborts the rest. Per-state semantics, derived from
 * `git status --porcelain -uall` at call time (never from what a diff surface displayed earlier):
 *  - untracked (`??`)      → delete from disk
 *  - staged add (`A_`)     → unstage, then delete from disk
 *  - staged rename (`R_`)  → atomic both sides: restore the old path from HEAD, drop + delete the new path
 *  - staged copy (`C_`)    → drop + delete the new path (the copy source keeps its own entry, if it changed)
 *  - other tracked change  → restore index + worktree from HEAD (clears mixed staged+unstaged in one go)
 * A file with NO uncommitted change (committed-only, unchanged, or unknown) is refused per-file.
 */
export async function discardUncommittedFiles(root: string, files: string[]): Promise<DiscardFileResult[]> {
  let entries: PorcelainEntry[];
  try {
    const { stdout } = await runGit(['status', '--porcelain', '-uall'], { cwd: root });
    entries = parseStatusPorcelain(stdout);
  } catch (err) {
    const error = errText(err, 'git status failed');
    return files.map((file) => ({ file, ok: false, error }));
  }
  // Index by both the unquoted and raw C-quoted spellings so a caller holding either form
  // (diff surfaces don't unquote exotic paths) still addresses the entry.
  const byPath = new Map<string, PorcelainEntry>();
  for (const e of entries) {
    byPath.set(e.path, e);
    if (e.rawPath !== e.path) byPath.set(e.rawPath, e);
  }

  const results: DiscardFileResult[] = [];
  for (const file of files) {
    const entry = byPath.get(file);
    if (!entry) {
      results.push({ file, ok: false, error: 'No uncommitted changes for this file (committed work is never discarded here)' });
      continue;
    }
    try {
      await discardOne(root, entry);
      results.push({ file, ok: true });
    } catch (err) {
      results.push({ file, ok: false, error: errText(err, 'Discard failed') });
    }
  }
  return results;
}

async function discardOne(root: string, e: PorcelainEntry): Promise<void> {
  if (e.x === '?') {
    // Untracked — nothing in git to restore; just remove it from disk.
    await fs.rm(path.join(root, e.path), { force: true });
    return;
  }
  if (e.x === 'R' && e.origPath) {
    // Staged rename — revert BOTH sides atomically: old path back into index + worktree, new
    // path out of the index and off disk. A one-sided revert leaves a double-delete/duplicate.
    await runGit(['restore', '--source=HEAD', '--staged', '--worktree', '--', e.origPath], { cwd: root });
    await runGit(['restore', '--staged', '--', e.path], { cwd: root });
    await fs.rm(path.join(root, e.path), { force: true });
    return;
  }
  if (e.x === 'A' || e.x === 'C') {
    // Staged add (or copy destination) — the path isn't in HEAD, so "restore from HEAD" can't
    // apply: unstage it, then delete the file.
    await runGit(['restore', '--staged', '--', e.path], { cwd: root });
    await fs.rm(path.join(root, e.path), { force: true });
    return;
  }
  // Tracked change (modified/deleted, staged and/or unstaged, incl. conflict states): restore
  // BOTH the index and the worktree from HEAD — clears mixed staged+unstaged in one operation
  // and resurrects a deleted file.
  await runGit(['restore', '--source=HEAD', '--staged', '--worktree', '--', e.path], { cwd: root });
}
