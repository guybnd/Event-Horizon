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

import { getWorkspace } from './workspace-context.js';
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildMcpServer } from './mcp-server.js';

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
    for (const k of Object.keys(getWorkspace().tasks)) delete getWorkspace().tasks[k];
    await fs.rm(root, { recursive: true, force: true }).catch(() => {});
  });

  it('a tag scan whose only carrier drifted out of status reports `excluded` (with reason) and `notes`, not just a bare message', async () => {
    getWorkspace().tasks['FLUX-1'] = { id: 'FLUX-1', status: 'Grooming', title: 'drifted', tags: ['burn-furnace'], history: [] };

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

// FLUX-1270: `adoptBranchFrom` (branch adoption) + `spawnedFrom` (display-only provenance) — the two
// additions that let a same-branch-dependent follow-up + its parent be pulled out of a parallel batch
// into a standalone sequential batch reusing the parent's still-open-PR branch, instead of the
// follow-up opening a second PR against the parent's branch that GitHub auto-closes the instant that
// branch is deleted on merge (the live incident this whole ticket traces to: FLUX-861/FLUX-1265).
describe('furnace_build MCP tool — branch adoption + spawnedFrom (FLUX-1270)', () => {
  let client: Client;
  let server: ReturnType<typeof buildMcpServer>;
  let root: string;

  interface FullToolCallResult {
    content: { type: string; text?: string }[];
    structuredContent?: Record<string, unknown>;
    isError?: boolean;
  }

  beforeAll(async () => {
    server = buildMcpServer();
    client = new Client({ name: 'eh-furnace-build-adopt-test', version: '1.0.0' }, { capabilities: {} });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  });

  afterAll(async () => {
    await client.close().catch(() => {});
    await server.close().catch(() => {});
  });

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'eh-furnace-build-adopt-'));
    await fs.mkdir(path.join(root, '.flux'), { recursive: true });
    setWorkspaceRoot(root);
    __resetFurnaceStoreForTests();
  });

  afterEach(async () => {
    for (const k of Object.keys(getWorkspace().tasks)) delete getWorkspace().tasks[k];
    await fs.rm(root, { recursive: true, force: true }).catch(() => {});
  });

  async function call(args: Record<string, unknown>): Promise<{ isError: boolean | undefined; code?: unknown; body: Record<string, unknown> }> {
    const res = (await client.callTool({ name: 'furnace_build', arguments: args })) as FullToolCallResult;
    // Success responses (jsonResult) put a JSON string in content[0].text; error responses
    // (errorResult) put the plain human-readable message there instead — only parse on success.
    const text = res.content?.[0]?.type === 'text' ? res.content[0].text : undefined;
    const body = !res.isError && text !== undefined ? (JSON.parse(text) as Record<string, unknown>) : {};
    return { isError: res.isError, code: res.structuredContent?.code, body };
  }

  /** Seeds the FLUX-861 (parent, PR open at Ready) / PR-434 (its synthetic PR card) shape. */
  function seedParentWithOpenPr() {
    getWorkspace().tasks['FLUX-861'] = { id: 'FLUX-861', status: 'Ready', title: 'Parent', branch: 'flux/FLUX-861-parent', history: [] };
    getWorkspace().tasks['PR-434'] = { id: 'PR-434', kind: 'pr', status: 'Ready', branch: 'flux/FLUX-861-parent', prNumber: 434, prState: 'OPEN', history: [] };
  }

  it('adopts the parent ticket\'s branch instead of minting one, forces kind sequential, and stamps spawnedFrom', async () => {
    seedParentWithOpenPr();

    const { isError, body } = await call({
      tickets: ['FLUX-861'],
      statuses: ['Ready'],
      adoptBranchFrom: 'FLUX-861',
      spawnedFrom: { batchId: 'origin-batch-id', ticketId: 'FLUX-861' },
      title: 'FLUX-861 + FLUX-1265 (spun off)',
    });

    expect(isError).toBeFalsy();
    const batch = body.batch as { branch: string; kind: string; spawnedFrom?: unknown; tickets: { ticketId: string }[] };
    expect(batch.branch).toBe('flux/FLUX-861-parent'); // adopted, not `flux/furnace-<id>-...`
    expect(batch.kind).toBe('sequential');
    expect(batch.spawnedFrom).toEqual({ batchId: 'origin-batch-id', ticketId: 'FLUX-861' });
    expect(batch.tickets.map((t) => t.ticketId)).toEqual(['FLUX-861']);
    expect((body.notes as string[]).some((n) => n.includes('Adopted FLUX-861'))).toBe(true);

    // The follow-up (mid-implementation, no PR of its own yet) then joins via the EXISTING
    // furnace_ticket action:"add" — widened with `allowedStatuses` (FLUX-1270) since a follow-up
    // caught mid-implementation is realistically still `In Progress`, not `Todo`.
    getWorkspace().tasks['FLUX-1265'] = { id: 'FLUX-1265', status: 'In Progress', title: 'Follow-up', history: [] };
    const addRes = (await client.callTool({
      name: 'furnace_ticket',
      arguments: { action: 'add', batchId: (body as { batchId: string }).batchId, ticketId: 'FLUX-1265', allowedStatuses: ['In Progress'] },
    })) as FullToolCallResult;
    expect(addRes.isError).toBeFalsy();
    const addBody = JSON.parse(addRes.content[0]!.text!) as { added: boolean; batch: { tickets: { ticketId: string }[] } };
    expect(addBody.added).toBe(true);
    expect(addBody.batch.tickets.map((t) => t.ticketId)).toEqual(['FLUX-861', 'FLUX-1265']);
  });

  it('rejects adoptBranchFrom naming an unknown ticket', async () => {
    getWorkspace().tasks['FLUX-1'] = { id: 'FLUX-1', status: 'Todo', title: 'X', history: [] };
    const res = await call({ tickets: ['FLUX-1'], adoptBranchFrom: 'FLUX-404' });
    expect(res.isError).toBe(true);
    expect(res.code).toBe('not_found');
  });

  it('rejects adoptBranchFrom naming a ticket with no branch', async () => {
    getWorkspace().tasks['FLUX-861'] = { id: 'FLUX-861', status: 'Ready', title: 'Parent', history: [] }; // no `branch`
    getWorkspace().tasks['FLUX-1'] = { id: 'FLUX-1', status: 'Todo', title: 'X', history: [] };
    const res = await call({ tickets: ['FLUX-1'], adoptBranchFrom: 'FLUX-861' });
    expect(res.isError).toBe(true);
    expect(res.code).toBe('validation_failed');
  });

  it('rejects adoptBranchFrom naming a ticket whose branch has no open PR', async () => {
    getWorkspace().tasks['FLUX-861'] = { id: 'FLUX-861', status: 'Ready', title: 'Parent', branch: 'flux/FLUX-861-parent', history: [] };
    getWorkspace().tasks['FLUX-1'] = { id: 'FLUX-1', status: 'Todo', title: 'X', history: [] };
    // No `kind:'pr'` card at all for this branch — nothing confirms an open PR.
    const res = await call({ tickets: ['FLUX-1'], adoptBranchFrom: 'FLUX-861' });
    expect(res.isError).toBe(true);
    expect(res.code).toBe('invalid_state');
  });

  it('rejects adoptBranchFrom combined with an explicit kind:"parallel" (nothing to adopt onto)', async () => {
    seedParentWithOpenPr();
    const res = await call({ tickets: ['FLUX-861'], statuses: ['Ready'], adoptBranchFrom: 'FLUX-861', kind: 'parallel' });
    expect(res.isError).toBe(true);
    expect(res.code).toBe('validation_failed');
  });

  it('a build with no adoptBranchFrom is unaffected — mints its own branch, no spawnedFrom (FLUX-1267/1268 shape)', async () => {
    getWorkspace().tasks['FLUX-1267'] = { id: 'FLUX-1267', status: 'Todo', title: 'Independent', history: [] };
    const { body } = await call({ tickets: ['FLUX-1267'] });
    const batch = body.batch as { branch: string; spawnedFrom?: unknown };
    expect(batch.branch).toMatch(/^flux\/furnace-/);
    expect(batch.spawnedFrom).toBeUndefined();
  });
});
