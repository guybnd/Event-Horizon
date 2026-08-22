#!/usr/bin/env node
// Targeted engine test gate (FLUX-1665).
//
// This is what `npm run check` runs locally instead of the full 205-file suite: the fast
// `unit` vitest project ALWAYS runs (cheap regression backstop), plus `vitest related`
// (the dedicated subcommand — NOT `run --related`, which vitest 4 rejects as an unknown
// `run` option) for whichever files this session actually changed — so a ticket that touched
// three files doesn't pay for the whole suite. The FULL suite is unaffected: CI (`ci.yml`) and
// release (`release.yml`) both call `npm run test -w engine` directly, not this script.
//
// CHANGED-FILE RESOLUTION (union of):
//   (a) committed changes since the merge-base with the base branch (default `master`,
//       override with EH_BASE_REF) — `git diff --name-only <merge-base> HEAD`
//   (b) uncommitted tracked changes — `git diff --name-only HEAD`
//   (c) untracked files — `git ls-files --others --exclude-standard`
// filtered to `engine/src/**`. If the base ref can't be resolved (shallow clone, detached
// worktree with no local `master`) or the change set is empty/undetectable, this falls back
// to the unit tier only — documented, not a silent skip.
//
// `resolveChangedFiles` is exported (repoRoot/baseRef parameterized) so it can be unit-tested
// against a synthetic git repo — see src/test-changed-resolution.test.ts. Importing this module
// does NOT execute the CLI gate; that only runs when the file is invoked directly (the
// `isMain` guard below), so the export is side-effect-free for a test to call.
//
// USAGE
//   node engine/scripts/test-changed.mjs

import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const engineRoot = join(__dirname, '..');
const defaultRepoRoot = join(engineRoot, '..');

function git(repoRoot, args) {
  try {
    return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return null;
  }
}

function linesOf(output) {
  if (!output) return [];
  return output.split(/\r?\n/).filter(Boolean);
}

function resolveMergeBase(repoRoot, baseRef) {
  if (git(repoRoot, ['rev-parse', '--verify', baseRef]) === null) return null;
  const out = git(repoRoot, ['merge-base', 'HEAD', baseRef]);
  return out ? out.trim() : null;
}

/**
 * Union of committed-since-merge-base, uncommitted, and untracked changes, filtered to
 * `engine/src/**` and returned as engine-relative paths (`src/...`). `repoRoot` defaults to
 * this repo; `baseRef` defaults to `EH_BASE_REF` or `master`.
 */
export function resolveChangedFiles(repoRoot = defaultRepoRoot, baseRef = process.env.EH_BASE_REF || 'master') {
  const seen = new Set();
  const mergeBase = resolveMergeBase(repoRoot, baseRef);
  if (mergeBase) {
    for (const f of linesOf(git(repoRoot, ['diff', '--name-only', mergeBase, 'HEAD']))) seen.add(f);
  }
  for (const f of linesOf(git(repoRoot, ['diff', '--name-only', 'HEAD']))) seen.add(f);
  for (const f of linesOf(git(repoRoot, ['ls-files', '--others', '--exclude-standard']))) seen.add(f);

  const enginePrefix = 'engine/';
  return [...seen]
    .filter((f) => f.startsWith(`${enginePrefix}src/`))
    // `vitest related` expects paths resolvable from its own root (engine/), matching how
    // test-tiers.json strips the same prefix for vitest.config.ts's include/exclude globs.
    .map((f) => f.slice(enginePrefix.length));
}

function run(label, args) {
  console.log(`[test-changed] ${label}: npx vitest ${args.join(' ')}`);
  try {
    execFileSync('npx', ['vitest', ...args], {
      cwd: engineRoot,
      stdio: 'inherit',
      shell: process.platform === 'win32',
      // `related` (unlike `run`) defaults its watch mode to `!process.env.CI` — force CI so a
      // local invocation never drops into an interactive watch loop and hangs the gate.
      env: { ...process.env, CI: '1' },
    });
    return true;
  } catch {
    return false;
  }
}

function main() {
  const changed = resolveChangedFiles();

  let ok = run('unit tier (always)', ['run', '--project', 'unit']);

  if (changed.length > 0) {
    console.log(`[test-changed] ${changed.length} changed file(s) under engine/src — running related tests across all projects:`);
    for (const f of changed) console.log(`  - ${f}`);
    ok = run('related to changed files', ['related', ...changed]) && ok;
  } else {
    console.log('[test-changed] no changed engine/src files detected (or base ref unresolved) — unit tier only.');
  }

  process.exit(ok ? 0 : 1);
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isMain) main();
