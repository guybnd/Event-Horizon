import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildMcpServer } from './mcp-server.js';
import { getWorkspace } from './workspace-context.js';

/**
 * FLUX-951: server-provided MCP prompts (/mcp__event-horizon__* slash commands).
 * Covers prompts/list (four prompts + argument schemas), prompts/get (phase
 * bodies sourced live from .docs/skills/event-horizon-<module>.md with the
 * frontmatter stripped and a ticket/version directive appended), and ticketId
 * argument completion (active tickets only), over a real in-memory round-trip.
 */
describe('MCP prompts (FLUX-951)', () => {
  const ACTIVE = 'PROMPT-1';
  const DONE = 'PROMPT-2';
  let client: Client;
  let server: ReturnType<typeof buildMcpServer>;

  beforeAll(async () => {
    // Seed one active and one terminal ticket: the grounding header and the
    // completion filter both read getWorkspace().tasks directly.
    getWorkspace().tasks[ACTIVE] = { id: ACTIVE, status: 'Todo', title: 'prompt harness ticket', history: [] };
    getWorkspace().tasks[DONE] = { id: DONE, status: 'Done', title: 'terminal prompt ticket', history: [] };

    server = buildMcpServer();
    client = new Client({ name: 'eh-prompts-test', version: '1.0.0' }, { capabilities: {} });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  });

  afterAll(async () => {
    delete getWorkspace().tasks[ACTIVE];
    delete getWorkspace().tasks[DONE];
    await client.close().catch(() => {});
    await server.close().catch(() => {});
  });

  /** Narrow the content union down to the text variant these prompts always return. */
  async function promptText(name: string, args?: Record<string, string>): Promise<string> {
    const res = await client.getPrompt({ name, arguments: args });
    expect(res.messages).toHaveLength(1);
    const msg = res.messages[0];
    if (!msg) throw new Error('expected one prompt message');
    expect(msg.role).toBe('user');
    if (msg.content.type !== 'text') throw new Error(`expected text content, got ${msg.content.type}`);
    return msg.content.text;
  }

  it('prompts/list returns the four prompts with title, description, and argument schemas', async () => {
    const { prompts } = await client.listPrompts();
    const byName = Object.fromEntries(prompts.map((p) => [p.name, p]));
    const mustHave = (name: string) => {
      const p = byName[name];
      if (!p) throw new Error(`prompt '${name}' should be listed`);
      expect(p.title).toBeTruthy();
      expect(p.description).toBeTruthy();
      return p;
    };
    expect(mustHave('groom').arguments).toEqual([expect.objectContaining({ name: 'ticketId', required: true })]);
    expect(mustHave('implement').arguments).toEqual([expect.objectContaining({ name: 'ticketId', required: true })]);
    expect(mustHave('release').arguments).toEqual([expect.objectContaining({ name: 'version', required: true })]);
    expect(mustHave('rebase-board').arguments ?? []).toEqual([]);
  });

  it('groom: grooming module body (frontmatter stripped) + grounding header + ticket directive', async () => {
    const text = await promptText('groom', { ticketId: ACTIVE });
    // Stable phrase from .docs/skills/event-horizon-grooming.md — read live, not re-authored.
    expect(text).toContain('Grooming Workflow');
    // Frontmatter stripped: the YAML block (title: Event Horizon Grooming) must not leak through.
    expect(text).not.toContain('title: Event Horizon Grooming');
    // Grounding header (the seeded ticket resolves) and the read-first directive.
    expect(text).toContain(`Ticket: ${ACTIVE} — prompt harness ticket (Todo)`);
    expect(text).toContain(`get_ticket('${ACTIVE}')`);
  });

  it('groom: an unknown ticket id still renders (no grounding header, directive intact)', async () => {
    const text = await promptText('groom', { ticketId: 'NOPE-404' });
    expect(text).not.toContain('Ticket: NOPE-404');
    expect(text).toContain("get_ticket('NOPE-404')");
    expect(text).toContain('Grooming Workflow');
  });

  it('implement: implementation module body + ticket directive', async () => {
    const text = await promptText('implement', { ticketId: ACTIVE });
    expect(text).toContain('Implementation Workflow');
    expect(text).toContain(`get_ticket('${ACTIVE}')`);
    expect(text).toContain('follow the implementation workflow above');
  });

  it('release: release module body with the version interpolated', async () => {
    const text = await promptText('release', { version: 'v9.9.9' });
    expect(text).toContain('Release Workflow');
    expect(text).toContain('v9.9.9');
  });

  it('rebase-board: hand-authored triage instruction pointing at propose_board_rebase', async () => {
    const text = await promptText('rebase-board');
    expect(text).toContain('list_tickets');
    expect(text).toContain('propose_board_rebase');
  });

  it('completes ticketId from active (non-terminal) tickets only', async () => {
    const res = await client.complete({
      ref: { type: 'ref/prompt', name: 'groom' },
      argument: { name: 'ticketId', value: 'PROMPT' },
    });
    expect(res.completion.values).toContain(ACTIVE);
    expect(res.completion.values).not.toContain(DONE);
  });
});
