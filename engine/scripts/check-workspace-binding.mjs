#!/usr/bin/env node
// Ratcheting ambient-workspace guard (FLUX-1755).
//
// `getWorkspace()` with no request/ALS binding resolves to the DEFAULT board. Every one of the
// multi-board misroutes fixed one at a time — FLUX-1548, FLUX-1574, FLUX-1595, FLUX-1695, the
// benchmark driver, and the benchmark analyst's "Ticket BENCH-15 not found 22 s after creation" —
// was a code path acting for a session that fell through to that default. The engine already logs
// the warning ("getWorkspace() called with no request/runWithWorkspace binding while N other
// board(s) are open") dozens of times a minute during dispatched runs.
//
// This guard does not fix the 250-odd existing call sites. It stops NEW bare `getWorkspace()` calls
// from landing silently: the CURRENT per-file count is the allowlist, a file may only go DOWN, and a
// brand-new file may not introduce any. As modules are migrated to an explicit `ws` / a
// `runWithWorkspace` binding, they re-seed the allowlist (which only shrinks). Mirrors
// check-git-exec.mjs (FLUX-997) and check-adapter-boundary.mjs (FLUX-938).
//
// WHAT COUNTS
//   Any `getWorkspace()` call with no arguments outside workspace-context.ts, including the
//   `ws: Workspace = getWorkspace()` default-parameter idiom — that default IS the hazard: it makes
//   an unbound caller silently pick the default board.
//
// USAGE
//   node engine/scripts/check-workspace-binding.mjs          # check; exit 1 on a NEW bare call
//   node engine/scripts/check-workspace-binding.mjs --seed   # regenerate the allowlist from current state
//                                                            # (ONLY run after REMOVING calls)
import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative, dirname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..', '..');
const allowlistPath = join(__dirname, 'workspace-binding-allowlist.json');
const SCAN_ROOT = join('engine', 'src');
const EXCLUDE_FILES = new Set([join('engine', 'src', 'workspace-context.ts')]);
const EXCLUDE_FILE = /\.d\.ts$|\.test\.ts$/;
const EXCLUDE_DIR = [join('engine', 'src', 'test-helpers')];
const BARE_CALL = /\bgetWorkspace\(\s*\)/g;

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const rel = relative(repoRoot, full);
    if (EXCLUDE_DIR.some((d) => rel === d || rel.startsWith(d + sep))) continue;
    const st = statSync(full);
    if (st.isDirectory()) walk(full, out);
    else if (/\.ts$/.test(name) && !EXCLUDE_FILE.test(name)) out.push(full);
  }
  return out;
}

function scan() {
  const counts = {};
  for (const file of walk(join(repoRoot, SCAN_ROOT))) {
    const rel = relative(repoRoot, file).split(sep).join('/');
    if (EXCLUDE_FILES.has(relative(repoRoot, file))) continue;
    const src = readFileSync(file, 'utf8');
    // Strip line comments so a commented-out call or a doc mention does not count.
    const code = src.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
    const n = (code.match(BARE_CALL) || []).length;
    if (n > 0) counts[rel] = n;
  }
  return counts;
}

const current = scan();
const total = Object.values(current).reduce((a, b) => a + b, 0);

if (process.argv.includes('--seed')) {
  writeFileSync(allowlistPath, JSON.stringify(current, null, 2) + '\n');
  console.log(`[workspace-binding] seeded allowlist: ${total} bare getWorkspace() call(s) across ${Object.keys(current).length} file(s).`);
  process.exit(0);
}

if (!existsSync(allowlistPath)) {
  console.error('[workspace-binding] no allowlist yet — run with --seed once to record the current state.');
  process.exit(1);
}
const allowed = JSON.parse(readFileSync(allowlistPath, 'utf8'));
const violations = [];
for (const [file, n] of Object.entries(current)) {
  const max = allowed[file] ?? 0;
  if (n > max) violations.push(`  ✗ ${file}: ${n} bare getWorkspace() call(s), allowlisted ${max}`);
}
if (violations.length > 0) {
  console.error('[workspace-binding] FAILED — NEW bare getWorkspace() call(s) (resolve to the DEFAULT board when unbound):\n');
  console.error(violations.join('\n'));
  console.error('\nPass the workspace explicitly (`ws`) or run the caller under runWithWorkspace(resolveWorkspaceByRoot(root), …).');
  console.error('Migrating a file? Remove calls, then re-seed:  node engine/scripts/check-workspace-binding.mjs --seed');
  process.exit(1);
}
const allowedTotal = Object.values(allowed).reduce((a, b) => a + b, 0);
console.log(`[workspace-binding] OK — no NEW bare getWorkspace() calls (${total} known, allowlist ${allowedTotal}; shrinking under FLUX-1755).`);
