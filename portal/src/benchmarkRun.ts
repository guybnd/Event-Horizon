import type { BenchmarkRunRow } from './api';

/**
 * Why a run did not solve (FLUX-1739).
 *
 * `solved` is a three-clause conjunction — the session terminated normally, it produced a diff, AND
 * the held-out check passed against the restored tree. A bare "unsolved" collapses three completely
 * different findings into one: an agent that edited the right file and got the logic wrong is not
 * the same as one that changed nothing, which is not the same as one the provider rate-limited.
 * This is the classifier the whole failure view is organised around.
 */
export type FailureMode = 'solved' | 'regressed' | 'check-failed' | 'empty-diff' | 'crashed' | 'attrition' | 'running';

/**
 * The five infrastructure classes leave every rate's denominator and are reported as attrition —
 * scoring a provider down for being rate-limited measures the network, not the agent.
 */
const INFRASTRUCTURE = new Set(['unavailable', 'auth', 'rate-limit', 'crash', 'cancelled']);

const IN_FLIGHT = new Set(['running', 'pending', 'collecting', 'waiting-for-slot']);

export function classifyRun(run: Pick<BenchmarkRunRow, 'solved' | 'failureClass' | 'status' | 'hasDiff' | 'regressed'>): FailureMode {
  // A run that fixed its ticket AND broke something else is still solved — but reporting it as a
  // plain success hides the finding a reviewer would care about most. Its own outcome, not a
  // footnote on a green tick.
  if (run.solved === true) return run.regressed === true ? 'regressed' : 'solved';
  if (run.failureClass && INFRASTRUCTURE.has(run.failureClass)) return 'attrition';
  // Checked before the diff/check clauses: an in-flight run has not failed anything yet, and
  // reading its absent `hasDiff` as "changed nothing" would report a false empty-diff.
  if (IN_FLIGHT.has(run.status)) return 'running';
  if (run.failureClass) return 'crashed';
  if (run.hasDiff === false) return 'empty-diff';
  return 'check-failed';
}

export const MODE_LABEL: Record<FailureMode, string> = {
  solved: 'solved',
  regressed: 'solved · broke the build',
  'check-failed': 'check failed',
  'empty-diff': 'empty diff',
  crashed: 'crashed',
  attrition: 'attrition',
  running: 'running',
};

/**
 * Pull the first failing assertion out of a validation tail rather than dumping the whole log.
 * The cause is what the reader needs; the run summary around it is noise.
 */
export function firstFailure(tail: string): string {
  const lines = tail.replace(/\r/g, '').split('\n');
  const idx = lines.findIndex((l) => /AssertionError|Error:|✕|FAIL/.test(l));
  if (idx === -1) return lines.slice(-14).join('\n').trim();
  return lines.slice(idx, idx + 14).join('\n').trim();
}
