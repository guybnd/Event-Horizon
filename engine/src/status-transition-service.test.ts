// FLUX-1044: coverage for the shared status-transition service, in three layers:
//
//   1. Pure unit tests of the shared decisions (`evaluateCommentGate`,
//      `resolveTransitionStatusNames`).
//   2. The FLUX-730/731 `evaluateWorktreeReadyRefusal` cases, folded in verbatim from the
//      former mcp-ready-refusal.test.ts (the function moved here from mcp-server.ts).
//   3. A REST ↔ MCP parity harness driving the REAL PUT /api/tasks/:id route and the REAL
//      `change_status`/`update_ticket` MCP tools against the same seeded tickets: every rule
//      genuinely shared between the two paths must produce the same accept/refuse outcome —
//      and the known INTENTIONAL divergences (commit-before-Ready, the FLUX-1263 plan-review
//      gate) are asserted to remain MCP-only rather than treated as bugs to unify.

import { getWorkspace } from './workspace-context.js';
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import http from 'http';
import type { AddressInfo } from 'net';
import express from 'express';
import matter from 'gray-matter';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

// Mirror mcp-nodiffexpected-handler.test.ts: stub the git-backed lookups the change_status
// Ready branch drives, so the commit-before-Ready scenario is exercisable without a real
// worktree/PR. Everything else passes through via importActual.
vi.mock('./branch-manager.js', async () => {
  const actual = await vi.importActual<typeof import('./branch-manager.js')>('./branch-manager.js');
  return { ...actual, getTicketBranchStatus: vi.fn(), createPullRequest: vi.fn(), checkGhAuth: vi.fn(), getGhAvailability: vi.fn() };
});
vi.mock('./task-worktree.js', async () => {
  const actual = await vi.importActual<typeof import('./task-worktree.js')>('./task-worktree.js');
  return { ...actual, findWorktreeForBranch: vi.fn(), worktreeUncommittedCount: vi.fn() };
});
// Stub the plan-gate dispatch so the FLUX-1263 divergence case can assert WHO triggers the
// gate without actually spawning a review session.
vi.mock('./gate-runner.js', async () => {
  const actual = await vi.importActual<typeof import('./gate-runner.js')>('./gate-runner.js');
  return { ...actual, startPlanGateNow: vi.fn() };
});

import {
  evaluateCommentGate,
  resolveTransitionStatusNames,
  evaluateWorktreeReadyRefusal,
} from './status-transition-service.js';
import { buildMcpServer } from './mcp-server.js';

import { setWorkspaceRoot } from './workspace.js';
import { requireWorkspace } from './middleware.js';
import { getConfig } from './config.js';
import { getTicketBranchStatus, createPullRequest, checkGhAuth, getGhAvailability } from './branch-manager.js';
import { findWorktreeForBranch, worktreeUncommittedCount } from './task-worktree.js';
import { startPlanGateNow } from './gate-runner.js';

// ─── 1. Pure decisions ────────────────────────────────────────────────────────

describe('resolveTransitionStatusNames', () => {
  it('falls back to the canonical names on an empty config', () => {
    expect(resolveTransitionStatusNames({})).toEqual({ requireInputStatus: 'Require Input', readyStatus: 'Ready' });
  });

  it('honors configured names', () => {
    expect(resolveTransitionStatusNames({ requireInputStatus: 'Blocked on Human', readyForMergeStatus: 'Review' }))
      .toEqual({ requireInputStatus: 'Blocked on Human', readyStatus: 'Review' });
  });
});

describe('evaluateCommentGate (shared REST/MCP comment-requirement rule)', () => {
  const names = { requireInputStatus: 'Require Input', readyStatus: 'Ready' };

  it('refuses a move into Require Input without a comment', () => {
    const d = evaluateCommentGate({ currentStatus: 'In Progress', newStatus: 'Require Input', hasComment: false, ...names });
    expect(d).toEqual({ refuse: true, gate: 'require-input-comment' });
  });

  it('Require Input is a HARD invariant — neither config nor the portal skip flag relaxes it', () => {
    const d = evaluateCommentGate({
      currentStatus: 'In Progress', newStatus: 'Require Input', hasComment: false, ...names,
      requireCommentOnStatusChange: false, skipCommentRequirement: true,
    });
    expect(d.refuse).toBe(true);
  });

  it('allows Require Input with a comment', () => {
    expect(evaluateCommentGate({ currentStatus: 'In Progress', newStatus: 'Require Input', hasComment: true, ...names }).refuse).toBe(false);
  });

  it('only transitions INTO the gated status are checked', () => {
    expect(evaluateCommentGate({ currentStatus: 'Require Input', newStatus: 'Require Input', hasComment: false, ...names }).refuse).toBe(false);
    expect(evaluateCommentGate({ currentStatus: 'Ready', newStatus: 'Ready', hasComment: false, ...names }).refuse).toBe(false);
  });

  it('refuses a move into Ready without a comment', () => {
    const d = evaluateCommentGate({ currentStatus: 'In Progress', newStatus: 'Ready', hasComment: false, ...names });
    expect(d).toEqual({ refuse: true, gate: 'ready-comment' });
  });

  it('config requireCommentOnStatusChange:false waives the Ready check', () => {
    expect(evaluateCommentGate({
      currentStatus: 'In Progress', newStatus: 'Ready', hasComment: false, ...names,
      requireCommentOnStatusChange: false,
    }).refuse).toBe(false);
  });

  it('the FLUX-847 portal skip flag waives the Ready check', () => {
    expect(evaluateCommentGate({
      currentStatus: 'In Progress', newStatus: 'Ready', hasComment: false, ...names,
      skipCommentRequirement: true,
    }).refuse).toBe(false);
  });

  it('allows Ready with a comment, and any non-gated transition without one', () => {
    expect(evaluateCommentGate({ currentStatus: 'In Progress', newStatus: 'Ready', hasComment: true, ...names }).refuse).toBe(false);
    expect(evaluateCommentGate({ currentStatus: 'Todo', newStatus: 'In Progress', hasComment: false, ...names }).refuse).toBe(false);
    expect(evaluateCommentGate({ currentStatus: 'Todo', newStatus: undefined, hasComment: false, ...names }).refuse).toBe(false);
  });
});

// ─── 2. evaluateWorktreeReadyRefusal (folded from mcp-ready-refusal.test.ts) ──

/**
 * FLUX-731: regression coverage for the FLUX-730 commit-before-Ready refusal. The decision
 * is factored out of the `change_status` MCP handler (now living in the status-transition
 * service, FLUX-1044) so it can be exercised as a pure function. These cases pin the exact
 * scope of the refusal: ONLY a worktree branch that exists with 0 commits ahead is refused;
 * everything else allows.
 */
describe('evaluateWorktreeReadyRefusal (FLUX-730 commit-before-Ready)', () => {
  const base = {
    ticketId: 'FLUX-1',
    branch: 'flux/FLUX-1-demo',
    readyStatus: 'Ready',
  };

  it('REFUSES a worktree branch that exists with 0 commits ahead', () => {
    const r = evaluateWorktreeReadyRefusal({
      ...base,
      worktreePath: 'C:/wt/EventHorizon-FLUX-1',
      branchStatus: { exists: true, aheadCount: 0 },
      changeCount: 2,
    });
    expect(r.refuse).toBe(true);
    expect(r.message).toContain('FLUX-1');
    expect(r.message).toContain('Ready');
    expect(r.message).toContain('no commits ahead of base');
    // changeCount > 0 → message names the uncommitted work (pluralized).
    expect(r.message).toContain('2 uncommitted changes');
    expect(r.message).toContain('Status left unchanged');
  });

  it('REFUSES with the "no changes yet" phrasing when changeCount is 0', () => {
    const r = evaluateWorktreeReadyRefusal({
      ...base,
      worktreePath: 'C:/wt/EventHorizon-FLUX-1',
      branchStatus: { exists: true, aheadCount: 0 },
      changeCount: 0,
    });
    expect(r.refuse).toBe(true);
    expect(r.message).toContain('no changes yet');
  });

  it('uses the singular form for exactly one uncommitted change', () => {
    const r = evaluateWorktreeReadyRefusal({
      ...base,
      worktreePath: 'C:/wt/EventHorizon-FLUX-1',
      branchStatus: { exists: true, aheadCount: 0 },
      changeCount: 1,
    });
    expect(r.message).toContain('1 uncommitted change');
    expect(r.message).not.toContain('1 uncommitted changes');
  });

  it('ALLOWS a worktree branch with commits ahead (falls through to PR)', () => {
    const r = evaluateWorktreeReadyRefusal({
      ...base,
      worktreePath: 'C:/wt/EventHorizon-FLUX-1',
      branchStatus: { exists: true, aheadCount: 3 },
    });
    expect(r.refuse).toBe(false);
    expect(r.message).toBeUndefined();
  });

  it('ALLOWS a plain branch with 0 commits ahead (no worktree → soft warning, not refused)', () => {
    const r = evaluateWorktreeReadyRefusal({
      ...base,
      worktreePath: null,
      branchStatus: { exists: true, aheadCount: 0 },
    });
    expect(r.refuse).toBe(false);
  });

  it('ALLOWS a branchless ticket (no branch status, unaffected)', () => {
    const r = evaluateWorktreeReadyRefusal({
      ...base,
      worktreePath: null,
      branchStatus: null,
    });
    expect(r.refuse).toBe(false);
  });

  it('ALLOWS when the worktree branch does not exist (exists:false)', () => {
    const r = evaluateWorktreeReadyRefusal({
      ...base,
      worktreePath: 'C:/wt/EventHorizon-FLUX-1',
      branchStatus: { exists: false, aheadCount: 0 },
    });
    expect(r.refuse).toBe(false);
  });

  // FLUX-1267: noDiffExpected escape hatch for legitimately zero-diff (verification-only) tickets.
  it('ALLOWS a worktree branch with 0 commits ahead when noDiffAcknowledged and the tree is clean', () => {
    const r = evaluateWorktreeReadyRefusal({
      ...base,
      worktreePath: 'C:/wt/EventHorizon-FLUX-1',
      branchStatus: { exists: true, aheadCount: 0 },
      changeCount: 0,
      noDiffAcknowledged: true,
    });
    expect(r.refuse).toBe(false);
    expect(r.message).toBeUndefined();
  });

  it('STILL REFUSES when noDiffAcknowledged is true but the worktree has uncommitted changes', () => {
    const r = evaluateWorktreeReadyRefusal({
      ...base,
      worktreePath: 'C:/wt/EventHorizon-FLUX-1',
      branchStatus: { exists: true, aheadCount: 0 },
      changeCount: 3,
      noDiffAcknowledged: true,
    });
    expect(r.refuse).toBe(true);
    expect(r.message).toContain('3 uncommitted changes');
  });

  it('mentions the noDiffExpected escape hatch in the refusal message', () => {
    const r = evaluateWorktreeReadyRefusal({
      ...base,
      worktreePath: 'C:/wt/EventHorizon-FLUX-1',
      branchStatus: { exists: true, aheadCount: 0 },
      changeCount: 0,
    });
    expect(r.refuse).toBe(true);
    expect(r.message).toContain('noDiffExpected:true');
  });
});

// ─── 3. REST PUT ↔ MCP parity harness ────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** Mirrors the narrowing helper in mcp-completion-handoff.test.ts. */
function isCallToolResult(value: unknown): value is CallToolResult {
  return isRecord(value) && Array.isArray(value['content']);
}

type HistoryEntryLike = Record<string, unknown> & { type?: string; comment?: string; to?: string };

describe('REST PUT ↔ MCP parity (FLUX-1044 shared status-transition rules)', () => {
  let root: string;
  let fluxDir: string;
  let client: Client;
  let server: ReturnType<typeof buildMcpServer>;
  let httpServer: http.Server;
  let baseUrl: string;

  beforeAll(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'eh-status-transition-'));
    fluxDir = path.join(root, '.flux');
    await fs.mkdir(fluxDir, { recursive: true });
    setWorkspaceRoot(root);

    server = buildMcpServer();
    client = new Client({ name: 'eh-status-transition-test', version: '1.0.0' }, { capabilities: {} });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    // Same express harness as tasks-put-history-reconciliation.test.ts — the REAL tasks router.
    const { default: tasksRouter } = await import('./routes/tasks.js');
    const app = express();
    app.use(express.json());
    app.use('/api/tasks', requireWorkspace, tasksRouter);
    httpServer = http.createServer(app);
    await new Promise<void>((resolve) => httpServer.listen(0, resolve));
    baseUrl = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await client.close().catch(() => {});
    await server.close().catch(() => {});
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    await fs.rm(root, { recursive: true, force: true }).catch(() => {});
  });

  beforeEach(() => {
    vi.mocked(getTicketBranchStatus).mockReset();
    vi.mocked(createPullRequest).mockReset();
    vi.mocked(checkGhAuth).mockReset().mockResolvedValue(true);
    vi.mocked(getGhAvailability).mockReset().mockResolvedValue({ ok: true });
    vi.mocked(findWorktreeForBranch).mockReset();
    vi.mocked(worktreeUncommittedCount).mockReset();
    vi.mocked(startPlanGateNow).mockReset().mockResolvedValue({ ok: true, message: 'plan gate started (test stub)' });
  });

  async function callTool(args: Parameters<Client['callTool']>[0]): Promise<CallToolResult> {
    const res: unknown = await client.callTool(args);
    if (!isCallToolResult(res)) throw new Error('expected a content-bearing tool result');
    return res;
  }

  async function putTask(id: string, payload: Record<string, unknown>): Promise<Response> {
    return fetch(`${baseUrl}/api/tasks/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  }

  /** Seed a ticket to BOTH cache and disk (the write path re-reads from disk under the lock). */
  async function seedTask(id: string, extra: Record<string, unknown> = {}) {
    const frontmatter = {
      id,
      title: `status-transition parity ${id}`,
      status: 'In Progress',
      priority: 'None',
      effort: 'None',
      assignee: 'unassigned',
      tags: [] as string[],
      createdBy: 'Agent',
      updatedBy: 'Agent',
      history: [
        { type: 'activity', id: 'a-created', user: 'Agent', date: '2026-07-01T00:00:00.000Z', comment: 'Created ticket.' },
      ] as unknown[],
      ...extra,
    };
    const filePath = path.join(fluxDir, `${id}.md`);
    await fs.writeFile(filePath, matter.stringify('', frontmatter), 'utf-8');
    getWorkspace().tasks[id] = { ...frontmatter, body: '', id, _path: filePath };
  }

  function dropTask(id: string) {
    delete getWorkspace().tasks[id];
  }

  function statusChangesTo(id: string, to: string): HistoryEntryLike[] {
    const history = (getWorkspace().tasks[id]?.history ?? []) as HistoryEntryLike[];
    return history.filter((e) => e.type === 'status_change' && e.to === to);
  }

  it('Ready without a comment: both paths refuse and leave the status unchanged', async () => {
    await seedTask('PAR-REST-1');
    await seedTask('PAR-MCP-1');
    try {
      const res = await putTask('PAR-REST-1', { status: 'Ready', updatedBy: 'tester' });
      expect(res.status).toBe(400);
      const body = await res.json() as { error?: string };
      expect(body.error).toBe('READY_MISSING_COMMENT');
      expect(getWorkspace().tasks['PAR-REST-1'].status).toBe('In Progress');

      const mcp = await callTool({ name: 'change_status', arguments: { ticketId: 'PAR-MCP-1', newStatus: 'Ready' } });
      expect(mcp.isError).toBe(true);
      expect(getWorkspace().tasks['PAR-MCP-1'].status).toBe('In Progress');
    } finally {
      dropTask('PAR-REST-1');
      dropTask('PAR-MCP-1');
    }
  });

  it('Ready with a comment: both paths accept, each recording exactly one status_change', async () => {
    await seedTask('PAR-REST-2');
    await seedTask('PAR-MCP-2');
    try {
      const res = await putTask('PAR-REST-2', {
        status: 'Ready',
        updatedBy: 'tester',
        appendHistory: [{ type: 'comment', user: 'tester', comment: 'shipped' }],
      });
      expect(res.status).toBe(200);
      expect(getWorkspace().tasks['PAR-REST-2'].status).toBe('Ready');
      expect(statusChangesTo('PAR-REST-2', 'Ready')).toHaveLength(1);

      const mcp = await callTool({ name: 'change_status', arguments: { ticketId: 'PAR-MCP-2', newStatus: 'Ready', comment: 'shipped' } });
      expect(mcp.isError).toBeFalsy();
      expect(getWorkspace().tasks['PAR-MCP-2'].status).toBe('Ready');
      expect(statusChangesTo('PAR-MCP-2', 'Ready')).toHaveLength(1);
    } finally {
      dropTask('PAR-REST-2');
      dropTask('PAR-MCP-2');
    }
  });

  it('a portal-style move (status_change sent as an appendHistory delta, FLUX-725) is not duplicated by the shared write helper', async () => {
    await seedTask('PAR-REST-3');
    try {
      const res = await putTask('PAR-REST-3', {
        status: 'Ready',
        updatedBy: 'tester',
        appendHistory: [{ type: 'status_change', from: 'In Progress', to: 'Ready', user: 'tester', comment: 'done via portal' }],
      });
      expect(res.status).toBe(200);
      expect(getWorkspace().tasks['PAR-REST-3'].status).toBe('Ready');
      const moves = statusChangesTo('PAR-REST-3', 'Ready');
      expect(moves).toHaveLength(1);
      // The surviving entry is the CLIENT's (it carries the required comment) — not a second,
      // comment-less engine fallback.
      expect(moves[0]!.comment).toBe('done via portal');
    } finally {
      dropTask('PAR-REST-3');
    }
  });

  it('a stale full-history submission carrying its own status_change (FLUX-1311) is not duplicated either', async () => {
    const creation = { type: 'activity', id: 'a-created', user: 'Agent', date: '2026-07-01T00:00:00.000Z', comment: 'Created ticket.' };
    const serverOnly = { type: 'comment', id: 'c-server', user: 'alice', date: '2026-07-01T00:01:00.000Z', comment: 'server-side note the client never saw' };
    await seedTask('PAR-REST-4', { history: [creation, serverOnly] });
    try {
      // The client's snapshot predates c-server, and it rebuilds a FULL history array containing
      // its own status_change (with the required comment).
      const res = await putTask('PAR-REST-4', {
        status: 'Ready',
        updatedBy: 'tester',
        history: [
          creation,
          { type: 'status_change', from: 'In Progress', to: 'Ready', user: 'tester', comment: 'done via stale snapshot' },
        ],
      });
      expect(res.status).toBe(200);
      expect(getWorkspace().tasks['PAR-REST-4'].status).toBe('Ready');
      const moves = statusChangesTo('PAR-REST-4', 'Ready');
      expect(moves).toHaveLength(1);
      expect(moves[0]!.comment).toBe('done via stale snapshot');
      // FLUX-1308: the server-only entry the stale snapshot omitted must survive.
      const comments = (getWorkspace().tasks['PAR-REST-4'].history as HistoryEntryLike[]).map((e) => e.comment);
      expect(comments).toContain('server-side note the client never saw');
    } finally {
      dropTask('PAR-REST-4');
    }
  });

  it('Require Input without a comment: both paths refuse', async () => {
    await seedTask('PAR-REST-5');
    await seedTask('PAR-MCP-5');
    try {
      const res = await putTask('PAR-REST-5', { status: 'Require Input', updatedBy: 'tester' });
      expect(res.status).toBe(400);
      const body = await res.json() as { error?: string };
      expect(body.error).toBe('REQUIRE_INPUT_MISSING_COMMENT');
      expect(getWorkspace().tasks['PAR-REST-5'].status).toBe('In Progress');
      expect(getWorkspace().tasks['PAR-REST-5'].swimlane).toBeFalsy();

      const mcp = await callTool({ name: 'change_status', arguments: { ticketId: 'PAR-MCP-5', newStatus: 'Require Input' } });
      expect(mcp.isError).toBe(true);
      expect(getWorkspace().tasks['PAR-MCP-5'].status).toBe('In Progress');
      expect(getWorkspace().tasks['PAR-MCP-5'].swimlane).toBeFalsy();
    } finally {
      dropTask('PAR-REST-5');
      dropTask('PAR-MCP-5');
    }
  });

  it('Require Input with a comment: both paths set the swimlane and keep the status in place', async () => {
    await seedTask('PAR-REST-6');
    await seedTask('PAR-MCP-6');
    try {
      const res = await putTask('PAR-REST-6', {
        status: 'Require Input',
        updatedBy: 'tester',
        appendHistory: [{ type: 'comment', user: 'tester', comment: 'which flavor do you want?' }],
      });
      expect(res.status).toBe(200);
      expect(getWorkspace().tasks['PAR-REST-6'].status).toBe('In Progress');
      expect(getWorkspace().tasks['PAR-REST-6'].swimlane).toBe('require-input');

      const mcp = await callTool({ name: 'change_status', arguments: { ticketId: 'PAR-MCP-6', newStatus: 'Require Input', comment: 'which flavor do you want?' } });
      expect(mcp.isError).toBeFalsy();
      expect(getWorkspace().tasks['PAR-MCP-6'].status).toBe('In Progress');
      expect(getWorkspace().tasks['PAR-MCP-6'].swimlane).toBe('require-input');
    } finally {
      dropTask('PAR-REST-6');
      dropTask('PAR-MCP-6');
    }
  });

  it('requireCommentOnStatusChange:false waives the Ready gate on BOTH paths — but never Require Input', async () => {
    await seedTask('PAR-REST-7');
    await seedTask('PAR-MCP-7');
    const prior = getConfig().requireCommentOnStatusChange;
    getConfig().requireCommentOnStatusChange = false;
    try {
      const res = await putTask('PAR-REST-7', { status: 'Ready', updatedBy: 'tester' });
      expect(res.status).toBe(200);
      expect(getWorkspace().tasks['PAR-REST-7'].status).toBe('Ready');

      const mcp = await callTool({ name: 'change_status', arguments: { ticketId: 'PAR-MCP-7', newStatus: 'Ready' } });
      expect(mcp.isError).toBeFalsy();
      expect(getWorkspace().tasks['PAR-MCP-7'].status).toBe('Ready');

      // The Require Input question remains a hard invariant under the same config.
      await seedTask('PAR-REST-7B');
      await seedTask('PAR-MCP-7B');
      try {
        const res2 = await putTask('PAR-REST-7B', { status: 'Require Input', updatedBy: 'tester' });
        expect(res2.status).toBe(400);
        const mcp2 = await callTool({ name: 'change_status', arguments: { ticketId: 'PAR-MCP-7B', newStatus: 'Require Input' } });
        expect(mcp2.isError).toBe(true);
      } finally {
        dropTask('PAR-REST-7B');
        dropTask('PAR-MCP-7B');
      }
    } finally {
      getConfig().requireCommentOnStatusChange = prior;
      dropTask('PAR-REST-7');
      dropTask('PAR-MCP-7');
    }
  });

  it('schema validation refuses an empty title on both paths (shared validate-then-register seam)', async () => {
    await seedTask('PAR-REST-8');
    await seedTask('PAR-MCP-8');
    try {
      const res = await putTask('PAR-REST-8', { title: '', updatedBy: 'tester' });
      expect(res.status).toBe(400);
      const body = await res.json() as { error?: string; message?: string };
      expect(body.error).toBe('SCHEMA_VALIDATION_FAILED');
      expect(body.message).toContain('title');

      const mcp = await callTool({ name: 'update_ticket', arguments: { ticketId: 'PAR-MCP-8', title: '' } });
      expect(mcp.isError).toBe(true);
      const text = (mcp.content[0] as { text?: string })?.text ?? '';
      expect(text).toContain('Schema validation failed');
      expect(text).toContain('title');
      // Neither ticket lost its title.
      expect(getWorkspace().tasks['PAR-REST-8'].title).toContain('PAR-REST-8');
      expect(getWorkspace().tasks['PAR-MCP-8'].title).toContain('PAR-MCP-8');
    } finally {
      dropTask('PAR-REST-8');
      dropTask('PAR-MCP-8');
    }
  });

  it('INTENTIONAL divergence (FLUX-730/731): commit-before-Ready refuses on MCP only — REST drag-to-Ready stays un-enforced', async () => {
    const BRANCH = 'flux/PAR-diverge-ready';
    await seedTask('PAR-REST-9', { branch: BRANCH });
    await seedTask('PAR-MCP-9', { branch: BRANCH });
    // A worktree branch with 0 commits ahead and a clean tree — exactly the FLUX-730 scenario.
    vi.mocked(getTicketBranchStatus).mockResolvedValue({ exists: true, aheadCount: 0, behindCount: 0 });
    vi.mocked(findWorktreeForBranch).mockResolvedValue('C:/wt/EventHorizon-PAR-diverge');
    vi.mocked(worktreeUncommittedCount).mockResolvedValue(0);
    try {
      const mcp = await callTool({ name: 'change_status', arguments: { ticketId: 'PAR-MCP-9', newStatus: 'Ready', comment: 'trying to move' } });
      expect(mcp.isError).toBe(true);
      const text = (mcp.content[0] as { text?: string })?.text ?? '';
      expect(text).toContain('no commits ahead of base');
      expect(getWorkspace().tasks['PAR-MCP-9'].status).toBe('In Progress');

      // The SAME scenario through REST PUT is a deliberate human action and goes through
      // (see the FLUX-730/731 comment in routes/tasks.ts — do not "fix" this asymmetry).
      const res = await putTask('PAR-REST-9', {
        status: 'Ready',
        updatedBy: 'tester',
        appendHistory: [{ type: 'comment', user: 'tester', comment: 'human drag-to-Ready' }],
      });
      expect(res.status).toBe(200);
      expect(getWorkspace().tasks['PAR-REST-9'].status).toBe('Ready');
    } finally {
      dropTask('PAR-REST-9');
      dropTask('PAR-MCP-9');
    }
  });

  it('INTENTIONAL divergence (FLUX-1263): the plan-review gate redirects Grooming→Todo on MCP only — REST moves directly', async () => {
    // FLUX-1379: this scenario is about the MCP-vs-REST redirect, not the deterministic pre-gate
    // lint — `seedTask`'s default fixture (empty body, effort 'None') would otherwise bounce the
    // MCP call on B2/B3 before it ever reaches the gate trigger under test. Disable lint here, same
    // idiom as the `requireCommentOnStatusChange` override above.
    const priorPlanLint = getConfig().planLint;
    getConfig().planLint = false;
    await seedTask('PAR-MCP-10', { status: 'Grooming', gatePolicyOverride: { plan: 'auto' } });
    await seedTask('PAR-REST-10', { status: 'Grooming', gatePolicyOverride: { plan: 'auto' } });
    try {
      const mcp = await callTool({ name: 'change_status', arguments: { ticketId: 'PAR-MCP-10', newStatus: 'Todo' } });
      expect(mcp.isError).toBeFalsy();
      // Redirected: the gate ran instead of the move.
      expect(vi.mocked(startPlanGateNow)).toHaveBeenCalledWith('PAR-MCP-10', { mode: 'loop-auto' });
      expect(getWorkspace().tasks['PAR-MCP-10'].status).toBe('Grooming');

      const res = await putTask('PAR-REST-10', { status: 'Todo', updatedBy: 'tester' });
      expect(res.status).toBe(200);
      expect(getWorkspace().tasks['PAR-REST-10'].status).toBe('Todo');
      const gateCalls = vi.mocked(startPlanGateNow).mock.calls.map((c) => c[0]);
      expect(gateCalls).not.toContain('PAR-REST-10');
    } finally {
      getConfig().planLint = priorPlanLint;
      dropTask('PAR-MCP-10');
      dropTask('PAR-REST-10');
    }
  });
});
