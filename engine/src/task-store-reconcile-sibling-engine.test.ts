import { getWorkspace } from './workspace-context.js';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import matter from 'gray-matter';
import { reconcileOrphanedSessions } from './task-store.js';

/**
 * FLUX-1572 regression guard. `reconcileOrphanedSessions` used to unconditionally abandon every
 * `agent_session` history entry left `active` at boot ("Session abandoned (engine restarted)"),
 * with no check for whether the recorded session actually belonged to a now-dead process. A
 * second engine instance bound to the same shared `.flux` store (another checkout, another
 * machine via flux-data sync, a stray dev boot) would run this same reconcile on ITS boot and
 * falsely mark the sibling engine's genuinely still-running sessions as abandoned. The fix stamps
 * the owning engine's own `process.pid` onto the entry at creation (`enginePid`, history.ts) and
 * only abandons when that pid is dead — a live `enginePid` means a live sibling still owns it.
 */
describe('reconcileOrphanedSessions leaves live-sibling-owned sessions alone (FLUX-1572)', () => {
  const aliveTaskId = 'FLUX-1';
  const deadTaskId = 'FLUX-2';
  const legacyTaskId = 'FLUX-3';
  let fluxDir: string;

  async function writeTicket(taskId: string, history: unknown[]) {
    const ticketPath = path.join(fluxDir, `${taskId}.md`);
    await fs.writeFile(
      ticketPath,
      matter.stringify('body', { id: taskId, title: 'T', status: 'In Progress', swimlane: null, history }),
    );
    getWorkspace().tasks[taskId] = {
      id: taskId,
      title: 'T',
      status: 'In Progress',
      swimlane: null,
      history,
      _path: ticketPath,
    };
    return ticketPath;
  }

  beforeEach(async () => {
    fluxDir = await fs.mkdtemp(path.join(os.tmpdir(), 'eh-reconcile-'));
  });

  afterEach(async () => {
    delete getWorkspace().tasks[aliveTaskId];
    delete getWorkspace().tasks[deadTaskId];
    delete getWorkspace().tasks[legacyTaskId];
    await fs.rm(fluxDir, { recursive: true, force: true }).catch(() => {});
  });

  it('skips a session whose enginePid is still alive (a live sibling engine owns it)', async () => {
    const ticketPath = await writeTicket(aliveTaskId, [
      { type: 'agent_session', sessionId: 's-alive', status: 'active', enginePid: process.pid },
    ]);

    await reconcileOrphanedSessions(getWorkspace());

    const onDisk = matter(await fs.readFile(ticketPath, 'utf-8'));
    const history = onDisk.data.history as Array<{ status?: string; outcome?: string }>;
    expect(history[0]?.status).toBe('active');
    expect(history[0]?.outcome).toBeUndefined();
  });

  it('abandons a session whose enginePid is dead (a genuine restart orphan)', async () => {
    const ticketPath = await writeTicket(deadTaskId, [
      // A pid this high is never a real live process.
      { type: 'agent_session', sessionId: 's-dead', status: 'active', enginePid: 999999999 },
    ]);

    await reconcileOrphanedSessions(getWorkspace());

    const onDisk = matter(await fs.readFile(ticketPath, 'utf-8'));
    const history = onDisk.data.history as Array<{ status?: string; outcome?: string }>;
    expect(history[0]?.status).toBe('cancelled');
    expect(history[0]?.outcome).toBe('Session abandoned (engine restarted).');
  });

  it('abandons a legacy session with no enginePid (pre-fix entries keep the old behavior)', async () => {
    const ticketPath = await writeTicket(legacyTaskId, [
      { type: 'agent_session', sessionId: 's-legacy', status: 'active' },
    ]);

    await reconcileOrphanedSessions(getWorkspace());

    const onDisk = matter(await fs.readFile(ticketPath, 'utf-8'));
    const history = onDisk.data.history as Array<{ status?: string; outcome?: string }>;
    expect(history[0]?.status).toBe('cancelled');
    expect(history[0]?.outcome).toBe('Session abandoned (engine restarted).');
  });
});
