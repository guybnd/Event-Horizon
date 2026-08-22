#!/usr/bin/env node
// Test-tier classification guard (FLUX-1665).
//
// Every engine test file is classified into one of two tiers:
//   - `unit`        — no real subprocess, no real git fixture. Runs with pool:'threads' (fast —
//                      worker_threads instead of a per-file OS process spawn).
//   - `integration` — spawns a child process (execFile*/spawn*/exec*/execSync, or a static
//                      `child_process` import) and/or builds a real git fixture (mkdtemp +
//                      git init). Runs with pool:'forks' (isolated processes; real subprocess
//                      work is not safe to share a worker thread).
//
// A file is classified INTEGRATION if it matches either signal. The computed set is
// compared against the committed `test-tiers.json`. This guard FAILS if a file that
// matches an integration signal is missing from the committed list — that is the failure
// mode this ticket exists to prevent: a spawn/git-fixture test silently landing in the fast
// `unit` tier and racing/contending with whatever else shares that pool.
//
// It is intentionally NOT a ratchet (unlike check-git-exec.mjs / check-adapter-boundary.mjs):
// there is no "known debt" to allow — every matching file MUST be in the integration list,
// always. The committed list is also allowed to contain files that DON'T match a signal
// (e.g. a slow-but-non-spawning file promoted to `integration` by hand after profiling) —
// the guard only complains about matches missing from the list, never extras.
//
// USAGE
//   node engine/scripts/classify-tests.mjs           # check (CI/gate); exit 1 if the committed
//                                                     # list is missing a matching file
//   node engine/scripts/classify-tests.mjs --write    # regenerate test-tiers.json from current
//                                                     # source (review the diff before committing)
//
// `isIntegrationTest` (the pure signal-matching predicate) and `computeIntegrationSet` (the
// directory walk) are exported so they can be unit-tested without touching the real repo — see
// src/classify-tests-partitioning.test.ts. Importing this module does NOT run the CLI check/
// write; that only happens when the file is invoked directly (the `isMain` guard below).
//
// Dependency-free (node builtins only) so it runs without an install.

import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative, dirname, sep, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..', '..'); // engine/scripts -> repo root
const tiersPath = join(__dirname, '..', 'test-tiers.json');

const SCAN_ROOT = join('engine', 'src');
const TEST_FILE = /\.test\.ts$/;

// Direct child-process usage: a static `child_process` import, or a call to any member of the
// exec/spawn family. Matches the intent (not the exact guard) of check-git-exec.mjs's SPAWN_RE,
// but here ANY exec/spawn target counts (not just git/gh) — a test spawning any external binary
// is real subprocess work and belongs in the isolated `integration` tier.
const SPAWN_RE = /(?<![\w$])(?:execFileAsync|execFileSync|execFile|execSync|spawnSync|spawn|exec)\s*\(/;
const CHILD_PROCESS_IMPORT_RE = /from\s+['"](?:node:)?child_process['"]|require\(\s*['"](?:node:)?child_process['"]\s*\)/;

// Real git-fixture construction: every fixture helper in the suite builds its temp repo via
// fs.mkdtemp/mkdtempSync (see CONTEXT SCOUT note on FLUX-1665 — 96+ files, no shared helper).
const MKDTEMP_RE = /\bmkdtemp(?:Sync)?\b/;

/**
 * True if a test file's source matches a direct spawn/child_process-import or real-git-fixture
 * (mkdtemp) signal — the two things that make a test unsafe for the fast, thread-pooled `unit`
 * tier. KNOWN LIMITATION (documented, not a bug): this is a static, direct-usage check only — a
 * file that spawns only TRANSITIVELY (via an imported helper module, with no spawn/mkdtemp
 * token of its own) is NOT detected. That gap is why the committed test-tiers.json also accepts
 * hand-curated entries beyond what this predicate finds.
 */
export function isIntegrationTest(content) {
  const matchesSpawn = SPAWN_RE.test(content) || CHILD_PROCESS_IMPORT_RE.test(content);
  const matchesFixture = MKDTEMP_RE.test(content);
  return matchesSpawn || matchesFixture;
}

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
    } else if (TEST_FILE.test(name)) {
      out.push(full);
    }
  }
}

/** Walks `scanRootAbs` (default: this repo's engine/src) for `*.test.ts` files matching `isIntegrationTest`, returning repo-root-relative paths. */
export function computeIntegrationSet(scanRootAbs = join(repoRoot, SCAN_ROOT), rootForRelative = repoRoot) {
  const files = [];
  walk(scanRootAbs, files);
  const integration = [];
  for (const file of files) {
    const rel = relative(rootForRelative, file).split(sep).join('/');
    let content;
    try { content = readFileSync(file, 'utf8'); } catch { continue; }
    if (isIntegrationTest(content)) integration.push(rel);
  }
  return integration.sort();
}

function loadCommitted() {
  if (!existsSync(tiersPath)) return null;
  try {
    const data = JSON.parse(readFileSync(tiersPath, 'utf8'));
    return Array.isArray(data.integration) ? data.integration : [];
  } catch (e) {
    console.error(`[classify-tests] could not parse ${relative(repoRoot, tiersPath)}: ${e.message}`);
    process.exit(2);
  }
}

function main() {
  const write = process.argv.includes('--write');
  const computed = computeIntegrationSet();

  if (write) {
    const payload = {
      _comment:
        'Committed test-tier classification for FLUX-1665. `integration` lists every engine test file ' +
        'that spawns a real subprocess and/or builds a real git fixture (mkdtemp) — these run in the ' +
        "forks-pool `integration` vitest project. Everything else runs in the threads-pool `unit` " +
        "project. Regenerate with `node engine/scripts/classify-tests.mjs --write` and review the " +
        'diff; extra hand-added entries (e.g. a slow-but-non-spawning file) are preserved by re-running ' +
        '--write only after adding them, not by editing this comment.',
      integration: computed,
    };
    const existing = loadCommitted();
    // Preserve any hand-added entries that don't match a static signal (e.g. profiled-slow files)
    // by unioning with whatever was already committed, rather than clobbering curation on --write.
    const preserved = existing ? existing.filter((f) => !computed.includes(f)) : [];
    payload.integration = [...computed, ...preserved].sort();
    writeFileSync(tiersPath, JSON.stringify(payload, null, 2) + '\n');
    console.log(
      `[classify-tests] wrote ${payload.integration.length} integration entries ` +
        `(${computed.length} auto-detected, ${preserved.length} hand-curated) to ${relative(repoRoot, tiersPath)}.`
    );
    process.exit(0);
  }

  const committed = loadCommitted();
  if (committed === null) {
    console.error(`[classify-tests] ${relative(repoRoot, tiersPath)} does not exist.`);
    console.error('Generate it with: node engine/scripts/classify-tests.mjs --write');
    process.exit(1);
  }

  const committedSet = new Set(committed);
  const missing = computed.filter((f) => !committedSet.has(f));

  if (missing.length === 0) {
    console.log(
      `[classify-tests] OK — ${committed.length} committed integration entries cover all ` +
        `${computed.length} auto-detected spawn/git-fixture test files.`
    );
    process.exit(0);
  }

  console.error('[classify-tests] FAILED — test file(s) spawn a process or build a git fixture but are missing from test-tiers.json:\n');
  for (const f of missing) console.error(`  ✗ ${f}`);
  console.error(
    '\nThese files must run in the isolated `integration` vitest project, not the fast `unit` tier.' +
      '\nAdd them to test-tiers.json by regenerating it and reviewing the diff:' +
      '\n  node engine/scripts/classify-tests.mjs --write'
  );
  process.exit(1);
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isMain) main();
