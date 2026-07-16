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

// FLUX-1443: a Scratch ticket (task.kind === 'scratch') must stay gated regardless of
// session.phase/task.status — this is the regression guard for the 2-turn self-unlock
// (change_status -> In Progress unlocking Write/Edit) the ticket fixes. Scoped strictly to
// `kind === 'scratch'`, never to `phase==='chat' && status==='Todo'` generally, so a normal
// ticket's chat-driven implementation is unaffected.
describe('disallowedToolsArgs gates a scratch ticket unconditionally (FLUX-1443)', () => {
  it('gates FILE_MUTATION_TOOLS for a scratch ticket even at status In Progress', () => {
    const session = { phase: 'chat' as const };
    const task = { status: 'In Progress', kind: 'scratch' };
    const args = disallowedToolsArgs(session, task);
    expect(args).toEqual(expect.arrayContaining(['AskUserQuestion', ...FILE_MUTATION_TOOLS]));
  });

  it('gates FILE_MUTATION_TOOLS for a scratch ticket even on a dispatched (non-chat) phase', () => {
    for (const phase of ['grooming', 'implementation', 'review', 'finalize', undefined] as const) {
      const session = { phase };
      const task = { status: 'In Progress', kind: 'scratch' };
      const args = disallowedToolsArgs(session, task);
      expect(args, `phase=${phase}`).toEqual(expect.arrayContaining([...FILE_MUTATION_TOOLS]));
    }
  });

  it('does NOT gate a non-scratch chat ticket at In Progress (no regression to real-ticket chat)', () => {
    const session = { phase: 'chat' as const };
    const task = { status: 'In Progress', kind: undefined };
    expect(disallowedToolsArgs(session, task)).toEqual(['--disallowed-tools', 'AskUserQuestion']);
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

// FLUX-1434: disallowedToolsArgs feeds session.personaId/phase/patternPosition/enableTools/
// focusComment into disallowedEhToolsForPersona's deny-list model (orchestration-personas.ts) and
// prefixes the result with `mcp__event-horizon__` — the CLI-arg-name shape `--disallowed-tools`
// actually needs for an MCP tool (confirmed empirically by FLUX-1376, see the comment above
// disallowedToolsArgs).
describe('disallowedToolsArgs scopes the event-horizon MCP toolset via the deny-list model (FLUX-1434)', () => {
  it('adds no EH tool restriction when no personaId is set (byte-identical to pre-FLUX-1385)', () => {
    const args = disallowedToolsArgs({ phase: 'implementation' }, { status: 'In Progress' });
    expect(args).toEqual(['--disallowed-tools', 'AskUserQuestion', 'ScheduleWakeup']);
  });

  it('adds no EH tool restriction for a lead persona', () => {
    const args = disallowedToolsArgs({ phase: 'implementation', personaId: 'dev-lead' }, { status: 'In Progress' });
    expect(args).toEqual(['--disallowed-tools', 'AskUserQuestion', 'ScheduleWakeup']);
  });

  it('scopes a worker persona delegate down to mcp__event-horizon__-prefixed disallow entries', () => {
    const args = disallowedToolsArgs({ phase: 'review', personaId: 'qa-correctness', patternPosition: 'assistant' }, { status: 'In Progress' });
    expect(args[0]).toBe('--disallowed-tools');
    expect(args).toEqual(expect.arrayContaining(['mcp__event-horizon__change_status', 'mcp__event-horizon__furnace_build']));
    expect(args).not.toEqual(expect.arrayContaining(['mcp__event-horizon__get_ticket', 'mcp__event-horizon__add_note']));
  });

  it('grants the phase baseline to a worker persona launched standalone (undefined patternPosition)', () => {
    // FLUX-1434 regression fix: a standalone launch of a worker persona in the review phase gets
    // the review phase's generic mission tools even though qa-correctness has no persona-level
    // override for them — the whole "any standalone launch of a phase with a worker persona"
    // class the deny-list model's phaseBaseline exists to cover.
    const args = disallowedToolsArgs({ phase: 'review', personaId: 'qa-correctness' }, { status: 'In Progress' });
    expect(args).not.toEqual(expect.arrayContaining(['mcp__event-horizon__change_status']));
    // Still scoped away from furnace tooling the review baseline never grants.
    expect(args).toEqual(expect.arrayContaining(['mcp__event-horizon__furnace_build']));
  });

  it('grants an explicit dispatch.enableTools grant regardless of position', () => {
    const args = disallowedToolsArgs(
      { phase: 'review', personaId: 'qa-correctness', patternPosition: 'assistant', enableTools: ['furnace_ticket'] },
      { status: 'In Progress' },
    );
    expect(args).not.toEqual(expect.arrayContaining(['mcp__event-horizon__furnace_ticket']));
    expect(args).toEqual(expect.arrayContaining(['mcp__event-horizon__change_status']));
  });

  it('never scopes a chat session even with a stray personaId', () => {
    const args = disallowedToolsArgs({ phase: 'chat', personaId: 'qa-correctness' }, { status: 'In Progress' });
    expect(args).not.toEqual(expect.arrayContaining([expect.stringContaining('mcp__event-horizon__')]));
  });

  it('restores the write set for a delegate worker persona with the deprecated sole-reviewer focus text', () => {
    const scoped = disallowedToolsArgs({ phase: 'review', personaId: 'qa-correctness', patternPosition: 'assistant' }, { status: 'In Progress' });
    expect(scoped).toEqual(expect.arrayContaining(['mcp__event-horizon__change_status']));
    const solo = disallowedToolsArgs(
      { phase: 'review', personaId: 'qa-correctness', patternPosition: 'assistant', focusComment: 'You are the SOLE reviewer for this ticket.' },
      { status: 'In Progress' },
    );
    expect(solo).not.toEqual(expect.arrayContaining(['mcp__event-horizon__change_status']));
  });

  it('never emits permission_prompt in the disallow list, even for a scoped delegate (FLUX-1385 regression #6)', () => {
    const args = disallowedToolsArgs({ phase: 'review', personaId: 'qa-correctness', patternPosition: 'assistant' }, { status: 'In Progress' });
    expect(args).not.toEqual(expect.arrayContaining(['mcp__event-horizon__permission_prompt']));
  });
});
