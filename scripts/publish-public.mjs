#!/usr/bin/env node
/**
 * publish-public.mjs
 *
 * Squash all dev commits since the last public release into one commit and
 * push it to the public remote. The public repo grows one commit per release:
 *   v0.23.0 → v0.24.0 → v0.25.0 …
 *
 * Usage:
 *   node scripts/publish-public.mjs <version>   e.g.  node scripts/publish-public.mjs v0.24.0
 *   npm run publish-public -- v0.24.0
 *
 * What it does:
 *   1. Fetch public/master to get the latest public tip.
 *   2. Guard against double-runs: if public/master already has the same tree
 *      as local HEAD, there is nothing new to squash — exit cleanly.
 *   3. Build a commit message from the release notes (or git log as fallback).
 *   4. Create a squashed commit via `git commit-tree` (tree = current HEAD,
 *      parent = current public/master tip) — no branch switching, no rebasing.
 *   5. Force-push that single commit to public/master.
 *   6. Tag the dev HEAD and push the tag to origin, so the dev repo's
 *      release workflow fires against real dev history.
 *   7. Push the same tag name pointing at the squashed commit to public —
 *      without moving the local tag off dev history.
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

const version = process.argv[2];
if (!version) {
  console.error('Usage: node scripts/publish-public.mjs <version>  (e.g. v0.24.0)');
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

// 2. Guard: if the public tip already carries our tree, nothing to do.
//    This prevents double-squash if the script is accidentally run twice.
const publicTree = run(`git rev-parse "${publicTip}^{tree}"`);
if (publicTree === headTree) {
  console.log('\nNothing to publish — public/master already has the current tree.');
  process.exit(0);
}

// 3. Build commit message — prefer release notes, fall back to git log.
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

// 4. Create squashed commit: tree = HEAD, parent = current public/master.
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

// 5. Force-push squashed commit to public/master.
console.log('\nForce-pushing to public/master…');
run(`git push public ${squashedSha}:refs/heads/master --force`);

// 6. Tag the dev HEAD and push to origin. The tag must point at a commit
//    that exists in dev history so the dev repo's release workflow can fire;
//    the squashed commit only exists in the public repo's history.
console.log(`\nTagging ${tag} on dev HEAD and pushing to origin…`);
try { run(`git tag -d ${tag}`); } catch {}
run(`git tag ${tag} ${localTip}`);
run(`git push origin ${tag} --force`);

// 7. Push the tag at the squashed commit to public via a refspec, keeping
//    the local tag pointed at dev history.
console.log(`\nPushing ${tag} (squashed commit) to public…`);
run(`git push public ${squashedSha}:refs/tags/${tag} --force`);

console.log(`\n✓ Done. ${tag} published to public as a single squashed commit (${squashedSha.slice(0, 10)}).\n`);
console.log(`  https://github.com/guybnd/event-horizon/releases/tag/${tag}\n`);
