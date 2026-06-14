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

import { spawn, type ChildProcess } from 'child_process';
import net from 'net';
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

const servers = new Map<string, SharedServer>();
const inflight = new Map<string, Promise<SharedServer | null>>();

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

/** URL of the ready shared server for a module, or null if not running. */
export function getSharedServerUrl(moduleId: string): string | null {
  const s = servers.get(moduleId);
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

  const existing = servers.get(m.id);
  if (existing && existing.projectPath === projectPath && await isPortListening(existing.port)) {
    return existing;
  }
  if (existing) { killTree(existing.child); servers.delete(m.id); }

  const pending = inflight.get(m.id);
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
      const cur = servers.get(m.id);
      if (cur && cur.child === child) servers.delete(m.id);
    });

    const deadline = Date.now() + HANDSHAKE_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (await mcpHandshakeOk(port)) {
        const url = `http://127.0.0.1:${port}/mcp`;
        const record: SharedServer = { moduleId: m.id, port, url, child, projectPath };
        servers.set(m.id, record);
        console.log(`[shared-mcp] "${m.id}" ready at ${url} (project: ${projectPath})`);
        return record;
      }
      await new Promise(r => setTimeout(r, HANDSHAKE_POLL_MS));
    }
    console.warn(`[shared-mcp] "${m.id}" did not answer an MCP handshake within ${HANDSHAKE_TIMEOUT_MS}ms — killing`);
    killTree(child);
    return null;
  })();

  inflight.set(m.id, startPromise);
  try { return await startPromise; } finally { inflight.delete(m.id); }
}

/** Kill every managed shared server. Call on engine shutdown. */
export function shutdownSharedServers(): void {
  for (const s of servers.values()) killTree(s.child);
  servers.clear();
}
