// Matrix expansion and run identity (FLUX-1739) — PURE. No I/O, no spawning, no git.
//
// Everything here must be decidable before a single process starts, so a malformed manifest fails
// immediately rather than after burning three sessions' worth of tokens.

import { createHash } from 'node:crypto';
import { CLI_CAPABILITIES, type CliFramework } from './agents/types.js';
import type { BenchmarkCell, BenchmarkRun, BenchmarkSuite } from './models/benchmark.js';

export class BenchmarkManifestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BenchmarkManifestError';
  }
}

const VALID_FRAMEWORKS = new Set(Object.keys(CLI_CAPABILITIES) as CliFramework[]);

/** A full 40-char SHA, or an abbreviated one. Never a branch name — branches move between cells. */
const COMMIT_RE = /^[0-9a-f]{7,40}$/i;

/**
 * Canonical serialization of a cell. Field order is FIXED here rather than taken from
 * `Object.keys`, because key order is an accident of object construction and would make `runId`
 * depend on how the manifest was parsed rather than on what it says.
 */
export function serializeCell(cell: BenchmarkCell): string {
  return JSON.stringify([cell.framework, cell.model ?? null, cell.effortOverride ?? null, cell.phase]);
}

/**
 * Run identity. Hashes ONLY `suiteId + baseCommit + cell + repetitionIndex`.
 *
 * Deliberately excluded: timestamps, pids, ticket ids, worktree paths, and every output. Those are
 * recorded as data on the run record, never folded into identity — so re-expanding one manifest
 * reproduces exactly the same run set with exactly the same ids, and a report can be recomputed and
 * compared across expansions.
 */
export function computeRunId(suiteId: string, baseCommit: string, cell: BenchmarkCell, repetitionIndex: number): string {
  const payload = JSON.stringify([suiteId, baseCommit, serializeCell(cell), repetitionIndex]);
  return createHash('sha256').update(payload).digest('hex').slice(0, 16);
}

/**
 * Validate a manifest. Throws `BenchmarkManifestError` on the first problem.
 *
 * `baseCommit` is only checked for SHAPE here — whether it actually resolves needs git, which the
 * runner does before it starts. Keeping this function pure is what lets the whole rejection surface
 * be unit-tested without a repo fixture.
 */
export function validateSuite(suite: BenchmarkSuite): void {
  if (!suite.id) throw new BenchmarkManifestError('suite id is required');
  if (!suite.seedPrompt?.trim()) throw new BenchmarkManifestError('seedPrompt is required — every cell runs the same seed task');
  if (!suite.baseCommit || !COMMIT_RE.test(suite.baseCommit)) {
    throw new BenchmarkManifestError(
      `baseCommit must be a commit SHA, got ${JSON.stringify(suite.baseCommit)} — a branch name would drift between cells started minutes apart`,
    );
  }
  if (!Array.isArray(suite.matrix) || suite.matrix.length === 0) {
    throw new BenchmarkManifestError('matrix must contain at least one cell');
  }
  if (!Number.isInteger(suite.repetitions) || suite.repetitions < 1) {
    throw new BenchmarkManifestError(`repetitions must be a positive integer, got ${suite.repetitions}`);
  }

  const seen = new Set<string>();
  for (const cell of suite.matrix) {
    if (!VALID_FRAMEWORKS.has(cell.framework)) {
      throw new BenchmarkManifestError(
        `unknown framework ${JSON.stringify(cell.framework)} — known: ${[...VALID_FRAMEWORKS].join(', ')}`,
      );
    }
    if (!cell.phase) throw new BenchmarkManifestError('each cell must name a phase');
    const key = serializeCell(cell);
    if (seen.has(key)) {
      throw new BenchmarkManifestError(
        `duplicate cell ${key} — two identical cells would silently double that configuration's weight in every rate`,
      );
    }
    seen.add(key);
  }

  if (suite.validation) {
    const v = suite.validation;
    if (!v.command?.trim()) throw new BenchmarkManifestError('validation.command is required when a validation block is present');
    if (!Array.isArray(v.args)) throw new BenchmarkManifestError('validation.args must be an array');
    if (!Array.isArray(v.paths) || v.paths.length === 0) {
      throw new BenchmarkManifestError('validation.paths must name at least one held-out path — without one, an agent can edit the check it is graded by');
    }
    if (!Number.isFinite(v.timeoutMs) || v.timeoutMs <= 0) {
      throw new BenchmarkManifestError('validation.timeoutMs must be a positive number');
    }
  }
}

/**
 * Requested-vs-applied effort, read from `CLI_CAPABILITIES` AT RUN TIME rather than from a hardcoded
 * list of which adapters support effort. Today `gemini` is the only unsupported entry, but that set
 * moves with every adapter change, and a stale copy here would silently report an effort that was
 * never applied.
 */
export function resolveEffort(cell: BenchmarkCell): { requested?: string; applied?: string } {
  if (!cell.effortOverride) return {};
  const caps = CLI_CAPABILITIES[cell.framework];
  const applied = caps?.effort?.supported ? cell.effortOverride : undefined;
  return { requested: cell.effortOverride, ...(applied !== undefined ? { applied } : {}) };
}

/**
 * Cartesian product × repetitions, in a stable order (cell-major, then repetition).
 *
 * Validates first, so an invalid manifest can never produce a partial run set.
 */
export function expandMatrix(suite: BenchmarkSuite): BenchmarkRun[] {
  validateSuite(suite);

  const runs: BenchmarkRun[] = [];
  for (const cell of suite.matrix) {
    const effort = resolveEffort(cell);
    for (let repetitionIndex = 0; repetitionIndex < suite.repetitions; repetitionIndex++) {
      runs.push({
        runId: computeRunId(suite.id, suite.baseCommit, cell, repetitionIndex),
        suiteId: suite.id,
        cell,
        repetitionIndex,
        status: 'pending',
        inputTokens: null,
        outputTokens: null,
        costUSD: null,
        ...(effort.requested !== undefined ? { effortRequested: effort.requested } : {}),
        ...(effort.applied !== undefined ? { effortApplied: effort.applied } : {}),
      });
    }
  }
  return runs;
}
