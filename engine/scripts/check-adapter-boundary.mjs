#!/usr/bin/env node
// Ratcheting adapter-boundary guard (FLUX-938, epic FLUX-851).
//
// Forbids per-CLI ("claude"-coupled) code from leaking OUTSIDE the one sanctioned
// home, `engine/src/agents/` — every other surface (routes, MCP server, portal,
// config) must talk to an agent only through the registry (`getAdapter`) and the
// `CLI_CAPABILITIES` table, never a hardcoded framework literal or a deep import of
// a specific adapter file. See .docs/event-horizon/architecture/adapter-layer-audit.md.
//
// HOW IT RATCHETS
//   The repo still has ~dozens of catalogued leaks (the audit). Rather than fail on
//   all of them on day one, the check compares the CURRENT leak set against an
//   allowlist of the KNOWN ones (adapter-boundary-allowlist.json). It fails only on
//   NEW leaks (a fingerprint absent from the allowlist, or MORE occurrences than
//   allowlisted). As each epic cleanup ticket removes leaks, it re-seeds the
//   allowlist (which only shrinks) — so the allowed set monotonically decreases and
//   new coupling can never be introduced silently.
//
// USAGE
//   node engine/scripts/check-adapter-boundary.mjs           # check (CI/gate); exit 1 on a new leak
//   node engine/scripts/check-adapter-boundary.mjs --seed    # regenerate the allowlist from current state
//                                                            # (ONLY run after REMOVING leaks; the diff is reviewed)
//
// Dependency-free (node builtins only) so it runs without an install.

import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative, dirname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..', '..'); // engine/scripts -> repo root
const allowlistPath = join(__dirname, 'adapter-boundary-allowlist.json');

// Directories scanned for leaks. The adapter dir itself is the SANCTIONED home for
// per-CLI code and is deliberately excluded.
const SCAN_ROOTS = ['engine/src', 'portal/src'];
const EXCLUDE_DIR_PREFIXES = [
  join('engine', 'src', 'agents'), // the one place per-CLI code is allowed
];
const FILE_EXT = /\.(ts|tsx)$/;
const EXCLUDE_FILE = /\.d\.ts$/; // generated declaration artifacts

// High-signal leak patterns — the core of the audit's grep-verification set. Each
// indicates per-CLI coupling that belongs behind getAdapter()/CLI_CAPABILITIES.
// (Extensible: a future ticket that fixes a whole category can add its pattern here.)
const PATTERNS = [
  // `framework === 'claude'` / `=== "claude"` / `!== 'claude'` (either operand order)
  { name: 'framework-literal-eq', re: /(?:[!=]==\s*['"]claude['"]|['"]claude['"]\s*[!=]==)/g },
  // `framework || 'claude'`, `EVENT_HORIZON_FRAMEWORK || 'claude'` default-coupling
  { name: 'claude-default-fallback', re: /\|\|\s*['"]claude['"]/g },
  // object-literal hardcode `framework: 'claude'`
  { name: 'framework-literal-assign', re: /framework\s*:\s*['"]claude['"]/g },
  // deep import of a specific adapter file from outside agents/ (only index.js/types.js are public)
  { name: 'adapter-deep-import', re: /from\s+['"][^'"]*\/agents\/(?:claude-code|copilot|gemini)(?:\.js)?['"]/g },
  // referencing the concrete adapter class by name outside agents/
  { name: 'concrete-adapter-ref', re: /\bClaudeCodeAdapter\b/g },
  // `claudeSessionId` — renamed to resumeSessionId in FLUX-902; this guards the rename
  { name: 'claude-session-id', re: /\bclaudeSessionId\b/g },
];

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

function isExcluded(relPath) {
  return EXCLUDE_DIR_PREFIXES.some((p) => relPath === p || relPath.startsWith(p + sep));
}

// Collect current leaks as { fingerprint -> { count, samples:[{file,line,text}] } }
function collect() {
  const files = [];
  for (const root of SCAN_ROOTS) walk(join(repoRoot, root), files);
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
      // FLUX-904: skip comment lines. A doc comment that NAMES a leak pattern (e.g. "replaced the
      // `=== 'claude'` check") is not a leak; matching it would trip the guard and pollute the
      // allowlist on every cleanup ticket. (Trailing-comment-on-code is rare and still caught if the
      // code itself leaks.) Only whole-line comments are skipped.
      const t = line.trim();
      if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) continue;
      for (const { name, re } of PATTERNS) {
        re.lastIndex = 0;
        let m;
        while ((m = re.exec(line)) !== null) {
          const match = m[0].trim();
          const fp = `${rel} :: ${name} :: ${match}`;
          let entry = hits.get(fp);
          if (!entry) { entry = { count: 0, samples: [] }; hits.set(fp, entry); }
          entry.count++;
          if (entry.samples.length < 3) entry.samples.push({ line: i + 1, text: line.trim().slice(0, 160) });
          if (m.index === re.lastIndex) re.lastIndex++; // avoid zero-width loop
        }
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
    console.error(`[adapter-boundary] could not parse allowlist: ${e.message}`);
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
    _comment: 'Ratcheting allowlist for check-adapter-boundary.mjs (FLUX-938). Each key is `relPath :: pattern :: match`; the value is the count of KNOWN occurrences. This set must only SHRINK — re-seed only after REMOVING leaks (epic FLUX-851 cleanup), and review the diff. A new leak (absent key, or count above the allowed value) fails CI.',
    allow,
  };
  writeFileSync(allowlistPath, JSON.stringify(payload, null, 2) + '\n');
  console.log(`[adapter-boundary] seeded allowlist with ${Object.keys(allow).length} known leak fingerprints.`);
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
  console.log(`[adapter-boundary] OK — no NEW per-CLI leakage outside engine/src/agents/ (${total} known occurrences allowlisted).`);
  process.exit(0);
}

console.error('[adapter-boundary] FAILED — new per-CLI ("claude"-coupled) code outside engine/src/agents/:\n');
for (const v of violations.sort((a, b) => a.fp.localeCompare(b.fp))) {
  console.error(`  ✗ ${v.fp}`);
  console.error(`      allowed ${v.allowed}, found ${v.found}`);
  for (const s of v.samples) console.error(`      ${s.line}: ${s.text}`);
}
console.error('\nPer-CLI code belongs in engine/src/agents/ (behind getAdapter()/CLI_CAPABILITIES), not here.');
console.error('If this is a sanctioned exception, document it in the audit and re-seed the allowlist:');
console.error('  node engine/scripts/check-adapter-boundary.mjs --seed   (review the allowlist diff)');
process.exit(1);
