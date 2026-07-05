// furnace_build MCP tool — error-path accounting (FLUX-1051 review follow-up).
//
// `buildBatchTickets` has always returned a full `excluded` accounting (pinned by
// furnace-builder.test.ts), but the `furnace_build` MCP handler's empty-result branch routed
// through the bare `errorResult(text, code)` helper, which only carries `{code, message}` in
// `structuredContent` — `excluded` (and the rest of `notes`) never reached the caller. That
// silently defeated Done-criterion #2 ("a tagged ticket that isn't loaded is always visible in
// excluded with a reason") for the single most likely trigger: tag N tickets, one or more drift
// out of status, and ALL of them happen to be the ones that fail (so the proposal's `tickets`
// array is empty and the old code path fired). This test exercises the real MCP tool via an
// in-memory client/server round-trip and pins that `excluded`/`notes` now survive onto the wire.

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildMcpServer } from './mcp-server.js';
import { tasksCache } from './task-store.js';
import { setWorkspaceRoot } from './workspace.js';
import { __resetFurnaceStoreForTests } from './furnace-store.js';

/** The MCP SDK's `callTool` return type is a union covering both the structured-content
 *  and legacy `toolResult` tool-result shapes, which doesn't narrow cleanly for a caller
 *  that (like this test) only cares about the structured-content branch. Assert the
 *  shape this suite actually reads instead of widening the whole result to `any`. */
interface McpToolCallResult {
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
}

describe('furnace_build MCP tool — excluded survives the zero-tickets error path (FLUX-1051)', () => {
  let client: Client;
  let server: ReturnType<typeof buildMcpServer>;
  let root: string;

  beforeAll(async () => {
    server = buildMcpServer();
    client = new Client({ name: 'eh-furnace-build-test', version: '1.0.0' }, { capabilities: {} });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  });

  afterAll(async () => {
    await client.close().catch(() => {});
    await server.close().catch(() => {});
  });

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'eh-furnace-build-mcp-'));
    await fs.mkdir(path.join(root, '.flux'), { recursive: true });
    setWorkspaceRoot(root);
    __resetFurnaceStoreForTests();
  });

  afterEach(async () => {
    for (const k of Object.keys(tasksCache)) delete tasksCache[k];
    await fs.rm(root, { recursive: true, force: true }).catch(() => {});
  });

  it('a tag scan whose only carrier drifted out of status reports `excluded` (with reason) and `notes`, not just a bare message', async () => {
    tasksCache['FLUX-1'] = { id: 'FLUX-1', status: 'Grooming', title: 'drifted', tags: ['burn-furnace'], history: [] };

    const res = (await client.callTool({
      name: 'furnace_build',
      arguments: { tag: 'burn-furnace' },
    })) as McpToolCallResult;

    expect(res.isError).toBe(true);
    expect(res.structuredContent?.code).toBe('invalid_state');
    expect(res.structuredContent?.excluded).toEqual([
      { ticketId: 'FLUX-1', title: 'drifted', reason: 'tagged but status Grooming (not allowed)' },
    ]);
    const notes = res.structuredContent?.notes as string[] | undefined;
    expect(notes?.[0]).toBe('⚠ 1 tagged ticket(s) NOT loaded — see excluded.');
  });

  it('an all-unknown explicit-ids build reports the unknown ids in `excluded` too', async () => {
    const res = (await client.callTool({
      name: 'furnace_build',
      arguments: { tickets: ['FLUX-999'] },
    })) as McpToolCallResult;

    expect(res.isError).toBe(true);
    expect(res.structuredContent?.excluded).toEqual([{ ticketId: 'FLUX-999', reason: 'unknown ticket id' }]);
  });
});
