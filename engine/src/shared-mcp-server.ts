// Engine-managed shared MCP servers.
//
// Some MCP servers (notably Serena, which boots a full language-server stack) are
// expensive to spawn one-per-client. When a module opts in via `sharedHttp`, the
// engine runs ONE streamable-http server per project and hands every agent session
// the same `http://127.0.0.1:<port>/mcp` URL, instead of each session stdio-spawning
// its own stack. See FLUX-495.
//
// Rollout is platform-gated: enabled by default on platforms we have proven
// (currently Windows). Elsewhere `ensureSharedServer` returns null and callers fall
// back to the module's per-session stdio `mcpServer`.

import { log } from './log.js';
import { spawn, type ChildProcess } from 'child_process';
import net from 'net';
import path from 'path';
import type { ModuleDeclaration } from './modules.js';

// Platforms where the shared HTTP server is proven and on by default.
const PROVEN_PLATFORMS = new Set<NodeJS.Platform>(['win32']);

// Escape hatch: set EVENT_HORIZON_SHARED_MCP=0 to force per-session stdio everywhere.
export function isSharedHttpPlatformProven(): boolean {
  if (process.env.EVENT_HORIZON_SHARED_MCP === '0') return false;
  return PROVEN_PLATFORMS.has(process.platform);
}

const PORT_SCAN_START = 9200;
const PORT_SCAN_END = 9299;
const HANDSHAKE_TIMEOUT_MS = 45_000;
const HANDSHAKE_POLL_MS = 1_000;

interface SharedServer {
  moduleId: string;
  port: number;
  url: string;
  child: ChildProcess;
  projectPath: string;
}

// FLUX-579: maps are keyed by `${moduleId}::${canonicalProjectPath}`, NOT by
// module id alone. With worktree-isolated sessions the default, two sessions in
// DIFFERENT worktrees that both want e.g. Serena would otherwise collide on the
// same `m.id` key — one would kill/respawn the other's server and resolve symbols
// against the wrong tree. A composite (module, worktree) key gives each its own
// server; eviction touches only its own key, never a sibling worktree's server.
const servers = new Map<string, SharedServer>();
const inflight = new Map<string, Promise<SharedServer | null>>();

/**
 * Canonicalize a project path so the SAME tree always produces the SAME key
 * regardless of casing / separators (Windows paths arrive both as short 8.3 /
 * differently-cased config roots and as long real-cased `git worktree list`
 * output). Resolve + normalize, and lowercase on win32 (case-insensitive FS).
 */
function canonicalProjectPath(projectPath: string): string {
  const resolved = path.resolve(projectPath);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

/** Composite map key for one (module, worktree/project) pair — FLUX-579. */
export function serverKey(moduleId: string, projectPath: string): string {
  return `${moduleId}::${canonicalProjectPath(projectPath)}`;
}

function isPortListening(port: number, host = '127.0.0.1'): Promise<boolean> {
  return new Promise(resolve => {
    const sock = net.connect({ port, host });
    let settled = false;
    const done = (v: boolean) => { if (settled) return; settled = true; sock.destroy(); resolve(v); };
    sock.once('connect', () => done(true));
    sock.once('error', () => done(false));
    sock.setTimeout(1000, () => done(false));
  });
}

async function findFreePort(): Promise<number | null> {
  for (let p = PORT_SCAN_START; p <= PORT_SCAN_END; p++) {
    if (!(await isPortListening(p))) return p;
  }
  return null;
}

// A successful MCP `initialize` over streamable-http returns HTTP 200.
async function mcpHandshakeOk(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'initialize',
        params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'event-horizon', version: '1.0' } },
      }),
    });
    return res.status === 200;
  } catch {
    return false;
  }
}

export function substituteArgs(args: string[], vars: Record<string, string>): string[] {
  return args.map(a => a.replace(/\$\{(\w+)\}/g, (_, k) => vars[k] ?? `\${${k}}`));
}

function killTree(child: ChildProcess): void {
  if (process.platform === 'win32' && child.pid) {
    // serena is launched via the shell on Windows; kill the whole tree.
    try { spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' }); return; } catch { /* fall through */ }
  }
  try { child.kill(); } catch { /* already gone */ }
}

/**
 * URL of the ready shared server for a module IN a given project/worktree, or
 * null if not running. The (module, worktree) pair is the key (FLUX-579) — a
 * server started for the workspace root does NOT satisfy a worktree session.
 */
export function getSharedServerUrl(moduleId: string, projectPath: string): string | null {
  if (!projectPath) return null;
  const s = servers.get(serverKey(moduleId, projectPath));
  return s ? s.url : null;
}

/**
 * Ensure a shared HTTP server is running for `m` pinned to `projectPath`.
 * Idempotent: reuses a healthy existing server; coalesces concurrent callers.
 * Returns null (caller should fall back to stdio) when the module hasn't opted
 * in, the platform isn't proven, no port is free, or the server never answered.
 */
export async function ensureSharedServer(m: ModuleDeclaration, projectPath: string): Promise<SharedServer | null> {
  if (!m.sharedHttp || !isSharedHttpPlatformProven() || !projectPath) return null;

  // FLUX-579: key by (module, worktree). A server for a DIFFERENT worktree lives
  // under a different key and is left untouched — only this pair's entry is
  // reused or evicted here.
  const key = serverKey(m.id, projectPath);

  const existing = servers.get(key);
  if (existing && await isPortListening(existing.port)) {
    return existing;
  }
  if (existing) { killTree(existing.child); servers.delete(key); }

  const pending = inflight.get(key);
  if (pending) return pending;

  const startPromise = (async (): Promise<SharedServer | null> => {
    const port = await findFreePort();
    if (port == null) {
      console.warn(`[shared-mcp] no free port for "${m.id}" in ${PORT_SCAN_START}-${PORT_SCAN_END}`);
      return null;
    }
    const isWin = process.platform === 'win32';
    const args = substituteArgs(m.sharedHttp!.args, { PROJECT: projectPath, PORT: String(port) });
    let child: ChildProcess;
    try {
      child = spawn(m.sharedHttp!.command, args, {
        stdio: 'ignore',
        shell: isWin,
        windowsHide: true,
        env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
      });
    } catch (err: any) {
      console.warn(`[shared-mcp] failed to spawn "${m.id}": ${err?.message ?? err}`);
      return null;
    }
    child.on('exit', () => {
      const cur = servers.get(key);
      if (cur && cur.child === child) servers.delete(key);
    });

    const deadline = Date.now() + HANDSHAKE_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (await mcpHandshakeOk(port)) {
        const url = `http://127.0.0.1:${port}/mcp`;
        const record: SharedServer = { moduleId: m.id, port, url, child, projectPath };
        servers.set(key, record);
        log.info(`[shared-mcp] "${m.id}" ready at ${url} (project: ${projectPath})`);
        return record;
      }
      await new Promise(r => setTimeout(r, HANDSHAKE_POLL_MS));
    }
    console.warn(`[shared-mcp] "${m.id}" did not answer an MCP handshake within ${HANDSHAKE_TIMEOUT_MS}ms — killing`);
    killTree(child);
    return null;
  })();

  inflight.set(key, startPromise);
  try { return await startPromise; } finally { inflight.delete(key); }
}

/** Kill every managed shared server. Call on engine shutdown. */
export function shutdownSharedServers(): void {
  for (const s of servers.values()) killTree(s.child);
  servers.clear();
}

/**
 * Evict (and kill) every shared server pinned to `projectPath` — across ALL
 * modules — and return how many were torn down. Call when a worktree is removed
 * so its per-worktree servers (Serena et al.) don't linger pointing at a tree
 * that no longer exists (FLUX-579). Matched by the same canonicalization the key
 * uses, so a differently-cased / 8.3 path still resolves. Best-effort and safe
 * to call for the workspace root or an unknown path (no-op when nothing matches).
 */
export function evictSharedServersForPath(projectPath: string): number {
  if (!projectPath) return 0;
  const canon = canonicalProjectPath(projectPath);
  let evicted = 0;
  for (const [key, s] of servers) {
    if (canonicalProjectPath(s.projectPath) === canon) {
      killTree(s.child);
      servers.delete(key);
      inflight.delete(key);
      evicted++;
    }
  }
  return evicted;
}
