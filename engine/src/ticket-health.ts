// Per-ticket health — retrospective triage of how a ticket's execution actually went (FLUX-1739
// follow-on).
//
// This reuses the benchmark's L2.5 friction extractor verbatim. Nothing in that layer was ever
// benchmark-specific: it reads a ticket's transcript, its `agent_session` progress and its
// frontmatter, all of which every ticket has.
//
// ── THE ONE THING THAT DOES NOT TRANSFER ──────────────────────────────────────
//
// A benchmark can ATTRIBUTE friction because it holds everything constant except the configuration:
// a signal present in every cell is a platform defect, one confined to a single framework is an
// adapter defect. A single ticket has no such control. There is nothing to compare it against, so
// the same raw counts carry much less meaning.
//
// So the signals are split, and only one half is graded:
//
//   UNAMBIGUOUS — bad regardless of what the ticket was. EventHorizon's own tools failing, a call to
//   a tool the session was scoped away from, a refusal nothing predicted, and a turn that ended with
//   no board action. None of these are ever explained by the work being hard.
//
//   CONTEXTUAL — reported, never graded. Re-reads and repeated calls can equally mean a genuinely
//   large ticket, and a human interrupt can be an agent correctly asking about a real ambiguity.
//   Grading these would manufacture alarms on exactly the tickets that most deserve a careful read.
//
// Getting that split wrong in the obvious direction — grade everything — would produce a health
// score that punishes hard tickets, which is worse than having no score at all.

import { readTurns } from './transcript.js';
import { getWorkspace } from './workspace-context.js';
import { extractFriction, type ProgressEntry } from './benchmark-friction.js';
import type { RunFriction } from './models/benchmark.js';

export type TicketHealthGrade = 'clean' | 'noisy' | 'rough' | 'broken';

export interface TicketHealthSignal {
  key: string;
  label: string;
  count: number;
  /** Where it came from — a turn id, or a progress timestamp. Never a claim without one. */
  locators: string[];
  detail?: string | undefined;
}

export interface TicketHealth {
  ticketId: string;
  grade: TicketHealthGrade;
  /** Bad regardless of what the ticket was. These drive the grade. */
  unambiguous: TicketHealthSignal[];
  /** Reported for context, deliberately NOT graded — a big ticket earns these honestly. */
  contextual: TicketHealthSignal[];
  sessionCount: number;
  /** Plain-language reason the grade is what it is, for the surface that renders it. */
  summary: string;
}

const UNAMBIGUOUS: { key: keyof RunFriction; label: string }[] = [
  { key: 'ehToolFailures', label: "EventHorizon's own tools failed" },
  { key: 'refusedUnexpected', label: 'Unexpected refusals' },
  { key: 'deniedToolAttempts', label: 'Called a tool it was scoped away from' },
  { key: 'protocolViolations', label: 'Ended a turn without a board action' },
];

const CONTEXTUAL: { key: keyof RunFriction; label: string }[] = [
  // Sessions are CONTEXTUAL on a real ticket, though they are unambiguous on a benchmark run.
  // A run is one dispatch, so a second session means something broke. A real ticket is worked
  // across grooming, implementation and review by design — counting that as damage graded every
  // long-lived ticket `broken`, which was verified against three real tickets and made the grade
  // carry no information at all.
  { key: 'sessionRestarts', label: 'Sessions on this ticket' },
  { key: 'reReads', label: 'Re-read the same thing' },
  { key: 'repeatCalls', label: 'Repeated identical calls' },
  { key: 'humanInterrupts', label: 'Stopped to ask a human' },
  { key: 'toolFailures', label: 'Tool failures (all tools)' },
  { key: 'refusedByDesign', label: 'Refused by design' },
];

function toSignal(friction: RunFriction, key: keyof RunFriction, label: string): TicketHealthSignal | null {
  const sig = friction[key];
  if (!sig || typeof sig === 'number' || sig.count === 0) return null;
  return {
    key: String(key),
    label,
    count: sig.count,
    locators: sig.evidence.slice(0, 5).map((e) => e.locator),
    detail: sig.evidence[0]?.detail,
  };
}

/**
 * Grade on the unambiguous signals only.
 *
 * `broken` is reserved for a ticket that could not proceed on its own — a turn that ended with no
 * board action, meaning nobody was driving it. That is the thing actually worth flagging. Volume alone tops out at `rough`: a ticket with many small tool failures that still
 * finished is noisy, not broken, and conflating the two would make the loud grade meaningless.
 */
export function gradeTicketHealth(unambiguous: TicketHealthSignal[]): { grade: TicketHealthGrade; summary: string } {
  if (unambiguous.length === 0) {
    return { grade: 'clean', summary: 'Ran without platform friction.' };
  }
  const total = unambiguous.reduce((a, s) => a + s.count, 0);
  const stalled = unambiguous.find((s) => s.key === 'protocolViolations');
  const worst = [...unambiguous].sort((a, b) => b.count - a.count)[0]!;

  if (stalled) {
    return {
      grade: 'broken',
      summary: `${stalled.label.toLowerCase()} (${stalled.count}×) — this ticket could not proceed without a human.`,
    };
  }
  if (total >= 5 || worst.count >= 3) {
    return { grade: 'rough', summary: `${worst.label.toLowerCase()} ${worst.count}×, ${total} platform issues in total.` };
  }
  return { grade: 'noisy', summary: `${total} platform issue${total === 1 ? '' : 's'} — ${worst.label.toLowerCase()}.` };
}

/** Every `agent_session` progress entry on the ticket, flattened. */
function progressOf(task: { history?: unknown[] } | undefined): ProgressEntry[] {
  const history = Array.isArray(task?.history) ? task.history : [];
  const out: ProgressEntry[] = [];
  for (const e of history) {
    const entry = e as { type?: string; progress?: unknown[] };
    if (entry?.type === 'agent_session' && Array.isArray(entry.progress)) out.push(...(entry.progress as ProgressEntry[]));
  }
  return out;
}

function sessionCountOf(task: { history?: unknown[] } | undefined): number {
  const history = Array.isArray(task?.history) ? task.history : [];
  return history.filter((e) => (e as { type?: string })?.type === 'agent_session').length;
}

/**
 * Card-cheap health: computed from the ticket record ALONE, with no file I/O.
 *
 * The full {@link computeTicketHealth} reads the ticket's transcript, which is fine for one open
 * modal and ruinous for a board that re-serializes every card on a ~3s poll. This variant scans only
 * `agent_session` progress and frontmatter — both already in memory.
 *
 * It is cheaper without being a guess, because of FLUX-1739's step-9 change: EventHorizon's own
 * failure lines are now durable TYPED entries (`data.error`) on the session's progress rather than
 * untyped text that compaction discarded. The two signals that actually drive the grade — EH tool
 * failures and a turn that ended with no board action — are therefore both visible here. Only the
 * transcript-derived contextual signals (re-reads, repeated calls) are missing, and those were never
 * graded anyway.
 *
 * Returns `null` for a ticket that has never run a session — nothing to say, and an early exit that
 * keeps the common case on a large board free.
 */
export function computeTicketHealthFromTask(
  task: { id?: string; history?: unknown[]; needsAction?: string | null; swimlane?: string | null; status?: string } | undefined,
): { grade: TicketHealthGrade; summary: string } | null {
  const history = Array.isArray(task?.history) ? task.history : [];
  let sessionCount = 0;
  for (const e of history) if ((e as { type?: string })?.type === 'agent_session') sessionCount++;
  if (sessionCount === 0) return null;

  const friction = extractFriction({
    turns: [],
    progress: progressOf(task),
    task: {
      needsAction: task?.needsAction ?? null,
      swimlane: task?.swimlane ?? null,
      status: task?.status ?? '',
      sessionCount,
    },
  });

  const unambiguous = UNAMBIGUOUS
    .map(({ key, label }) => toSignal(friction, key, label))
    .filter((s): s is TicketHealthSignal => s !== null);

  return gradeTicketHealth(unambiguous);
}

export async function computeTicketHealth(ticketId: string): Promise<TicketHealth> {
  const task = getWorkspace().tasks[ticketId] as
    { history?: unknown[]; needsAction?: string | null; swimlane?: string | null; status?: string } | undefined;

  const turns = await readTurns(ticketId).catch(() => []);
  const sessionCount = sessionCountOf(task);

  const friction = extractFriction({
    turns,
    progress: progressOf(task),
    task: {
      needsAction: task?.needsAction ?? null,
      swimlane: task?.swimlane ?? null,
      status: task?.status ?? '',
      sessionCount,
    },
  });

  const unambiguous = UNAMBIGUOUS.map(({ key, label }) => toSignal(friction, key, label)).filter((s): s is TicketHealthSignal => s !== null);
  const contextual = CONTEXTUAL.map(({ key, label }) => toSignal(friction, key, label)).filter((s): s is TicketHealthSignal => s !== null);
  const { grade, summary } = gradeTicketHealth(unambiguous);

  return { ticketId, grade, unambiguous, contextual, sessionCount, summary };
}

// ── Stale In Progress (FLUX-1775) ──────────────────────────────────────────────
//
// The signals above grade how a session WENT. This one is orthogonal: it flags a ticket nobody
// is currently driving at all — In Progress, no live session, and no history activity for a long
// time. That happens most on epics, where the parent sits untouched while children get worked
// individually and nobody moves the parent when they finish.

export type StaleInProgressSuggestion = 'Done' | 'review' | 'Todo';

export interface StaleInProgressSignal {
  ticketId: string;
  hoursSinceActivity: number;
  childrenDone: number;
  childrenTotal: number;
  suggestion: StaleInProgressSuggestion;
}

/** Default staleness threshold: 48h with no live session and no history activity. */
export const STALE_IN_PROGRESS_MS = 48 * 60 * 60 * 1000;

/** Ms since the most recent parseable `date` in `history`, or null if none is parseable. */
function msSinceLastHistoryEntry(history: unknown[], now: number): number | null {
  let latest: number | null = null;
  for (const e of history) {
    const date = (e as { date?: unknown })?.date;
    if (typeof date !== 'string') continue;
    const ms = new Date(date).getTime();
    if (!Number.isFinite(ms)) continue;
    if (latest === null || ms > latest) latest = ms;
  }
  if (latest === null) return null;
  const elapsed = now - latest;
  return elapsed >= 0 ? elapsed : null;
}

/**
 * Pure classifier: every fact the verdict depends on is a parameter (status, history, whether a
 * live session exists, children's statuses) rather than read from the workspace/session-store
 * here, so it can be tested with a fixed `now` and no fixtures. Callers own gathering those facts
 * (`board-triage.ts`'s `buildTriageFragment`, which already has workspace-scoped active-session
 * and parent/child lookups for its other signals).
 *
 * `suggestion` is `'Done'` when every child is terminal, `'review'` when at least half are (worth
 * a human glance before closing), and `'Todo'` otherwise (including tickets with no children at
 * all) — nudging the parent back to a status someone will actually look at.
 */
export function classifyStaleInProgress(params: {
  ticketId: string;
  status: string;
  inProgressStatus: string;
  history: unknown[];
  hasActiveSession: boolean;
  childrenStatuses: string[];
  terminalStatuses: string[];
  now?: number;
  thresholdMs?: number;
}): StaleInProgressSignal | null {
  if (params.status !== params.inProgressStatus || params.hasActiveSession) return null;

  const now = params.now ?? Date.now();
  const ms = msSinceLastHistoryEntry(params.history, now);
  const threshold = params.thresholdMs ?? STALE_IN_PROGRESS_MS;
  if (ms === null || ms < threshold) return null;

  const terminal = new Set(params.terminalStatuses);
  const childrenTotal = params.childrenStatuses.length;
  const childrenDone = params.childrenStatuses.filter((s) => terminal.has(s)).length;

  let suggestion: StaleInProgressSuggestion = 'Todo';
  if (childrenTotal > 0) {
    if (childrenDone === childrenTotal) suggestion = 'Done';
    else if (childrenDone >= childrenTotal / 2) suggestion = 'review';
  }

  return {
    ticketId: params.ticketId,
    hoursSinceActivity: Math.floor(ms / (60 * 60 * 1000)),
    childrenDone,
    childrenTotal,
    suggestion,
  };
}
