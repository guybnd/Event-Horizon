// L2.5 — platform friction extraction (FLUX-1739). PURE: no I/O, no spawning, no framework branching.
//
// This is the half of the benchmark that measures EVENTHORIZON, not the agent. A configuration can
// pass validation while burning half its budget re-reading the ticket, hitting a refused tool six
// times and parking without a board action — and score identically to a clean run. This layer is
// what makes that difference visible.
//
// Two invariants that are easy to break and expensive to get wrong:
//   • Friction is recorded for SOLVED AND UNSOLVED runs alike, and never feeds `solved`, any L2 rate
//     or the Pareto frontier. A platform that obstructed a successful agent still obstructed it.
//   • A BY-DESIGN refusal is not a defect. The benchmark deliberately refuses PR/push surfaces for
//     run tickets; counting those as EventHorizon failing the agent would make every suite grade
//     itself `obstructive` for working correctly. That is what BENCHMARK_REFUSAL_MARKER separates.
//
// Every counted signal carries an evidence locator (turnId, or a progress timestamp), because the
// analyst in step 13 may not assert anything it cannot cite.

import {
  isEventHorizonTool,
  isHumanInterruptTurn,
  toolCallsInTurn,
  toolResultError,
  type Turn,
} from './projection.js';
import {
  BENCHMARK_REFUSAL_MARKER,
  emptyFriction,
  emptySignal,
  REPEAT_CALL_THRESHOLD,
  type FrictionEvidence,
  type FrictionSignal,
  type RunFriction,
} from './models/benchmark.js';

/** The subset of an `agent_session` progress entry this layer reads. */
export interface ProgressEntry {
  timestamp?: string;
  message?: string;
  type?: string;
  data?: unknown;
}

/** The subset of the run's ticket frontmatter this layer reads. */
export interface FrictionTaskView {
  needsAction?: string | null;
  swimlane?: string | null;
  status?: string;
  /** Tool names the session's own scoping denied — a call to one means prompt and scoping disagree. */
  disallowedEhTools?: string[];
  /** Count of `agent_session` entries on this ticket; more than one means the run restarted. */
  sessionCount?: number;
  /**
   * True when every session on the ticket has ENDED (a benchmark run at collection). Enables the
   * "ended in a working status" rule, which must stay off for a ticket that is still being worked.
   */
  terminal?: boolean;
  /** Statuses that mean "someone is working on it"; defaults to Todo / In Progress. */
  workingStatuses?: string[];
}

const DEFAULT_WORKING_STATUSES = ['Todo', 'In Progress'];

export interface FrictionInput {
  turns: Turn[];
  progress: ProgressEntry[];
  task: FrictionTaskView;
  /** From `computeContextBudget` — reused, never reimplemented. */
  contextBudget?: { injectedTokens?: number | null } | undefined;
  inputTokens?: number | null;
}

function signal(evidence: FrictionEvidence[]): FrictionSignal {
  return { count: evidence.length, evidence };
}

/** Stable identity for "the same call again": tool name plus its serialized parameters. */
function callKey(name: string, input: Record<string, unknown>): string {
  return `${name}::${JSON.stringify(input, Object.keys(input).sort())}`;
}

export function extractFriction(input: FrictionInput): RunFriction {
  const friction = emptyFriction();
  const { turns, progress, task } = input;

  const toolFailures: FrictionEvidence[] = [];
  const ehToolFailures: FrictionEvidence[] = [];
  const refusedByDesign: FrictionEvidence[] = [];
  const refusedUnexpected: FrictionEvidence[] = [];
  const deniedToolAttempts: FrictionEvidence[] = [];
  const humanInterrupts: FrictionEvidence[] = [];

  const denied = new Set(task.disallowedEhTools ?? []);
  const callCounts = new Map<string, FrictionEvidence[]>();
  const readCounts = new Map<string, FrictionEvidence[]>();

  // The call that most recently ran, so a failing tool_result can be attributed to a tool name.
  let lastCall: { name: string; isEh: boolean } | undefined;

  for (const turn of turns) {
    if (isHumanInterruptTurn(turn)) {
      humanInterrupts.push({ locator: turn.turnId, detail: String(turn.raw?.type) });
    }

    for (const call of toolCallsInTurn(turn)) {
      const isEh = isEventHorizonTool(call);
      lastCall = { name: call.name, isEh };

      // Scoping and prompt disagree: the session was told not to have this tool, and asked anyway.
      if (denied.has(call.name) || denied.has(call.rawName)) {
        deniedToolAttempts.push({ locator: turn.turnId, detail: call.name });
      }

      // Thrash: the SAME call with the SAME parameters, repeatedly.
      const key = callKey(call.name, call.input);
      const bucket = callCounts.get(key);
      if (bucket) bucket.push({ locator: turn.turnId, detail: call.name });
      else callCounts.set(key, [{ locator: turn.turnId, detail: call.name }]);

      // Disorientation: re-reading its own ticket, or the same file, over and over.
      const rereadKey = call.name === 'get_ticket' ? `get_ticket:${String(call.input.ticketId ?? '')}`
        : call.name === 'Read' ? `Read:${String(call.input.file_path ?? call.input.path ?? '')}`
        : null;
      if (rereadKey) {
        const rb = readCounts.get(rereadKey);
        if (rb) rb.push({ locator: turn.turnId, detail: rereadKey });
        else readCounts.set(rereadKey, [{ locator: turn.turnId, detail: rereadKey }]);
      }
    }

    const err = toolResultError(turn);
    if (err != null) {
      const ev: FrictionEvidence = { locator: turn.turnId, detail: err.slice(0, 200) };
      // A refusal the platform INTENDS is not a failure. Checked before anything else so a
      // by-design refusal never lands in toolFailures/ehToolFailures.
      if (err.includes(BENCHMARK_REFUSAL_MARKER)) {
        refusedByDesign.push(ev);
      } else if (lastCall?.isEh && /\brefus(ed|es|ing)\b|\bcannot\b|\bnot allowed\b/i.test(err)) {
        // Only the platform's own tools can refuse. A Bash result that happens to contain "cannot"
        // (`ls: cannot access …`, a failing test's stack trace) is the agent's ordinary work; counting
        // it here graded every build-track cell `obstructive` (tower-defense-clean1, both models).
        refusedUnexpected.push(ev);
        toolFailures.push(ev);
        ehToolFailures.push(ev);
      } else {
        toolFailures.push(ev);
        if (lastCall?.isEh) ehToolFailures.push(ev);
      }
    }
  }

  // EH's own normalized failure lines, now durable as typed `data.error` entries (step 9).
  //
  // Used ONLY when there is no transcript. When turns are present every one of these failures is
  // already in them as a tool result, and counting both sources listed each incident twice — the
  // analyst's dissent on the first clean run caught it (4 ehToolFailures for 2 incidents). The
  // progress path exists for the card-cheap health grade, which has no transcript to read.
  for (const entry of turns.length > 0 ? [] : progress) {
    const error = (entry?.data as { error?: unknown } | undefined)?.error;
    if (error == null) continue;
    const text = String(error);
    const ev: FrictionEvidence = { locator: entry.timestamp ?? 'unknown', detail: text.slice(0, 200) };
    if (text.includes(BENCHMARK_REFUSAL_MARKER)) {
      refusedByDesign.push(ev);
      continue;
    }
    toolFailures.push(ev);
    if (/mcp__event-horizon__/.test(text)) ehToolFailures.push(ev);
  }

  const repeatCalls: FrictionEvidence[] = [];
  for (const evidence of callCounts.values()) {
    if (evidence.length >= REPEAT_CALL_THRESHOLD) repeatCalls.push(...evidence);
  }
  const reReads: FrictionEvidence[] = [];
  for (const evidence of readCounts.values()) {
    if (evidence.length >= REPEAT_CALL_THRESHOLD) reReads.push(...evidence);
  }

  // Protocol violations the engine ALREADY detects and today only flags — never counts.
  const protocolViolations: FrictionEvidence[] = [];
  const working = task.workingStatuses ?? DEFAULT_WORKING_STATUSES;
  if (task.needsAction) {
    // The final-message HEURISTIC ("Agent may need your input: …") is a notification that the agent's
    // last words might contain a question, not a detected protocol breach. On a ticket that DID hand
    // off (left the working set) it is at best a wording nit — observed grading a 2/3 cell
    // "obstructive" over "Ticket X is now Ready. Root cause: … which drifts …". Count it only while
    // the ticket is still in a working status, where the engine's hard backstop would agree.
    const heuristic = /^Agent may need your input:/.test(String(task.needsAction));
    if (!heuristic || working.includes(task.status ?? '')) {
      protocolViolations.push({ locator: 'frontmatter:needsAction', detail: String(task.needsAction).slice(0, 200) });
    }
  }
  if (task.swimlane === 'require-input') {
    protocolViolations.push({ locator: 'frontmatter:swimlane', detail: 'parked at require-input' });
  }
  // FLUX-1761: a run whose sessions have all ended with the ticket still in a working status never
  // handed it off — that is the violation itself, whether or not the engine's detector flagged it.
  // Derived from the durable ticket state, so it does not depend on a needsAction write racing the
  // collector (observed: a solved run that exited waiting on a background command, flagged nothing,
  // and graded clean). Off unless the caller says the sessions are terminal.
  if (task.terminal && (task.workingStatuses ?? DEFAULT_WORKING_STATUSES).includes(task.status ?? '') && task.swimlane !== 'require-input') {
    protocolViolations.push({ locator: 'frontmatter:status', detail: `sessions ended with the ticket still "${task.status}" — no hand-off` });
  }

  const restarts = Math.max(0, (task.sessionCount ?? 1) - 1);
  const sessionRestarts: FrictionEvidence[] = Array.from({ length: restarts }, (_, i) => ({
    locator: `session:${i + 2}`,
    detail: 'session restarted on this run ticket',
  }));

  const injected = input.contextBudget?.injectedTokens;
  const orientationCost = injected != null && input.inputTokens != null && input.inputTokens > 0
    ? injected / input.inputTokens
    : null;

  friction.toolFailures = signal(toolFailures);
  friction.ehToolFailures = signal(ehToolFailures);
  friction.refusedByDesign = signal(refusedByDesign);
  friction.refusedUnexpected = signal(refusedUnexpected);
  friction.repeatCalls = signal(repeatCalls);
  friction.reReads = signal(reReads);
  friction.deniedToolAttempts = signal(deniedToolAttempts);
  friction.protocolViolations = signal(protocolViolations);
  friction.humanInterrupts = signal(humanInterrupts);
  friction.sessionRestarts = signal(sessionRestarts);
  friction.orientationCost = orientationCost;
  return friction;
}

/** True when a run recorded any friction at all — the `clean` vs `noisy` boundary. */
export function hasAnyFriction(f: RunFriction): boolean {
  return f.ehToolFailures.count > 0
    || f.repeatCalls.count > 0
    || f.protocolViolations.count > 0
    || f.refusedUnexpected.count > 0
    || f.deniedToolAttempts.count > 0;
}

export { emptySignal };
