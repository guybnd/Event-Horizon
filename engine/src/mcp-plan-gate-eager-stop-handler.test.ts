// FLUX-1330 (FLUX-1320 follow-up): FLUX-1320's gate-runner tests (gate-runner.test.ts, `describe(
// 'resolvePlanVerdictNow (FLUX-1320)')`) all call `resolvePlanVerdictNow` directly and hand-set
// `tasksCache[id].planReviewState` — none of them drive the actual wiring in the `change_status`
// handler (mcp-server.ts, the FLUX-1320 block right after the `updateTaskWithHistory` persist) that
// calls `resolvePlanVerdictNow` at all. If a refactor drops, moves, or mis-conditions that call, no
// test fails — the system silently degrades back to the 5-15s `planGateRunning` tick lag the ticket
// existed to fix. This file drives the eager stop through the REAL `change_status` MCP tool call.
//
// Mirrors mcp-nodiffexpected-handler.test.ts's InMemoryTransport round-trip harness (real task-store,
// a temp-dir workspace) and gate-runner.test.ts's `furnace-stoker.js` mock (so `dispatchSession` never
// spawns a real session) plus its Grooming-seed / `startPlanGateNow` / running-review-session setup.

import { getWorkspace } from './workspace-context.js';
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import matter from 'gray-matter';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { CliSessionStatus } from './agents/types.js';

let sessionSeq = 0;
const dispatchSession = vi.fn(async (_ticketId: string, _phase: string, _opts?: unknown) => ({ sid: `sess-${++sessionSeq}` }));
const parkTicketOnBoard = vi.fn(async (_ticketId: string, _reason: string, _opts?: unknown) => {});

// Same mocking idiom as gate-runner.test.ts: only the I/O edges the gate runner drives through
// furnace-stoker.js are stubbed; everything else (the batch tools mcp-server.ts itself imports from
// this module) passes through via importOriginal so unrelated handler code keeps working normally.
vi.mock('./furnace-stoker.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./furnace-stoker.js')>();
  return {
    ...actual,
    dispatchSession: (t: string, p: string, o?: unknown) => dispatchSession(t, p, o),
    resumeOrDispatchSession: async (t: string, p: string, o?: unknown) => {
      const r = await dispatchSession(t, p, o);
      return { ...r, resumed: false };
    },
    parkTicketOnBoard: (t: string, r: string, o?: unknown) => parkTicketOnBoard(t, r, o),
  };
});

import { buildMcpServer } from './mcp-server.js';
import { setWorkspaceRoot } from './workspace.js';
import { getConfig } from './config.js';
import { startPlanGateNow, isGateRunning, __resetGateRunnerForTests } from './gate-runner.js';
import { cliSessionsById } from './session-store.js';
import { clearNotifications } from './notifications.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isCallToolResult(value: unknown): value is CallToolResult {
  return isRecord(value) && Array.isArray(value['content']);
}

describe('change_status -> resolvePlanVerdictNow eager-stop wiring (FLUX-1320 handler-level, FLUX-1330)', () => {
  let client: Client;
  let server: ReturnType<typeof buildMcpServer>;
  let root: string;
  let fluxDir: string;

  beforeAll(async () => {
    server = buildMcpServer();
    client = new Client({ name: 'eh-plan-gate-eager-stop-test', version: '1.0.0' }, { capabilities: {} });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  });

  afterAll(async () => {
    await client.close().catch(() => {});
    await server.close().catch(() => {});
    await fs.rm(root, { recursive: true, force: true }).catch(() => {});
  });

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'eh-plan-gate-eager-stop-'));
    fluxDir = path.join(root, '.flux');
    await fs.mkdir(fluxDir, { recursive: true });
    setWorkspaceRoot(root);
    __resetGateRunnerForTests();
    cliSessionsById.clear();
    dispatchSession.mockClear();
    parkTicketOnBoard.mockClear();
    sessionSeq = 0;
    clearNotifications();
    getConfig().gatePolicy = { boardDefault: { plan: 'auto', review: 'you' } };
    getConfig().requireInputStatus = 'Require Input';
    getConfig().columns = [
      { name: 'Grooming' }, { name: 'Todo' }, { name: 'In Progress' }, { name: 'Ready' }, { name: 'Done' },
    ];
    getConfig().planReviewDepth = 'auto';
  });

  async function callTool(args: Parameters<Client['callTool']>[0]): Promise<CallToolResult> {
    const res: unknown = await client.callTool(args);
    if (!isCallToolResult(res)) throw new Error('expected a content-bearing tool result');
    return res;
  }

  /** Real file-backed task, mirroring mcp-nodiffexpected-handler.test.ts's seedTask. */
  async function seedGroomingTask(id: string, extra: Record<string, unknown> = {}) {
    const frontmatter = {
      id,
      title: `plan-gate eager-stop handler test ${id}`,
      status: 'Grooming',
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
    await fs.writeFile(filePath, matter.stringify('plan body', frontmatter), 'utf-8');
    getWorkspace().tasks[id] = { ...frontmatter, body: 'plan body', id, _path: filePath };
  }

  function dropTask(id: string) {
    delete getWorkspace().tasks[id];
  }

  function putRunningReviewSession(): void {
    // The reviewer is still mid-turn — the 5s tick could not have observed a verdict yet, so any
    // stop we see here can only have come from the eager `resolvePlanVerdictNow` call inside the
    // `change_status` handler itself, never from a `gateRunnerTick`.
    const sid = `sess-${sessionSeq}`;
    cliSessionsById.set(sid, { id: sid, phase: 'review', status: 'running' as CliSessionStatus } as unknown as ReturnType<typeof cliSessionsById.get> & object);
  }

  it('loop-confirm + change_status({newStatus:"Grooming", planReviewState:"approved"}) stops the run and flags the human synchronously, in the same call — no tick', async () => {
    const TICKET = 'EGH-1';
    await seedGroomingTask(TICKET);
    await startPlanGateNow(TICKET, { mode: 'loop-confirm' });
    putRunningReviewSession();
    dispatchSession.mockClear();

    const res = await callTool({
      name: 'change_status',
      arguments: { ticketId: TICKET, newStatus: 'Grooming', planReviewState: 'approved' },
    });

    try {
      expect(res.isError).toBeFalsy();
      // No revise/review pass was (re)dispatched by the handler's own call into the gate machinery.
      expect(dispatchSession).not.toHaveBeenCalled();
      expect(isGateRunning(TICKET)).toBe(false);

      const task = getWorkspace().tasks[TICKET];
      expect(task.status).toBe('Grooming');
      expect(task.planReviewState).toBe('approved');
      expect(task.planGateRunning).toBeUndefined();
      expect(task.needsAction).toMatch(/verdict: approved/i);
    } finally {
      dropTask(TICKET);
    }
  });

  it('loop-auto + change_status({newStatus:"Grooming", planReviewState:"approved"}) auto-moves Grooming -> Todo synchronously and clears the verdict — no tick', async () => {
    const TICKET = 'EGH-2';
    await seedGroomingTask(TICKET);
    await startPlanGateNow(TICKET, { mode: 'loop-auto' });
    putRunningReviewSession();
    dispatchSession.mockClear();

    const res = await callTool({
      name: 'change_status',
      arguments: { ticketId: TICKET, newStatus: 'Grooming', planReviewState: 'approved' },
    });

    try {
      expect(res.isError).toBeFalsy();
      expect(dispatchSession).not.toHaveBeenCalled();
      expect(isGateRunning(TICKET)).toBe(false);

      const task = getWorkspace().tasks[TICKET];
      expect(task.status).toBe('Todo');
      expect(task.planReviewState).toBeNull();
      expect(task.planGateRunning).toBeUndefined();
    } finally {
      dropTask(TICKET);
    }
  });

  it('loop-auto + change_status({newStatus:"Grooming", planReviewState:"changes-requested"}) leaves the run untouched — the looping revise still waits for the session to complete', async () => {
    const TICKET = 'EGH-3';
    await seedGroomingTask(TICKET);
    await startPlanGateNow(TICKET, { mode: 'loop-auto' });
    putRunningReviewSession();
    dispatchSession.mockClear();

    const res = await callTool({
      name: 'change_status',
      arguments: { ticketId: TICKET, newStatus: 'Grooming', planReviewState: 'changes-requested' },
    });

    try {
      expect(res.isError).toBeFalsy();
      // changes-requested under a looping mode is NOT short-circuited by the eager path — no revise
      // dispatched yet, and the run keeps going (waiting on the still-running review session).
      expect(dispatchSession).not.toHaveBeenCalled();
      expect(isGateRunning(TICKET)).toBe(true);

      const task = getWorkspace().tasks[TICKET];
      expect(task.status).toBe('Grooming');
      expect(task.planReviewState).toBe('changes-requested');
      expect(task.planGateRunning).toBe(true);
    } finally {
      dropTask(TICKET);
    }
  });
});
