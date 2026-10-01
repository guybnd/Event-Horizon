// FLUX-1739: L2.5 friction extraction. Pure, so the whole layer is testable from hand-built turn and
// progress fixtures with no spawn and no repo.
import { describe, it, expect } from 'vitest';
import { extractFriction, hasAnyFriction, type FrictionInput } from './benchmark-friction.js';
import { BENCHMARK_REFUSAL_MARKER, REPEAT_CALL_THRESHOLD } from './models/benchmark.js';
import type { Turn } from './projection.js';

let seq = 0;
function turn(raw: unknown): Turn {
  seq++;
  return { turnId: `s:${seq}`, streamId: 's', seq, ts: new Date().toISOString(), role: 'tool', raw };
}

function toolCall(name: string, input: Record<string, unknown> = {}): Turn {
  return turn({ type: 'assistant', message: { content: [{ type: 'tool_use', name, input }] } });
}

function toolFailure(text: string): Turn {
  return turn({ type: 'user', message: { content: [{ type: 'tool_result', is_error: true, content: text }] } });
}

function input(overrides: Partial<FrictionInput> = {}): FrictionInput {
  return { turns: [], progress: [], task: {}, ...overrides };
}

describe('tool failures', () => {
  it('counts a failed tool result', () => {
    const f = extractFriction(input({ turns: [toolCall('Read', { file_path: 'a' }), toolFailure('ENOENT')] }));
    expect(f.toolFailures.count).toBe(1);
    expect(f.toolFailures.evidence[0]!.locator).toBeTruthy();
  });

  it('attributes an EH tool failure to ehToolFailures — the sharpest signal', () => {
    const f = extractFriction(input({
      turns: [toolCall('mcp__event-horizon__get_ticket', { ticketId: 'T-1' }), toolFailure('timeout')],
    }));
    expect(f.ehToolFailures.count).toBe(1);
    expect(f.toolFailures.count).toBe(1);
  });

  it('does not attribute a non-EH tool failure to ehToolFailures', () => {
    const f = extractFriction(input({ turns: [toolCall('Read', { file_path: 'a' }), toolFailure('ENOENT')] }));
    expect(f.ehToolFailures.count).toBe(0);
  });

  it('reads EH failure lines out of durable typed progress entries (step 9)', () => {
    const f = extractFriction(input({
      progress: [{ timestamp: 't1', type: 'info', data: { error: 'Tool failed: mcp__event-horizon__change_status — boom' } }],
    }));
    expect(f.ehToolFailures.count).toBe(1);
    expect(f.toolFailures.count).toBe(1);
    expect(f.toolFailures.evidence[0]!.locator).toBe('t1');
  });

  it('does NOT count the same incident twice when it appears in both transcript and progress', () => {
    // The durable progress line is the SAME failure the transcript already holds as a tool result.
    // Caught by the analyst's dissent on the first clean run: 4 ehToolFailures for 2 incidents.
    const f = extractFriction(input({
      turns: [toolCall('mcp__event-horizon__get_ticket', { ticketId: 'T-1' }), toolFailure('Ticket T-1 not found')],
      progress: [{ timestamp: 't1', type: 'info', data: { error: 'Tool failed: mcp__event-horizon__get_ticket — Ticket T-1 not found' } }],
    }));
    expect(f.ehToolFailures.count).toBe(1);
    expect(f.toolFailures.count).toBe(1);
  });
});

describe('by-design vs unexpected refusals', () => {
  it('counts a marked refusal as by-design and NOT as a tool failure', () => {
    const f = extractFriction(input({
      turns: [
        toolCall('mcp__event-horizon__finish_ticket', {}),
        toolFailure(`${BENCHMARK_REFUSAL_MARKER} Cannot finish BENCH-1 — it is a benchmark run ticket.`),
      ],
    }));
    expect(f.refusedByDesign.count).toBe(1);
    expect(f.refusedUnexpected.count).toBe(0);
    expect(f.toolFailures.count).toBe(0);
    expect(f.ehToolFailures.count).toBe(0);
  });

  it('counts an unmarked refusal as unexpected AND as a tool failure', () => {
    const f = extractFriction(input({
      turns: [toolCall('mcp__event-horizon__change_status', {}), toolFailure('Cannot move ticket: workspace is activating')],
    }));
    expect(f.refusedUnexpected.count).toBe(1);
    expect(f.toolFailures.count).toBe(1);
  });

  it('does not read a shell result containing "cannot" as a refusal', () => {
    const f = extractFriction(input({
      turns: [
        toolCall('Bash', { command: 'ls scripts/seeds' }),
        toolFailure("Exit code 2\nls: cannot access 'scripts/seeds': No such file or directory"),
      ],
    }));
    expect(f.refusedUnexpected.count).toBe(0);
    expect(f.ehToolFailures.count).toBe(0);
    expect(f.toolFailures.count).toBe(1);
    expect(hasAnyFriction(f)).toBe(false);
  });

  it('never lets a by-design refusal raise the grade via hasAnyFriction', () => {
    const f = extractFriction(input({
      turns: [toolCall('mcp__event-horizon__branch', {}), toolFailure(`${BENCHMARK_REFUSAL_MARKER} nope`)],
    }));
    expect(hasAnyFriction(f)).toBe(false);
  });

  it('separates by-design refusals arriving via progress entries too', () => {
    const f = extractFriction(input({
      progress: [{ timestamp: 't1', data: { error: `${BENCHMARK_REFUSAL_MARKER} refused` } }],
    }));
    expect(f.refusedByDesign.count).toBe(1);
    expect(f.toolFailures.count).toBe(0);
  });
});

describe('thrash and disorientation', () => {
  it(`counts ${REPEAT_CALL_THRESHOLD} identical calls as thrash`, () => {
    const turns = Array.from({ length: REPEAT_CALL_THRESHOLD }, () => toolCall('Grep', { pattern: 'x' }));
    expect(extractFriction(input({ turns })).repeatCalls.count).toBe(REPEAT_CALL_THRESHOLD);
  });

  it('does NOT count two identical calls — a retry is not thrash', () => {
    const turns = Array.from({ length: REPEAT_CALL_THRESHOLD - 1 }, () => toolCall('Grep', { pattern: 'x' }));
    expect(extractFriction(input({ turns })).repeatCalls.count).toBe(0);
  });

  it('treats different parameters as different calls', () => {
    const turns = [toolCall('Grep', { pattern: 'a' }), toolCall('Grep', { pattern: 'b' }), toolCall('Grep', { pattern: 'c' })];
    expect(extractFriction(input({ turns })).repeatCalls.count).toBe(0);
  });

  it('is insensitive to parameter key order', () => {
    const turns = [
      toolCall('Grep', { a: 1, b: 2 }),
      toolCall('Grep', { b: 2, a: 1 }),
      toolCall('Grep', { a: 1, b: 2 }),
    ];
    expect(extractFriction(input({ turns })).repeatCalls.count).toBe(REPEAT_CALL_THRESHOLD);
  });

  it('counts repeated re-reads of the same ticket as disorientation', () => {
    const turns = Array.from({ length: 3 }, () => toolCall('get_ticket', { ticketId: 'T-1' }));
    expect(extractFriction(input({ turns })).reReads.count).toBe(3);
  });

  it('counts repeated reads of one path, but not reads of different paths', () => {
    const same = Array.from({ length: 3 }, () => toolCall('Read', { file_path: '/a.ts' }));
    expect(extractFriction(input({ turns: same })).reReads.count).toBe(3);
    const different = ['/a.ts', '/b.ts', '/c.ts'].map((p) => toolCall('Read', { file_path: p }));
    expect(extractFriction(input({ turns: different })).reReads.count).toBe(0);
  });
});

describe('denied tools, interrupts, restarts', () => {
  it('counts a call to a tool the session was scoped away from', () => {
    const f = extractFriction(input({
      turns: [toolCall('finish_ticket', {})],
      task: { disallowedEhTools: ['finish_ticket'] },
    }));
    expect(f.deniedToolAttempts.count).toBe(1);
  });

  it('counts ask-question and permission-request turns as human interrupts', () => {
    const f = extractFriction(input({
      turns: [turn({ type: 'ask-question' }), turn({ type: 'permission-request' }), turn({ type: 'assistant' })],
    }));
    expect(f.humanInterrupts.count).toBe(2);
  });

  it('counts session restarts as sessions beyond the first', () => {
    expect(extractFriction(input({ task: { sessionCount: 3 } })).sessionRestarts.count).toBe(2);
    expect(extractFriction(input({ task: { sessionCount: 1 } })).sessionRestarts.count).toBe(0);
    expect(extractFriction(input({ task: {} })).sessionRestarts.count).toBe(0);
  });
});

describe('protocol violations — detectors that today only flag, never count', () => {
  it('counts a standing needsAction flag', () => {
    const f = extractFriction(input({ task: { needsAction: 'ended turn with no board action' } }));
    expect(f.protocolViolations.count).toBe(1);
  });

  it('counts a require-input park', () => {
    const f = extractFriction(input({ task: { swimlane: 'require-input' } }));
    expect(f.protocolViolations.count).toBe(1);
  });

  it('counts both independently', () => {
    const f = extractFriction(input({ task: { needsAction: 'x', swimlane: 'require-input' } }));
    expect(f.protocolViolations.count).toBe(2);
  });
});

describe('heuristic needsAction is not a violation once the ticket handed off', () => {
  it('ignores "Agent may need your input" on a Ready ticket', () => {
    const f = extractFriction(input({ task: { status: 'Ready', needsAction: 'Agent may need your input: Ticket X is now Ready. Root cause: …', sessionCount: 1, terminal: true } }));
    expect(f.protocolViolations.count).toBe(0);
  });

  it('still counts it while the ticket is in a working status', () => {
    const f = extractFriction(input({ task: { status: 'In Progress', needsAction: 'Agent may need your input: should I …?', sessionCount: 1 } }));
    expect(f.protocolViolations.count).toBe(1);
  });

  it('always counts the hard backstop message, whatever the status', () => {
    const f = extractFriction(input({ task: { status: 'Ready', needsAction: 'Agent left a comment on this "Ready" ticket without raising a structured prompt', sessionCount: 1 } }));
    expect(f.protocolViolations.count).toBe(1);
  });
});

describe('ended in a working status (FLUX-1761)', () => {
  it('counts sessions that all ended with the ticket still In Progress — a hand-off failure', () => {
    // Observed: a run solved its task, said it would wait for a background command, exited, and
    // was graded clean because the needsAction write never landed before collection.
    const f = extractFriction(input({ task: { status: 'In Progress', sessionCount: 1, terminal: true } }));
    expect(f.protocolViolations.count).toBe(1);
    expect(f.protocolViolations.evidence[0]!.locator).toBe('frontmatter:status');
  });

  it('stays OFF for a ticket that is still being worked (not terminal)', () => {
    const f = extractFriction(input({ task: { status: 'In Progress', sessionCount: 1 } }));
    expect(f.protocolViolations.count).toBe(0);
  });

  it('does not double-count a Require Input park, which is a real hand-off', () => {
    const f = extractFriction(input({ task: { status: 'In Progress', swimlane: 'require-input', sessionCount: 1, terminal: true } }));
    expect(f.protocolViolations.count).toBe(1);
    expect(f.protocolViolations.evidence[0]!.locator).toBe('frontmatter:swimlane');
  });

  it('is silent once the ticket left the working set', () => {
    const f = extractFriction(input({ task: { status: 'Ready', sessionCount: 1, terminal: true } }));
    expect(f.protocolViolations.count).toBe(0);
  });
});

describe('orientationCost', () => {
  it('is the injected-context share of the run input tokens', () => {
    const f = extractFriction(input({ contextBudget: { injectedTokens: 250 }, inputTokens: 1000 }));
    expect(f.orientationCost).toBeCloseTo(0.25, 12);
  });

  it('is null — never 0 — when either side is unknown', () => {
    expect(extractFriction(input({ inputTokens: 1000 })).orientationCost).toBeNull();
    expect(extractFriction(input({ contextBudget: { injectedTokens: 100 } })).orientationCost).toBeNull();
    expect(extractFriction(input({ contextBudget: { injectedTokens: 100 }, inputTokens: 0 })).orientationCost).toBeNull();
  });
});

describe('a clean run', () => {
  it('produces every field, all empty, and reports no friction', () => {
    const f = extractFriction(input({ turns: [toolCall('Read', { file_path: '/a' })] }));
    expect(hasAnyFriction(f)).toBe(false);
    expect(f.toolFailures.count).toBe(0);
    expect(f.orientationCost).toBeNull();
    // Every signal is present even when empty, so a report never has to distinguish
    // "no friction" from "field missing".
    for (const key of ['toolFailures', 'ehToolFailures', 'repeatCalls', 'reReads', 'protocolViolations'] as const) {
      expect(f[key]).toEqual({ count: 0, evidence: [] });
    }
  });
});
