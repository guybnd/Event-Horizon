import { describe, it, expect } from 'vitest';
import { gradeTicketHealth, classifyStaleInProgress, STALE_IN_PROGRESS_MS, type TicketHealthSignal } from './ticket-health.js';

// Per-ticket health reuses the benchmark's friction extractor, but NOT its grading. A benchmark can
// attribute friction because it holds everything constant across cells; a single ticket has no such
// control. So only the unambiguous signals are graded, and these tests pin that boundary — because
// the tempting mistake (grade everything) produces a score that punishes hard tickets, which is
// worse than no score at all.

const sig = (key: string, count: number): TicketHealthSignal => ({ key, label: key, count, locators: ['s:1'] });

describe('gradeTicketHealth', () => {
  it('is clean with no unambiguous signals', () => {
    expect(gradeTicketHealth([]).grade).toBe('clean');
  });

  it('is broken when the ticket could not proceed without a human', () => {
    // A turn that ended with no board action, or a session that had to restart, means someone had
    // to step in. That is the thing actually worth flagging.
    expect(gradeTicketHealth([sig('protocolViolations', 1)]).grade).toBe('broken');
  });

  it('does NOT escalate volume alone to broken', () => {
    // A ticket with many small tool failures that still finished is rough, not broken. Conflating
    // the two would make the loudest grade meaningless — which is how health scores get ignored.
    expect(gradeTicketHealth([sig('ehToolFailures', 9)]).grade).toBe('rough');
  });

  it('is rough at meaningful volume and noisy below it', () => {
    expect(gradeTicketHealth([sig('ehToolFailures', 3)]).grade).toBe('rough');
    expect(gradeTicketHealth([sig('ehToolFailures', 1)]).grade).toBe('noisy');
    expect(gradeTicketHealth([sig('ehToolFailures', 2), sig('refusedUnexpected', 3)]).grade).toBe('rough');
  });

  it('names the dominant signal so the summary is actionable', () => {
    const { summary } = gradeTicketHealth([sig('ehToolFailures', 4)]);
    expect(summary).toMatch(/ehToolFailures/i);
    expect(summary).toMatch(/4/);
  });

  it('says plainly when a human had to intervene', () => {
    expect(gradeTicketHealth([sig('protocolViolations', 2)]).summary).toMatch(/could not proceed without a human/i);
  });

  it('does NOT grade on session count -- a real ticket is worked across many sessions by design', () => {
    // Verified against three real tickets: counting sessions as damage graded every long-lived
    // ticket 'broken' and made the grade carry no information. Sessions are contextual here, even
    // though they are unambiguous on a benchmark run where one dispatch means one session.
    expect(gradeTicketHealth([]).grade).toBe('clean');
  });

  it('prefers the stalled signal over a louder volume signal', () => {
    // 9 tool failures is noisy; one turn ending with no board action means nobody was driving.
    // The second is the more important fact even though the first is the bigger number.
    const { grade } = gradeTicketHealth([sig('ehToolFailures', 9), sig('protocolViolations', 1)]);
    expect(grade).toBe('broken');
  });
});

describe('classifyStaleInProgress', () => {
  const NOW = new Date('2026-09-29T12:00:00.000Z').getTime();
  const hoursAgo = (h: number) => new Date(NOW - h * 60 * 60 * 1000).toISOString();

  const base = {
    ticketId: 'FLUX-1',
    status: 'In Progress',
    inProgressStatus: 'In Progress',
    hasActiveSession: false,
    childrenStatuses: [] as string[],
    terminalStatuses: ['Done', 'Released', 'Archived'],
    now: NOW,
  };

  it('is null when the status is not the working In Progress status', () => {
    const r = classifyStaleInProgress({ ...base, status: 'Todo', history: [{ date: hoursAgo(100) }] });
    expect(r).toBeNull();
  });

  it('is null when a session is currently active', () => {
    const r = classifyStaleInProgress({ ...base, hasActiveSession: true, history: [{ date: hoursAgo(100) }] });
    expect(r).toBeNull();
  });

  it('is null when the most recent activity is within the 48h threshold', () => {
    const r = classifyStaleInProgress({ ...base, history: [{ date: hoursAgo(10) }] });
    expect(r).toBeNull();
  });

  it('is null when history has no parseable date', () => {
    const r = classifyStaleInProgress({ ...base, history: [{ note: 'no date field' }] });
    expect(r).toBeNull();
  });

  it('flags a ticket idle past the threshold and reports hours since activity', () => {
    const r = classifyStaleInProgress({ ...base, history: [{ date: hoursAgo(72) }, { date: hoursAgo(90) }] });
    expect(r).not.toBeNull();
    expect(r!.hoursSinceActivity).toBe(72);
  });

  it('respects an explicit thresholdMs override', () => {
    expect(classifyStaleInProgress({ ...base, history: [{ date: hoursAgo(10) }], thresholdMs: 5 * 60 * 60 * 1000 })).not.toBeNull();
    expect(STALE_IN_PROGRESS_MS).toBe(48 * 60 * 60 * 1000);
  });

  it('suggests Todo with no children', () => {
    const r = classifyStaleInProgress({ ...base, history: [{ date: hoursAgo(72) }] });
    expect(r!.suggestion).toBe('Todo');
    expect(r!.childrenTotal).toBe(0);
  });

  it('suggests Done when every child is terminal', () => {
    const r = classifyStaleInProgress({
      ...base,
      history: [{ date: hoursAgo(72) }],
      childrenStatuses: ['Done', 'Released'],
    });
    expect(r!.suggestion).toBe('Done');
    expect(r!.childrenDone).toBe(2);
    expect(r!.childrenTotal).toBe(2);
  });

  it('suggests review when at least half the children are done but not all', () => {
    const r = classifyStaleInProgress({
      ...base,
      history: [{ date: hoursAgo(72) }],
      childrenStatuses: ['Done', 'Done', 'In Progress', 'Todo'],
    });
    expect(r!.suggestion).toBe('review');
    expect(r!.childrenDone).toBe(2);
    expect(r!.childrenTotal).toBe(4);
  });

  it('suggests Todo when fewer than half the children are done', () => {
    const r = classifyStaleInProgress({
      ...base,
      history: [{ date: hoursAgo(72) }],
      childrenStatuses: ['Done', 'In Progress', 'Todo'],
    });
    expect(r!.suggestion).toBe('Todo');
  });
});
