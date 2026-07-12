import { describe, it, expect, afterEach } from 'vitest';
import { getConfig } from '../config.js';
import { captureScheduledWakeup, tryEnterScheduledWake, honorScheduledWakeupsEnabled, type ClaudeContentBlock } from './claude-code.js';
import type { CliSessionRecord } from './types.js';

// FLUX-1390: honored-ScheduleWakeup unit coverage for the pure staging/finalization helpers
// (captureScheduledWakeup / tryEnterScheduledWake) in isolation. The exit-handler wiring AROUND
// them — entering `scheduled`, and finalizing a wake-resumed turn that finishes cleanly — is
// covered end-to-end in claude-code-wake-resume-finalize.test.ts.

function mkSession(overrides: Partial<CliSessionRecord> = {}): CliSessionRecord {
  return {
    id: 'sess-1',
    taskId: 'FLUX-1',
    framework: 'claude',
    status: 'running',
    command: 'claude',
    args: [],
    startedAt: new Date().toISOString(),
    label: 'Claude Code',
    outputBuffer: '',
    liveOutputBuffer: '',
    pendingAssistantText: '',
    cumulativeOutput: '',
    requestedStop: false,
    writeQueue: Promise.resolve(),
    skipPermissions: true,
    ...overrides,
  };
}

function wakeupBlock(input: Record<string, unknown>): ClaudeContentBlock {
  return { type: 'tool_use', id: 'tool-1', name: 'ScheduleWakeup', input };
}

describe('captureScheduledWakeup / tryEnterScheduledWake (FLUX-1390)', () => {
  afterEach(() => {
    delete getConfig().agents;
  });

  it('honorScheduledWakeupsEnabled reads the config flag (default off)', () => {
    expect(honorScheduledWakeupsEnabled()).toBe(false);
    getConfig().agents = { honorScheduledWakeups: true };
    expect(honorScheduledWakeupsEnabled()).toBe(true);
  });

  it('captureScheduledWakeup is a no-op when the flag is off', () => {
    const session = mkSession({ phase: 'implementation' });
    captureScheduledWakeup(session, wakeupBlock({ delaySeconds: 120 }));
    expect(session.pendingWakeAt).toBeUndefined();
  });

  it('captureScheduledWakeup is a no-op for a chat session even when the flag is on', () => {
    getConfig().agents = { honorScheduledWakeups: true };
    const session = mkSession({ phase: 'chat' });
    captureScheduledWakeup(session, wakeupBlock({ delaySeconds: 120 }));
    expect(session.pendingWakeAt).toBeUndefined();
  });

  it('stages pendingWakeAt/pendingWakeReason, clamped to [60, 3600]s, for a dispatched phase', () => {
    getConfig().agents = { honorScheduledWakeups: true };
    const before = Date.now();
    const session = mkSession({ phase: 'implementation' });
    captureScheduledWakeup(session, wakeupBlock({ delaySeconds: 10, reason: 'waiting on CI' }));
    expect(session.pendingWakeAt).toBeDefined();
    const delayMs = new Date(session.pendingWakeAt!).getTime() - before;
    expect(delayMs).toBeGreaterThanOrEqual(60_000 - 100); // clamped up to the 60s floor
    expect(delayMs).toBeLessThan(61_000);
    expect(session.pendingWakeReason).toBe('waiting on CI');

    const session2 = mkSession({ phase: 'review' });
    captureScheduledWakeup(session2, wakeupBlock({ delaySeconds: 10_000 }));
    const delayMs2 = new Date(session2.pendingWakeAt!).getTime() - before;
    expect(delayMs2).toBeLessThanOrEqual(3_600_000 + 100); // clamped down to the 3600s ceiling
    expect(delayMs2).toBeGreaterThan(3_599_000);
  });

  it('tryEnterScheduledWake enters `scheduled` on a clean turn with a staged wakeup, flag on', () => {
    getConfig().agents = { honorScheduledWakeups: true };
    const session = mkSession({ phase: 'implementation', pendingWakeAt: new Date(Date.now() + 60_000).toISOString(), pendingWakeReason: 'polling CI' });
    const entered = tryEnterScheduledWake(session, 0);
    expect(entered).toBe(true);
    expect(session.status).toBe('scheduled');
    expect(session.wakeReason).toBe('polling CI');
    expect(session.pendingWakeAt).toBeUndefined();
    expect(session.endedAt).toBeUndefined();
  });

  it('does not enter scheduled when the flag is off, and clears the pending stage', () => {
    const session = mkSession({ pendingWakeAt: new Date(Date.now() + 60_000).toISOString() });
    expect(tryEnterScheduledWake(session, 0)).toBe(false);
    expect(session.status).toBe('running');
    expect(session.pendingWakeAt).toBeUndefined();
  });

  it('does not enter scheduled for a non-zero exit code, a user stop, or a Require-Input pause, and clears the pending stage', () => {
    getConfig().agents = { honorScheduledWakeups: true };
    const wakeAt = new Date(Date.now() + 60_000).toISOString();

    const crashed = mkSession({ pendingWakeAt: wakeAt });
    expect(tryEnterScheduledWake(crashed, 1)).toBe(false);
    expect(crashed.pendingWakeAt).toBeUndefined();

    const stopped = mkSession({ pendingWakeAt: wakeAt, requestedStop: true });
    expect(tryEnterScheduledWake(stopped, 0)).toBe(false);
    expect(stopped.pendingWakeAt).toBeUndefined();

    const paused = mkSession({ pendingWakeAt: wakeAt, pausedForInput: true });
    expect(tryEnterScheduledWake(paused, 0)).toBe(false);
    expect(paused.pendingWakeAt).toBeUndefined();
  });

  it('fails closed (does not re-enter scheduled) once MAX_SCHEDULED_WAKE_RESUMES is spent', () => {
    getConfig().agents = { honorScheduledWakeups: true };
    const session = mkSession({
      pendingWakeAt: new Date(Date.now() + 60_000).toISOString(),
      scheduledResumeCount: 5, // at the cap
    });
    const entered = tryEnterScheduledWake(session, 0);
    expect(entered).toBe(false);
    expect(session.status).toBe('running'); // untouched — falls through to normal finalization
    expect(session.pendingWakeAt).toBeUndefined();
  });
});
