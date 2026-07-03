import { log } from './log.js';
import { spawn, type ChildProcess } from 'child_process';
// FLUX-917: tree-kill the engine on hot-restart. The engine is spawned with `shell: isWin`, so a raw
// killProcessTree(child) hits cmd.exe and does NOT propagate to the tsx→node engine grandchild on
// Windows — the engine's gracefulShutdown (which reaps agent child trees) never runs, orphaning
// claude.exe/serena/context7 processes on every engine/src change (the leak #163 fixed elsewhere but
// missed on this path). killProcessTree taskkill /F /T's the whole tree on win32; on POSIX it stays
// a graceful SIGTERM to the (non-shell) child, so the engine still runs its own handler there.
import { killProcessTree } from './kill-process-tree.js';
import path from 'path';
import { fileURLToPath } from 'url';
import { readFileSync } from 'fs';
import { createHash } from 'crypto';

const __dir = path.dirname(fileURLToPath(import.meta.url));
const ENGINE_ENTRY = path.join(__dir, 'index.ts');

const args = process.argv.slice(2);
let child: ChildProcess | null = null;
let restartPending = false;
let debounceTimer: ReturnType<typeof setTimeout> | null = null;

const isWin = process.platform === 'win32';

function spawnEngine() {
  child = spawn('tsx', [ENGINE_ENTRY, ...args], {
    stdio: 'inherit',
    shell: isWin,
  });

  child.on('exit', (code) => {
    child = null;
    if (restartPending) {
      restartPending = false;
      log.info('[dev-watcher] Restarting engine...');
      spawnEngine();
    } else if (code !== null && code !== 0) {
      console.error(`[dev-watcher] Engine exited with code ${code}, restarting in 1s...`);
      setTimeout(spawnEngine, 1000);
    } else {
      process.exit(0);
    }
  });
}

// ─── FLUX-988: content-hash gate ────────────────────────────────────────────────
// chokidar fires on mtime, not content. A `git checkout` / `git switch` / `git merge --abort` in
// the checkout rewrites tracked files with IDENTICAL content but a fresh mtime — indistinguishable
// from a real edit to a plain mtime watcher. Left unguarded, ordinary git operations bounce the
// engine and wipe every running agent session (the recurring "Session abandoned (engine restarted)"
// incident). We keep a last-seen content hash per file and skip any event whose bytes did not
// actually change. The baseline is seeded from chokidar's initial scan (see startWatcher) so the
// FIRST real edit after startup is never mistaken for a no-op.
const contentHashes = new Map<string, string>();

function hashFile(file: string): string | null {
  try {
    return createHash('sha1').update(readFileSync(file)).digest('hex');
  } catch {
    return null; // unreadable (mid-write / just deleted) — caller treats as "changed"
  }
}

// True when `file`'s content genuinely differs from the last time we saw it (and updates the
// baseline). A null hash (unreadable) counts as changed so a real edit that raced the read is
// never swallowed.
function contentChanged(file: string): boolean {
  const h = hashFile(file);
  if (h === null) { contentHashes.delete(file); return true; }
  if (contentHashes.get(file) === h) return false;
  contentHashes.set(file, h);
  return true;
}

// ─── FLUX-988: fail-SAFE engine-state probe ─────────────────────────────────────
// Tri-state, sourced from the authoritative /api/board/state (getAllActiveSessions — counts
// per-ticket AND board/orchestrator/delegate/group sessions, unlike the old per-ticket /api/tasks
// cliSession scan which could miss a supervisor session entirely). Only 'idle' is a POSITIVE
// confirmation that nothing is running. Any failure to read the engine (down, restarting, non-OK,
// throw) is 'unknown' — NEVER "safe to kill." The old check returned false (== treat as idle) on
// every uncertainty path, so a momentarily-unreachable engine (normal right around a restart or
// under load) had its live sessions taskkill'd.
type EngineState = 'idle' | 'active' | 'unknown';

async function getEngineState(): Promise<EngineState> {
  try {
    const res = await fetch('http://localhost:3067/api/board/state');
    if (!res.ok) return 'unknown';
    const body = await res.json() as { activeSessions?: unknown[] };
    const count = Array.isArray(body.activeSessions) ? body.activeSessions.length : 0;
    return count > 0 ? 'active' : 'idle';
  } catch {
    return 'unknown';
  }
}

async function notifyRestartPending() {
  try {
    await fetch('http://localhost:3067/api/events/restart-pending', { method: 'POST' });
  } catch {}
}

async function handleFileChange(file: string, event: 'add' | 'change' | 'unlink') {
  // FLUX-988: skip no-op churn. A deletion is always a real change; an add/change must actually
  // alter the file's bytes to count (this is what defeats git-checkout/merge mtime churn).
  if (event === 'unlink') {
    contentHashes.delete(file);
  } else if (!contentChanged(file)) {
    return;
  }

  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(async () => {
    const state = await getEngineState();
    if (state === 'idle') {
      // POSITIVELY confirmed nothing is running — safe to restart immediately.
      log.info('[dev-watcher] No active sessions, restarting immediately.');
      restartPending = true;
      if (child) {
        killProcessTree(child);
      } else {
        spawnEngine();
      }
    } else {
      // FLUX-988: 'active' OR 'unknown' → NEVER hard-kill. Defer to the engine's graceful drain
      // (restart-pending → the engine auto-restarts once its sessions end). Treating 'unknown'
      // (engine unreachable) as active is deliberate: a deferred or manual restart is always
      // preferable to wiping a live session we simply could not see.
      const why = state === 'active'
        ? 'active session(s) running'
        : 'engine state unknown (unreachable) — assuming active';
      log.info(`[dev-watcher] Restart deferred — ${why}. It will restart when sessions end (or restart 'npm run dev' manually).`);
      restartPending = true;
      await notifyRestartPending();
    }
  }, 300);
}

async function startWatcher() {
  const { watch } = await import('chokidar');
  // FLUX-988: ignoreInitial:false so chokidar's initial scan seeds the content-hash baseline BEFORE
  // we act on any event — otherwise the first git-checkout churn after startup has no baseline to
  // compare against and would look like a real edit. Events are swallowed until 'ready' (hashes
  // recorded only), then handled normally.
  const watcher = watch(path.join(__dir, '**/*.ts'), {
    ignored: [/node_modules/, /\.git/, /dev-watcher\.ts$/],
    ignoreInitial: false,
  });

  let ready = false;
  watcher.on('add', (p) => {
    if (!ready) { const h = hashFile(p); if (h) contentHashes.set(p, h); return; }
    void handleFileChange(p, 'add');
  });
  watcher.on('change', (p) => { if (ready) void handleFileChange(p, 'change'); });
  watcher.on('unlink', (p) => { if (ready) void handleFileChange(p, 'unlink'); });
  watcher.on('ready', () => {
    ready = true;
    log.info('[dev-watcher] Watching engine/src for changes...');
  });

  spawnEngine();
}

process.on('SIGINT', () => {
  if (child) killProcessTree(child);
  process.exit(0);
});
process.on('SIGTERM', () => {
  if (child) killProcessTree(child);
  process.exit(0);
});

startWatcher();
