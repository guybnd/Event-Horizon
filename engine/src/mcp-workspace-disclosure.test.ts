import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildMcpServer, buildBoardConfigProjection, permissionDecisionFor } from './mcp-server.js';
import { runWithWorkspace, openWorkspace, closeWorkspace } from './workspace-context.js';
import path from 'path';
import os from 'os';

/**
 * FLUX-1573: a hand-launched session's static `.mcp.json` sends no `X-EH-Workspace` header and
 * silently binds to the boot/default board (FLUX-1557's deterministic fallback) — the agent has
 * no surface to tell "verified binding" from "assumed binding" apart. These tests pin the
 * disclosure surfaces this ticket adds: `buildBoardConfigProjection()`'s new `workspaceRoot`/
 * `binding`/`storeMode` fields, and the read-only `list_workspaces` tool.
 */
describe('buildBoardConfigProjection: workspace-binding disclosure (FLUX-1573)', () => {
  it("reports binding:'header' and the bound canonical root inside a runWithWorkspace binding", async () => {
    const root = path.join(os.tmpdir(), `eh-disclosure-header-${process.pid}`);
    const ws = openWorkspace(root);
    try {
      const projection = runWithWorkspace(ws, () => buildBoardConfigProjection());
      expect(projection.binding).toBe('header');
      expect(typeof projection.workspaceRoot).toBe('string');
      expect(projection.storeMode === 'in-repo' || projection.storeMode === 'orphan').toBe(true);
    } finally {
      if (ws.root) await closeWorkspace(ws.root);
    }
  });

  it("reports binding:'default-fallback' when unbound (no X-EH-Workspace header)", () => {
    const projection = runWithWorkspace(null, () => buildBoardConfigProjection());
    expect(projection.binding).toBe('default-fallback');
  });

  it('always includes workspaceRoot/binding/storeMode — a pre-fix engine is identified by their ABSENCE', () => {
    const projection = buildBoardConfigProjection();
    expect(projection).toHaveProperty('workspaceRoot');
    expect(projection).toHaveProperty('binding');
    expect(projection).toHaveProperty('storeMode');
  });
});

describe('list_workspaces MCP tool (FLUX-1573)', () => {
  it("is on the SAFE_PERMISSION_TOOLS allow tier", () => {
    expect(permissionDecisionFor('list_workspaces')).toBe('allow');
    expect(permissionDecisionFor('mcp__event-horizon__list_workspaces')).toBe('allow');
  });

  describe('in-memory round-trip', () => {
    let client: Client;
    let server: ReturnType<typeof buildMcpServer>;

    beforeAll(async () => {
      server = buildMcpServer();
      client = new Client({ name: 'eh-workspace-disclosure-test', version: '1.0.0' }, { capabilities: {} });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    });

    afterAll(async () => {
      await client.close().catch(() => {});
      await server.close().catch(() => {});
    });

    it('is registered with readOnlyHint:true', async () => {
      const { tools } = await client.listTools();
      const tool = tools.find((t) => t.name === 'list_workspaces');
      expect(tool).toBeDefined();
      expect(tool?.annotations?.readOnlyHint).toBe(true);
    });

    it('returns a workspaces array whose entries carry canonicalRoot', async () => {
      const res: unknown = await client.callTool({ name: 'list_workspaces', arguments: {} });
      const structured = (res as { structuredContent?: { workspaces?: unknown[] } }).structuredContent;
      expect(Array.isArray(structured?.workspaces)).toBe(true);
      for (const entry of structured?.workspaces ?? []) {
        expect(typeof (entry as { canonicalRoot?: unknown }).canonicalRoot).toBe('string');
      }
    });
  });
});
