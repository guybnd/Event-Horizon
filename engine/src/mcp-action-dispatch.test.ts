import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildMcpServer, permissionDecisionFor } from './mcp-server.js';
import { tasksCache } from './task-store.js';

/**
 * FLUX-882: the 34→24 consolidation re-homed several tools behind an `action` discriminator and made
 * the permission gate action-aware. These two facets carried zero direct coverage (the review's M3),
 * so this file pins (a) the pure action-aware permission decision and (b) the per-action validation
 * guards inside the merged handlers, exercised through a real in-memory MCP round-trip.
 */
describe('permissionDecisionFor (FLUX-882 action-aware gating)', () => {
  it('confirm-gates branch ONLY on action:"delete" (the old delete_branch gate)', () => {
    expect(permissionDecisionFor('branch', { action: 'delete' })).toBe('confirm');
    expect(permissionDecisionFor('branch', { action: 'create' })).toBe('allow');
    expect(permissionDecisionFor('branch', { action: 'status' })).toBe('allow');
  });

  it('strips the mcp__<server>__ prefix before deciding', () => {
    expect(permissionDecisionFor('mcp__event-horizon__branch', { action: 'delete' })).toBe('confirm');
    expect(permissionDecisionFor('mcp__event-horizon__change_status')).toBe('confirm');
    expect(permissionDecisionFor('mcp__event-horizon__get_ticket')).toBe('allow');
  });

  it('keeps the confirm tier for the destructive/restructuring verbs', () => {
    for (const t of ['change_status', 'finish_ticket', 'archive', 'extract_ticket', 'merge_tickets', 'Bash']) {
      expect(permissionDecisionFor(t)).toBe('confirm');
    }
  });

  it('does NOT downgrade: the merged auto-allow tools stay allow (they absorbed already-allowed ops)', () => {
    for (const t of ['group_doc', 'add_note', 'swimlane', 'create_ticket', 'delegate', 'get_ticket', 'list_tickets']) {
      expect(permissionDecisionFor(t)).toBe('allow');
    }
  });

  it('falls back to allow for an unknown tool and for branch with no input (fail-open, documented)', () => {
    expect(permissionDecisionFor('some_unknown_tool')).toBe('allow');
    expect(permissionDecisionFor('branch')).toBe('allow');
  });
});

describe('merged-tool action dispatch & per-action validation (in-memory round-trip)', () => {
  const TICKET = 'DISPATCH-1';
  let client: Client;
  let server: ReturnType<typeof buildMcpServer>;

  beforeAll(async () => {
    // Seed a ticket so the handlers get past their `tasksCache[ticketId]` not_found guard and reach
    // the per-action validation. The guards under test fire before any git/network/disk I/O.
    (tasksCache as any)[TICKET] = { id: TICKET, status: 'Todo', title: 'dispatch test', history: [] };

    server = buildMcpServer();
    client = new Client({ name: 'eh-action-dispatch-test', version: '1.0.0' }, { capabilities: {} });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  });

  afterAll(async () => {
    delete (tasksCache as any)[TICKET];
    await client.close().catch(() => {});
    await server.close().catch(() => {});
  });

  it('branch: rejects `force` on a non-delete action with a clean validation error (no crash)', async () => {
    const res: any = await client.callTool({
      name: 'branch',
      arguments: { ticketId: TICKET, action: 'create', force: true },
    });
    expect(res.isError).toBe(true);
    expect(res.structuredContent?.code).toBe('validation_failed');
    expect(res.content?.[0]?.text).toMatch(/force is only valid for action "delete"/i);
  });

  it('swimlane: action "set" without a swimlane id returns validation_failed (not a crash)', async () => {
    const res: any = await client.callTool({
      name: 'swimlane',
      arguments: { ticketId: TICKET, action: 'set' },
    });
    expect(res.isError).toBe(true);
    expect(res.structuredContent?.code).toBe('validation_failed');
  });

  it('rejects an unknown action at the schema layer — gracefully, never silently succeeding', async () => {
    // The `action` enum has no default, so an out-of-enum value is rejected (InputValidationError /
    // isError) rather than falling through to a destructive branch. Robust to either SDK surfacing.
    let threw = false;
    let result: any;
    try {
      result = await client.callTool({
        name: 'branch',
        arguments: { ticketId: TICKET, action: 'obliterate' },
      });
    } catch {
      threw = true;
    }
    expect(threw || result?.isError === true).toBe(true);
  });
});
