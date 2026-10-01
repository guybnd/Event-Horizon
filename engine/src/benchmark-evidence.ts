// Evidence collection (FLUX-1739) — turning a finished run ticket into L0 primitives and an L1 verdict.
//
// Everything here reads DURABLE state (ticket frontmatter + history) rather than the in-memory
// `CliSessionRecord`, which is a Map an engine restart destroys. A suite is a multi-hour job, so a
// collector that read live session state would lose every run completed before a restart.
//
// The failure-class normalization is where attrition is decided, and that decision is what keeps the
// solve rate honest: scoring a provider down for being rate-limited measures the network, not the agent.

import { findSessionOutcome } from './history.js';
import { diffFilesForBranch } from './diff-aggregator.js';
import { log } from './log.js';
import type { AgentSessionEntry } from './history.js';
import type { BenchmarkFailureClass, BenchmarkRun } from './models/benchmark.js';

/** The subset of a run ticket this collector reads. Loosely typed, as ticket frontmatter is. */
export interface EvidenceTaskView {
  id?: string;
  status?: string;
  branch?: string;
  history?: unknown[];
  needsAction?: string | null;
  swimlane?: string | null;
  tokenMetadata?: {
    inputTokens?: number | null;
    outputTokens?: number | null;
    costUSD?: number | null;
  } | undefined;
}

/** Every `agent_session` entry on the ticket, newest last. */
export function sessionEntries(task: EvidenceTaskView | null | undefined): AgentSessionEntry[] {
  const history = Array.isArray(task?.history) ? task.history : [];
  return history.filter((e): e is AgentSessionEntry => (e as { type?: string })?.type === 'agent_session');
}

/**
 * Map a session's terminal state onto the benchmark's failure taxonomy.
 *
 * The five INFRASTRUCTURE classes leave every rate's denominator; the rest stay in it. That split is
 * the reason this function reads the durable `outcome` text rather than just `status`: a `failed`
 * session that failed because the provider was rate-limited is attrition, while a `failed` session
 * that failed because the agent crashed the run is a real result — and only the outcome text
 * distinguishes them.
 */
export function classifyFailure(
  status: AgentSessionEntry['status'] | undefined,
  outcome: string | undefined,
): BenchmarkFailureClass | undefined {
  const text = (outcome ?? '').toLowerCase();
  if (/rate.?limit|quota|429|usage limit/.test(text)) return 'rate-limit';
  if (/not authenticated|unauthori[sz]ed|auth(entication)? fail|login/.test(text)) return 'auth';
  if (/not installed|binary not found|command not found|unavailable|enoent/.test(text)) return 'unavailable';
  if (/timed out|timeout/.test(text)) return 'timeout';
  if (status === 'cancelled') return 'cancelled';
  if (status === 'failed') return 'crash';
  // `active` at collection time means the session never reached a terminal state — treat it as a
  // crash rather than silently scoring an unfinished run.
  if (status === 'active') return 'crash';
  return undefined;
}

export interface CollectEvidenceInput {
  task: EvidenceTaskView;
  sessionId?: string | undefined;
  workspaceRoot: string;
  baseCommit: string;
  /** Optional injection point so the collector is testable without a repo. */
  diff?: typeof diffFilesForBranch;
}

export interface CollectedEvidence {
  status: BenchmarkRun['status'];
  failureClass?: BenchmarkFailureClass | undefined;
  sessionOutcome?: string | undefined;
  startedAt?: string | undefined;
  endedAt?: string | undefined;
  durationMs?: number | undefined;
  inputTokens: number | null;
  outputTokens: number | null;
  costUSD: number | null;
  changedFileCount: number;
  hasDiff: boolean;
  changedPaths: string[];
  sessionCount: number;
  finalStatus?: string | undefined;
}

export async function collectEvidence(input: CollectEvidenceInput): Promise<CollectedEvidence> {
  const { task, workspaceRoot, baseCommit } = input;
  const entries = sessionEntries(task);
  const entry = input.sessionId
    ? entries.find((e) => e.sessionId === input.sessionId) ?? entries[entries.length - 1]
    : entries[entries.length - 1];

  const outcome = findSessionOutcome(task as { history?: unknown[] }, entry?.sessionId);
  const failureClass = classifyFailure(entry?.status, outcome);

  const startedAt = entry?.startedAt;
  const endedAt = entry?.endedAt;
  const durationMs = startedAt && endedAt ? Math.max(0, Date.parse(endedAt) - Date.parse(startedAt)) : undefined;

  // Absent telemetry is `null`, never `0`. A run whose token data was lost is not a free run, and
  // averaging a fabricated zero into costPerSolve silently understates it.
  const tm = task.tokenMetadata;
  const inputTokens = typeof tm?.inputTokens === 'number' ? tm.inputTokens : null;
  const outputTokens = typeof tm?.outputTokens === 'number' ? tm.outputTokens : null;
  const costUSD = typeof tm?.costUSD === 'number' ? tm.costUSD : null;

  // Measured against the PINNED baseCommit, explicitly. Without `baseBranch` this defaults to
  // `resolveBaseBranch`, i.e. the moving default branch — which is exactly the drift the suite pins
  // out, and would misattribute post-branch master commits to the run.
  let changedPaths: string[] = [];
  if (task.branch) {
    try {
      const runDiff = input.diff ?? diffFilesForBranch;
      const summary = await runDiff(workspaceRoot, task.branch, { baseBranch: baseCommit });
      // With a dedicated worktree this unions merge-base changes with the uncommitted path set, so a
      // run that never committed still yields a non-empty diff — which matters, because the Ready
      // guard deliberately skips the commit-before-Ready refusal for benchmark tickets.
      changedPaths = (summary.files ?? []).map((f) => f.file).filter(Boolean);
    } catch (err) {
      log.warn(`[benchmark-evidence] diff for ${task.id ?? '?'} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return {
    status: failureClass ? 'failed' : 'completed',
    failureClass,
    sessionOutcome: outcome,
    startedAt,
    endedAt,
    durationMs,
    inputTokens,
    outputTokens,
    costUSD,
    changedFileCount: changedPaths.length,
    hasDiff: changedPaths.length > 0,
    changedPaths,
    sessionCount: entries.length,
    finalStatus: task.status,
  };
}

/**
 * L1: the run verdict.
 *
 * `solved` requires ALL THREE of: a normal terminal state, a non-empty diff, and validation passing
 * against the RESTORED tree. A manifest with no validation block yields `undefined` — telemetry and
 * friction only, never counted as a failure, because "we did not check" is not "it failed".
 */
export function deriveSolved(run: Pick<BenchmarkRun, 'failureClass' | 'hasDiff' | 'validation'>): boolean | undefined {
  if (!run.validation) return undefined;
  // The harness never got to judge the work — attrition, not a verdict.
  if (run.validation.harnessError) return undefined;
  if (run.failureClass) return false;
  if (!run.hasDiff) return false;
  return run.validation.passed === true;
}
