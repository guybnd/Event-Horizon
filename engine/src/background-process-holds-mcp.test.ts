// FLUX-1645: functional MCP-tool tests for hold_background_process / release_background_process,
// over the real buildMcpServer() + InMemoryTransport round-trip (furnace-batch-mcp.test.ts's
// pattern). InMemoryTransport bypasses HTTP entirely, so `getBoundConversation()` falls back to
// `process.env.EH_SESSION_ID`/`EH_SESSION_TOKEN` (the same fallback the stdio `--mcp` path uses) —
// set those per-test to simulate a specific live session's own signed identity, exactly the
// unforgeable channel `getVerifiedSessionId()` in mcp-server.ts trusts instead of an agent-supplied
// `sessionId` argument (there is no such input). This is the crux the plan review flagged as the
// hardest risk (AC2), so these tests focus on the authorization/rejection paths.
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { spawn, type ChildProcess } from 'child_process';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildMcpServer } from './mcp-server.js';
import { setWorkspaceRoot } from './workspace.js';
import { getWorkspace } from './workspace-context.js';
import { createTask } from './task-store.js';
import { signConversation } from './session-binding.js';
import { cliSessionsById } from './session-store.js';
import type { CliSessionRecord } from './agents/types.js';
import { createOrRenewHold, findHold, __resetBackgroundProcessHoldsForTest } from './background-process-holds.js';
import { indexProcessTable } from './kill-process-tree.js';

interface ToolCallResult {
  content: { type: string; text?: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

describe('hold_background_process / release_background_process MCP tools (FLUX-1645)', () => {
  let client: Client;
  let server: ReturnType<typeof buildMcpServer>;
  let root: string;

  beforeAll(async () => {
    server = buildMcpServer();
    client = new Client({ name: 'eh-background-hold-mcp-test', version: '1.0.0' }, { capabilities: {} });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  });

  afterAll(async () => {
    await client.close().catch(() => {});
    await server.close().catch(() => {});
  });

  async function callTool(name: string, input: Record<string, unknown>): Promise<ToolCallResult> {
    return (await client.callTool({ name, arguments: input })) as unknown as ToolCallResult;
  }

  function structuredOf(r: ToolCallResult): Record<string, unknown> {
    return r.structuredContent ?? {};
  }
  function textOf(r: ToolCallResult): string {
    return r.content.find((c) => c.type === 'text')?.text ?? '';
  }

  function bindSession(sessionId: string | undefined): void {
    if (!sessionId) {
      delete process.env.EH_SESSION_ID;
      delete process.env.EH_SESSION_TOKEN;
      return;
    }
    process.env.EH_SESSION_ID = sessionId;
    process.env.EH_SESSION_TOKEN = signConversation(sessionId);
  }

  let ticketId: string;
  let doneTicketId: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'eh-hold-mcp-'));
    await fs.mkdir(path.join(root, '.flux'), { recursive: true });
    setWorkspaceRoot(root);
    __resetBackgroundProcessHoldsForTest();
    ticketId = (await createTask({ title: 'Long build', status: 'In Progress' })).id;
    doneTicketId = (await createTask({ title: 'Finished', status: 'Done' })).id;
    cliSessionsById.set('sess-a', {
      id: 'sess-a', taskId: ticketId, status: 'running', pid: process.pid, workspaceRoot: getWorkspace().root,
    } as unknown as CliSessionRecord);
    cliSessionsById.set('sess-done', {
      id: 'sess-done', taskId: doneTicketId, status: 'running', pid: process.pid, workspaceRoot: getWorkspace().root,
    } as unknown as CliSessionRecord);
    cliSessionsById.set('sess-other-ws', {
      id: 'sess-other-ws', taskId: ticketId, status: 'running', pid: process.pid, workspaceRoot: '/some/other/workspace',
    } as unknown as CliSessionRecord);
  });

  afterEach(async () => {
    for (const k of Object.keys(getWorkspace().tasks)) delete getWorkspace().tasks[k];
    cliSessionsById.clear();
    __resetBackgroundProcessHoldsForTest();
    bindSession(undefined);
    await fs.rm(root, { recursive: true, force: true }).catch(() => {});
  });

  describe('hold_background_process — rejections never change reap behavior', () => {
    it('rejects when no verified session is bound to the connection', async () => {
      bindSession(undefined);
      const r = await callTool('hold_background_process', { ticketId: ticketId, pid: process.pid + 1, reason: 'build' });
      expect(r.isError).toBe(true);
      expect(structuredOf(r).code).toBe('validation_failed');
    });

    it('rejects an agent-supplied sessionId-shaped forgery attempt — the token must actually verify', async () => {
      process.env.EH_SESSION_ID = 'sess-a';
      process.env.EH_SESSION_TOKEN = 'not-a-real-signature';
      const r = await callTool('hold_background_process', { ticketId: ticketId, pid: process.pid + 1, reason: 'build' });
      expect(r.isError).toBe(true);
      expect(structuredOf(r).code).toBe('validation_failed');
    });

    it('rejects when the bound session belongs to a DIFFERENT ticket than the one named', async () => {
      bindSession('sess-a');
      const r = await callTool('hold_background_process', { ticketId: doneTicketId, pid: process.pid + 1, reason: 'build' });
      expect(r.isError).toBe(true);
      expect(structuredOf(r).code).toBe('validation_failed');
    });

    it('rejects when the bound session belongs to a DIFFERENT workspace than this connection', async () => {
      bindSession('sess-other-ws');
      const r = await callTool('hold_background_process', { ticketId: ticketId, pid: process.pid + 1, reason: 'build' });
      expect(r.isError).toBe(true);
      expect(structuredOf(r).code).toBe('validation_failed');
    });

    // win32-only: on other platforms the earlier platform rejection (validation_failed) fires
    // before the terminal-status check this test targets — Linux behavior is covered by the
    // dedicated 'rejects on a non-Windows platform' test below.
    it.skipIf(process.platform !== 'win32')('rejects a terminal-status ticket', async () => {
      bindSession('sess-done');
      const r = await callTool('hold_background_process', { ticketId: doneTicketId, pid: process.pid + 1, reason: 'build' });
      expect(r.isError).toBe(true);
      expect(structuredOf(r).code).toBe('invalid_state');
    });

    it('rejects the engine\'s own pid', async () => {
      bindSession('sess-a');
      const r = await callTool('hold_background_process', { ticketId: ticketId, pid: process.pid, reason: 'build' });
      expect(r.isError).toBe(true);
      expect(structuredOf(r).code).toBe('validation_failed');
    });

    it('rejects a dead pid', async () => {
      bindSession('sess-a');
      const r = await callTool('hold_background_process', { ticketId: ticketId, pid: 999_999, reason: 'build' });
      expect(r.isError).toBe(true);
      expect(structuredOf(r).code).toBe('validation_failed');
    });

    it('rejects on a non-Windows platform', async () => {
      const original = Object.getOwnPropertyDescriptor(process, 'platform')!;
      Object.defineProperty(process, 'platform', { ...original, value: 'linux' });
      try {
        bindSession('sess-a');
        const r = await callTool('hold_background_process', { ticketId: ticketId, pid: process.pid + 1, reason: 'build' });
        expect(r.isError).toBe(true);
        expect(structuredOf(r).code).toBe('validation_failed');
      } finally {
        Object.defineProperty(process, 'platform', original);
      }
    });
  });

  // win32-only: the success path requires real Win32 descendant verification (holds are a
  // Windows-only feature — the tool rejects other platforms outright, per the test above).
  describe.skipIf(process.platform !== 'win32')('hold_background_process — success path (a real live descendant pid)', () => {
    let child: ChildProcess | undefined;

    afterEach(() => {
      if (child && child.pid && !child.killed) child.kill();
      child = undefined;
    });

    it('holds a genuine live child of the calling session\'s own process, and renewing it updates reason/expiry', async () => {
      child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'ignore' });
      await new Promise((resolve) => child!.once('spawn', resolve));
      const childPid = child.pid!;

      bindSession('sess-a');
      const created = await callTool('hold_background_process', { ticketId: ticketId, pid: childPid, reason: 'unit test build' });
      expect(created.isError).toBeFalsy();
      const createdOut = structuredOf(created);
      expect(createdOut.pid).toBe(childPid);
      expect(createdOut.sessionId).toBe('sess-a');
      expect(createdOut.renewed).toBe(false);
      expect(typeof createdOut.expiresAt).toBe('string');
      expect(findHold(getWorkspace().root, childPid)?.sessionId).toBe('sess-a');

      const renewed = await callTool('hold_background_process', { ticketId: ticketId, pid: childPid, reason: 'still building', ttlMinutes: 5 });
      expect(renewed.isError).toBeFalsy();
      const renewedOut = structuredOf(renewed);
      expect(renewedOut.renewed).toBe(true);
      expect(renewedOut.reason).toBe('still building');
    }, 15000);

    it('a different session cannot hold a pid already held by sess-a — reported as invalid_state, not a silent takeover', async () => {
      child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'ignore' });
      await new Promise((resolve) => child!.once('spawn', resolve));
      const childPid = child.pid!;

      cliSessionsById.set('sess-b', {
        id: 'sess-b', taskId: ticketId, status: 'running', pid: process.pid, workspaceRoot: getWorkspace().root,
      } as unknown as CliSessionRecord);

      bindSession('sess-a');
      await callTool('hold_background_process', { ticketId: ticketId, pid: childPid, reason: 'first' });

      bindSession('sess-b');
      const r = await callTool('hold_background_process', { ticketId: ticketId, pid: childPid, reason: 'steal it' });
      expect(r.isError).toBe(true);
      expect(structuredOf(r).code).toBe('invalid_state');
      expect(findHold(getWorkspace().root, childPid)?.sessionId).toBe('sess-a'); // unchanged
    }, 15000);
  });

  describe('release_background_process — owner-only, idempotent, never signals the process', () => {
    it('rejects when no verified session is bound', async () => {
      bindSession(undefined);
      const r = await callTool('release_background_process', { ticketId: ticketId, pid: 12345 });
      expect(r.isError).toBe(true);
    });

    it('releasing a pid with no active hold is a success-shaped no-op, not an error (idempotent)', async () => {
      bindSession('sess-a');
      const r = await callTool('release_background_process', { ticketId: ticketId, pid: 12345 });
      expect(r.isError).toBeFalsy();
      expect(textOf(r)).toContain('No active hold');
    });

    it('a different session cannot release sess-a\'s hold', async () => {
      createOrRenewHold(
        { workspaceRoot: getWorkspace().root, taskId: ticketId, sessionId: 'sess-a', pid: 55555, fingerprint: '', reason: 'x', ttlMinutes: 30, worktreePath: null, branch: null },
        indexProcessTable([]),
      );
      cliSessionsById.set('sess-b', {
        id: 'sess-b', taskId: ticketId, status: 'running', pid: process.pid, workspaceRoot: getWorkspace().root,
      } as unknown as CliSessionRecord);

      bindSession('sess-b');
      const r = await callTool('release_background_process', { ticketId: ticketId, pid: 55555 });
      expect(r.isError).toBe(true);
      expect(structuredOf(r).code).toBe('invalid_state');
      expect(findHold(getWorkspace().root, 55555)).toBeDefined(); // still held

      bindSession('sess-a');
      const ok = await callTool('release_background_process', { ticketId: ticketId, pid: 55555 });
      expect(ok.isError).toBeFalsy();
      expect(findHold(getWorkspace().root, 55555)).toBeUndefined();
    });
  });
});
