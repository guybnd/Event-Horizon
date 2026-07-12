import { getWorkspace } from './workspace-context.js';
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import matter from 'gray-matter';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

// FLUX-1378: `change_status` stamps `lastReviewedCommit` alongside a FRESH (non-null) `reviewState`
// verdict — the input the delta re-review focus (`deltaReviewFocus`, furnace-stoker.ts) diffs against.
// Stub `resolveCommit` (real implementation shells out to git) so the scenario is exercised
// deterministically without a real git repo; everything else from branch-manager.js is passed through
// via importActual so unrelated handler code keeps working normally.
vi.mock('./branch-manager.js', async () => {
  const actual = await vi.importActual<typeof import('./branch-manager.js')>('./branch-manager.js');
  return { ...actual, resolveCommit: vi.fn() };
});

import { buildMcpServer } from './mcp-server.js';
import { setWorkspaceRoot } from './workspace.js';
import { resolveCommit } from './branch-manager.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
function isCallToolResult(value: unknown): value is CallToolResult {
  return isRecord(value) && Array.isArray(value['content']);
}

describe('change_status stamps lastReviewedCommit (FLUX-1378)', () => {
  let client: Client;
  let server: ReturnType<typeof buildMcpServer>;
  let root: string;
  let fluxDir: string;

  beforeAll(async () => {
    server = buildMcpServer();
    client = new Client({ name: 'eh-lastreviewedcommit-test', version: '1.0.0' }, { capabilities: {} });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    root = await fs.mkdtemp(path.join(os.tmpdir(), 'eh-lastreviewedcommit-'));
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
    vi.mocked(resolveCommit).mockReset();
  });

  async function callTool(args: Parameters<Client['callTool']>[0]): Promise<CallToolResult> {
    const res: unknown = await client.callTool(args);
    if (!isCallToolResult(res)) throw new Error('expected a content-bearing tool result');
    return res;
  }

  async function seedTask(id: string, extra: Record<string, unknown> = {}) {
    const frontmatter = {
      id,
      title: `lastReviewedCommit test ${id}`,
      status: 'In Progress',
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

  it('stamps the resolved branch-tip SHA on a worktree ticket alongside a changes-requested verdict', async () => {
    const TICKET = 'LRC-1';
    const BRANCH = `flux/${TICKET}-demo`;
    await seedTask(TICKET, { branch: BRANCH });
    vi.mocked(resolveCommit).mockResolvedValue('abc123def456abc123def456abc123def456abc');

    try {
      const res = await callTool({
        name: 'change_status',
        arguments: { ticketId: TICKET, newStatus: 'In Progress', reviewState: 'changes-requested', comment: 'Found issues.' },
      });
      expect(res.isError).toBeFalsy();
      expect(resolveCommit).toHaveBeenCalledWith(BRANCH);
      expect(getWorkspace().tasks[TICKET].lastReviewedCommit).toBe('abc123def456abc123def456abc123def456abc');
    } finally {
      dropTask(TICKET);
    }
  });

  it('also stamps on an approved verdict (any fresh non-null verdict, not just changes-requested)', async () => {
    const TICKET = 'LRC-2';
    const BRANCH = `flux/${TICKET}-demo`;
    await seedTask(TICKET, { branch: BRANCH, status: 'In Progress' });
    vi.mocked(resolveCommit).mockResolvedValue('def456abc123def456abc123def456abc123def');

    try {
      const res = await callTool({
        name: 'change_status',
        arguments: { ticketId: TICKET, newStatus: 'In Progress', reviewState: 'approved', comment: 'Looks good, re-affirming.' },
      });
      expect(res.isError).toBeFalsy();
      expect(getWorkspace().tasks[TICKET].lastReviewedCommit).toBe('def456abc123def456abc123def456abc123def');
    } finally {
      dropTask(TICKET);
    }
  });

  it('a branchless ticket does not crash and leaves lastReviewedCommit unset', async () => {
    const TICKET = 'LRC-3';
    await seedTask(TICKET); // no `branch` field at all

    try {
      const res = await callTool({
        name: 'change_status',
        arguments: { ticketId: TICKET, newStatus: 'In Progress', reviewState: 'changes-requested', comment: 'Found issues.' },
      });
      expect(res.isError).toBeFalsy();
      expect(resolveCommit).not.toHaveBeenCalled();
      expect(getWorkspace().tasks[TICKET].lastReviewedCommit).toBeUndefined();
    } finally {
      dropTask(TICKET);
    }
  });

  it('clearing the verdict (reviewState: null) does not stamp a new lastReviewedCommit', async () => {
    const TICKET = 'LRC-4';
    const BRANCH = `flux/${TICKET}-demo`;
    await seedTask(TICKET, { branch: BRANCH, status: 'Ready', reviewState: 'approved', lastReviewedCommit: 'previous-sha' });

    try {
      const res = await callTool({
        name: 'change_status',
        arguments: { ticketId: TICKET, newStatus: 'In Progress', reviewState: null, comment: 'Reopening for unrelated reasons.' },
      });
      expect(res.isError).toBeFalsy();
      expect(resolveCommit).not.toHaveBeenCalled();
      // Untouched — a clear must not overwrite the last real review's commit.
      expect(getWorkspace().tasks[TICKET].lastReviewedCommit).toBe('previous-sha');
    } finally {
      dropTask(TICKET);
    }
  });

  it('a resolveCommit failure (git error) leaves lastReviewedCommit unset without failing the call', async () => {
    const TICKET = 'LRC-5';
    const BRANCH = `flux/${TICKET}-demo`;
    await seedTask(TICKET, { branch: BRANCH });
    vi.mocked(resolveCommit).mockResolvedValue(null);

    try {
      const res = await callTool({
        name: 'change_status',
        arguments: { ticketId: TICKET, newStatus: 'In Progress', reviewState: 'changes-requested', comment: 'Found issues.' },
      });
      expect(res.isError).toBeFalsy();
      expect(getWorkspace().tasks[TICKET].lastReviewedCommit).toBeUndefined();
    } finally {
      dropTask(TICKET);
    }
  });
});
