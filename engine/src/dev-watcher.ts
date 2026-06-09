import { spawn, execSync, type ChildProcess } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __dir = path.dirname(fileURLToPath(import.meta.url));
const ENGINE_ENTRY = path.join(__dir, 'index.ts');

const args = process.argv.slice(2);
let child: ChildProcess | null = null;
let restartPending = false;
let debounceTimer: ReturnType<typeof setTimeout> | null = null;

const isWin = process.platform === 'win32';
const PORTAL_PORT = 5167;

function killPort(port: number): void {
  try {
    if (isWin) {
      const output = execSync(`netstat -ano | findstr ":${port}" | findstr "LISTENING"`, { encoding: 'utf-8' });
      const pids = new Set(
        output.split('\n')
          .map(line => line.trim().split(/\s+/).pop())
          .filter((pid): pid is string => !!pid && /^\d+$/.test(pid))
      );
      for (const pid of pids) {
        try { execSync(`taskkill /F /PID ${pid}`, { stdio: 'ignore' }); } catch {}
      }
    } else {
      execSync(`lsof -ti:${port} | xargs -r kill -9`, { stdio: 'ignore' });
    }
  } catch {}
}

function spawnEngine() {
  child = spawn('tsx', [ENGINE_ENTRY, ...args], {
    stdio: 'inherit',
    shell: isWin,
  });

  child.on('exit', (code) => {
    child = null;
    if (restartPending) {
      restartPending = false;
      console.log('[dev-watcher] Restarting engine...');
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
      console.log('[dev-watcher] No active sessions, restarting immediately.');
      restartPending = true;
      if (child) {
        child.kill('SIGTERM');
      } else {
        spawnEngine();
      }
    } else {
      console.log('[dev-watcher] Active sessions detected — restart deferred.');
      restartPending = true;
      await notifyRestartPending();
    }
  }, 300);
}

async function startWatcher() {
  killPort(PORTAL_PORT);

  const { watch } = await import('chokidar');
  const watcher = watch(path.join(__dir, '**/*.ts'), {
    ignored: [/node_modules/, /\.git/, /dev-watcher\.ts$/],
    ignoreInitial: true,
  });

  watcher.on('change', () => { void handleFileChange(); });
  watcher.on('add', () => { void handleFileChange(); });
  watcher.on('unlink', () => { void handleFileChange(); });

  console.log('[dev-watcher] Watching engine/src for changes...');
  spawnEngine();
}

process.on('SIGINT', () => {
  if (child) child.kill('SIGTERM');
  process.exit(0);
});
process.on('SIGTERM', () => {
  if (child) child.kill('SIGTERM');
  process.exit(0);
});

startWatcher();
