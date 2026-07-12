import { getWorkspace } from './workspace-context.js';
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import matter from 'gray-matter';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

// FLUX-1268: the `change_status` handler's `noDiffExpected` skip-PR path (mcp-server.ts, guarded by
// FLUX-1267) is only reachable for a *worktree* branch — stub the git-backed lookups it drives so
// the scenario (clean tree, 0 commits ahead) can be exercised without a real worktree/PR. Everything
// else from these modules is passed through via importActual so unrelated handler code (e.g. the
// FLUX-1031 reclaim sweep) keeps working normally.
vi.mock('./branch-manager.js', async () => {
  const actual = await vi.importActual<typeof import('./branch-manager.js')>('./branch-manager.js');
  return { ...actual, getTicketBranchStatus: vi.fn(), createPullRequest: vi.fn(), checkGhAuth: vi.fn() };
});
vi.mock('./task-worktree.js', async () => {
  const actual = await vi.importActual<typeof import('./task-worktree.js')>('./task-worktree.js');
  return { ...actual, findWorktreeForBranch: vi.fn(), worktreeUncommittedCount: vi.fn() };
});

import { buildMcpServer } from './mcp-server.js';

import { setWorkspaceRoot } from './workspace.js';
import { getTicketBranchStatus, createPullRequest, checkGhAuth } from './branch-manager.js';
import { findWorktreeForBranch, worktreeUncommittedCount } from './task-worktree.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** Mirrors the narrowing helper in mcp-completion-handoff.test.ts. */
function isCallToolResult(value: unknown): value is CallToolResult {
  return isRecord(value) && Array.isArray(value['content']);
}

type HistoryEntryLike = Record<string, unknown> & { type?: string; comment?: string };

describe('change_status noDiffExpected handler path (FLUX-1268)', () => {
  let client: Client;
  let server: ReturnType<typeof buildMcpServer>;
  let root: string;
  let fluxDir: string;

  beforeAll(async () => {
    server = buildMcpServer();
    client = new Client({ name: 'eh-nodiffexpected-test', version: '1.0.0' }, { capabilities: {} });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    root = await fs.mkdtemp(path.join(os.tmpdir(), 'eh-nodiffexpected-'));
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
    vi.mocked(getTicketBranchStatus).mockReset();
    vi.mocked(createPullRequest).mockReset();
    vi.mocked(checkGhAuth).mockReset().mockResolvedValue(true);
    vi.mocked(findWorktreeForBranch).mockReset();
    vi.mocked(worktreeUncommittedCount).mockReset();
  });

  async function callTool(args: Parameters<Client['callTool']>[0]): Promise<CallToolResult> {
    const res: unknown = await client.callTool(args);
    if (!isCallToolResult(res)) throw new Error('expected a content-bearing tool result');
    return res;
  }

  /** Mirrors mcp-completion-handoff.test.ts's seedTask, plus a worktree `branch`. */
  async function seedTask(id: string, branch: string, extra: Record<string, unknown> = {}) {
    const frontmatter = {
      id,
      title: `nodiffexpected handler test ${id}`,
      status: 'In Progress',
      priority: 'None',
      effort: 'None',
      assignee: 'unassigned',
      tags: [] as string[],
      createdBy: 'Agent',
      updatedBy: 'Agent',
      branch,
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

  it('noDiffExpected:true on a clean, 0-ahead worktree branch skips PR creation and records the zero-diff activity entry', async () => {
    const TICKET = 'NODIFF-1';
    const BRANCH = `flux/${TICKET}-demo`;
    await seedTask(TICKET, BRANCH);
    vi.mocked(getTicketBranchStatus).mockResolvedValue({ exists: true, aheadCount: 0, behindCount: 0 });
    vi.mocked(findWorktreeForBranch).mockResolvedValue('C:/wt/EventHorizon-NODIFF-1');
    vi.mocked(worktreeUncommittedCount).mockResolvedValue(0);

    try {
      const res = await callTool({
        name: 'change_status',
        arguments: { ticketId: TICKET, newStatus: 'Ready', comment: 'Verified — nothing to change.', noDiffExpected: true },
      });
      expect(res.isError).toBeFalsy();

      const task = getWorkspace().tasks[TICKET];
      expect(task.status).toBe('Ready');
      // No PR was opened: the create call never fired, and neither field it would have set is present.
      expect(createPullRequest).not.toHaveBeenCalled();
      expect(task.implementationLink).toBeUndefined();
      expect(task.swimlane).toBeFalsy();

      const history = task.history as HistoryEntryLike[];
      const zeroDiffEntry = history.find((e) => e.type === 'activity' && typeof e.comment === 'string' && e.comment.includes('Zero-diff ticket acknowledged'));
      expect(zeroDiffEntry).toBeDefined();
      expect(zeroDiffEntry?.comment).toContain(BRANCH);
      expect(zeroDiffEntry?.comment).toContain('no commits ahead of base');
      expect(zeroDiffEntry?.comment).toContain('no PR was opened');
      // The "commit needed"/PR-failure warning path must not also fire.
      expect(history.some((e) => e.type === 'activity' && typeof e.comment === 'string' && e.comment.startsWith('⚠️'))).toBe(false);
    } finally {
      dropTask(TICKET);
    }
  });

  it('without noDiffExpected, the same clean 0-ahead worktree branch still refuses Ready (FLUX-730 baseline)', async () => {
    const TICKET = 'NODIFF-2';
    const BRANCH = `flux/${TICKET}-demo`;
    await seedTask(TICKET, BRANCH);
    vi.mocked(getTicketBranchStatus).mockResolvedValue({ exists: true, aheadCount: 0, behindCount: 0 });
    vi.mocked(findWorktreeForBranch).mockResolvedValue('C:/wt/EventHorizon-NODIFF-2');
    vi.mocked(worktreeUncommittedCount).mockResolvedValue(0);

    try {
      const res = await callTool({
        name: 'change_status',
        arguments: { ticketId: TICKET, newStatus: 'Ready', comment: 'Trying to skip ahead.' },
      });
      expect(res.isError).toBe(true);

      const task = getWorkspace().tasks[TICKET];
      expect(task.status).toBe('In Progress');
      expect(createPullRequest).not.toHaveBeenCalled();
    } finally {
      dropTask(TICKET);
    }
  });
});
