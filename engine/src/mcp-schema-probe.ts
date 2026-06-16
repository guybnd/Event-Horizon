import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { getModuleMcpServers, getWorkspaceMcpServers } from './modules.js';
import { workspaceRoot } from './workspace.js';

function measure(value: unknown): { bytes: number; tokensEst: number } {
  const json = typeof value === 'string' ? value : JSON.stringify(value ?? null);
  return { bytes: Buffer.byteLength(json ?? '', 'utf8'), tokensEst: Math.ceil((json ?? '').length / 4) };
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)),
  ]);
}

export interface McpServerSchemaMetrics {
  id: string;
  source: string;
  ok: boolean;
  error?: string;
  toolCount: number;
  toolsBytes: number;
  toolsTokensEst: number;
  instructionsBytes: number;
  instructionsTokensEst: number;
  totalBytes: number;
  totalTokensEst: number;
  tools: Array<{ name: string; bytes: number; tokensEst: number }>;
}

export interface McpSchemaReport {
  servers: McpServerSchemaMetrics[];
  totalTokensEst: number;
  note: string;
}

function makeTransport(config: any) {
  const type = config.type || (config.url ? 'http' : 'stdio');
  if (type === 'http' || type === 'streamable-http') {
    return new StreamableHTTPClientTransport(new URL(config.url));
  }
  if (type === 'sse') {
    return new SSEClientTransport(new URL(config.url));
  }
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
  Object.assign(env, config.env ?? {});
  return new StdioClientTransport({
    command: config.command,
    args: config.args ?? [],
    env,
    cwd: workspaceRoot || process.cwd(),
    stderr: 'ignore',
  });
}

/**
 * Spawns/connects one MCP server, performs the handshake, lists its tools, and
 * measures the serialized schema (name + description + inputSchema) per tool
 * plus the server's `instructions` block — i.e. the full per-server context cost
 * an agent pays for having the server connected. Supports stdio + http + sse.
 * The connection is always torn down; failures resolve to `ok: false`.
 */
export async function probeMcpServer(
  id: string,
  config: any,
  timeoutMs = 20000,
  source = 'unknown',
): Promise<McpServerSchemaMetrics> {
  const empty: McpServerSchemaMetrics = {
    id, source, ok: false, toolCount: 0,
    toolsBytes: 0, toolsTokensEst: 0, instructionsBytes: 0, instructionsTokensEst: 0,
    totalBytes: 0, totalTokensEst: 0, tools: [],
  };

  let transport: any;
  try {
    transport = makeTransport(config);
  } catch (err: any) {
    return { ...empty, error: err?.message || 'bad server config' };
  }
  const client = new Client({ name: 'eh-schema-probe', version: '1.0.0' }, { capabilities: {} });

  try {
    await withTimeout(client.connect(transport), timeoutMs, `connect(${id})`);
    const res = await withTimeout(client.listTools(), timeoutMs, `listTools(${id})`);
    const tools = (res.tools ?? [])
      .map((t: any) => {
        const m = measure({ name: t.name, description: t.description, inputSchema: t.inputSchema });
        return { name: t.name, bytes: m.bytes, tokensEst: m.tokensEst };
      })
      .sort((a, b) => b.bytes - a.bytes);
    const toolsBytes = tools.reduce((s, t) => s + t.bytes, 0);
    const toolsTokensEst = tools.reduce((s, t) => s + t.tokensEst, 0);

    const instr = measure(client.getInstructions());

    return {
      id, source, ok: true, toolCount: tools.length,
      toolsBytes, toolsTokensEst,
      instructionsBytes: instr.bytes, instructionsTokensEst: instr.tokensEst,
      totalBytes: toolsBytes + instr.bytes,
      totalTokensEst: toolsTokensEst + instr.tokensEst,
      tools,
    };
  } catch (err: any) {
    return { ...empty, error: err?.message || String(err) };
  } finally {
    try { await client.close(); } catch { /* ignore */ }
    try { await transport.close(); } catch { /* ignore */ }
  }
}

/**
 * Probes EVERY MCP server an agent gets — both EH module-system servers and the
 * host `.mcp.json` servers (incl. event-horizon's own tools) — deduped by id,
 * and reports each server's tool + instructions schema cost. This is the full
 * static MCP context an agent pays for. On-demand and slow (spawns servers).
 */
export async function probeAllMcpSchemas(phase?: string, tags?: string[], timeoutMs = 20000): Promise<McpSchemaReport> {
  const merged = new Map<string, { config: any; source: string }>();
  for (const [id, cfg] of Object.entries(getModuleMcpServers(phase, tags))) merged.set(id, { config: cfg, source: 'module' });
  for (const [id, cfg] of Object.entries(getWorkspaceMcpServers())) {
    if (merged.has(id)) merged.get(id)!.source = 'module+host';
    else merged.set(id, { config: cfg, source: 'host' });
  }

  const results = await Promise.all(
    [...merged.entries()].map(([id, { config, source }]) => probeMcpServer(id, config, timeoutMs, source)),
  );
  results.sort((a, b) => b.totalTokensEst - a.totalTokensEst);
  const totalTokensEst = results.reduce((s, r) => s + r.totalTokensEst, 0);
  return {
    servers: results,
    totalTokensEst,
    note:
      merged.size === 0
        ? 'No MCP servers found in module config or workspace .mcp.json.'
        : 'Full per-server schema cost (tools + instructions) an agent pays for each connected server. Spawns each server to enumerate; slow/uninstalled servers show ok:false.',
  };
}

/** Module-only probe (kept for back-compat / targeted use). */
export async function probeModuleMcpSchemas(phase?: string, tags?: string[], timeoutMs = 20000): Promise<McpSchemaReport> {
  const servers = getModuleMcpServers(phase, tags);
  const ids = Object.keys(servers);
  const results = await Promise.all(ids.map((id) => probeMcpServer(id, servers[id]!, timeoutMs, 'module')));
  results.sort((a, b) => b.totalTokensEst - a.totalTokensEst);
  return {
    servers: results,
    totalTokensEst: results.reduce((s, r) => s + r.totalTokensEst, 0),
    note: ids.length === 0 ? 'No module MCP servers are active for this workspace/phase.' : 'Module MCP servers only.',
  };
}
