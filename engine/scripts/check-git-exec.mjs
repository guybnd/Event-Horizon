#!/usr/bin/env node
// Ratcheting git/gh-spawn guard (FLUX-997, epic FLUX-996).
//
// Forbids spawning `git`/`gh` directly (bare execFile/execFileSync/execSync/spawn/spawnSync/exec
// with a 'git' or 'gh' command literal) ANYWHERE in engine/src except the one sanctioned runner,
// `git-exec.ts`. Every other module must go through runGit()/runGh(), which ALWAYS apply a
// timeout, the non-interactive gh-authed credential env, and tree-kill on timeout/abort — the
// hardening whose ABSENCE is the dominant cause of the FLUX-996 hangs (a bare `git push`/`fetch`
// with no timeout hangs forever on a slow/unreachable remote or a GCM prompt).
//
// HOW IT RATCHETS
//   The repo still has ~14 files with bare git/gh spawns (the S2–S5 migration targets, plus the
//   already-hardened sync path). Rather than fail on all of them on day one, the check compares
//   the CURRENT spawn set against an allowlist of the KNOWN ones (git-exec-allowlist.json). It
//   fails only on NEW spawns (a fingerprint absent from the allowlist, or MORE occurrences than
//   allowlisted). As S2–S5 route each module through runGit()/runGh(), they re-seed the allowlist
//   (which only shrinks) — so the allowed set monotonically decreases to zero and new bare git/gh
//   spawns can never be introduced silently. Mirrors check-adapter-boundary.mjs (FLUX-938).
//
// USAGE
//   node engine/scripts/check-git-exec.mjs           # check (CI/gate); exit 1 on a new bare spawn
//   node engine/scripts/check-git-exec.mjs --seed     # regenerate the allowlist from current state
//                                                      # (ONLY run after ROUTING calls through runGit/runGh)
//
// Dependency-free (node builtins only) so it runs without an install.

import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative, dirname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..', '..'); // engine/scripts -> repo root
const allowlistPath = join(__dirname, 'git-exec-allowlist.json');

const SCAN_ROOT = join('engine', 'src');
// The sanctioned home for git/gh spawning. runGit()/runGh() live here; nothing else may spawn.
const EXCLUDE_FILES = [join('engine', 'src', 'git-exec.ts')];
const FILE_EXT = /\.ts$/;
const EXCLUDE_FILE = /\.d\.ts$|\.test\.ts$/; // declarations + tests (tests may spawn stand-ins)

// A bare git/gh spawn: an exec/spawn-family call whose first string argument starts with the
// command `git` or `gh`. Covers BOTH the argv form (execFile('git', […])) and the idiomatic
// shell-string form (execSync('git push origin main'), exec('gh pr …')), in single/double/backtick
// quotes — the command word is followed by either a closing quote (argv form) or whitespace
// (shell form). Anchoring on that boundary avoids matching `github…`/`ghost`.
// Longest names first so execFileAsync/execFileSync match before execFile, etc.
const SPAWN_RE = /(?<![\w$])(?:execFileAsync|execFileSync|execFile|execSync|spawnSync|spawn|exec)\s*\(\s*(['"`])(git|gh)(?:\1|\s)/g;

function walk(dir, out) {
  let entries;
  try { entries = readdirSync(dir); } catch { return; }
  for (const name of entries) {
    const full = join(dir, name);
    let st;
    try { st = statSync(full); } catch { continue; }
    if (st.isDirectory()) {
      if (name === 'node_modules') continue;
      walk(full, out);
    } else if (FILE_EXT.test(name) && !EXCLUDE_FILE.test(name)) {
      out.push(full);
    }
  }
}

function isExcluded(relNative) {
  return EXCLUDE_FILES.some((p) => relNative === p);
}

// Collect current bare spawns as { fingerprint -> { count, samples:[{line,text}] } }.
function collect() {
  const files = [];
  walk(join(repoRoot, SCAN_ROOT), files);
  const hits = new Map();
  for (const file of files) {
    const rel = relative(repoRoot, file).split(sep).join('/');
    const relNative = relative(repoRoot, file);
    if (isExcluded(relNative)) continue;
    let content;
    try { content = readFileSync(file, 'utf8'); } catch { continue; }
    const lines = content.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const t = line.trim();
      // Skip whole-line comments so a doc comment naming `execFile('git', …)` isn't counted.
      if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) continue;
      SPAWN_RE.lastIndex = 0;
      let m;
      while ((m = SPAWN_RE.exec(line)) !== null) {
        const cmd = m[2];
        const fp = `${rel} :: ${cmd}`;
        let entry = hits.get(fp);
        if (!entry) { entry = { count: 0, samples: [] }; hits.set(fp, entry); }
        entry.count++;
        if (entry.samples.length < 3) entry.samples.push({ line: i + 1, text: t.slice(0, 160) });
        if (m.index === SPAWN_RE.lastIndex) SPAWN_RE.lastIndex++; // avoid zero-width loop
      }
    }
  }
  return hits;
}

function loadAllowlist() {
  if (!existsSync(allowlistPath)) return {};
  try {
    const data = JSON.parse(readFileSync(allowlistPath, 'utf8'));
    return data.allow || {};
  } catch (e) {
    console.error(`[git-exec] could not parse allowlist: ${e.message}`);
    process.exit(2);
  }
}

const seed = process.argv.includes('--seed');
const hits = collect();

if (seed) {
  const allow = {};
  for (const [fp, entry] of [...hits.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    allow[fp] = entry.count;
  }
  const payload = {
    _comment: 'Ratcheting allowlist for check-git-exec.mjs (FLUX-997, epic FLUX-996). Each key is `relPath :: git|gh`; the value is the count of KNOWN bare spawns still to migrate to runGit()/runGh(). This set must only SHRINK — re-seed only after ROUTING calls through the runner (S2–S5), and review the diff. A new bare spawn (absent key, or count above the allowed value) fails CI.',
    allow,
  };
  writeFileSync(allowlistPath, JSON.stringify(payload, null, 2) + '\n');
  console.log(`[git-exec] seeded allowlist with ${Object.keys(allow).length} known bare-spawn fingerprints.`);
  process.exit(0);
}

const allow = loadAllowlist();
const violations = [];
for (const [fp, entry] of hits) {
  const allowed = allow[fp] ?? 0;
  if (entry.count > allowed) {
    violations.push({ fp, allowed, found: entry.count, samples: entry.samples });
  }
}

if (violations.length === 0) {
  const total = [...hits.values()].reduce((n, e) => n + e.count, 0);
  console.log(`[git-exec] OK — no NEW bare git/gh spawns outside git-exec.ts (${total} known occurrences allowlisted, shrinking via S2–S5).`);
  process.exit(0);
}

console.error('[git-exec] FAILED — new bare git/gh spawn(s) outside git-exec.ts:\n');
for (const v of violations.sort((a, b) => a.fp.localeCompare(b.fp))) {
  console.error(`  ✗ ${v.fp}`);
  console.error(`      allowed ${v.allowed}, found ${v.found}`);
  for (const s of v.samples) console.error(`      ${s.line}: ${s.text}`);
}
console.error('\nSpawn git/gh only through runGit()/runGh() in engine/src/git-exec.ts (timeout + non-interactive env + tree-kill).');
console.error('If you just ROUTED calls through the runner, re-seed the (shrinking) allowlist:');
console.error('  node engine/scripts/check-git-exec.mjs --seed   (review the allowlist diff)');
process.exit(1);
