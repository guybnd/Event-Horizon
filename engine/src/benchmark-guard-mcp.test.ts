// FLUX-1739: server-side, framework-agnostic guards for `kind:'benchmark'` run tickets.
//
// These are asserted at the MCP handler with NO adapter in play, because that is the only place the
// guarantee actually holds: `disallowedEhToolsForPersona` has exactly one consumer (claude-code.ts),
// so a persona-level denial would leave the other five matrix frameworks free to open PRs. The kind
// refusal is the guarantee; the persona denial is only defence-in-depth.
//
// The `change_status` -> Ready case is the important one and the least obvious: that block is the
// PRIMARY PR-opening path in the engine (every implementation session hits it at end of turn), so an
// unguarded 45-cell suite opens 45 real PRs. It must be SKIPPED while the transition itself still
// SUCCEEDS — Ready is a legitimate terminal state that evidence collection reads.
//
// Follows the in-memory `client.callTool(...)` round-trip pattern from scratch-guard-mcp.test.ts.
import { getWorkspace } from './workspace-context.js';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import matter from 'gray-matter';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { buildMcpServer } from './mcp-server.js';
import { setWorkspaceRoot } from './workspace.js';
import { BENCHMARK_REFUSAL_MARKER } from './models/benchmark.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isCallToolResult(value: unknown): value is CallToolResult {
  return isRecord(value) && Array.isArray(value['content']);
}

describe('Benchmark run-ticket guards (FLUX-1739)', () => {
  let client: Client;
  let server: ReturnType<typeof buildMcpServer>;
  let root: string;
  let fluxDir: string;

  beforeAll(async () => {
    server = buildMcpServer();
    client = new Client({ name: 'eh-benchmark-guard-test', version: '1.0.0' }, { capabilities: {} });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    root = await fs.mkdtemp(path.join(os.tmpdir(), 'eh-benchmark-guard-'));
    fluxDir = path.join(root, '.flux');
    await fs.mkdir(fluxDir, { recursive: true });
    setWorkspaceRoot(root);
  });

  afterAll(async () => {
    await client.close().catch(() => {});
    await server.close().catch(() => {});
    await fs.rm(root, { recursive: true, force: true }).catch(() => {});
  });

  async function callTool(args: Parameters<Client['callTool']>[0]): Promise<CallToolResult> {
    const res: unknown = await client.callTool(args);
    if (!isCallToolResult(res)) throw new Error('expected a content-bearing tool result');
    return res;
  }

  function textOf(res: CallToolResult): string {
    const first = res.content[0];
    return first && first.type === 'text' ? (first.text as string) : '';
  }

  async function seedTask(id: string, extra: Record<string, unknown> = {}) {
    const frontmatter = {
      id,
      title: `benchmark guard test ${id}`,
      status: 'Todo',
      priority: 'None',
      effort: 'None',
      assignee: 'unassigned',
      tags: [] as string[],
      createdBy: 'Agent',
      updatedBy: 'Agent',
      history: [] as unknown[],
      ...extra,
    };
    const filePath = path.join(fluxDir, `${id}.md`);
    await fs.writeFile(filePath, matter.stringify('', frontmatter), 'utf-8');
    getWorkspace().tasks[id] = { ...frontmatter, body: '', id, _path: filePath };
  }

  function dropTask(id: string) {
    delete getWorkspace().tasks[id];
  }

  it('refuses finish_ticket, with the by-design marker so friction does not score it as a failure', async () => {
    const TICKET = 'BENCHGUARD-1';
    await seedTask(TICKET, { kind: 'benchmark', status: 'Ready' });
    try {
      const res = await callTool({
        name: 'finish_ticket',
        arguments: { ticketId: TICKET, implementationLink: 'abc1234', completionComment: 'Done.' },
      });
      expect(res.isError).toBe(true);
      expect(textOf(res)).toContain(BENCHMARK_REFUSAL_MARKER);
      expect(textOf(res)).toContain('benchmark run ticket');
      expect(getWorkspace().tasks[TICKET].status).toBe('Ready'); // refused before any transition
    } finally {
      dropTask(TICKET);
    }
  });

  it('refuses branch(action:"create") — the runner owns the pinned, unpushed branch', async () => {
    const TICKET = 'BENCHGUARD-2';
    await seedTask(TICKET, { kind: 'benchmark' });
    try {
      const res = await callTool({ name: 'branch', arguments: { ticketId: TICKET, action: 'create' } });
      expect(res.isError).toBe(true);
      expect(textOf(res)).toContain(BENCHMARK_REFUSAL_MARKER);
      expect(getWorkspace().tasks[TICKET].branch).toBeUndefined();
    } finally {
      dropTask(TICKET);
    }
  });

  it('refuses merge_tickets in either direction', async () => {
    const BENCH = 'BENCHGUARD-3';
    const REAL = 'BENCHGUARD-4';
    await seedTask(BENCH, { kind: 'benchmark' });
    await seedTask(REAL);
    try {
      const asSource = await callTool({ name: 'merge_tickets', arguments: { into: REAL, from: [BENCH] } });
      expect(asSource.isError).toBe(true);
      expect(textOf(asSource)).toContain(BENCHMARK_REFUSAL_MARKER);

      const asSurvivor = await callTool({ name: 'merge_tickets', arguments: { into: BENCH, from: [REAL] } });
      expect(asSurvivor.isError).toBe(true);
      expect(textOf(asSurvivor)).toContain(BENCHMARK_REFUSAL_MARKER);
    } finally {
      dropTask(BENCH);
      dropTask(REAL);
    }
  });

  it('change_status -> Ready SUCCEEDS but opens no PR and stamps no implementationLink or open-pr swimlane', async () => {
    const TICKET = 'BENCHGUARD-5';
    // A benchmark run always has a branch by construction, which is exactly what arms the PR block.
    await seedTask(TICKET, { kind: 'benchmark', status: 'In Progress', branch: 'flux/BENCHGUARD-5-run' });
    try {
      const res = await callTool({
        name: 'change_status',
        arguments: { ticketId: TICKET, newStatus: 'Ready', comment: 'Run finished.' },
      });
      expect(res.isError).toBeFalsy();

      const task = getWorkspace().tasks[TICKET];
      // The transition itself must still succeed — Ready is a real terminal state for a run, and
      // evidence collection reads that status.
      expect(task.status).toBe('Ready');
      // ...but nothing PR-shaped may have happened.
      expect(task.implementationLink).toBeUndefined();
      expect(task.swimlane).not.toBe('open-pr');
      // ...and Temper must not have armed its auto-review loop. A run has a branch by construction,
      // so without the kind guard every cell would spawn a review session, burn tokens, hold a
      // worktree slot, and a changes-requested verdict would bounce the ticket back to In Progress —
      // overwriting the terminal status the run is scored on.
      expect(task.tempering).not.toBe(true);
    } finally {
      dropTask(TICKET);
    }
  });

  it('records a marked activity entry in place of the skipped PR, so the skip is not silent', async () => {
    const TICKET = 'BENCHGUARD-6';
    await seedTask(TICKET, { kind: 'benchmark', status: 'In Progress', branch: 'flux/BENCHGUARD-6-run' });
    try {
      await callTool({
        name: 'change_status',
        arguments: { ticketId: TICKET, newStatus: 'Ready', comment: 'Run finished.' },
      });
      const history = (getWorkspace().tasks[TICKET].history ?? []) as { comment?: string }[];
      const marked = history.filter((e) => typeof e.comment === 'string' && e.comment.includes(BENCHMARK_REFUSAL_MARKER));
      expect(marked.length).toBeGreaterThan(0);
      expect(marked.some((e) => /never pushed or merged/.test(e.comment!))).toBe(true);
    } finally {
      dropTask(TICKET);
    }
  });

  it('hides benchmark tickets from the list_tickets active screen', async () => {
    const BENCH = 'BENCHGUARD-7';
    const REAL = 'BENCHGUARD-8';
    await seedTask(BENCH, { kind: 'benchmark' });
    await seedTask(REAL);
    try {
      const res = await callTool({ name: 'list_tickets', arguments: {} });
      const text = textOf(res);
      expect(text).toContain(REAL);
      expect(text).not.toContain(BENCH);
    } finally {
      dropTask(BENCH);
      dropTask(REAL);
    }
  });

  it('leaves non-benchmark tickets untouched by every guard above', async () => {
    const TICKET = 'BENCHGUARD-9';
    await seedTask(TICKET, { status: 'Ready' });
    try {
      const res = await callTool({
        name: 'finish_ticket',
        arguments: { ticketId: TICKET, implementationLink: 'abc1234', completionComment: 'Done.' },
      });
      expect(textOf(res)).not.toContain(BENCHMARK_REFUSAL_MARKER);
    } finally {
      dropTask(TICKET);
    }
  });
});
