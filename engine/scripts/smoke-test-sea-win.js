#!/usr/bin/env node
/**
 * CI smoke test (FLUX-1323): package the standalone Windows SEA binary via the same
 * package-release.js path that produces the shipped artifact, boot it with a scratch
 * workspace/port, and assert GET /api/health returns 200 before the release is considered
 * good. Nothing in CI previously launched the built binary, which let FLUX-1321 (isSea
 * detection silently failing, so packaged assets were never extracted) ship undetected.
 *
 * Windows-only — run from the repo root after `npm run build` has produced the portal +
 * engine bundles. package-release.js does NOT invoke `npm run build` itself, so this script
 * can't be run standalone without one first — `npm run smoke-test:win` alone will fail on a
 * clean checkout; use `npm run package:win` (which chains `build` first) or run `npm run
 * build` yourself before invoking this directly.
 */

import { spawnSync, spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { fileURLToPath } from 'url';

if (process.platform !== 'win32') {
  console.error('smoke-test-sea-win.js only runs on win32');
  process.exit(1);
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const engineRoot = path.resolve(__dirname, '..');
const repoRoot = path.resolve(engineRoot, '..');
const releasesDir = path.join(repoRoot, 'releases');

const WIN_BSDTAR = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
const PORT = 47831; // scratch port, distinct from the 3067 default, so it can't collide with a real instance
const HEALTH_TIMEOUT_MS = 30_000;
const POLL_INTERVAL_MS = 500;
// Bounds each individual fetch() — without this, a hung server (TCP connection accepted but
// never responding, distinct from connection-refused-while-booting) blocks await fetch()
// indefinitely and the HEALTH_TIMEOUT_MS deadline loop never gets re-evaluated (FLUX-1325).
const FETCH_TIMEOUT_MS = 5_000;

function fail(message) {
  console.error(`\n[smoke-test] FAILED: ${message}`);
  process.exit(1);
}

console.log('[smoke-test] Building Windows SEA binary via package-release.js …');
const build = spawnSync(
  process.execPath, [path.join(engineRoot, 'scripts', 'package-release.js'), '--platform', 'win'],
  { cwd: repoRoot, stdio: 'inherit' }
);
if (build.status !== 0) fail('package-release.js --platform win exited non-zero');

const zipName = fs.readdirSync(releasesDir).find((f) => /^event-horizon-win-.*\.zip$/.test(f));
if (!zipName) fail(`no event-horizon-win-*.zip produced in ${releasesDir}`);
const zipPath = path.join(releasesDir, zipName);

const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eh-smoke-'));

function cleanupFiles() {
  try { fs.rmSync(scratchDir, { recursive: true, force: true }); } catch { /* best-effort */ }
  try { fs.rmSync(zipPath, { force: true }); } catch { /* best-effort */ }
}

console.log(`[smoke-test] Extracting ${zipName} → ${scratchDir} …`);
const extract = spawnSync(WIN_BSDTAR, ['-xf', zipPath, '-C', scratchDir], { stdio: 'inherit' });
if (extract.status !== 0) { cleanupFiles(); fail('failed to extract the SEA zip'); }

const exeName = fs.readdirSync(scratchDir).find((f) => f.endsWith('.exe'));
if (!exeName) { cleanupFiles(); fail(`no .exe found in extracted zip contents of ${scratchDir}`); }
const exePath = path.join(scratchDir, exeName);

// Packaged mode reads the port from event-horizon.config.json next to the executable
// (process.env.PORT is only honored unpackaged) — pin a scratch port here so the boot
// never collides with a real dev/prod instance already running on 3067.
fs.writeFileSync(path.join(scratchDir, 'event-horizon.config.json'), JSON.stringify({ port: PORT }, null, 2));

// Isolate global app settings under a scratch home/APPDATA (engine/src/global-settings.ts
// resolves its data dir from process.env.APPDATA on win32, and separately reads a *legacy*
// settings dir at os.homedir()/.event-horizon that migrateFromLegacy() copies forward on every
// boot — os.homedir() itself resolves from USERPROFILE). Verified locally: without overriding
// BOTH, a machine with EventHorizon already installed re-registers its real workspace into the
// scratch APPDATA via that legacy-migration path, and the smoke-test binary auto-binds to it via
// the "registered"/"lastWorkspace" fallback in startServer() — never what a scratch boot wants.
const scratchHome = path.join(scratchDir, 'home');
const scratchAppData = path.join(scratchHome, 'AppData', 'Roaming');
fs.mkdirSync(scratchAppData, { recursive: true });

async function cleanup(child) {
  if (child && !childExited) {
    // Prefer the engine's own graceful shutdown route over a hard kill — avoids leaving chokidar
    // watchers / child processes in a half-torn-down state (observed as a native libuv assertion
    // crash on a raw kill() during local verification).
    try {
      await fetch(`http://127.0.0.1:${PORT}/api/shutdown`, {
        method: 'POST',
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      await new Promise((r) => setTimeout(r, 500));
    } catch { /* engine already gone / never came up / hung — fall through to a hard kill */ }
  }
  try { child?.kill(); } catch { /* already dead */ }
  cleanupFiles();
}

console.log(`[smoke-test] Launching ${exeName} on port ${PORT} (scratch workspace + APPDATA) …`);
// cwd is the freshly extracted scratch dir — no .flux/.flux-store there, so the engine boots
// unbound rather than picking up this checkout's own board.
const child = spawn(exePath, [], {
  cwd: scratchDir,
  stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, APPDATA: scratchAppData, USERPROFILE: scratchHome },
});

let output = '';
child.stdout.on('data', (d) => { output += d.toString(); });
child.stderr.on('data', (d) => { output += d.toString(); });

let childExited = false;
let childExitInfo = '';
child.on('exit', (code, signal) => {
  childExited = true;
  childExitInfo = `exit code=${code} signal=${signal}`;
});

async function waitForHealth() {
  const deadline = Date.now() + HEALTH_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (childExited) {
      throw new Error(`process exited before becoming healthy (${childExitInfo})\n--- output ---\n${output}`);
    }
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/api/health`, {
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (res.status === 200) return res.json();
    } catch {
      // connection refused while still booting, or a hung request that hit FETCH_TIMEOUT_MS —
      // either way, keep polling; the outer HEALTH_TIMEOUT_MS deadline bounds the whole loop
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  throw new Error(`/api/health did not return 200 within ${HEALTH_TIMEOUT_MS}ms\n--- output ---\n${output}`);
}

// /api/health alone boots fine even when SEA asset extraction is broken (isPackaged just falls
// back to env/dev defaults) — it would NOT have caught FLUX-1321 by itself. The portal SPA shell
// is only served once the embedded assets are extracted (see isSea branch in startServer(),
// engine/src/index.ts), so also asserting on it is the actual regression guard the ticket wants.
async function checkPortalServed() {
  const res = await fetch(`http://127.0.0.1:${PORT}/`, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (res.status !== 200) {
    throw new Error(`GET / returned ${res.status} — packaged portal assets were not served (SEA asset extraction likely broken)`);
  }
  const body = await res.text();
  if (!body.includes('id="root"')) {
    throw new Error(`GET / did not return the portal SPA shell — SEA asset extraction likely broken\n--- body ---\n${body}`);
  }
}

try {
  const health = await waitForHealth();
  console.log(`[smoke-test] /api/health OK: ${JSON.stringify(health)}`);
  await checkPortalServed();
  console.log('[smoke-test] GET / served the portal SPA shell OK');
  await cleanup(child);
  process.exit(0);
} catch (err) {
  await cleanup(child);
  fail(err instanceof Error ? err.message : String(err));
}
