#!/usr/bin/env node
/**
 * publish-public.mjs
 *
 * Squash all commits since the last public release into one and push to the
 * public remote. Keeps the public repo's history clean — each release is a
 * single commit parented to the previous public tip.
 *
 * Usage:
 *   node scripts/publish-public.mjs <version>   e.g.  node scripts/publish-public.mjs v0.24.0
 *   npm run publish-public -- v0.24.0
 *
 * What it does:
 *   1. Fetch public/master to get the latest public tip.
 *   2. Build a commit message from the release notes (or git log as fallback).
 *   3. Create a squashed commit via `git commit-tree` (tree = current HEAD,
 *      parent = current public/master tip) — no branch switching, no rebasing.
 *   4. Force-push that single commit to public/master.
 *   5. Create (or move) the version tag locally and push it to public.
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
const tag = version.startsWith('v') ? version : `v${version}`;

console.log(`\n→ Publishing ${tag} to public remote…\n`);

// 1. Fetch public so public/master is current.
console.log('Fetching public remote…');
run('git fetch public');

const publicTip = run('git rev-parse public/master');
const localTip  = run('git rev-parse HEAD');

console.log(`  public/master : ${publicTip.slice(0, 10)}`);
console.log(`  local HEAD    : ${localTip.slice(0, 10)}`);

if (publicTip === localTip) {
  console.log('\nNothing to publish — public/master is already at HEAD.');
  process.exit(0);
}

// 2. Build commit message — prefer release notes, fall back to git log.
const releaseNotesPath = path.join(root, '.docs', 'release-notes', `${tag}.md`);
let commitMsg;
if (existsSync(releaseNotesPath)) {
  const raw = readFileSync(releaseNotesPath, 'utf-8');
  const body = raw.replace(/^---[\s\S]*?---\n/, '').trim();
  commitMsg = `Release ${tag}\n\n${body}`;
} else {
  const logLines = run(`git log --oneline ${publicTip}..${localTip}`);
  commitMsg = `Release ${tag}\n\n${logLines}`;
}

// 3. Create squashed commit: tree = HEAD, parent = current public/master.
console.log('\nCreating squashed commit…');
const headTree = run('git rev-parse "HEAD^{tree}"');

const tmpMsg = path.join(root, '.git', 'PUBLIC_SQUASH_MSG');
writeFileSync(tmpMsg, commitMsg, 'utf-8');

let squashedSha;
try {
  squashedSha = run(`git commit-tree ${headTree} -p ${publicTip} -F .git/PUBLIC_SQUASH_MSG`);
} finally {
  try { unlinkSync(tmpMsg); } catch {}
}
console.log(`  squashed SHA  : ${squashedSha.slice(0, 10)}`);

// 4. Force-push squashed commit to public/master.
console.log('\nForce-pushing to public/master…');
run(`git push public ${squashedSha}:refs/heads/master --force`);

// 5. Create/move local tag and push to public.
console.log(`\nTagging ${tag}…`);
try { run(`git tag -d ${tag}`); } catch {}
run(`git tag ${tag} ${squashedSha}`);
run(`git push public ${tag} --force`);

console.log(`\n✓ Done. ${tag} published to public as a single squashed commit (${squashedSha.slice(0, 10)}).\n`);
console.log(`  https://github.com/guybnd/event-horizon/releases/tag/${tag}\n`);
