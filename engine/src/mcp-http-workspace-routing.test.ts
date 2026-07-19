import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import path from 'path';
import os from 'os';
import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { handleMcpHttpRequest } from './mcp-server.js';
import { openWorkspace, closeWorkspace, listWorkspaces, getDefaultWorkspace } from './workspace-context.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isCallToolResult(value: unknown): value is CallToolResult {
  return isRecord(value) && ('structuredContent' in value || 'content' in value);
}

function tmpRoot(name: string): string {
  return path.join(os.tmpdir(), 'flux-mcp-workspace-routing-test', name);
}

/**
 * FLUX-1448 (epic FLUX-1230 S3): per-connection MCP workspace binding. Mirrors
 * mcp-http-conversation-routing.test.ts's real-HTTP-transport harness (FLUX-1213) — two
 * concurrent connections prove isolation the same way, just keyed on `x-eh-workspace` (resolved
 * against the S1 registry, workspace-context.ts) instead of `x-eh-conversation-id`. Both
 * workspaces seed the SAME ticket id (`FLUX-1`) with different titles — the exact cross-board
 * id-collision this ticket exists to prevent.
 */
describe('MCP HTTP per-connection workspace binding (FLUX-1448)', () => {
  let server: http.Server;
  let baseUrl: URL;
  const rootA = tmpRoot('a');
  const rootB = tmpRoot('b');

  beforeAll(async () => {
    const wsA = openWorkspace(rootA);
    wsA.tasks['FLUX-1'] = { id: 'FLUX-1', title: 'Workspace A ticket', status: 'Todo', history: [] };
    const wsB = openWorkspace(rootB);
    wsB.tasks['FLUX-1'] = { id: 'FLUX-1', title: 'Workspace B ticket', status: 'Todo', history: [] };
    // FLUX-1557: the unbound/unrouted fallback resolves to the default workspace, never whichever
    // registry entry was opened last — seed it with its own distinctly-titled ticket so the
    // "unrouted" test below can tell the two apart.
    getDefaultWorkspace().tasks['FLUX-1'] = { id: 'FLUX-1', title: 'Default board ticket', status: 'Todo', history: [] };

    server = http.createServer((req, res) => {
      handleMcpHttpRequest(req, res).catch((err) => {
        res.statusCode = 500;
        res.end(String(err));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    baseUrl = new URL(`http://127.0.0.1:${port}/mcp`);
  });

  afterAll(async () => {
    delete getDefaultWorkspace().tasks['FLUX-1'];
    await Promise.all(listWorkspaces().map((ws) => ws.root && closeWorkspace(ws.root)));
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  async function connectClient(workspaceRoot: string | undefined, label: string): Promise<Client> {
    const headers = workspaceRoot ? { 'x-eh-workspace': workspaceRoot } : undefined;
    const transport = new StreamableHTTPClientTransport(baseUrl, headers ? { requestInit: { headers } } : undefined);
    const client = new Client({ name: `eh-ws-routing-test-${label}`, version: '1.0.0' }, { capabilities: {} });
    // Cast: same exactOptionalPropertyTypes/sessionId mismatch mcp-schema-probe.ts casts around —
    // StreamableHTTPClientTransport genuinely implements Transport.
    await client.connect(transport as Transport);
    return client;
  }

  async function getTicketTitle(client: Client, ticketId: string): Promise<unknown> {
    const raw: unknown = await client.callTool({ name: 'get_ticket', arguments: { ticketId } });
    if (!isCallToolResult(raw)) throw new Error('expected a get_ticket result');
    return (raw as { structuredContent?: { title?: unknown } }).structuredContent?.title;
  }

  it('two concurrent connections bound to different workspaces resolve the SAME ticket id to their OWN board', async () => {
    const [clientA, clientB] = await Promise.all([
      connectClient(rootA, 'A'),
      connectClient(rootB, 'B'),
    ]);
    try {
      const [titleA, titleB] = await Promise.all([
        getTicketTitle(clientA, 'FLUX-1'),
        getTicketTitle(clientB, 'FLUX-1'),
      ]);
      expect(titleA).toBe('Workspace A ticket');
      expect(titleB).toBe('Workspace B ticket');
    } finally {
      await clientA.close().catch(() => {});
      await clientB.close().catch(() => {});
    }
  });

  it('a client naming the legacy default/boot root binds to defaultWorkspace even though it is never a registry entry (the scratch-chat-on-the-wrong-board fix)', async () => {
    const defaultWs = getDefaultWorkspace();
    const priorRoot = defaultWs.root;
    const priorTask = defaultWs.tasks['FLUX-1'];
    const bootRoot = tmpRoot('boot');
    defaultWs.root = path.resolve(bootRoot);
    defaultWs.tasks['FLUX-1'] = { id: 'FLUX-1', title: 'Boot board ticket', status: 'Todo', history: [] };
    try {
      // rootB is the registry's most-recently-opened board — before the fix, a session spawned on
      // the boot board sent its root back but the registry-only lookup missed, so boundWorkspace()
      // silently served rootB's board instead.
      const client = await connectClient(bootRoot, 'boot');
      try {
        expect(await getTicketTitle(client, 'FLUX-1')).toBe('Boot board ticket');
      } finally {
        await client.close().catch(() => {});
      }
    } finally {
      defaultWs.root = priorRoot;
      if (priorTask) defaultWs.tasks['FLUX-1'] = priorTask;
      else delete defaultWs.tasks['FLUX-1'];
    }
  });

  it('an unrouted client (no x-eh-workspace header) and one naming an unregistered root both fall back to the default workspace — never an error, never silently misrouted to whichever board opened last (FLUX-1557)', async () => {
    const [unroutedClient, unknownRootClient] = await Promise.all([
      connectClient(undefined, 'unrouted'),
      connectClient(tmpRoot('never-registered'), 'unknown-root'),
    ]);
    try {
      const [unroutedTitle, unknownRootTitle] = await Promise.all([
        getTicketTitle(unroutedClient, 'FLUX-1'),
        getTicketTitle(unknownRootClient, 'FLUX-1'),
      ]);
      expect(unroutedTitle).toBe('Default board ticket');
      expect(unknownRootTitle).toBe('Default board ticket');
    } finally {
      await unroutedClient.close().catch(() => {});
      await unknownRootClient.close().catch(() => {});
    }
  });
});
