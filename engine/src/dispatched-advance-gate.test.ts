// FLUX-850: a dispatched (unattended, no-human-present) session that also runs with
// `skipPermissions: true` — spawned via the MCP `start_session` tool, a board-rebase `dispatch`
// verb, or Furnace's `dispatchSession` — must not be able to silently advance a ticket past Ready.
// Before this ticket, the permission gate (`permission_prompt`, mcp-action-dispatch.test.ts) only
// ever ran for GATED sessions; a skip-permission session bypassed it entirely and a notification was
// the only signal (the FLUX-840/841/844 incident). An ordinary interactive session (portal chat, or
// a human clicking Groom/Implement/Review/Finalize) must still be able to move its own ticket to
// Ready/Done exactly as before — those never set `CliSessionRecord.dispatched`.
//
// Pure-predicate coverage first (mirrors mcp-plan-gate.test.ts's idiom for `evaluatePlanGateTrigger`),
// then a real `change_status`/`finish_ticket` MCP-handler round-trip (mirrors
// mcp-plan-gate-eager-stop-handler.test.ts's InMemoryTransport + hand-registered `cliSessionsById`
// harness) proving the gate actually wires into both tools.

import { getWorkspace } from './workspace-context.js';
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import matter from 'gray-matter';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { CliSessionRecord, CliSessionStatus } from './agents/types.js';
import { buildMcpServer, hasDispatchedSkipPermissionSession, shouldGateDispatchedAdvance } from './mcp-server.js';
import { setWorkspaceRoot } from './workspace.js';
import { cliSessionsById, registerSession } from './session-store.js';
import { clearNotifications } from './notifications.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isCallToolResult(value: unknown): value is CallToolResult {
  return isRecord(value) && Array.isArray(value['content']);
}

function fakeSession(overrides: Partial<CliSessionRecord> & { status: CliSessionStatus }): Pick<CliSessionRecord, 'status' | 'dispatched' | 'skipPermissions'> {
  return { dispatched: false, skipPermissions: false, ...overrides };
}

describe('hasDispatchedSkipPermissionSession (FLUX-850)', () => {
  it('true only when a RUNNING session is both dispatched and skip-permissions', () => {
    expect(hasDispatchedSkipPermissionSession([fakeSession({ status: 'running', dispatched: true, skipPermissions: true })])).toBe(true);
  });

  it('false for a dispatched session that is gated (not skip-permissions) — the pre-existing permission_prompt gate already covers that case', () => {
    expect(hasDispatchedSkipPermissionSession([fakeSession({ status: 'running', dispatched: true, skipPermissions: false })])).toBe(false);
  });

  it('false for an ordinary interactive skip-permission session (dispatched unset) — a human clicked Start/Send', () => {
    expect(hasDispatchedSkipPermissionSession([fakeSession({ status: 'running', dispatched: false, skipPermissions: true })])).toBe(false);
    expect(hasDispatchedSkipPermissionSession([fakeSession({ status: 'running', skipPermissions: true })])).toBe(false);
  });

  it('false for a dispatched+skip-permission session that is not currently running (waiting-input, completed)', () => {
    expect(hasDispatchedSkipPermissionSession([fakeSession({ status: 'waiting-input', dispatched: true, skipPermissions: true })])).toBe(false);
    expect(hasDispatchedSkipPermissionSession([fakeSession({ status: 'completed', dispatched: true, skipPermissions: true })])).toBe(false);
  });

  it('true if ANY session in a mixed set qualifies', () => {
    expect(hasDispatchedSkipPermissionSession([
      fakeSession({ status: 'running', dispatched: false, skipPermissions: true }),
      fakeSession({ status: 'running', dispatched: true, skipPermissions: true }),
    ])).toBe(true);
  });

  it('false for an empty session list', () => {
    expect(hasDispatchedSkipPermissionSession([])).toBe(false);
  });
});

describe('shouldGateDispatchedAdvance (FLUX-850)', () => {
  const base = { hasDispatchedSkipPermissionSession: true, readyStatus: 'Ready' } as const;

  it('gates a forward move into Ready', () => {
    expect(shouldGateDispatchedAdvance({ ...base, currentStatus: 'In Progress', newStatus: 'Ready' })).toBe(true);
  });

  it('gates a direct move to the literal "Done" status (bypassing finish_ticket)', () => {
    expect(shouldGateDispatchedAdvance({ ...base, currentStatus: 'Ready', newStatus: 'Done' })).toBe(true);
  });

  it('never gates when no dispatched skip-permission session is active — the interactive-session escape hatch', () => {
    expect(shouldGateDispatchedAdvance({ ...base, hasDispatchedSkipPermissionSession: false, currentStatus: 'In Progress', newStatus: 'Ready' })).toBe(false);
  });

  it('never gates a move to any status other than Ready/Done (e.g. Require Input, In Progress)', () => {
    expect(shouldGateDispatchedAdvance({ ...base, currentStatus: 'Todo', newStatus: 'In Progress' })).toBe(false);
    expect(shouldGateDispatchedAdvance({ ...base, currentStatus: 'In Progress', newStatus: 'Require Input' })).toBe(false);
  });

  it('never gates a no-op re-affirm (current status already equals the target)', () => {
    expect(shouldGateDispatchedAdvance({ ...base, currentStatus: 'Ready', newStatus: 'Ready' })).toBe(false);
    expect(shouldGateDispatchedAdvance({ ...base, currentStatus: 'Done', newStatus: 'Done' })).toBe(false);
  });
});

describe('change_status / finish_ticket — dispatched hard gate (FLUX-850 handler-level)', () => {
  let client: Client;
  let server: ReturnType<typeof buildMcpServer>;
  let root: string;
  let fluxDir: string;
  let sessionSeq = 0;

  beforeAll(async () => {
    server = buildMcpServer();
    client = new Client({ name: 'eh-dispatched-gate-test', version: '1.0.0' }, { capabilities: {} });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    root = await fs.mkdtemp(path.join(os.tmpdir(), 'eh-dispatched-gate-'));
    fluxDir = path.join(root, '.flux');
    await fs.mkdir(fluxDir, { recursive: true });
    setWorkspaceRoot(root);
  });

  afterAll(async () => {
    await client.close().catch(() => {});
    await server.close().catch(() => {});
    await fs.rm(root, { recursive: true, force: true }).catch(() => {});
  });

  beforeEach(() => {
    cliSessionsById.clear();
    clearNotifications();
    sessionSeq = 0;
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

  /** Writes a real, branchless ticket file (so `updateTaskWithHistory`'s disk write has a valid
   *  `_path`) — branchless keeps both `change_status` (no PR-creation side effects) and
   *  `finish_ticket` (no gh/branch merge path) focused purely on the FLUX-850 gate itself. A
   *  `baselineCommit` sidesteps finish_ticket's `resolveCommit('HEAD~1')` lazy-repair, matching
   *  mcp-completion-handoff.test.ts's "safe no-op" trick. */
  async function seedTask(id: string, status: string, extra: Record<string, unknown> = {}) {
    const frontmatter = {
      id,
      title: `dispatched-gate test ${id}`,
      status,
      priority: 'None',
      effort: 'None',
      assignee: 'unassigned',
      tags: [] as string[],
      createdBy: 'Agent',
      updatedBy: 'Agent',
      history: [] as unknown[],
      baselineCommit: 'not-a-real-commit-for-test',
      ...extra,
    };
    const filePath = path.join(fluxDir, `${id}.md`);
    await fs.writeFile(filePath, matter.stringify('', frontmatter), 'utf-8');
    getWorkspace().tasks[id] = { ...frontmatter, body: '', id, _path: filePath };
  }

  function dropTask(id: string) {
    delete getWorkspace().tasks[id];
  }

  /** Registers a RUNNING session on `taskId` — the same wiring `getActiveSessionsForTask` reads
   *  in production (`cliSessionsById` + the id index `registerSession` maintains). */
  function putSession(taskId: string, opts: { dispatched?: boolean; skipPermissions?: boolean }): string {
    const sid = `sess-${++sessionSeq}`;
    cliSessionsById.set(sid, {
      id: sid,
      taskId,
      status: 'running',
      dispatched: opts.dispatched ?? false,
      skipPermissions: opts.skipPermissions ?? false,
    } as unknown as CliSessionRecord);
    registerSession(taskId, sid);
    return sid;
  }

  it('change_status: a dispatched+skip-permission session cannot move a ticket to Ready — redirected to Require Input instead', async () => {
    const TICKET = 'DISPATCHGATE-1';
    await seedTask(TICKET, 'In Progress');
    const sid = putSession(TICKET, { dispatched: true, skipPermissions: true });
    try {
      const res = await callTool({
        name: 'change_status',
        arguments: { ticketId: TICKET, newStatus: 'Ready', comment: 'Implemented and validated.' },
      });
      expect(res.isError).toBeFalsy();
      expect(textOf(res)).toMatch(/hard gate/i);

      const task = getWorkspace().tasks[TICKET];
      expect(task.status).toBe('In Progress'); // never advanced to Ready
      expect(task.swimlane).toBe('require-input');
      const lastComment = [...(task.history as { type?: string; comment?: string }[])].reverse().find((h) => h.type === 'comment');
      expect(lastComment?.comment).toContain('Implemented and validated.');

      const session = cliSessionsById.get(sid);
      expect(session?.status).toBe('waiting-input');
      expect(session?.pausedForInput).toBe(true);
    } finally {
      dropTask(TICKET);
    }
  });

  it('change_status: an ordinary interactive session (no dispatched session active) moves the ticket to Ready normally', async () => {
    const TICKET = 'DISPATCHGATE-2';
    await seedTask(TICKET, 'In Progress');
    // No active session registered at all — the common case for these tool-call-level tests, and
    // equally representative of a human-driven portal chat session (never marked `dispatched`).
    try {
      const res = await callTool({
        name: 'change_status',
        arguments: { ticketId: TICKET, newStatus: 'Ready', comment: 'Implemented and validated.' },
      });
      expect(res.isError).toBeFalsy();
      expect(getWorkspace().tasks[TICKET].status).toBe('Ready');
      expect(getWorkspace().tasks[TICKET].swimlane).toBeFalsy();
    } finally {
      dropTask(TICKET);
    }
  });

  it('change_status: a Furnace-style session (skip-permissions, but never marked `dispatched` — see furnace-stoker.ts dispatchSession, FLUX-850 review follow-up) moves the ticket to Ready normally, same as an ordinary interactive session', async () => {
    const TICKET = 'DISPATCHGATE-FURNACE';
    await seedTask(TICKET, 'In Progress');
    putSession(TICKET, { dispatched: false, skipPermissions: true });
    try {
      const res = await callTool({
        name: 'change_status',
        arguments: { ticketId: TICKET, newStatus: 'Ready', comment: 'Implemented and validated.' },
      });
      expect(res.isError).toBeFalsy();
      expect(textOf(res)).not.toMatch(/hard gate/i);
      expect(getWorkspace().tasks[TICKET].status).toBe('Ready');
      expect(getWorkspace().tasks[TICKET].swimlane).toBeFalsy();
    } finally {
      dropTask(TICKET);
    }
  });

  it('change_status: a dispatched session that is GATED (not skip-permissions) is unaffected — the pre-existing permission_prompt gate already covers it', async () => {
    const TICKET = 'DISPATCHGATE-3';
    await seedTask(TICKET, 'In Progress');
    putSession(TICKET, { dispatched: true, skipPermissions: false });
    try {
      const res = await callTool({
        name: 'change_status',
        arguments: { ticketId: TICKET, newStatus: 'Ready', comment: 'Implemented and validated.' },
      });
      expect(res.isError).toBeFalsy();
      expect(getWorkspace().tasks[TICKET].status).toBe('Ready');
    } finally {
      dropTask(TICKET);
    }
  });

  it('change_status: re-affirming Ready with a dispatched session active is a no-op, not a re-trigger', async () => {
    const TICKET = 'DISPATCHGATE-4';
    await seedTask(TICKET, 'Ready');
    putSession(TICKET, { dispatched: true, skipPermissions: true });
    try {
      const res = await callTool({
        name: 'change_status',
        arguments: { ticketId: TICKET, newStatus: 'Ready', comment: 'Still ready.' },
      });
      expect(res.isError).toBeFalsy();
      expect(textOf(res)).not.toMatch(/hard gate/i);
      expect(getWorkspace().tasks[TICKET].status).toBe('Ready');
      expect(getWorkspace().tasks[TICKET].swimlane).toBeFalsy();
    } finally {
      dropTask(TICKET);
    }
  });

  it('finish_ticket: a dispatched+skip-permission session cannot merge to Done — redirected to Require Input, ticket stays in Ready', async () => {
    const TICKET = 'DISPATCHGATE-5';
    await seedTask(TICKET, 'Ready');
    const sid = putSession(TICKET, { dispatched: true, skipPermissions: true });
    try {
      const res = await callTool({
        name: 'finish_ticket',
        arguments: { ticketId: TICKET, implementationLink: 'abc1234', completionComment: 'Shipped.' },
      });
      expect(res.isError).toBeFalsy();
      expect(textOf(res)).toMatch(/hard gate/i);

      const task = getWorkspace().tasks[TICKET];
      expect(task.status).toBe('Ready'); // never advanced to Done
      expect(task.swimlane).toBe('require-input');

      const session = cliSessionsById.get(sid);
      expect(session?.status).toBe('waiting-input');
    } finally {
      dropTask(TICKET);
    }
  });

  it('finish_ticket: an ordinary interactive session (no dispatched session active) finishes the ticket normally', async () => {
    const TICKET = 'DISPATCHGATE-6';
    await seedTask(TICKET, 'Ready');
    try {
      const res = await callTool({
        name: 'finish_ticket',
        arguments: { ticketId: TICKET, implementationLink: 'abc1234', completionComment: 'Shipped.' },
      });
      expect(res.isError).toBeFalsy();
      expect(getWorkspace().tasks[TICKET].status).toBe('Done');
    } finally {
      dropTask(TICKET);
    }
  });
});
