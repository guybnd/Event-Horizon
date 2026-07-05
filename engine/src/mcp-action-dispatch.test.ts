import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { buildMcpServer, permissionDecisionFor } from './mcp-server.js';
import { tasksCache } from './task-store.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** `Client.callTool()`'s declared return type is a wider union than the SDK's own exported
 *  `CallToolResult` (it also allows a legacy `{ toolResult }`-only shape) — narrow it here with a
 *  runtime shape check instead of trusting every call site to remember a cast. */
function isCallToolResult(value: unknown): value is CallToolResult {
  return isRecord(value) && Array.isArray(value['content']);
}

/** Narrow the content-block union down to the 'text' variant these tools always return. */
function textOf(result: CallToolResult): string | undefined {
  const first = result.content[0];
  return first && 'text' in first ? first.text : undefined;
}

/**
 * FLUX-882: the 34→24 consolidation re-homed several tools behind an `action` discriminator and made
 * the permission gate action-aware. These two facets carried zero direct coverage (the review's M3),
 * so this file pins (a) the pure action-aware permission decision and (b) the per-action validation
 * guards inside the merged handlers, exercised through a real in-memory MCP round-trip.
 */
describe('permissionDecisionFor (FLUX-882 action-aware gating, hardened FLUX-939)', () => {
  it('confirm-gates branch ONLY on action:"delete" (the old delete_branch gate)', () => {
    expect(permissionDecisionFor('branch', { action: 'delete' })).toBe('confirm');
    expect(permissionDecisionFor('branch', { action: 'create' })).toBe('allow');
    expect(permissionDecisionFor('branch', { action: 'status' })).toBe('allow');
  });

  it('confirm-gates furnace_batch ONLY on action:"discard" (the old furnace_discard gate, FLUX-1085)', () => {
    expect(permissionDecisionFor('furnace_batch', { action: 'discard' })).toBe('confirm');
    expect(permissionDecisionFor('furnace_batch', { action: 'ignite' })).toBe('allow');
    expect(permissionDecisionFor('furnace_batch', { action: 'stop' })).toBe('allow');
    expect(permissionDecisionFor('furnace_batch', { action: 'resume' })).toBe('allow');
  });

  it('confirm-gates group_doc ONLY on action:"delete" — the cross-repo-fanout destructive action (FLUX-939, was auto-allow for every action)', () => {
    expect(permissionDecisionFor('group_doc', { action: 'delete' })).toBe('confirm');
    expect(permissionDecisionFor('group_doc', { action: 'list' })).toBe('allow');
    expect(permissionDecisionFor('group_doc', { action: 'read' })).toBe('allow');
    expect(permissionDecisionFor('group_doc', { action: 'submit' })).toBe('allow');
  });

  it('strips the mcp__<server>__ prefix before deciding', () => {
    expect(permissionDecisionFor('mcp__event-horizon__branch', { action: 'delete' })).toBe('confirm');
    expect(permissionDecisionFor('mcp__event-horizon__furnace_batch', { action: 'discard' })).toBe('confirm');
    expect(permissionDecisionFor('mcp__event-horizon__group_doc', { action: 'delete' })).toBe('confirm');
    expect(permissionDecisionFor('mcp__event-horizon__change_status')).toBe('confirm');
    expect(permissionDecisionFor('mcp__event-horizon__get_ticket')).toBe('allow');
  });

  it('keeps the confirm tier for the destructive/restructuring verbs', () => {
    for (const t of ['change_status', 'finish_ticket', 'archive', 'extract_ticket', 'merge_tickets', 'Bash']) {
      expect(permissionDecisionFor(t)).toBe('confirm');
    }
  });

  it('leaves the Furnace per-ticket tool (retry/dismiss/takeover/handback/add/remove) on the allow tier — none of its actions are destructive (FLUX-1085, was furnace_add_ticket/furnace_remove_ticket in FLUX-1081)', () => {
    for (const action of ['retry', 'dismiss', 'takeover', 'handback', 'add', 'remove']) {
      expect(permissionDecisionFor('furnace_ticket', { action })).toBe('allow');
    }
    expect(permissionDecisionFor('furnace_ticket')).toBe('allow');
  });

  it('does NOT downgrade: the merged auto-allow tools stay allow (they absorbed already-allowed ops)', () => {
    for (const t of ['add_note', 'swimlane', 'create_ticket', 'delegate', 'get_ticket', 'list_tickets']) {
      expect(permissionDecisionFor(t)).toBe('allow');
    }
  });

  it('is fail-safe, not fail-open: an action-aware tool with a missing/unrecognized action confirms rather than defaulting to allow (FLUX-939)', () => {
    // Previously `bare === 'branch'` special-cased ONLY 'delete' as non-allow, so an absent `input`
    // fell through to 'allow' for a destructive-capable tool. Now every action-aware tool auto-allows
    // ONLY its explicitly-listed safe actions; anything else — including no input at all — confirms.
    expect(permissionDecisionFor('branch')).toBe('confirm');
    expect(permissionDecisionFor('branch', {})).toBe('confirm');
    expect(permissionDecisionFor('branch', { action: 'obliterate' })).toBe('confirm');
    expect(permissionDecisionFor('furnace_batch')).toBe('confirm');
    expect(permissionDecisionFor('group_doc')).toBe('confirm');
  });

  it('falls back to allow for an unknown (non-action-aware) tool', () => {
    expect(permissionDecisionFor('some_unknown_tool')).toBe('allow');
  });
});

describe('merged-tool action dispatch & per-action validation (in-memory round-trip)', () => {
  const TICKET = 'DISPATCH-1';
  let client: Client;
  let server: ReturnType<typeof buildMcpServer>;

  beforeAll(async () => {
    // Seed a ticket so the handlers get past their `tasksCache[ticketId]` not_found guard and reach
    // the per-action validation. The guards under test fire before any git/network/disk I/O.
    tasksCache[TICKET] = { id: TICKET, status: 'Todo', title: 'dispatch test', history: [] };

    server = buildMcpServer();
    client = new Client({ name: 'eh-action-dispatch-test', version: '1.0.0' }, { capabilities: {} });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  });

  afterAll(async () => {
    delete tasksCache[TICKET];
    await client.close().catch(() => {});
    await server.close().catch(() => {});
  });

  /** Thin wrapper narrowing `client.callTool`'s wide SDK return type down to `CallToolResult`. */
  async function callTool(args: Parameters<Client['callTool']>[0]): Promise<CallToolResult> {
    const res: unknown = await client.callTool(args);
    if (!isCallToolResult(res)) throw new Error('expected a content-bearing tool result');
    return res;
  }

  it('branch: rejects `force` on a non-delete action with a clean validation error (no crash)', async () => {
    const res = await callTool({
      name: 'branch',
      arguments: { ticketId: TICKET, action: 'create', force: true },
    });
    expect(res.isError).toBe(true);
    expect(res.structuredContent?.code).toBe('validation_failed');
    expect(textOf(res)).toMatch(/force is only valid for action "delete"/i);
  });

  it('furnace_batch: rejects `reason`/`hard` on a non-stop action with a clean validation error (no crash, FLUX-1085)', async () => {
    const res = await callTool({
      name: 'furnace_batch',
      arguments: { batchId: 'nope', action: 'ignite', hard: true },
    });
    expect(res.isError).toBe(true);
    expect(res.structuredContent?.code).toBe('validation_failed');
    expect(textOf(res)).toMatch(/reason\/hard are only valid for action "stop"/i);
  });

  it('swimlane: action "set" without a swimlane id returns validation_failed (not a crash)', async () => {
    const res = await callTool({
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
    let result: CallToolResult | undefined;
    try {
      result = await callTool({
        name: 'branch',
        arguments: { ticketId: TICKET, action: 'obliterate' },
      });
    } catch {
      threw = true;
    }
    expect(threw || result?.isError === true).toBe(true);
  });
});
