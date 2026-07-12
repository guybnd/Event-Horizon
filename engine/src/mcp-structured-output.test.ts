import { getWorkspace } from './workspace-context.js';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { buildMcpServer } from './mcp-server.js';

import { getConfig } from './config.js';

/**
 * FLUX-950: MCP structured output (outputSchema + structuredContent).
 *
 * `get_ticket` / `list_tickets` / `get_board_config` were migrated to `registerTool`
 * with an `outputSchema` and now return their payload as `structuredContent` — the
 * SINGLE wire representation. This pins the AXI #1 contract for that change:
 *
 *  - structuredContent is present and well-shaped (the SDK validates it against the
 *    advertised outputSchema on the way out — a throw here fails the round-trip).
 *  - the text `content` block is EMPTY: the typed JSON is never duplicated as a
 *    stringified second copy (duplicating doubles per-call tokens — the exact thing
 *    the pinned AXI #1 constraint forbids).
 *  - the on-wire payload did NOT inflate vs. the old `jsonResult` text shape — it
 *    shrinks, because structuredContent skips the JSON-in-a-JSON-string escaping.
 *  - tools/list advertises the outputSchema so typed clients can validate.
 */

// Mirrors the chars/4 token heuristic in agent-payload-metrics.ts `measure` (good
// enough to rank relative weight, not an exact tokenizer count).
function measure(value: unknown): { bytes: number; tokensEst: number } {
  const json = JSON.stringify(value) ?? '';
  return { bytes: Buffer.byteLength(json, 'utf8'), tokensEst: Math.ceil(json.length / 4) };
}

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

const TICKET = 'STRUCT-1';

describe('FLUX-950 structured output (outputSchema + structuredContent)', () => {
  let client: Client;
  let server: ReturnType<typeof buildMcpServer>;
  const savedConfig: Record<string, unknown> = {};

  beforeAll(async () => {
    // Seed a representative ticket with some history so the payload is non-trivial
    // (the token-delta assertion is only meaningful on a real-sized payload).
    getWorkspace().tasks[TICKET] = {
      id: TICKET,
      title: 'Structured output round-trip',
      status: 'In Progress',
      priority: 'Low',
      effort: 'S',
      assignee: 'unassigned',
      tags: ['mcp', 'engine'],
      body: 'A representative body paragraph that costs tokens when double-encoded.\n'.repeat(8),
      history: Array.from({ length: 6 }, (_, i) => ({
        type: 'activity',
        user: 'Agent',
        date: `2026-06-30T08:0${i}:00.000Z`,
        comment: `Activity entry ${i} with enough text to matter for the byte comparison.`,
      })),
    };

    // Seed the board config fields get_board_config projects.
    for (const k of ['columns', 'hiddenStatuses', 'tags', 'priorities', 'projects', 'users', 'requireInputStatus', 'readyForMergeStatus']) {
      savedConfig[k] = getConfig()[k];
    }
    getConfig().columns = [{ name: 'Todo' }, { name: 'In Progress' }, { name: 'Done' }];
    getConfig().hiddenStatuses = [{ name: 'Archived' }];
    getConfig().tags = [{ name: 'mcp' }, { name: 'engine' }];
    getConfig().priorities = [{ name: 'Low', icon: 'arrow-down' }, { name: 'High', icon: 'arrow-up' }];
    getConfig().projects = ['FLUX'];
    getConfig().users = ['guy'];
    getConfig().requireInputStatus = 'Require Input';
    getConfig().readyForMergeStatus = 'Ready';

    server = buildMcpServer();
    client = new Client({ name: 'eh-structured-output-test', version: '1.0.0' }, { capabilities: {} });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  });

  afterAll(async () => {
    delete getWorkspace().tasks[TICKET];
    for (const [k, v] of Object.entries(savedConfig)) getConfig()[k] = v;
    await client.close().catch(() => {});
    await server.close().catch(() => {});
  });

  /** Thin wrapper narrowing `client.callTool`'s wide SDK return type down to `CallToolResult`. */
  async function callTool(args: Parameters<Client['callTool']>[0]): Promise<CallToolResult> {
    const res: unknown = await client.callTool(args);
    if (!isCallToolResult(res)) throw new Error('expected a content-bearing tool result');
    return res;
  }

  it('tools/list advertises an outputSchema for each migrated read tool', async () => {
    const { tools } = await client.listTools();
    for (const name of ['get_ticket', 'list_tickets', 'get_board_config']) {
      const tool = tools.find((t) => t.name === name);
      expect(tool, `${name} should be registered`).toBeTruthy();
      expect(tool!.outputSchema, `${name} should advertise an outputSchema`).toBeTruthy();
      expect(tool!.outputSchema!.type).toBe('object');
    }
  });

  it('get_ticket returns the payload as structuredContent with NO duplicated text block', async () => {
    const res = await callTool({ name: 'get_ticket', arguments: { ticketId: TICKET } });
    // SDK validated structuredContent against the outputSchema before we got here
    // (a mismatch would have surfaced as isError) — so reaching valid data proves the
    // guardrail passed.
    expect(res.isError).toBeFalsy();
    expect(res.structuredContent).toBeTruthy();
    expect(res.structuredContent?.id).toBe(TICKET);
    expect(res.structuredContent?.status).toBe('In Progress');
    expect(Array.isArray(res.structuredContent?.history)).toBe(true);
    // AXI #1: structuredContent REPLACES the text JSON — it is not emitted alongside a
    // second full copy. The text content block must be empty.
    expect(res.content).toEqual([]);

    // AXI #1 measurement: the structured payload must not inflate the wire vs. the old
    // jsonResult text shape. The old shape stringified the SAME object into a text
    // block (JSON-in-a-JSON-string); the new shape carries it as structuredContent.
    const payload = res.structuredContent;
    const before = measure({ content: [{ type: 'text', text: JSON.stringify(payload) }] });
    const after = measure({ content: [], structuredContent: payload });
    // Prove it shrank (the dropped double-encoding + text wrapper), never grew.
    expect(after.bytes).toBeLessThan(before.bytes);
    // eslint-disable-next-line no-console
    console.log(
      `[FLUX-950] get_ticket wire bytes: before(jsonResult text)=${before.bytes} ` +
      `after(structuredContent)=${after.bytes} ` +
      `delta=${after.bytes - before.bytes} (${Math.round((1 - after.bytes / before.bytes) * 100)}% smaller); ` +
      `tokensEst ${before.tokensEst}→${after.tokensEst}`,
    );
  });

  it('list_tickets always returns a { tickets } object envelope (never a bare array) as structuredContent', async () => {
    const res = await callTool({ name: 'list_tickets', arguments: {} });
    expect(res.isError).toBeFalsy();
    expect(res.structuredContent).toBeTruthy();
    const tickets = res.structuredContent?.['tickets'];
    expect(Array.isArray(tickets)).toBe(true);
    expect(Array.isArray(tickets) && tickets.some((t) => isRecord(t) && t['id'] === TICKET)).toBe(true);
    expect(res.content).toEqual([]);
  });

  it('get_board_config returns its projection as structuredContent with no text duplicate', async () => {
    const res = await callTool({ name: 'get_board_config', arguments: {} });
    expect(res.isError).toBeFalsy();
    expect(res.structuredContent).toBeTruthy();
    expect(res.structuredContent?.statuses).toEqual(['Todo', 'In Progress', 'Done', 'Archived']);
    expect(res.structuredContent?.tags).toEqual(['mcp', 'engine']);
    expect(res.content).toEqual([]);
  });

  it('a not_found error still carries a usable text message (error path keeps content)', async () => {
    // The error path is unchanged: errorResult still emits a text block + structuredContent,
    // and the SDK skips outputSchema validation for isError results — so a client that
    // ignores structuredContent still reads the human-readable failure.
    const res = await callTool({ name: 'get_ticket', arguments: { ticketId: 'NOPE-404' } });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/not found/i);
    expect(res.structuredContent?.code).toBe('not_found');
  });
});
