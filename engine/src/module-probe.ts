import { spawn } from 'child_process';
import { broadcastEvent } from './events.js';
import type { ConnectorInfo, ModuleDeclaration } from './modules.js';
import { resolveEnvVars } from './modules.js';
import { ensureSharedServer, isSharedHttpPlatformProven } from './shared-mcp-server.js';
import { getWorkspaceRoot } from './workspace.js';
import { refreshMcpServerTools } from './mcp-readonly.js';

export type ProbeStatus = 'ok' | 'error' | 'checking' | 'unknown';

export interface ProbeResult {
  status: ProbeStatus;
  message: string;
  checkedAt: string;
  /** FLUX-1656 (Connectors panel) fields — absent on a plain module probe result. */
  source?: 'module' | 'workspace';
  env?: { required: string[]; present: string[]; missing: string[] };
  /** HTTP-like status code surfaced by a failed `initialize` or declared `authProbe` call
   *  (e.g. 401), when the upstream reported one. */
  upstreamStatus?: number | undefined;
}

const probeStatuses = new Map<string, ProbeResult>();

export function getProbeStatus(id: string): ProbeResult {
  return probeStatuses.get(id) ?? { status: 'unknown', message: '', checkedAt: '' };
}

export function getAllProbeStatuses(): Record<string, ProbeResult> {
  return Object.fromEntries(probeStatuses.entries());
}

function broadcast(id: string, result: ProbeResult) {
  probeStatuses.set(id, result);
  broadcastEvent('module-status', { id, ...result });
}

export async function probeModule(m: ModuleDeclaration): Promise<ProbeResult> {
  if (!m.mcpServer && !m.sharedHttp) {
    const result: ProbeResult = { status: 'unknown', message: 'No MCP server defined', checkedAt: new Date().toISOString() };
    probeStatuses.set(m.id, result);
    return result;
  }

  // Shared-HTTP modules on a proven platform: start (or reuse) the single shared
  // server and report its health, instead of spawning a throwaway stdio stack.
  if (m.sharedHttp && isSharedHttpPlatformProven()) {
    broadcast(m.id, { status: 'checking', message: 'Starting shared HTTP server…', checkedAt: new Date().toISOString() });
    const workspaceRoot = getWorkspaceRoot();
    if (!workspaceRoot) {
      const result: ProbeResult = { status: 'error', message: 'No active workspace — cannot start shared server', checkedAt: new Date().toISOString() };
      broadcast(m.id, result);
      return result;
    }
    const srv = await ensureSharedServer(m, workspaceRoot);
    const result: ProbeResult = srv
      ? { status: 'ok', message: `Shared HTTP server ready at ${srv.url}`, checkedAt: new Date().toISOString() }
      : { status: 'error', message: 'Shared HTTP server failed to start', checkedAt: new Date().toISOString() };
    broadcast(m.id, result);
    return result;
  }

  if (!m.mcpServer) {
    const result: ProbeResult = { status: 'unknown', message: 'No stdio MCP server defined', checkedAt: new Date().toISOString() };
    probeStatuses.set(m.id, result);
    return result;
  }

  broadcast(m.id, { status: 'checking', message: 'Starting server process…', checkedAt: new Date().toISOString() });

  return new Promise((resolve) => {
    const isWin = process.platform === 'win32';
    let proc: ReturnType<typeof spawn>;
    try {
      proc = spawn(m.mcpServer!.command, m.mcpServer!.args, {
        stdio: 'pipe',
        shell: isWin,
        env: { ...process.env, ...m.mcpServer!.env },
        windowsHide: true,
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      const result: ProbeResult = { status: 'error', message: `Failed to spawn: ${message}`, checkedAt: new Date().toISOString() };
      broadcast(m.id, result);
      return resolve(result);
    }

    let stderr = '';
    let settled = false;

    const settle = (result: ProbeResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { proc.kill(); } catch {}
      broadcast(m.id, result);
      resolve(result);
    };

    proc.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString().slice(0, 500); });

    proc.on('error', (err) => {
      settle({ status: 'error', message: `Process error: ${err.message}`, checkedAt: new Date().toISOString() });
    });

    proc.on('exit', (code) => {
      if (settled) return;
      if (code === 0 || code === null) {
        // Exited cleanly — treat as ok (some servers do --version style exit)
        settle({ status: 'ok', message: 'Server process exited cleanly', checkedAt: new Date().toISOString() });
      } else {
        settle({ status: 'error', message: stderr.trim() || `Process exited with code ${code}`, checkedAt: new Date().toISOString() });
      }
    });

    // 5 second timeout — still running means server is up
    const timer = setTimeout(() => {
      settle({ status: 'ok', message: 'Server process started and is running', checkedAt: new Date().toISOString() });
    }, 5000);
  });
}

export async function probeAllEnabled(modules: ModuleDeclaration[]): Promise<void> {
  const enabled = modules.filter(m => m.enabled && (m.mcpServer || m.sharedHttp));
  await Promise.all(enabled.map(m => probeModule(m).catch(() => {})));
}

// ── Connectors (FLUX-1656) ──────────────────────────────────────────────────────────────────────
//
// A SEPARATE cache + SSE event from the module probe above (plan-review non-blocking note): the
// module id-space (`probeStatuses`) and the connector id-space overlap (a workspace `.mcp.json`
// server can share a bare name with a configured module), and `GET /modules/status` must never
// start returning connector rows. Connectors get their own map and their own `'connector-status'`
// broadcast so `ModulesSection.tsx`'s `module-status` listener never sees a connector id.

const connectorProbeStatuses = new Map<string, ProbeResult>();

export function getConnectorProbeStatus(id: string): ProbeResult {
  return connectorProbeStatuses.get(id) ?? { status: 'unknown', message: '', checkedAt: '' };
}

export function getAllConnectorProbeStatuses(): Record<string, ProbeResult> {
  return Object.fromEntries(connectorProbeStatuses.entries());
}

function broadcastConnector(id: string, result: ProbeResult): ProbeResult {
  connectorProbeStatuses.set(id, result);
  broadcastEvent('connector-status', { id, ...result });
  return result;
}

interface McpProbeOutcome {
  ok: boolean;
  upstreamStatus?: number | undefined;
  message: string;
}

const MCP_STDIO_PROBE_TIMEOUT_MS = 10_000;
const MCP_HTTP_PROBE_TIMEOUT_MS = 10_000;
const INITIALIZE_PARAMS = { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'event-horizon', version: '1.0' } };

/** Pull a 3-digit HTTP-like status (4xx/5xx) out of an error message / tool-result text, if one
 *  is present — the "upstream status code" the acceptance criteria call for (e.g. a 401). */
function extractUpstreamStatus(text: string | undefined): number | undefined {
  if (!text) return undefined;
  const m = text.match(/\b([45]\d{2})\b/);
  return m ? Number(m[1]) : undefined;
}

function textFromToolResult(result: { content?: Array<{ text?: string }> } | undefined): string {
  return (result?.content ?? []).map(c => c?.text).filter(Boolean).join(' ');
}

/**
 * Real MCP `initialize` handshake over stdio, optionally followed by ONE declared `authProbe` tool
 * call — unlike `probeModule`'s stdio path above (which only checks the process stays alive), this
 * speaks JSON-RPC so a bad auth token that the server rejects at (or just after) `initialize` is
 * caught, not just "process didn't crash". Every branch settles exactly once; the process is always
 * killed on settle so a hung/misbehaving server can't outlive the probe.
 */
function mcpStdioProbe(command: string, args: string[], env: Record<string, string> | undefined, authProbeTool: string | undefined): Promise<McpProbeOutcome> {
  return new Promise((resolve) => {
    const isWin = process.platform === 'win32';
    let proc: ReturnType<typeof spawn>;
    try {
      proc = spawn(command, args, { stdio: 'pipe', shell: isWin, env: { ...process.env, ...env }, windowsHide: true });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      resolve({ ok: false, message: `Failed to spawn: ${message}` });
      return;
    }

    let stdoutBuffer = '';
    let stderr = '';
    let settled = false;
    let step: 'initialize' | 'authProbe' = 'initialize';

    const settle = (outcome: McpProbeOutcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { proc.kill(); } catch { /* already gone */ }
      resolve(outcome);
    };

    const timer = setTimeout(() => {
      settle({ ok: false, message: stderr.trim() || 'MCP handshake timed out' });
    }, MCP_STDIO_PROBE_TIMEOUT_MS);

    proc.stderr?.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(0, 500); });
    proc.on('error', (err) => settle({ ok: false, message: `Process error: ${err.message}` }));
    proc.on('exit', (code) => {
      if (!settled) settle({ ok: false, message: stderr.trim() || `Process exited with code ${code}` });
    });

    proc.stdout?.on('data', (chunk: Buffer) => {
      stdoutBuffer += chunk.toString();
      let newlineIdx: number;
      while ((newlineIdx = stdoutBuffer.indexOf('\n')) !== -1) {
        const line = stdoutBuffer.slice(0, newlineIdx).trim();
        stdoutBuffer = stdoutBuffer.slice(newlineIdx + 1);
        if (!line) continue;
        let msg: { id?: number; error?: { message?: string }; result?: { isError?: boolean; content?: Array<{ text?: string }> } };
        try { msg = JSON.parse(line); } catch { continue; }

        if (step === 'initialize' && msg.id === 1) {
          if (msg.error) {
            settle({ ok: false, upstreamStatus: extractUpstreamStatus(msg.error.message), message: msg.error.message || 'initialize failed' });
            return;
          }
          if (!authProbeTool) {
            settle({ ok: true, message: 'MCP initialize handshake succeeded' });
            return;
          }
          step = 'authProbe';
          proc.stdin?.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: authProbeTool, arguments: {} } })}\n`);
        } else if (step === 'authProbe' && msg.id === 2) {
          if (msg.error) {
            settle({ ok: false, upstreamStatus: extractUpstreamStatus(msg.error.message), message: msg.error.message || `${authProbeTool} failed` });
            return;
          }
          if (msg.result?.isError) {
            const text = textFromToolResult(msg.result);
            settle({ ok: false, upstreamStatus: extractUpstreamStatus(text), message: text || `${authProbeTool} returned an error` });
            return;
          }
          settle({ ok: true, message: `MCP initialize + ${authProbeTool} succeeded` });
        }
      }
    });

    proc.stdin?.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: INITIALIZE_PARAMS })}\n`);
  });
}

/** Same `initialize` (+ optional declared `authProbe`) handshake as `mcpStdioProbe`, but over a
 *  streamable-http endpoint — covers both a workspace `.mcp.json` remote-http server and an
 *  engine-managed shared-http server (whose URL comes from `ensureSharedServer`). */
async function mcpHttpProbe(url: string, authProbeTool: string | undefined): Promise<McpProbeOutcome> {
  const post = (body: unknown) => fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(MCP_HTTP_PROBE_TIMEOUT_MS),
  });

  try {
    const initRes = await post({ jsonrpc: '2.0', id: 1, method: 'initialize', params: INITIALIZE_PARAMS });
    if (!initRes.ok) {
      return { ok: false, upstreamStatus: initRes.status, message: `initialize failed with HTTP ${initRes.status}` };
    }
    if (!authProbeTool) return { ok: true, message: 'MCP initialize handshake succeeded' };

    const callRes = await post({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: authProbeTool, arguments: {} } });
    if (!callRes.ok) {
      return { ok: false, upstreamStatus: callRes.status, message: `${authProbeTool} failed with HTTP ${callRes.status}` };
    }
    const body = await callRes.json().catch(() => null) as { result?: { isError?: boolean; content?: Array<{ text?: string }> }; error?: { message?: string } } | null;
    if (body?.error) {
      return { ok: false, upstreamStatus: extractUpstreamStatus(body.error.message), message: body.error.message || `${authProbeTool} failed` };
    }
    if (body?.result?.isError) {
      const text = textFromToolResult(body.result);
      return { ok: false, upstreamStatus: extractUpstreamStatus(text), message: text || `${authProbeTool} returned an error` };
    }
    return { ok: true, message: `MCP initialize + ${authProbeTool} succeeded` };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, message: `HTTP probe failed: ${message}` };
  }
}

/**
 * Probe one connector's env presence + live auth. The restart-hint rule lives HERE and only here
 * (FLUX-1656 impl step 3): any required env var absent from the ENGINE's own `process.env` — the
 * exact env agent sessions inherit — short-circuits to red with the restart hint, before ever
 * spawning/connecting, since a missing var makes any auth outcome moot. Never logs or returns a
 * var's VALUE, only its name and presence.
 */
export async function probeConnector(c: ConnectorInfo): Promise<ProbeResult> {
  // FLUX-1657: warm the mcp-readonly.ts tool-name cache alongside the connectivity probe — the read-
  // only deny-list needs a connector's real tool names, and this Test-button probe is the natural
  // refresh point (never on a session-spawn path). Fire-and-forget: never blocks or changes this
  // function's own connectivity result, and a probe failure just leaves the cache as a miss (fail
  // open at the deny-list layer, see mcp-readonly.ts).
  refreshMcpServerTools(c).catch(() => {});

  const required = c.requiredEnv;
  const missing = required.filter(name => !process.env[name]);
  const present = required.filter(name => Boolean(process.env[name]));
  const env = { required, present, missing };

  if (missing.length > 0) {
    return broadcastConnector(c.id, {
      status: 'error',
      message: `Missing required env var${missing.length > 1 ? 's' : ''}: ${missing.join(', ')}. Required vars not present in the engine process — if you set them after starting the engine, restart it to pick up new env vars.`,
      checkedAt: new Date().toISOString(),
      source: c.source,
      env,
    });
  }

  broadcastConnector(c.id, { status: 'checking', message: 'Probing connection…', checkedAt: new Date().toISOString(), source: c.source, env });

  let outcome: McpProbeOutcome;
  if (c.sharedHttp && isSharedHttpPlatformProven()) {
    const workspaceRoot = getWorkspaceRoot();
    if (!workspaceRoot) {
      outcome = { ok: false, message: 'No active workspace — cannot start shared server' };
    } else {
      // ensureSharedServer only reads `id`/`sharedHttp` off its ModuleDeclaration param — build the
      // minimal shape rather than casting ConnectorInfo (which lacks `description`/`enabled`).
      const moduleDecl: ModuleDeclaration = { id: c.id, name: c.name, description: '', enabled: true, sharedHttp: c.sharedHttp };
      const srv = await ensureSharedServer(moduleDecl, workspaceRoot);
      outcome = srv ? await mcpHttpProbe(srv.url, c.authProbe) : { ok: false, message: 'Shared HTTP server failed to start' };
    }
  } else if (c.mcpServer) {
    // Resolve `${VAR}` placeholders against the engine's own process.env before spawning — same
    // idiom as getModuleMcpServers/resolveEnvVars in modules.ts. Without this, a passthrough env
    // declaration like mem0's `{ MEM0_API_KEY: '${MEM0_API_KEY}' }` reaches the child process as the
    // literal unresolved string (spread last over `...process.env`), so a correctly-configured
    // connector always fails auth (plan-review blocker, FLUX-1656).
    const resolvedEnv = c.mcpServer.env
      ? resolveEnvVars(c.mcpServer.env, processEnvVars())
      : undefined;
    outcome = await mcpStdioProbe(c.mcpServer.command, c.mcpServer.args, resolvedEnv, c.authProbe);
  } else if (c.url) {
    outcome = await mcpHttpProbe(c.url, c.authProbe);
  } else {
    outcome = { ok: false, message: 'No MCP server defined' };
  }

  return broadcastConnector(c.id, {
    status: outcome.ok ? 'ok' : 'error',
    message: redactSecrets(outcome.message, present),
    checkedAt: new Date().toISOString(),
    source: c.source,
    env,
    upstreamStatus: outcome.upstreamStatus,
  });
}

/** `process.env` narrowed to defined string values, for use as a `resolveEnvVars` vars map. */
function processEnvVars(): Record<string, string> {
  return Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined));
}

/** Scrub any required env var's REAL value out of a probe message before it's cached/broadcast —
 *  a crashing/verbose child process (stdio stderr) or a failed fetch (HTTP error message, which can
 *  embed a query-string credential) can otherwise echo a secret back into `message`, which flows to
 *  the REST endpoint, the `connector-status` SSE broadcast, and the mirrored `eh-event` log. Never
 *  shown/logged and violates the feature's stated invariant otherwise (plan-review finding). */
function redactSecrets(message: string, presentEnvNames: string[]): string {
  let result = message;
  for (const name of presentEnvNames) {
    const value = process.env[name];
    if (value && value.length > 0) {
      result = result.split(value).join('[REDACTED]');
    }
  }
  // A failed fetch's error message can embed the full request URL, including a query-string
  // credential (e.g. `?api_key=...`) for a remote MCP HTTP connector — strip query strings from
  // any URL that made it into the message, independent of the named-env-var scrub above.
  result = result.replace(/(https?:\/\/[^\s?]+)\?[^\s]*/g, '$1');
  return result;
}

export async function probeAllConnectors(connectors: ConnectorInfo[]): Promise<void> {
  await Promise.all(connectors.map(c => probeConnector(c).catch(() => {})));
}
