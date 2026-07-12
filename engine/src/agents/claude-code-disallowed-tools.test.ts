import { describe, it, expect, afterEach } from 'vitest';
import { getConfig } from '../config.js';
import { disallowedToolsArgs, isChatEditGated, FILE_MUTATION_TOOLS } from './claude-code.js';

// FLUX-926: ticket chat may edit files only while the ticket is In Progress. Enforcement is via
// --disallowed-tools (permission-mode-independent — covers the default 'skip' chat path where
// permission_prompt never fires), computed fresh on every chat spawn since chat turns re-spawn
// the CLI each turn. Non-chat phases and the board session (no ticket status) must never be
// gated — only 'chat' + a non-'In Progress' task status blocks file mutation.
//
// Co-located in agents/ (like claude-code-rate-limit.test.ts) because it deep-imports a concrete
// adapter file, which the adapter-boundary guard forbids outside agents/.
describe('isChatEditGated / disallowedToolsArgs (FLUX-926)', () => {
  it('gates a chat session on a non-In-Progress ticket', () => {
    for (const status of ['Grooming', 'Todo', 'Backlog', 'Ready', 'Done', 'Archived', 'Require Input', undefined]) {
      const session = { phase: 'chat' as const };
      const task = { status };
      expect(isChatEditGated(session, task), `status=${status}`).toBe(true);
      const args = disallowedToolsArgs(session, task);
      expect(args[0]).toBe('--disallowed-tools');
      expect(args).toEqual(expect.arrayContaining(['AskUserQuestion', ...FILE_MUTATION_TOOLS]));
    }
  });

  it('does not gate a chat session on an In Progress ticket', () => {
    const session = { phase: 'chat' as const };
    const task = { status: 'In Progress' };
    expect(isChatEditGated(session, task)).toBe(false);
    expect(disallowedToolsArgs(session, task)).toEqual(['--disallowed-tools', 'AskUserQuestion']);
  });

  it('never gates non-chat phases, regardless of ticket status', () => {
    for (const phase of ['grooming', 'implementation', 'review', 'finalize', undefined] as const) {
      for (const status of ['Todo', 'Grooming', 'In Progress', 'Ready']) {
        const session = { phase };
        const task = { status };
        expect(isChatEditGated(session, task), `phase=${phase} status=${status}`).toBe(false);
        expect(disallowedToolsArgs(session, task)).toEqual(['--disallowed-tools', 'AskUserQuestion', 'ScheduleWakeup']);
      }
    }
  });

  it('gates a chat session with no task/status (board-less lookup) rather than fail open', () => {
    const session = { phase: 'chat' as const };
    expect(isChatEditGated(session, undefined)).toBe(true);
    expect(isChatEditGated(session, {})).toBe(true);
  });
});

// FLUX-1389: dispatched (non-chat) phase sessions are one-shot `claude -p` processes that exit at
// turn end — ScheduleWakeup's wakeup can never be honored there, so it must be blocked; a `chat`
// session is genuinely interactive/resumable and must be unaffected.
describe('disallowedToolsArgs blocks ScheduleWakeup for dispatched phases only (FLUX-1389)', () => {
  it('blocks ScheduleWakeup for every dispatched phase (and no explicit phase)', () => {
    for (const phase of ['grooming', 'implementation', 'review', 'finalize', undefined] as const) {
      const args = disallowedToolsArgs({ phase }, { status: 'In Progress' });
      expect(args, `phase=${phase}`).toEqual(expect.arrayContaining(['ScheduleWakeup']));
    }
  });

  it('does not block ScheduleWakeup for a chat session', () => {
    const args = disallowedToolsArgs({ phase: 'chat' }, { status: 'In Progress' });
    expect(args).not.toEqual(expect.arrayContaining(['ScheduleWakeup']));
  });
});

// FLUX-1390: `agents.honorScheduledWakeups` makes the FLUX-1389 block conditional — off (the
// default) is byte-identical to FLUX-1389; on, ScheduleWakeup is no longer disallowed for a
// dispatched phase, since the exit handler now honors it (tryEnterScheduledWake) instead of it
// silently no-oping.
describe('disallowedToolsArgs honors agents.honorScheduledWakeups (FLUX-1390)', () => {
  afterEach(() => {
    delete getConfig().agents;
  });

  it('still blocks ScheduleWakeup for dispatched phases when the flag is off (default)', () => {
    for (const phase of ['grooming', 'implementation', 'review', 'finalize', undefined] as const) {
      const args = disallowedToolsArgs({ phase }, { status: 'In Progress' });
      expect(args, `phase=${phase}`).toEqual(expect.arrayContaining(['ScheduleWakeup']));
    }
  });

  it('does not block ScheduleWakeup for dispatched phases when the flag is on', () => {
    getConfig().agents = { honorScheduledWakeups: true };
    for (const phase of ['grooming', 'implementation', 'review', 'finalize', undefined] as const) {
      const args = disallowedToolsArgs({ phase }, { status: 'In Progress' });
      expect(args, `phase=${phase}`).not.toEqual(expect.arrayContaining(['ScheduleWakeup']));
      expect(args).toEqual(expect.arrayContaining(['AskUserQuestion']));
    }
  });

  it('never blocks ScheduleWakeup for a chat session either way', () => {
    getConfig().agents = { honorScheduledWakeups: false };
    expect(disallowedToolsArgs({ phase: 'chat' }, { status: 'In Progress' })).not.toEqual(expect.arrayContaining(['ScheduleWakeup']));
    getConfig().agents = { honorScheduledWakeups: true };
    expect(disallowedToolsArgs({ phase: 'chat' }, { status: 'In Progress' })).not.toEqual(expect.arrayContaining(['ScheduleWakeup']));
  });
});
