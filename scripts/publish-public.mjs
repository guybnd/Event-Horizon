#!/usr/bin/env node
/**
 * publish-public.mjs
 *
 * Squash all dev commits since the last public release into one commit and
 * push it to the public remote. The public repo grows one commit per release:
 *   v0.23.0 → v0.24.0 → v0.25.0 …
 *
 * Usage:
 *   node scripts/publish-public.mjs <version> [--re-cut] [--allow-dirty]
 *   npm run publish-public -- v0.24.0
 *
 * What it does:
 *   1. Fetch public/master to get the latest public tip.
 *   2. Guard against double-runs: if public/master already has the same tree
 *      as local HEAD, there is nothing new to squash — exit cleanly.
 *   2b. Guard against re-publishing an already-released tag (read-only check,
 *      runs before anything on public is mutated — see FLUX-835 hardening below).
 *   3. Build a commit message from the release notes (or git log as fallback).
 *   4. Create a squashed commit via `git commit-tree` (tree = current HEAD,
 *      parent = current public/master tip) — no branch switching, no rebasing.
 *   5. Force-push that single commit to public/master.
 *   6. Tag the dev HEAD and push the tag to origin, so the dev repo's
 *      release workflow fires against real dev history.
 *   7. Push the same tag name pointing at the squashed commit to public —
 *      without moving the local tag off dev history.
 *
 * FLUX-835 hardening — v1.0.0 shipped two different builds under one tag because a
 * re-run force-moved an already-published tag onto a different squash commit. Two guards
 * close that gap:
 *   - Immutable version tags: if <tag> already exists on the public remote, the run is
 *     refused (post-release fixes should cut a new version, e.g. v1.0.1) unless --re-cut
 *     is passed to intentionally replace it.
 *   - Freshness guard: publishing is refused when the worktree is dirty or local HEAD has
 *     diverged from origin/master (fetched fresh, not assumed), unless --allow-dirty.
 */

import { execSync } from 'child_process';
import { readFileSync, writeFileSync, existsSync, unlinkSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

function run(cmd, opts = {}) {
  return execSync(cmd, { cwd: root, encoding: 'utf-8', ...opts }).trim();
}

const args = process.argv.slice(2);
const reCut = args.includes('--re-cut');
const allowDirty = args.includes('--allow-dirty');
const version = args.find((a) => !a.startsWith('--'));
if (!version) {
  console.error('Usage: node scripts/publish-public.mjs <version> [--re-cut] [--allow-dirty]  (e.g. v0.24.0)');
  process.exit(1);
}
// Version convention (FLUX-1317): release artifacts (notes files/headers, git tags, public
// releases) are v-prefixed; package.json is bare semver. Either input form is accepted — we
// normalize to a v-tag here and derive the bare form to locate a (possibly bare-named) notes file.
const tag = version.startsWith('v') ? version : `v${version}`;
const bareVersion = tag.replace(/^v/, '');

console.log(`\n→ Publishing ${tag} to public remote…\n`);

// 1. Fetch public so public/master is current.
console.log('Fetching public remote…');
run('git fetch public');

const publicTip  = run('git rev-parse public/master');
const localTip   = run('git rev-parse HEAD');
const headTree   = run('git rev-parse "HEAD^{tree}"');

console.log(`  public/master : ${publicTip.slice(0, 10)}`);
console.log(`  local HEAD    : ${localTip.slice(0, 10)}`);

// 1b. Freshness guard (FLUX-835): fetch origin (the dev source of truth) and refuse to
//     publish from a dirty worktree or a local HEAD that has diverged from origin/master —
//     a stale/uncommitted local state is exactly how a re-cut build silently differs from
//     what an earlier run captured. --allow-dirty is the explicit escape hatch.
console.log('Fetching origin remote…');
run('git fetch origin');

const dirtyStatus = run('git status --porcelain');
if (dirtyStatus && !allowDirty) {
  console.error('\n✗ Worktree has uncommitted changes:');
  console.error(dirtyStatus);
  console.error('  Commit or stash them, or pass --allow-dirty to publish anyway.');
  process.exit(1);
}

const originTip = run('git rev-parse origin/master');
if (originTip !== localTip && !allowDirty) {
  console.error(`\n✗ Local HEAD (${localTip.slice(0, 10)}) does not match origin/master (${originTip.slice(0, 10)}).`);
  console.error('  Pull/push to bring them in sync, or pass --allow-dirty to publish from this HEAD anyway.');
  process.exit(1);
}

// 2. Guard: if the public tip already carries our tree, nothing to do.
//    This prevents double-squash if the script is accidentally run twice.
const publicTree = run(`git rev-parse "${publicTip}^{tree}"`);
if (publicTree === headTree) {
  console.log('\nNothing to publish — public/master already has the current tree.');
  process.exit(0);
}

// 2b. Immutable tag guard (FLUX-835): once <tag> exists on public, refuse to move it —
//     that is exactly how v1.0.0 shipped two different builds under one tag. This must run
//     before the master force-push below: it is a read-only probe with no dependency on the
//     squashed commit, so checking it first means a refused re-run never mutates public/master.
//     --re-cut is the explicit opt-in to intentionally replace an already-published release.
console.log(`\nChecking whether ${tag} already exists on public…`);
const existingPublicTag = run(`git ls-remote --tags public refs/tags/${tag}`);
if (existingPublicTag && !reCut) {
  console.error(`\n✗ Tag ${tag} already exists on the public remote.`);
  console.error('  Re-running publish-public for an already-released version would silently move');
  console.error('  an existing release tag onto different content. Cut a new version for follow-up');
  console.error(`  fixes (e.g. a patch bump past ${tag}), or pass --re-cut to intentionally replace it.`);
  process.exit(1);
}

// 4. Build commit message — prefer release notes, fall back to git log.
//    flux:release writes v-prefixed note files, but tolerate a bare-named file too so a prefix
//    mismatch never silently drops us to the git-log fallback (FLUX-1317).
const notesDir = path.join(root, '.docs', 'release-notes');
const releaseNotesPath = [
  path.join(notesDir, `${tag}.md`),
  path.join(notesDir, `${bareVersion}.md`),
].find(existsSync);
let commitMsg;
if (releaseNotesPath) {
  const raw = readFileSync(releaseNotesPath, 'utf-8');
  const body = raw.replace(/^---[\s\S]*?---\n/, '').trim();
  commitMsg = `Release ${tag}\n\n${body}`;
} else {
  // Fall back to one-line log of everything not yet on public.
  // Note: this log is from dev history and won't exist as a common ancestor,
  // so we diff against the merge-base if one exists, otherwise all of HEAD.
  let logLines;
  try {
    const base = run(`git merge-base HEAD ${publicTip}`);
    logLines = run(`git log --oneline ${base}..${localTip}`);
  } catch {
    logLines = run(`git log --oneline -20 ${localTip}`);
  }
  commitMsg = `Release ${tag}\n\n${logLines}`;
}

// 5. Create squashed commit: tree = HEAD, parent = current public/master.
console.log('\nCreating squashed commit…');
const tmpMsg = path.join(root, '.git', 'PUBLIC_SQUASH_MSG');
writeFileSync(tmpMsg, commitMsg, 'utf-8');

let squashedSha;
try {
  squashedSha = run(`git commit-tree ${headTree} -p ${publicTip} -F .git/PUBLIC_SQUASH_MSG`);
} finally {
  try { unlinkSync(tmpMsg); } catch {}
}
console.log(`  squashed SHA  : ${squashedSha.slice(0, 10)}`);

// 6. Force-push squashed commit to public/master.
console.log('\nForce-pushing to public/master…');
run(`git push public ${squashedSha}:refs/heads/master --force`);

// 7. Tag the dev HEAD and push to origin. The tag must point at a commit
//    that exists in dev history so the dev repo's release workflow can fire;
//    the squashed commit only exists in the public repo's history.
//    The push is force only when --re-cut is intentionally replacing an existing tag.
console.log(`\nTagging ${tag} on dev HEAD and pushing to origin…`);
try { run(`git tag -d ${tag}`); } catch {}
run(`git tag ${tag} ${localTip}`);
run(`git push origin ${tag}${existingPublicTag ? ' --force' : ''}`);

// 8. Push the tag at the squashed commit to public via a refspec, keeping
//    the local tag pointed at dev history.
console.log(`\nPushing ${tag} (squashed commit) to public…`);
run(`git push public ${squashedSha}:refs/tags/${tag}${existingPublicTag ? ' --force' : ''}`);

console.log(`\n✓ Done. ${tag} published to public as a single squashed commit (${squashedSha.slice(0, 10)}).\n`);
console.log(`  https://github.com/guybnd/event-horizon/releases/tag/${tag}\n`);
