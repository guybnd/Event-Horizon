// FLUX-1083: functional MCP-tool tests for furnace_discard / furnace_add_ticket / furnace_remove_ticket
// (FLUX-1081 added the handlers but only a permission-tier classification test — see
// mcp-action-dispatch.test.ts — ever exercised them). Follows the `client.callTool(...)` in-memory
// round-trip pattern established by mcp-structured-output.test.ts / furnace-build-mcp.test.ts, so these
// pin the handlers' actual behavior rather than just their existence.
//
// FLUX-1085: those three tools were folded into `furnace_batch` (action:"discard") and `furnace_ticket`
// (action:"add"/"remove") — updated in place here rather than renaming the file, since the underlying
// behavior pinned below is unchanged, only the tool name + action discriminator.

import { getWorkspace } from './workspace-context.js';
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildMcpServer } from './mcp-server.js';

import { setWorkspaceRoot } from './workspace.js';
import { createFurnaceBatch, updateFurnaceBatch, mutateFurnaceBatch, getFurnaceBatch, __resetFurnaceStoreForTests } from './furnace-store.js';
import { reconcileBatch } from './furnace-stoker.js';
import { newBatchTicket, type FurnaceBatch } from './models/furnace.js';
import { cliSessionsById, cliSessionsByTaskId, registerSession } from './session-store.js';
import type { CliSessionRecord } from './agents/types.js';

/** The narrow shape these furnace tools actually produce: content[0] is always a 'text' block
 *  carrying a JSON string, plus structuredContent + isError. The SDK's own `callTool` return type is
 *  a much wider union (every content-block variant, plus a legacy `toolResult`-only compat shape) that
 *  doesn't structurally match its own exported `CallToolResult` type, so tests narrow to this instead
 *  of fighting that union at every call site (see the `callTool` wrapper below). */
interface ToolCallResult {
  content: { type: string; text?: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

/** The subset of a furnace_batch/furnace_ticket JSON response body these tests assert on. */
interface FurnaceToolResult {
  discarded?: boolean;
  batchId?: string;
  added?: boolean;
  removed?: boolean;
  batch?: FurnaceBatch;
}

describe('furnace_batch action:"discard" / furnace_ticket actions:"add"/"remove" MCP tools (FLUX-1083, consolidated FLUX-1085)', () => {
  let client: Client;
  let server: ReturnType<typeof buildMcpServer>;
  let root: string;

  beforeAll(async () => {
    server = buildMcpServer();
    client = new Client({ name: 'eh-furnace-batch-mcp-test', version: '1.0.0' }, { capabilities: {} });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  });

  afterAll(async () => {
    await client.close().catch(() => {});
    await server.close().catch(() => {});
  });

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'eh-furnace-batch-mcp-'));
    await fs.mkdir(path.join(root, '.flux'), { recursive: true });
    setWorkspaceRoot(root);
    __resetFurnaceStoreForTests();
  });

  afterEach(async () => {
    for (const k of Object.keys(getWorkspace().tasks)) delete getWorkspace().tasks[k];
    cliSessionsById.clear();
    cliSessionsByTaskId.clear();
    await fs.rm(root, { recursive: true, force: true }).catch(() => {});
  });

  /** Thin wrapper narrowing client.callTool's wide SDK return type down to {@link ToolCallResult}. */
  async function callTool(args: Parameters<Client['callTool']>[0]): Promise<ToolCallResult> {
    return (await client.callTool(args)) as unknown as ToolCallResult;
  }

  /** Narrow the content-block union to 'text' — the only kind these tools return. */
  function textOf(res: ToolCallResult): string | undefined {
    const first = res.content?.[0];
    return first && first.type === 'text' ? first.text : undefined;
  }

  function parsed(res: ToolCallResult): FurnaceToolResult {
    const text = textOf(res);
    if (text === undefined) throw new Error('expected text content');
    return JSON.parse(text) as FurnaceToolResult;
  }

  describe('furnace_batch action:"discard"', () => {
    it('deletes a draft batch', async () => {
      const batch = await createFurnaceBatch({ title: 'Discard me' });
      const res = await callTool({ name: 'furnace_batch', arguments: { action: 'discard', batchId: batch.id } });
      expect(res.isError).toBeFalsy();
      expect(parsed(res)).toEqual({ discarded: true, batchId: batch.id });
      expect(getFurnaceBatch(batch.id)).toBeUndefined();
    });

    it('404s on an unknown batch', async () => {
      const res = await callTool({ name: 'furnace_batch', arguments: { action: 'discard', batchId: 'nope' } });
      expect(res.isError).toBe(true);
      expect(res.structuredContent?.code).toBe('not_found');
    });

    it('refuses a burning batch with invalid_state', async () => {
      const batch = await createFurnaceBatch({ title: 'Burning batch' });
      await updateFurnaceBatch(batch.id, { status: 'burning' });
      const res = await callTool({ name: 'furnace_batch', arguments: { action: 'discard', batchId: batch.id } });
      expect(res.isError).toBe(true);
      expect(res.structuredContent?.code).toBe('invalid_state');
      expect(getFurnaceBatch(batch.id)).toBeTruthy();
    });
  });

  describe('furnace_ticket action:"add"', () => {
    it('appends a ticket with the next contiguous order', async () => {
      const batch = await createFurnaceBatch({
        title: 'Add ticket',
        tickets: [newBatchTicket('FLUX-1', 0), newBatchTicket('FLUX-2', 1)],
      });
      getWorkspace().tasks['FLUX-3'] = { id: 'FLUX-3', status: 'Todo', title: 'Third ticket', history: [] };

      const res = await callTool({ name: 'furnace_ticket', arguments: { action: 'add', batchId: batch.id, ticketId: 'FLUX-3' } });
      expect(res.isError).toBeFalsy();
      const body = parsed(res);
      expect(body.added).toBe(true);
      const entry = body.batch!.tickets.find((t) => t.ticketId === 'FLUX-3');
      expect(entry).toBeTruthy();
      expect(entry!.order).toBe(2);
      expect(entry!.state).toBe('queued');
    });

    it('rejects appending to a done batch with invalid_state', async () => {
      const batch = await createFurnaceBatch({ title: 'Done batch' });
      await updateFurnaceBatch(batch.id, { status: 'done' });
      getWorkspace().tasks['FLUX-1'] = { id: 'FLUX-1', status: 'Todo', title: 'Ticket', history: [] };

      const res = await callTool({ name: 'furnace_ticket', arguments: { action: 'add', batchId: batch.id, ticketId: 'FLUX-1' } });
      expect(res.isError).toBe(true);
      expect(res.structuredContent?.code).toBe('invalid_state');
    });

    it('rejects a ticket already in the batch with invalid_state', async () => {
      const batch = await createFurnaceBatch({ title: 'Dup ticket', tickets: [newBatchTicket('FLUX-1', 0)] });
      getWorkspace().tasks['FLUX-1'] = { id: 'FLUX-1', status: 'Todo', title: 'Ticket', history: [] };

      const res = await callTool({ name: 'furnace_ticket', arguments: { action: 'add', batchId: batch.id, ticketId: 'FLUX-1' } });
      expect(res.isError).toBe(true);
      expect(res.structuredContent?.code).toBe('invalid_state');
    });

    it('rejects an unknown ticket id with validation_failed', async () => {
      const batch = await createFurnaceBatch({ title: 'Unknown ticket' });
      const res = await callTool({ name: 'furnace_ticket', arguments: { action: 'add', batchId: batch.id, ticketId: 'FLUX-404' } });
      expect(res.isError).toBe(true);
      expect(res.structuredContent?.code).toBe('validation_failed');
      expect(textOf(res)).toMatch(/unknown ticket id/i);
    });

    it('rejects a ticket with a disallowed status with validation_failed', async () => {
      const batch = await createFurnaceBatch({ title: 'Bad status ticket' });
      getWorkspace().tasks['FLUX-5'] = { id: 'FLUX-5', status: 'Grooming', title: 'Not ready', history: [] };

      const res = await callTool({ name: 'furnace_ticket', arguments: { action: 'add', batchId: batch.id, ticketId: 'FLUX-5' } });
      expect(res.isError).toBe(true);
      expect(res.structuredContent?.code).toBe('validation_failed');
      expect(textOf(res)).toMatch(/not in an allowed status/i);
    });

    it('rejects a ticket already queued in another non-terminal batch, naming the owner (FLUX-1051)', async () => {
      getWorkspace().tasks['FLUX-1'] = { id: 'FLUX-1', status: 'Todo', title: 'One', history: [] };
      const owner = await createFurnaceBatch({ title: 'Owner', tickets: [newBatchTicket('FLUX-1', 0, 'One')] });
      const other = await createFurnaceBatch({ title: 'Other' });

      const res = await callTool({ name: 'furnace_ticket', arguments: { action: 'add', batchId: other.id, ticketId: 'FLUX-1' } });
      expect(res.isError).toBe(true);
      expect(res.structuredContent?.code).toBe('validation_failed');
      expect(textOf(res)).toContain(owner.id);
      expect(getFurnaceBatch(other.id)?.tickets).toEqual([]);
    });
  });

  describe('furnace_ticket action:"remove"', () => {
    it('removes a queued ticket from a draft batch', async () => {
      const batch = await createFurnaceBatch({ title: 'Remove ticket', tickets: [newBatchTicket('FLUX-1', 0), newBatchTicket('FLUX-2', 1)] });
      const res = await callTool({ name: 'furnace_ticket', arguments: { action: 'remove', batchId: batch.id, ticketId: 'FLUX-1' } });
      expect(res.isError).toBeFalsy();
      const body = parsed(res);
      expect(body.removed).toBe(true);
      expect(body.batch!.tickets.some((t) => t.ticketId === 'FLUX-1')).toBe(false);
    });

    it('404s when the ticket is not in the batch', async () => {
      const batch = await createFurnaceBatch({ title: 'No such ticket' });
      const res = await callTool({ name: 'furnace_ticket', arguments: { action: 'remove', batchId: batch.id, ticketId: 'FLUX-1' } });
      expect(res.isError).toBe(true);
      expect(res.structuredContent?.code).toBe('not_found');
    });

    it('refuses to remove an actively-burning ticket from a burning batch', async () => {
      const batch = await createFurnaceBatch({ title: 'Actively burning', tickets: [newBatchTicket('FLUX-1', 0)] });
      await updateFurnaceBatch(batch.id, { status: 'burning' });
      await mutateFurnaceBatch(batch.id, (draft) => {
        const t = draft.tickets.find((x) => x.ticketId === 'FLUX-1');
        if (t) t.state = 'implementing';
      });

      const res = await callTool({ name: 'furnace_ticket', arguments: { action: 'remove', batchId: batch.id, ticketId: 'FLUX-1' } });
      expect(res.isError).toBe(true);
      expect(res.structuredContent?.code).toBe('invalid_state');
      expect(getFurnaceBatch(batch.id)?.tickets.some((t) => t.ticketId === 'FLUX-1')).toBe(true);
    });

    it('allows removing a still-queued ticket even while the batch is burning', async () => {
      const batch = await createFurnaceBatch({
        title: 'Queued alongside burning',
        tickets: [newBatchTicket('FLUX-1', 0), newBatchTicket('FLUX-2', 1)],
      });
      await updateFurnaceBatch(batch.id, { status: 'burning' });
      await mutateFurnaceBatch(batch.id, (draft) => {
        const t = draft.tickets.find((x) => x.ticketId === 'FLUX-1');
        if (t) t.state = 'implementing';
      });

      const res = await callTool({ name: 'furnace_ticket', arguments: { action: 'remove', batchId: batch.id, ticketId: 'FLUX-2' } });
      expect(res.isError).toBeFalsy();
      const body = parsed(res);
      expect(body.removed).toBe(true);
      expect(body.batch!.tickets.some((t) => t.ticketId === 'FLUX-2')).toBe(false);
    });

    it('allows removing a terminal ticket even while the batch is burning', async () => {
      const batch = await createFurnaceBatch({ title: 'Terminal alongside burning', tickets: [newBatchTicket('FLUX-1', 0)] });
      await updateFurnaceBatch(batch.id, { status: 'burning' });
      await mutateFurnaceBatch(batch.id, (draft) => {
        const t = draft.tickets.find((x) => x.ticketId === 'FLUX-1');
        if (t) t.state = 'pr-open';
      });

      const res = await callTool({ name: 'furnace_ticket', arguments: { action: 'remove', batchId: batch.id, ticketId: 'FLUX-1' } });
      expect(res.isError).toBeFalsy();
      const body = parsed(res);
      expect(body.removed).toBe(true);
    });
  });

  // FLUX-1094: neither removal path used to clear the takeover-debounce Sets (`suspectedHumanTakeover` /
  // `dispatching`) for the ticket it evicted. A stale "suspected" entry surviving into a ticket's NEXT
  // batch made that batch's very first reconcile pass look like the SECOND consecutive pass, confirming a
  // takeover immediately instead of requiring two — these pin the fix by round-tripping a ticket id through
  // remove/discard into a fresh batch and asserting its debounce restarts clean (one pass ⇒ still
  // unconfirmed).
  describe('FLUX-1094 — takeover-debounce tracking is cleared when a ticket leaves Furnace ownership', () => {
    it('furnace_ticket action:"remove" clears it — a re-entrant ticket id gets a fresh two-pass debounce in its next batch', async () => {
      const batch1 = await createFurnaceBatch({ title: 'Batch 1', tickets: [newBatchTicket('RE-1094', 0)] });
      await updateFurnaceBatch(batch1.id, { status: 'done' }); // reconcileBatch only needs status !== 'draft'
      cliSessionsById.set('human-sess-1094', { id: 'human-sess-1094', taskId: 'RE-1094', status: 'running', phase: 'implementation' } as unknown as CliSessionRecord);
      registerSession('RE-1094', 'human-sess-1094');
      getWorkspace().tasks['RE-1094'] = { id: 'RE-1094', status: 'In Progress' };

      await reconcileBatch(batch1.id); // pass 1 in batch1: suspected, not confirmed
      expect(getFurnaceBatch(batch1.id)?.tickets[0]?.owner).toBeUndefined();

      const res = await callTool({ name: 'furnace_ticket', arguments: { action: 'remove', batchId: batch1.id, ticketId: 'RE-1094' } });
      expect(res.isError).toBeFalsy();

      const batch2 = await createFurnaceBatch({ title: 'Batch 2', tickets: [newBatchTicket('RE-1094', 0)] });
      await updateFurnaceBatch(batch2.id, { status: 'done' });

      await reconcileBatch(batch2.id); // a single fresh pass — must NOT confirm immediately off leftover state
      expect(getFurnaceBatch(batch2.id)?.tickets[0]?.owner).toBeUndefined();
    });

    it('furnace_batch action:"discard" clears it for every ticket in the deleted batch', async () => {
      const batch1 = await createFurnaceBatch({ title: 'Batch 1 (discard)', tickets: [newBatchTicket('RE-1094B', 0)] });
      await updateFurnaceBatch(batch1.id, { status: 'done' });
      cliSessionsById.set('human-sess-1094b', { id: 'human-sess-1094b', taskId: 'RE-1094B', status: 'running', phase: 'implementation' } as unknown as CliSessionRecord);
      registerSession('RE-1094B', 'human-sess-1094b');
      getWorkspace().tasks['RE-1094B'] = { id: 'RE-1094B', status: 'In Progress' };

      await reconcileBatch(batch1.id);
      expect(getFurnaceBatch(batch1.id)?.tickets[0]?.owner).toBeUndefined();

      const res = await callTool({ name: 'furnace_batch', arguments: { action: 'discard', batchId: batch1.id } });
      expect(res.isError).toBeFalsy();

      const batch2 = await createFurnaceBatch({ title: 'Batch 2 (discard)', tickets: [newBatchTicket('RE-1094B', 0)] });
      await updateFurnaceBatch(batch2.id, { status: 'done' });

      await reconcileBatch(batch2.id);
      expect(getFurnaceBatch(batch2.id)?.tickets[0]?.owner).toBeUndefined();
    });
  });
});
