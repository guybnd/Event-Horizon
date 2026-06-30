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

async function hasActiveSessions(): Promise<boolean> {
  try {
    const res = await fetch('http://localhost:3067/api/health');
    if (!res.ok) return false;
    const tasks = await fetch('http://localhost:3067/api/tasks');
    if (!tasks.ok) return false;
    const list = await tasks.json() as Array<{ cliSession?: { status?: string } }>;
    return list.some(t =>
      t.cliSession && ['running', 'pending', 'waiting-input'].includes(t.cliSession.status || '')
    );
  } catch {
    return false;
  }
}

async function notifyRestartPending() {
  try {
    await fetch('http://localhost:3067/api/events/restart-pending', { method: 'POST' });
  } catch {}
}

async function handleFileChange() {
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(async () => {
    const active = await hasActiveSessions();
    if (!active) {
      log.info('[dev-watcher] No active sessions, restarting immediately.');
      restartPending = true;
      if (child) {
        killProcessTree(child);
      } else {
        spawnEngine();
      }
    } else {
      log.info('[dev-watcher] Active sessions detected — restart deferred.');
      restartPending = true;
      await notifyRestartPending();
    }
  }, 300);
}

async function startWatcher() {
  const { watch } = await import('chokidar');
  const watcher = watch(path.join(__dir, '**/*.ts'), {
    ignored: [/node_modules/, /\.git/, /dev-watcher\.ts$/],
    ignoreInitial: true,
  });

  watcher.on('change', () => { void handleFileChange(); });
  watcher.on('add', () => { void handleFileChange(); });
  watcher.on('unlink', () => { void handleFileChange(); });

  log.info('[dev-watcher] Watching engine/src for changes...');
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
