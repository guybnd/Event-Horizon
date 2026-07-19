// FLUX-1555: attention surfaces (notifications store+broadcasts, the durable HITL prompt index,
// board-rebase's pending list) were process-global / active-board-targeted — a background board's
// items bled into the active board's bell, and a timed-out `ask_user_question` on a non-active
// board silently vanished (no flag, no notification). These tests lock the fix: every surface is
// scoped to the board that OWNS the record, not whichever board is ambiently active when it's read
// or when a bare timer fires.
//
// `updateTaskWithHistory` is mocked the same way temper-gate-multi-workspace.test.ts does — applying
// writes directly into the real per-workspace `tasks` cache (honoring an explicit `ws` argument, or
// falling back to the ambient `getWorkspace()`) — so `raiseNeedsAction`'s real logic runs without
// touching disk.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';

vi.mock('./task-store.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./task-store.js')>();
  const { getWorkspace: getWs } = await import('./workspace-context.js');
  const updateTaskWithHistory = vi.fn(async (
    taskId: string,
    options: { extraFields?: Record<string, unknown> },
    ws?: unknown,
  ) => {
    const target = (ws as { tasks: Record<string, Record<string, unknown>> } | undefined) ?? getWs();
    const t = target.tasks[taskId];
    if (!t) return null;
    if (options.extraFields) Object.assign(t, options.extraFields);
    return t;
  });
  return { ...actual, updateTaskWithHistory };
});

import { getWorkspace, getDefaultWorkspace, openWorkspace, closeWorkspace, runWithWorkspace, type Workspace } from './workspace-context.js';
import { setWorkspaceRoot } from './workspace.js';
import { addNotification, getNotifications, getUnreadCount, clearNotifications } from './notifications.js';
import { parkPrompt, resolvePrompt, listOpenPrompts, flushOpenPrompts } from './hitl-prompts.js';
import { proposeBoardRebase, listPendingBoardRebases } from './board-rebase.js';

describe('Attention surfaces — multi-workspace isolation (FLUX-1555)', () => {
  let defaultWs: Workspace;
  let otherWs: Workspace;
  let defaultRoot: string;
  let otherRoot: string;

  beforeEach(async () => {
    defaultRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'eh-attn-default-'));
    setWorkspaceRoot(defaultRoot); // binds `defaultWorkspace` — the "background" board in these tests
    defaultWs = getDefaultWorkspace();
    defaultWs.tasks = {};

    otherRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'eh-attn-other-'));
    otherWs = openWorkspace(otherRoot); // registers + activates a 2nd, "active" board
    otherWs.tasks = {};
    // FLUX-1571/FLUX-1581: `openWorkspace()` stores the realpath-canonical form on `ws.root` (an
    // 8.3 short-name tmpdir on Windows, a symlinked one on macOS, differs from the literal
    // `mkdtemp()` result). `setWorkspaceRoot()` (board A's path above, the legacy not-yet-migrated
    // single-workspace setter) does NOT canonicalize, so `defaultRoot` already matches
    // `defaultWs.root`. Realign `otherRoot` to `otherWs.root` so the `workspaceRoot` this suite
    // asserts against matches what `parkPrompt`'s real `getWorkspaceRoot()` stamp actually produces.
    otherRoot = otherWs.root ?? otherRoot;

    clearNotifications();
  });

  afterEach(async () => {
    // Drain any prompts either board left open so a leaked timer/record can't bleed into the next test.
    for (const r of [...listOpenPrompts('permission'), ...listOpenPrompts('question')]) resolvePrompt(r.id, {});
    await flushOpenPrompts();
    clearNotifications();
    await closeWorkspace(otherRoot);
    await fs.rm(defaultRoot, { recursive: true, force: true }).catch(() => {});
    await fs.rm(otherRoot, { recursive: true, force: true }).catch(() => {});
  });

  describe('notifications store (findings A/B)', () => {
    it('getNotifications/getUnreadCount are scoped to the board that generated the notification', () => {
      addNotification({ type: 'info', title: 'From A', message: 'a', actions: [] }, defaultWs);
      addNotification({ type: 'info', title: 'From B', message: 'b', actions: [] }, otherWs);

      expect(getNotifications(defaultWs).map((n) => n.title)).toEqual(['From A']);
      expect(getNotifications(otherWs).map((n) => n.title)).toEqual(['From B']);
      expect(getUnreadCount(defaultWs)).toBe(1);
      expect(getUnreadCount(otherWs)).toBe(1);
    });

    it('a notification added with an explicit ws stamps that board, not whichever one is ambiently active (FLUX-1557)', () => {
      // The unbound/ambient fallback is deterministically the default workspace now, never a
      // registered "active" board — so pass the OTHER board explicitly to prove it still wins.
      expect(getWorkspace()).toBe(defaultWs);
      addNotification({ type: 'completion', title: 'Bg ticket done', message: 'x', actions: [] }, otherWs);

      expect(getNotifications(otherWs)).toHaveLength(1);
      expect(getNotifications(defaultWs)).toHaveLength(0);
    });
  });

  describe('durable HITL prompt index (findings C/D — the headline vanishing-timeout regression)', () => {
    it('a prompt parked on a BACKGROUND board times out onto its OWN board — needsAction + notification land there, not on the active board', async () => {
      defaultWs.tasks['FLUX-9001'] = { id: 'FLUX-9001', title: 'Background ticket', status: 'In Progress' };
      // FLUX-1557: the unbound/ambient fallback is deterministically the default workspace now.
      expect(getWorkspace()).toBe(defaultWs);

      const parked = runWithWorkspace(defaultWs, () =>
        parkPrompt({
          kind: 'question',
          payload: { questions: [{ header: 'H', question: 'Proceed?', options: [{ label: 'Yes' }] }] },
          conversationId: 'FLUX-9001',
          timeoutMs: 30,
        }),
      );

      const result = await parked; // resolves once the bare setTimeout fires settle()
      expect(result).toEqual({ answers: {}, unanswered: true });

      // The flag + notification land on the OWNING (background) board...
      expect(defaultWs.tasks['FLUX-9001']!.needsAction).toBeTruthy();
      expect(getNotifications(defaultWs).some((n) => n.ticketId === 'FLUX-9001')).toBe(true);
      // ...never on whichever board was active when the timer happened to fire.
      expect(getNotifications(otherWs).some((n) => n.ticketId === 'FLUX-9001')).toBe(false);
    });

    it('a prompt parked on board B is written only to board B\'s open-prompts.json — board A\'s file stays untouched', async () => {
      const parkedA = runWithWorkspace(defaultWs, () =>
        parkPrompt({ kind: 'permission', payload: { toolName: 'Bash', input: { command: 'ls' } }, conversationId: 'FLUX-A', timeoutMs: 60_000 }),
      );
      const parkedB = runWithWorkspace(otherWs, () =>
        parkPrompt({ kind: 'permission', payload: { toolName: 'Write', input: {} }, conversationId: 'FLUX-B', timeoutMs: 60_000 }),
      );
      await Promise.resolve();
      await flushOpenPrompts();

      const fileA = JSON.parse(await fs.readFile(path.join(defaultRoot, '.flux', 'open-prompts.json'), 'utf-8'));
      const fileB = JSON.parse(await fs.readFile(path.join(otherRoot, '.flux', 'open-prompts.json'), 'utf-8'));
      expect(fileA).toHaveLength(1);
      expect(fileA[0]).toMatchObject({ conversationId: 'FLUX-A', workspaceRoot: defaultRoot });
      expect(fileB).toHaveLength(1);
      expect(fileB[0]).toMatchObject({ conversationId: 'FLUX-B', workspaceRoot: otherRoot });

      for (const r of [...listOpenPrompts('permission')]) resolvePrompt(r.id, {});
      await parkedA;
      await parkedB;

      // Both settled — each board's file truncates to [] rather than leaking the other's record in.
      await flushOpenPrompts();
      expect(JSON.parse(await fs.readFile(path.join(defaultRoot, '.flux', 'open-prompts.json'), 'utf-8'))).toEqual([]);
      expect(JSON.parse(await fs.readFile(path.join(otherRoot, '.flux', 'open-prompts.json'), 'utf-8'))).toEqual([]);
    });
  });

  describe('board-rebase pending list (finding E)', () => {
    it('a batch proposed on board B is absent from board A\'s pending list', () => {
      runWithWorkspace(otherWs, () => proposeBoardRebase([{ kind: 'leave', targets: ['FLUX-1'], summary: 'leave it in the thread' }], null));

      expect(runWithWorkspace(defaultWs, () => listPendingBoardRebases())).toHaveLength(0);
      expect(runWithWorkspace(otherWs, () => listPendingBoardRebases())).toHaveLength(1);
    });
  });
});
