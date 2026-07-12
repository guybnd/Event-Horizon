// FLUX-1271: integration coverage for finish_ticket's merge-lock at the actual MCP-handler level
// (previously only the pure hasHumanGateTouch unit was exercised directly — see
// models/gate-policy.test.ts). Follows the in-memory `client.callTool(...)` round-trip pattern from
// mcp-completion-handoff.test.ts / furnace-batch-mcp.test.ts.
//
// This also pins the fix for the spoofing gap FLUX-1271 raised: add_note's freeform `user` param
// cannot forge a "human touch" anymore — mcp-server.ts stamps its own comment entries
// `selfAttested`, and hasHumanGateTouch ignores those regardless of the claimed `user`.
//
// checkGhAuth is mocked to `false` so the "past the merge-lock" case is deterministic without a
// real `gh` — it lets finish_ticket reach (and fail at) the next, differently-worded gh-auth check,
// which is enough to prove the merge-lock itself did not block the call.
vi.mock('./branch-manager.js', () => ({ checkGhAuth: vi.fn().mockResolvedValue(false) }));

import { getWorkspace } from './workspace-context.js';
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import matter from 'gray-matter';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { buildMcpServer } from './mcp-server.js';

import { setWorkspaceRoot } from './workspace.js';
import { getConfig } from './config.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** Mirrors the narrowing helper used by the other MCP-handler integration tests — `callTool`'s
 *  declared return type is wider than the SDK's own `CallToolResult`. */
function isCallToolResult(value: unknown): value is CallToolResult {
  return isRecord(value) && Array.isArray(value['content']);
}

describe('finish_ticket merge-lock — MCP handler integration (FLUX-1271)', () => {
  let client: Client;
  let server: ReturnType<typeof buildMcpServer>;
  let root: string;
  let fluxDir: string;

  beforeAll(async () => {
    server = buildMcpServer();
    client = new Client({ name: 'eh-merge-lock-test', version: '1.0.0' }, { capabilities: {} });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    root = await fs.mkdtemp(path.join(os.tmpdir(), 'eh-merge-lock-'));
    fluxDir = path.join(root, '.flux');
    await fs.mkdir(fluxDir, { recursive: true });
    setWorkspaceRoot(root);
  });

  afterAll(async () => {
    await client.close().catch(() => {});
    await server.close().catch(() => {});
    await fs.rm(root, { recursive: true, force: true }).catch(() => {});
  });

  // FLUX-1290: this whole describe block exercises the merge-lock's ON behavior (today's exact
  // pre-FLUX-1290 refusal), which since this ticket now requires `blockAgentPrMerges: true` to
  // fire at all — the flag itself defaults to `false`. See the sibling describe block below for
  // default-off coverage.
  beforeEach(() => {
    getConfig().blockAgentPrMerges = true;
  });

  afterEach(() => {
    delete getConfig().blockAgentPrMerges;
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

  /** Writes a real ticket file (so `updateTaskWithHistory`'s disk write has a valid `_path`) and
   *  seeds `tasksCache` the same way `loadTask`/`createTask` would — a Ready, branch-bound ticket,
   *  which is exactly the shape finish_ticket's merge-lock check applies to. */
  async function seedTask(id: string, extra: Record<string, unknown> = {}) {
    const frontmatter = {
      id,
      title: `merge-lock test ${id}`,
      status: 'Ready',
      priority: 'None',
      effort: 'None',
      assignee: 'unassigned',
      tags: [] as string[],
      createdBy: 'Agent',
      updatedBy: 'Agent',
      history: [] as unknown[],
      branch: `flux/${id.toLowerCase()}`,
      ...extra,
    };
    const filePath = path.join(fluxDir, `${id}.md`);
    await fs.writeFile(filePath, matter.stringify('', frontmatter), 'utf-8');
    getWorkspace().tasks[id] = { ...frontmatter, body: '', id, _path: filePath };
  }

  function dropTask(id: string) {
    delete getWorkspace().tasks[id];
  }

  it('refuses to finish a branch ticket with no human touch in its history', async () => {
    const TICKET = 'MERGELOCK-1';
    await seedTask(TICKET);
    try {
      const res = await callTool({
        name: 'finish_ticket',
        arguments: { ticketId: TICKET, implementationLink: 'abc1234', completionComment: 'Done.' },
      });
      expect(res.isError).toBe(true);
      expect(textOf(res)).toContain('merge-lock');
      expect(getWorkspace().tasks[TICKET].status).toBe('Ready'); // refused before any transition happened
    } finally {
      dropTask(TICKET);
    }
  });

  it('add_note cannot forge a human touch — the merge-lock still refuses after a spoofed comment', async () => {
    const TICKET = 'MERGELOCK-2';
    await seedTask(TICKET);
    try {
      const noteRes = await callTool({
        name: 'add_note',
        arguments: { ticketId: TICKET, type: 'comment', user: 'SomeHuman', message: 'Looks good to me!' },
      });
      expect(noteRes.isError).toBeFalsy();

      const res = await callTool({
        name: 'finish_ticket',
        arguments: { ticketId: TICKET, implementationLink: 'abc1234', completionComment: 'Done.' },
      });
      expect(res.isError).toBe(true);
      expect(textOf(res)).toContain('merge-lock');
    } finally {
      dropTask(TICKET);
    }
  });

  it('succeeds past the merge-lock once a genuinely human-authored entry exists', async () => {
    const TICKET = 'MERGELOCK-3';
    // A comment seeded directly onto history (not via add_note) simulates the one write path the
    // FLUX-1271 fix does NOT mark selfAttested — the portal's own REST write — which is the genuine
    // human-touch signal the merge-lock is meant to require.
    await seedTask(TICKET, {
      history: [{ type: 'comment', user: 'guybnd', comment: 'Reviewed, ship it.', date: new Date().toISOString() }],
    });
    try {
      const res = await callTool({
        name: 'finish_ticket',
        arguments: { ticketId: TICKET, implementationLink: 'abc1234', completionComment: 'Done.' },
      });
      // Past the merge-lock, finish_ticket hits the (mocked-false) gh-auth check next — a
      // differently-worded refusal that proves the lock itself did not block this call.
      expect(res.isError).toBe(true);
      expect(textOf(res)).not.toContain('merge-lock');
      expect(textOf(res)).toContain('gh not configured');
      expect(getWorkspace().tasks[TICKET].status).toBe('In Progress');
    } finally {
      dropTask(TICKET);
    }
  });
});

describe('finish_ticket merge-lock — blockAgentPrMerges gate (FLUX-1290)', () => {
  let client: Client;
  let server: ReturnType<typeof buildMcpServer>;
  let root: string;
  let fluxDir: string;

  beforeAll(async () => {
    server = buildMcpServer();
    client = new Client({ name: 'eh-merge-lock-flag-test', version: '1.0.0' }, { capabilities: {} });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    root = await fs.mkdtemp(path.join(os.tmpdir(), 'eh-merge-lock-flag-'));
    fluxDir = path.join(root, '.flux');
    await fs.mkdir(fluxDir, { recursive: true });
    setWorkspaceRoot(root);
  });

  afterAll(async () => {
    await client.close().catch(() => {});
    await server.close().catch(() => {});
    await fs.rm(root, { recursive: true, force: true }).catch(() => {});
  });

  afterEach(() => {
    delete getConfig().blockAgentPrMerges;
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
      title: `merge-lock flag test ${id}`,
      status: 'Ready',
      priority: 'None',
      effort: 'None',
      assignee: 'unassigned',
      tags: [] as string[],
      createdBy: 'Agent',
      updatedBy: 'Agent',
      history: [] as unknown[],
      branch: `flux/${id.toLowerCase()}`,
      ...extra,
    };
    const filePath = path.join(fluxDir, `${id}.md`);
    await fs.writeFile(filePath, matter.stringify('', frontmatter), 'utf-8');
    getWorkspace().tasks[id] = { ...frontmatter, body: '', id, _path: filePath };
  }

  function dropTask(id: string) {
    delete getWorkspace().tasks[id];
  }

  it('on a fresh/unmigrated config (flag unset), skips the merge-lock — no human touch required', async () => {
    expect(getConfig().blockAgentPrMerges).toBeUndefined(); // fresh default, never explicitly set
    const TICKET = 'MERGEFLAG-1';
    await seedTask(TICKET);
    try {
      const res = await callTool({
        name: 'finish_ticket',
        arguments: { ticketId: TICKET, implementationLink: 'abc1234', completionComment: 'Done.' },
      });
      // Past the merge-lock, finish_ticket hits the (mocked-false) gh-auth check next — proving the
      // lock itself did not block this call despite zero human touch in history.
      expect(textOf(res)).not.toContain('merge-lock');
      expect(textOf(res)).toContain('gh not configured');
    } finally {
      dropTask(TICKET);
    }
  });

  it('with blockAgentPrMerges: false explicitly, skips the merge-lock the same way', async () => {
    getConfig().blockAgentPrMerges = false;
    const TICKET = 'MERGEFLAG-2';
    await seedTask(TICKET);
    try {
      const res = await callTool({
        name: 'finish_ticket',
        arguments: { ticketId: TICKET, implementationLink: 'abc1234', completionComment: 'Done.' },
      });
      expect(textOf(res)).not.toContain('merge-lock');
      expect(textOf(res)).toContain('gh not configured');
    } finally {
      dropTask(TICKET);
    }
  });

  it('with blockAgentPrMerges: true, byte-for-byte identical refusal to the default-on legacy behavior', async () => {
    getConfig().blockAgentPrMerges = true;
    const TICKET = 'MERGEFLAG-3';
    await seedTask(TICKET);
    try {
      const res = await callTool({
        name: 'finish_ticket',
        arguments: { ticketId: TICKET, implementationLink: 'abc1234', completionComment: 'Done.' },
      });
      expect(res.isError).toBe(true);
      expect(textOf(res)).toBe(
        `Cannot finish ${TICKET} — merge-lock: no human-authored comment or status change found in its history yet. ` +
        `A human must interact with this ticket (comment, review, or move its status) before its PR can be merged — this is a structural "merge is always human" guarantee, not a preference. ` +
        `Ask a human to review ${TICKET} (or leave a comment on it), then finish again.`
      );
      expect(getWorkspace().tasks[TICKET].status).toBe('Ready');
    } finally {
      dropTask(TICKET);
    }
  });
});
