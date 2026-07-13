import { EventEmitter } from 'events';
import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { getWorkspaceRoot } from './workspace.js';

/**
 * FLUX-1030: on macOS/Linux, node-pty spawns via a bundled `spawn-helper` binary that it `exec`s.
 * The prebuilt `spawn-helper` shipped in `node-pty/prebuilds/<platform>-<arch>/` can land on disk
 * WITHOUT its executable bit (some install/vendoring paths strip it) — and when it's not +x, every
 * `pty.spawn` fails with a bare `posix_spawnp failed.` and the terminal silently no-ops. Restore the
 * bit here, mirroring node-pty's own resolution order (build dirs first, then the prebuild), so a
 * fresh clone / reinstall self-heals on first use. No-op on Windows (uses conpty, no helper).
 */
function ensureSpawnHelperExecutable(): void {
  if (process.platform === 'win32') return;
  try {
    // esbuild's cjs bundle has no `import.meta.url` (see packaged-mode.ts), so
    // `createRequire(import.meta.url)` throws there — prefer the bundle's real ambient
    // `require` and only fall back for the ESM dev (tsx) path. (FLUX-1321)
    const nodeRequire: NodeJS.Require =
      typeof require === 'function' ? require : createRequire(import.meta.url);
    const pkgRoot = path.dirname(nodeRequire.resolve('node-pty/package.json'));
    const candidates = [
      'build/Release/spawn-helper',
      'build/Debug/spawn-helper',
      `prebuilds/${process.platform}-${process.arch}/spawn-helper`,
    ];
    for (const rel of candidates) {
      const helper = path.join(pkgRoot, rel);
      let stat: fs.Stats;
      try { stat = fs.statSync(helper); } catch { continue; }
      // Already executable by the owner? Leave it alone.
      if (stat.mode & 0o100) continue;
      fs.chmodSync(helper, 0o755);
    }
  } catch {
    // Best-effort — if resolution/chmod fails, spawn will surface the real error to the route below.
  }
}

// Dynamic import to avoid build issues with native addon
let pty: typeof import('node-pty') | null = null;
async function getPty() {
  if (!pty) {
    ensureSpawnHelperExecutable();
    pty = await import('node-pty');
  }
  return pty;
}

export interface TerminalSession {
  id: string;
  pty: import('node-pty').IPty | null;
  status: 'running' | 'exited';
  scrollbackBuffer: string[];
  cols: number;
  rows: number;
  cwd: string;
  createdAt: string;
  title: string;
}

const MAX_SCROLLBACK = 5000;

const sessions = new Map<string, TerminalSession>();

/** Per-session EventEmitter for pushing pty data to WS transport. */
const sessionEmitters = new Map<string, EventEmitter>();

export function getSessionEmitter(id: string): EventEmitter | undefined {
  return sessionEmitters.get(id);
}

export async function createTerminalSession(
  cols = 80,
  rows = 24,
  title = 'Terminal',
): Promise<TerminalSession> {
  const nodePty = await getPty();
  const id = crypto.randomUUID();
  // FLUX-1404: platform-gate the shell choice. On win32, SHELL is unset (or worse, a POSIX
  // path like /usr/bin/bash when launched from Git Bash) and os.userInfo().shell is null, so
  // the Unix fallback chain used to hand ConPTY '/bin/bash' → "File not found" on every spawn.
  const shell =
    process.platform === 'win32'
      ? process.env.ComSpec || 'powershell.exe'
      : process.env.SHELL || os.userInfo().shell || '/bin/bash';
  const cwd = getWorkspaceRoot() || process.cwd();

  const ptyProcess = nodePty.spawn(shell, [], {
    name: 'xterm-256color',
    cols,
    rows,
    cwd,
    env: process.env as Record<string, string>,
  });

  const session: TerminalSession = {
    id,
    pty: ptyProcess,
    status: 'running',
    scrollbackBuffer: [],
    cols,
    rows,
    cwd,
    createdAt: new Date().toISOString(),
    title,
  };

  const emitter = new EventEmitter();
  // Each WS client registers 2 listeners (data + exit). Raise the cap so
  // Node doesn't emit MaxListenersExceededWarning with more than 5 clients.
  emitter.setMaxListeners(64);
  sessionEmitters.set(id, emitter);

  ptyProcess.onData((data: string) => {
    // Append to scrollback (split by newlines, keep last MAX_SCROLLBACK lines)
    const incoming = data.split('\n');
    if (session.scrollbackBuffer.length > 0 && incoming.length > 0) {
      // Append to last line
      session.scrollbackBuffer[session.scrollbackBuffer.length - 1] += incoming.shift() || '';
    }
    session.scrollbackBuffer.push(...incoming);
    // splice(0, excess) shifts all remaining elements — O(MAX_SCROLLBACK) every write
    // once the buffer is full. slice(-N) allocates a fresh compact array instead.
    if (session.scrollbackBuffer.length > MAX_SCROLLBACK) {
      session.scrollbackBuffer = session.scrollbackBuffer.slice(-MAX_SCROLLBACK);
    }
    emitter.emit('data', data);
  });

  ptyProcess.onExit(({ exitCode }: { exitCode: number; signal?: number }) => {
    session.status = 'exited';
    session.pty = null;
    emitter.emit('exit', exitCode);
  });

  sessions.set(id, session);
  return session;
}

export function getTerminalSession(id: string): TerminalSession | undefined {
  return sessions.get(id);
}

export function listTerminalSessions(): TerminalSession[] {
  return [...sessions.values()];
}

/** Send SIGTERM to the PTY process without removing the session from the store.
 *  The pty.onExit handler fires normally and transitions status → 'exited'. */
export function killTerminalSession(id: string): void {
  const session = sessions.get(id);
  if (!session || !session.pty || session.status !== 'running') return;
  try { session.pty.kill('SIGTERM'); } catch {}
}

export function destroyTerminalSession(id: string): void {
  const session = sessions.get(id);
  if (!session) return;
  if (session.pty) {
    try { session.pty.kill(); } catch {}
  }
  session.status = 'exited';
  session.pty = null;
  sessions.delete(id);
  sessionEmitters.delete(id);
}

export function destroyAllTerminalSessions(): void {
  for (const id of sessions.keys()) {
    destroyTerminalSession(id);
  }
}

/** Called on engine boot — no live PTYs survive a restart; just clear the in-memory map. */
export function reconcileOrphanedTerminalSessions(): void {
  // Since sessions are purely in-memory (no persistence), there is nothing to reconcile.
  // If we had persisted sessions, we'd mark them 'exited' here.
  sessions.clear();
  sessionEmitters.clear();
}
