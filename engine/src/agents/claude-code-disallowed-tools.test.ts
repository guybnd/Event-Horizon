import { describe, it, expect, afterEach, vi } from 'vitest';
import { getConfig } from '../config.js';
import { disallowedToolsArgs, isChatEditGated, FILE_MUTATION_TOOLS, stampDisallowedEhTools } from './claude-code.js';
import * as orchestrationPersonas from '../orchestration-personas.js';

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
    // FLUX-1462: grooming/review now carry a LEAD_PHASE_DENY trim even with no personaId, so their
    // args include extra `mcp__event-horizon__*` entries — asserted via arrayContaining instead of
    // the old exact-equality, which still holds unchanged for implementation/finalize/undefined.
    const TRIMMED_PHASES = new Set(['grooming', 'review']);
    for (const phase of ['grooming', 'implementation', 'review', 'finalize', undefined] as const) {
      for (const status of ['Todo', 'Grooming', 'In Progress', 'Ready']) {
        const session = { phase };
        const task = { status };
        expect(isChatEditGated(session, task), `phase=${phase} status=${status}`).toBe(false);
        const args = disallowedToolsArgs(session, task);
        if (TRIMMED_PHASES.has(phase as string)) {
          expect(args, `phase=${phase} status=${status}`).toEqual(expect.arrayContaining(['--disallowed-tools', 'AskUserQuestion', 'ScheduleWakeup']));
        } else {
          expect(args, `phase=${phase} status=${status}`).toEqual(['--disallowed-tools', 'AskUserQuestion', 'ScheduleWakeup']);
        }
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

// FLUX-1226 (C2) — the second byte-compat surface for the Mission-block -> persona migration.
// Phase B resolves each launch phase's role TEXT through the persona catalog
// (`resolveSoloChatPersona`), but never stamps the resolved default persona's id onto
// `session.personaId` — so this tool-scoping computation (keyed on `session.personaId`, not on
// prompt text) must be completely untouched by the migration, for every phase, by construction.
// A dispatched solo/standalone session still carries no `personaId` and a chat/scratch session is
// still hard-skipped — exactly as before FLUX-1226.
//
// FLUX-1462 deliberately punches one hole in this: `grooming`/`review` now get a per-phase trim
// (`LEAD_PHASE_DENY`) even with no personaId. That's a scoped, intentional exception — split out
// below — not a regression of this gate; `implementation`/`fast-path`/`finalize` stay byte-identical.
describe('disallowedToolsArgs / disallowedEhToolsForPersona stay untouched by the FLUX-1226 persona migration (C2)', () => {
  const UNTRIMMED_DISPATCHED_PHASES = ['fast-path', 'implementation', 'finalize'] as const;

  it('a no-personaId dispatched session stays un-scoped for phases FLUX-1462 does not trim (byte-identical to pre-FLUX-1226)', () => {
    for (const phase of UNTRIMMED_DISPATCHED_PHASES) {
      const args = disallowedToolsArgs({ phase }, { status: 'In Progress' });
      expect(args, `phase=${phase}`).not.toEqual(expect.arrayContaining([expect.stringContaining('mcp__event-horizon__')]));
    }
  });

  it('a chat session (incl. scratch) stays hard-skipped for EH scoping regardless of any stray personaId', () => {
    const chatArgs = disallowedToolsArgs({ phase: 'chat' }, { status: 'In Progress' });
    expect(chatArgs).not.toEqual(expect.arrayContaining([expect.stringContaining('mcp__event-horizon__')]));

    const scratchArgs = disallowedToolsArgs({ phase: 'chat' }, { status: 'In Progress', kind: 'scratch' });
    expect(scratchArgs).not.toEqual(expect.arrayContaining([expect.stringContaining('mcp__event-horizon__')]));
  });
});

// FLUX-1462: a genuinely standalone dispatched grooming/review session (no personaId, no
// patternPosition) gets its `LEAD_PHASE_DENY` trim — the deliberate, ticket-scoped exception to
// the C2 gate above. Any non-standalone patternPosition (a worker delegate's `assistant`/`step`,
// or a scatter-gather orchestrator/combiner's `lead`/`combiner`) must stay untouched.
describe('disallowedToolsArgs trims a dispatched solo lead\'s toolset per phase (FLUX-1462)', () => {
  it('trims branch/finish_ticket/merge_tickets for a standalone grooming session', () => {
    const args = disallowedToolsArgs({ phase: 'grooming' }, { status: 'Grooming' });
    expect(args).toEqual(expect.arrayContaining([
      'mcp__event-horizon__branch', 'mcp__event-horizon__finish_ticket', 'mcp__event-horizon__merge_tickets',
    ]));
  });

  it('trims branch/finish_ticket/merge_tickets for a standalone review session', () => {
    const args = disallowedToolsArgs({ phase: 'review' }, { status: 'Ready' });
    expect(args).toEqual(expect.arrayContaining([
      'mcp__event-horizon__branch', 'mcp__event-horizon__finish_ticket', 'mcp__event-horizon__merge_tickets',
    ]));
  });

  it('FLUX-1383: trims branch/finish_ticket/merge_tickets for a standalone batch-grooming session (same as grooming)', () => {
    const args = disallowedToolsArgs({ phase: 'batch-grooming' }, { status: 'Grooming' });
    expect(args).toEqual(expect.arrayContaining([
      'mcp__event-horizon__branch', 'mcp__event-horizon__finish_ticket', 'mcp__event-horizon__merge_tickets',
    ]));
  });

  it('never trims the NEVER_DENY floor or leaves the phase mission tools scoped', () => {
    const args = disallowedToolsArgs({ phase: 'grooming' }, { status: 'Grooming' });
    expect(args).not.toEqual(expect.arrayContaining([
      'mcp__event-horizon__get_ticket', 'mcp__event-horizon__add_note',
      'mcp__event-horizon__update_ticket', 'mcp__event-horizon__change_status', 'mcp__event-horizon__create_ticket',
    ]));
  });

  it('does NOT trim a worker delegate dispatched into grooming/review (patternPosition assistant/step untouched)', () => {
    const assistantArgs = disallowedToolsArgs({ phase: 'grooming', patternPosition: 'assistant' }, { status: 'Grooming' });
    expect(assistantArgs).not.toEqual(expect.arrayContaining([expect.stringContaining('mcp__event-horizon__branch')]));

    const stepArgs = disallowedToolsArgs({ phase: 'review', patternPosition: 'step' }, { status: 'Ready' });
    expect(stepArgs).not.toEqual(expect.arrayContaining([expect.stringContaining('mcp__event-horizon__branch')]));
  });

  it('does NOT trim a scatter-gather orchestrator/combiner lead (non-standalone patternPosition untouched)', () => {
    const leadArgs = disallowedToolsArgs({ phase: 'review', patternPosition: 'lead' }, { status: 'Ready' });
    expect(leadArgs).not.toEqual(expect.arrayContaining([expect.stringContaining('mcp__event-horizon__')]));
  });

  it('an explicit enableTools grant re-enables a trimmed tool for a standalone dispatch', () => {
    const args = disallowedToolsArgs({ phase: 'grooming', enableTools: ['branch'] }, { status: 'Grooming' });
    expect(args).not.toEqual(expect.arrayContaining(['mcp__event-horizon__branch']));
    expect(args).toEqual(expect.arrayContaining(['mcp__event-horizon__finish_ticket', 'mcp__event-horizon__merge_tickets']));
  });

  it('leaves implementation/fast-path/finalize untouched (no LEAD_PHASE_DENY entry)', () => {
    for (const phase of ['implementation', 'fast-path', 'finalize'] as const) {
      const args = disallowedToolsArgs({ phase }, { status: 'In Progress' });
      expect(args, `phase=${phase}`).not.toEqual(expect.arrayContaining([expect.stringContaining('mcp__event-horizon__')]));
    }
  });
});

// FLUX-1479 (FLUX-1226 Phase E): a persistent chat session's `phase` field stays 'chat' forever
// (FLUX-602), so a phase HANDOFF is carried on the separate `handoffPhase` field instead —
// disallowedToolsArgs/stampDisallowedEhTools must recompute against `handoffPhase ?? phase`, not
// hard-skip just because the literal `phase` is still 'chat'.
describe('disallowedToolsArgs / stampDisallowedEhTools honor a phase handoff (FLUX-1479)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('a chat session with no handoff is unaffected (byte-identical to pre-FLUX-1479)', () => {
    const args = disallowedToolsArgs({ phase: 'chat', handoffPhase: undefined }, { status: 'In Progress' });
    expect(args).not.toEqual(expect.arrayContaining([expect.stringContaining('mcp__event-horizon__')]));
  });

  it('a handed-off chat session recomputes against the destination phase — the recompute genuinely runs, not just the outcome', () => {
    const spy = vi.spyOn(orchestrationPersonas, 'disallowedEhToolsForPersona');
    disallowedToolsArgs({ phase: 'chat', handoffPhase: 'grooming' }, { status: 'In Progress' });
    // The hard-skip ternary must have let the call through with the DESTINATION phase, not 'chat'.
    expect(spy).toHaveBeenCalledWith(expect.objectContaining({ phase: 'grooming' }));
  });

  it('stampDisallowedEhTools recomputes against the destination phase too', () => {
    const spy = vi.spyOn(orchestrationPersonas, 'disallowedEhToolsForPersona');
    const session = { phase: 'chat' as const, handoffPhase: 'grooming' as const, disallowedEhTools: undefined as string[] | undefined };
    stampDisallowedEhTools(session as never);
    expect(spy).toHaveBeenCalledWith(expect.objectContaining({ phase: 'grooming' }));
  });

  it('a handed-off session with no personaId (the phase-default lead persona) still stays un-scoped in the OUTCOME for an untrimmed phase — the recompute runs but resolves to no-op', () => {
    // FLUX-1462: grooming/review now DO trim on handoff (covered separately below) — this case
    // uses 'implementation', which LEAD_PHASE_DENY deliberately never trims, to keep testing the
    // "recompute runs but resolves to no-op" shape FLUX-1479 introduced.
    const session = { phase: 'chat' as const, handoffPhase: 'implementation' as const, disallowedEhTools: undefined as string[] | undefined };
    stampDisallowedEhTools(session as never);
    expect(session.disallowedEhTools).toBeUndefined();
    const args = disallowedToolsArgs({ phase: 'chat', handoffPhase: 'implementation' }, { status: 'In Progress' });
    expect(args).not.toEqual(expect.arrayContaining([expect.stringContaining('mcp__event-horizon__')]));
  });

  it('FLUX-1462: a handed-off session into grooming DOES recompute a real trim (handoff generalizes the new phase-lead deny)', () => {
    const session = { phase: 'chat' as const, handoffPhase: 'grooming' as const, disallowedEhTools: undefined as string[] | undefined };
    stampDisallowedEhTools(session as never);
    expect(session.disallowedEhTools).toEqual(expect.arrayContaining(['branch', 'finish_ticket', 'merge_tickets']));
    const args = disallowedToolsArgs({ phase: 'chat', handoffPhase: 'grooming' }, { status: 'In Progress' });
    expect(args).toEqual(expect.arrayContaining(['mcp__event-horizon__branch', 'mcp__event-horizon__finish_ticket', 'mcp__event-horizon__merge_tickets']));
  });
});

