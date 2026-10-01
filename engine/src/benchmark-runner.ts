// The benchmark runner (FLUX-1739) — mints one throwaway ticket per run, dispatches it, collects its
// evidence, and tears the worktree down without ever letting the run's output reach the real repo.
//
// This module deliberately does NOT import `models/furnace.ts` or `furnace-stoker.ts`. It reuses the
// Furnace's PATTERNS (sidecar store, self-fetch dispatch, report shape) and none of its types: the
// Furnace keys on `ticketId` throughout, so N concurrent repetitions of ONE seed — the whole premise
// of a benchmark — have no representation in its model.

import fs from 'node:fs/promises';
import { createTask, updateTaskWithHistory } from './task-store.js';
import { getEnginePort } from './packaged-mode.js';
import { getWorkspace, resolveWorkspaceByRoot, runWithWorkspace } from './workspace-context.js';
import { cliSessionsById } from './session-store.js';
import { ensureTicketIsolation } from './ticket-isolation.js';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { removeTaskWorktree, detachTaskWorktree, taskWorktreeDir, linkWorktreeDependencies, DEFAULT_MAX_TASK_WORKTREES } from './task-worktree.js';
import { runGit } from './git-exec.js';
import { log } from './log.js';
import { captureEngineProvenance } from './benchmark-provenance.js';
import { getLocalVersion } from './update-check.js';
import { beginCollection, endCollection, refreshCollection } from './benchmark-collection-guard.js';
import { collectEvidence, deriveSolved, type EvidenceTaskView } from './benchmark-evidence.js';
import { runGuardedValidation } from './benchmark-validation.js';
import { extractFriction } from './benchmark-friction.js';
import { updateBenchmarkRun, getBenchmarkDir } from './benchmark-store.js';
import { readTurns } from './transcript.js';
import { toolCallsInTurn } from './projection.js';
import { computeContextBudget } from './context-budget-metrics.js';
import { CLI_CAPABILITIES, type CliSessionStatus } from './agents/types.js';
import { resolveCliVersion } from './agents/cli-version.js';
import {
  BENCHMARK_KIND,
  DEFAULT_RUN_BUDGET_MS,
  resolveConcurrency,
  type BenchmarkRun,
  type BenchmarkSuite,
} from './models/benchmark.js';

/** Extra grace, after the session entry finalizes, for `tokenMetadata` to be written. */
const TOKEN_METADATA_GRACE_MS = 20_000;

const engineBase = () => `http://127.0.0.1:${getEnginePort()}`;

// ── Ticket minting is serialized ──────────────────────────────────────────────

/**
 * `createTask` is NOT safe to call concurrently, and a benchmark is the first thing in the engine
 * that ever does.
 *
 * It derives the next id by scanning `ws.tasks` for the current max, then (in orphan mode) AWAITS
 * `getMaxIdFromRemote` before writing the new ticket file. Two runs starting together both scan,
 * both compute `maxId + 1`, and both receive the SAME id — after which they also share a worktree
 * path, because `taskWorktreeDir` derives it purely from the ticket id. Observed live: two cells of
 * one suite both minted `BENCH-2`, and the second died with "a worktree already exists ... on a
 * different branch".
 *
 * That collision destroys the premise the whole design rests on — one throwaway ticket per run is
 * what makes N repetitions of one seed representable at all, and what keeps each run's telemetry,
 * transcript and diff its own.
 *
 * Serializing HERE rather than fixing `createTask`'s allocator is deliberate: the allocator is on
 * the path of every ticket the board creates, so widening a lock there is a change with board-wide
 * blast radius that deserves its own ticket and its own review. This confines the fix to the only
 * caller that actually creates tickets concurrently. Minting is milliseconds; the runs it gates are
 * minutes, so the serialization costs nothing measurable.
 */
let mintChain: Promise<unknown> = Promise.resolve();

export function withTicketMintLock<T>(fn: () => Promise<T>): Promise<T> {
  const result = mintChain.then(fn, fn);
  mintChain = result.then(() => {}, () => {});
  return result;
}

// ── Preflight ─────────────────────────────────────────────────────────────────

/**
 * Can this cell actually run as specified? A cell that cannot is recorded UNAVAILABLE with a reason
 * and never substituted for.
 *
 * MLPerf's closed division is the precedent: a silent fallback to a different framework, model or
 * effort makes the published result a lie about what was measured. It is always better to report a
 * missing cell than a wrong one.
 */
export function preflightCell(cell: BenchmarkRun['cell']): { ok: true } | { ok: false; reason: string } {
  const caps = CLI_CAPABILITIES[cell.framework];
  if (!caps) return { ok: false, reason: `unknown framework ${cell.framework}` };
  if (cell.effortOverride && !caps.effort.supported) {
    // Not fatal — recorded as requested-vs-applied rather than refused, because the run still
    // measures something real about that framework. The report must not claim the effort applied.
    return { ok: true };
  }
  return { ok: true };
}

// ── Dispatch seam ─────────────────────────────────────────────────────────────

export interface DispatchResult { sessionId: string | null; error?: string }

/**
 * Start the run's agent session through the SAME self-fetch seam the Furnace uses, so
 * `SpawnOptions`/`createPendingSession`/`prepareAndLaunchSession` stay module-private.
 *
 * Deliberately sent WITHOUT `isolation`: the runner already created the worktree, pinned to the
 * suite's baseCommit. `prepareAndLaunchSession` calls `ensureTicketIsolation` with NO `baseBranch`,
 * so letting the route do it would branch from the default branch's live HEAD — drifting between
 * cells started minutes apart and destroying the only thing that makes cells comparable.
 */
export async function dispatchRun(
  ticketId: string,
  run: BenchmarkRun,
  workspaceRoot: string | null,
): Promise<DispatchResult> {
  const body: Record<string, unknown> = {
    phase: run.cell.phase,
    skipPermissions: true,
    patternPosition: 'standalone',
    user: 'Benchmark',
    framework: run.cell.framework,
    supersedeParked: true,
  };
  if (run.cell.model) body.model = run.cell.model;
  if (run.cell.effortOverride) body.effortOverride = run.cell.effortOverride;

  try {
    const res = await fetch(`${engineBase()}/api/tasks/${encodeURIComponent(ticketId)}/cli-session/start`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(workspaceRoot ? { 'X-EH-Workspace': workspaceRoot } : {}),
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const err = (await res.json().catch(() => ({}))) as { error?: string };
      return { sessionId: null, error: err?.error || res.statusText };
    }
    const j = (await res.json().catch(() => ({}))) as { session?: { id?: string } };
    return { sessionId: j.session?.id ?? null };
  } catch (e: unknown) {
    return { sessionId: null, error: e instanceof Error ? e.message : String(e) };
  }
}

/** A worktree-cap rejection — the exact predicate `reclaimOnCapAndRetry` already tests. */
export function isCapRejection(err: unknown): boolean {
  return /limit reached/i.test(err instanceof Error ? err.message : String(err));
}

/**
 * Is a dispatch refusal worth retrying?
 *
 * A freshly-minted ticket is not instantly visible to the start route: the board cache is populated
 * asynchronously, and a workspace that is still activating refuses outright. Both surface as a
 * refusal that looks permanent but resolves in seconds.
 *
 * Observed live, and it mis-scores rather than merely retries: one cell of a two-cell suite dispatched
 * fine while its sibling came back "Task not found" and was recorded `failureClass: 'crash'` — a
 * scored failure against a configuration that never got to run. A transient refusal must not enter
 * the denominator as if the agent had failed.
 */
export function isTransientDispatchRefusal(error: string | undefined): boolean {
  if (!error) return false;
  return /task not found|is activating|not open|please retry/i.test(error);
}

const DISPATCH_RETRIES = 15;
const DISPATCH_RETRY_DELAY_MS = 2_000;

/**
 * Wait until the start route can see the ticket: GET it with the same workspace header the dispatch
 * will use. Bounded; on timeout we proceed and let dispatchWithRetry report the real refusal.
 */
export async function awaitTicketVisible(ticketId: string, workspaceRoot: string | null, timeoutMs = 30_000, pollMs = 1_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const res = await fetch(`${engineBase()}/api/tasks/${encodeURIComponent(ticketId)}`, {
        headers: workspaceRoot ? { 'X-EH-Workspace': workspaceRoot } : {},
      });
      if (res.ok) return true;
    } catch { /* engine not reachable yet — keep waiting */ }
    if (Date.now() >= deadline) {
      log.warn(`[benchmark-runner] ${ticketId} not visible to the start route after ${timeoutMs}ms — dispatching anyway`);
      return false;
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}

/** Dispatch, retrying only the refusals that are genuinely transient. */
export async function dispatchWithRetry(
  ticketId: string,
  run: BenchmarkRun,
  workspaceRoot: string | null,
  dispatch: typeof dispatchRun = dispatchRun,
): Promise<DispatchResult> {
  let last: DispatchResult = { sessionId: null, error: 'not attempted' };
  for (let attempt = 0; attempt <= DISPATCH_RETRIES; attempt++) {
    last = await dispatch(ticketId, run, workspaceRoot);
    if (last.sessionId) return last;
    if (!isTransientDispatchRefusal(last.error)) return last;
    log.info(`[benchmark-runner] dispatch for ${ticketId} refused transiently (${last.error}) — retry ${attempt + 1}/${DISPATCH_RETRIES}`);
    await new Promise((resolve) => setTimeout(resolve, DISPATCH_RETRY_DELAY_MS));
  }
  return last;
}

// ── Teardown ──────────────────────────────────────────────────────────────────

export interface TeardownResult {
  outcome: 'removed' | 'detached' | 'failed';
  error?: string;
}

/**
 * Tear a finished run's worktree down. THE ORDER IS THE GUARANTEE, and both of its steps exist
 * because of a specific way the tree can escape:
 *
 *   1. COMMIT FIRST. A run's tree is dirty BY DESIGN — the Ready guard skips commit-before-Ready,
 *      an uncommitted run is explicitly scoreable, and validation copies held-out paths back
 *      afterwards. `removeTaskWorktree` refuses a dirty tree outright (it throws rather than
 *      force-removing, so it can never discard real work), so without a commit teardown throws on
 *      essentially every run, the slot is never returned, and the suite deadlocks after a few cells.
 *      The commit is also what makes "keep the local branch" mean anything: without it an
 *      uncommitted run leaves a ZERO-COMMIT branch recording nothing while the worktree holding its
 *      actual edits is deleted.
 *
 *   2. NEVER `detachTaskWorktree` WITHOUT `applyToMain: false`. That option defaults to TRUE — it
 *      applies the stashed work onto the main tree "so it surfaces on master". For a benchmark that
 *      is the worst possible outcome: the uncontrolled destination is not `origin`, it is the user's
 *      own checkout.
 *
 * The caller must archive the ticket ONLY after this returns a non-`failed` outcome. `Ready` is not
 * in `TERMINAL_TICKET_STATUSES`, so a run left at Ready reads as non-terminal to `isTicketTerminal`,
 * and the reconcile sweep's `if (dirty && !detachDirty) continue` skips its tree instead of
 * detaching it onto main. That is what makes a crashed runner safe too.
 */
export async function teardownRun(
  workspaceRoot: string,
  worktreePath: string,
  runId: string,
): Promise<TeardownResult> {
  try {
    // 1 — commit whatever the agent left, onto the run's own local branch.
    await runGit(['add', '-A'], { cwd: worktreePath });
    // Decide "is there anything to commit" by INSPECTING the tree, not by pattern-matching a failed
    // commit's error text: a run that changed nothing is the normal empty-diff case, and inferring
    // it from an error string would both log a spurious warning and mask a real commit failure.
    const staged = (await runGit(['status', '--porcelain'], { cwd: worktreePath })).stdout.trim();
    if (staged.length > 0) {
      try {
        // `--no-verify`: a repo pre-commit hook (lint/format over agent output) failing here would
        // leave the tree dirty and reinstate the exact failure this step exists to prevent. The
        // commit is a RECORD, not a contribution.
        await runGit(['commit', '--no-verify', '-m', `benchmark run ${runId}`], { cwd: worktreePath });
      } catch (err) {
        log.warn(`[benchmark-runner] commit for ${runId} failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // 2 — only a genuinely clean tree may go through removeTaskWorktree.
    const { stdout } = await runGit(['status', '--porcelain'], { cwd: worktreePath });
    if (stdout.trim().length === 0) {
      await removeTaskWorktree(workspaceRoot, worktreePath);
      return { outcome: 'removed' };
    }

    // Residue `add -A` could not stage (e.g. a nested repo). Preserve it as a stash ref, explicitly
    // NOT applied to the main tree.
    await detachTaskWorktree(workspaceRoot, worktreePath, { applyToMain: false, ticketId: runId });
    return { outcome: 'detached' };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    log.warn(`[benchmark-runner] teardown for ${runId} failed: ${error}`);
    return { outcome: 'failed', error };
  }
}

// ── One run, end to end ───────────────────────────────────────────────────────

export interface RunOneOptions {
  suite: BenchmarkSuite;
  run: BenchmarkRun;
  workspaceRoot: string;
  /** Injected in tests so a run can be driven without spawning a real agent. */
  dispatch?: typeof dispatchRun;
  /** Resolves once the run's session reaches a terminal state. */
  awaitTerminal?: (ticketId: string, sessionId: string | null, budgetMs: number) => Promise<unknown>;
}

/**
 * Execute one matrix cell repetition.
 *
 * The collection window opens BEFORE dispatch and closes in a `finally` after teardown. Opening it
 * later would be too late: the runner does not regain control at the instant the run's session ends,
 * and in that gap the ticket rests at Ready with no live session — reclaimable by the reconcile sweep
 * and by any sibling run's cap backstop, which bypasses the Ready grace buffer entirely.
 */
export async function runOne(opts: RunOneOptions): Promise<BenchmarkRun> {
  const { suite, run, workspaceRoot } = opts;
  const budgetMs = suite.wallClockBudgetMs ?? DEFAULT_RUN_BUDGET_MS;

  // Stamp the platform BEFORE anything else — a run that dies at preflight is still a data point,
  // and still needs to say which EventHorizon produced it.
  run.engine = await captureEngineProvenance(workspaceRoot, getLocalVersion());
  // ...and which agent CLI (FLUX-1759). Cached per framework per engine process; null when the probe
  // fails, so "unknown" is recorded rather than omitted.
  run.cli = { framework: run.cell.framework, version: await resolveCliVersion(run.cell.framework) };

  const pre = preflightCell(run.cell);
  if (!pre.ok) {
    run.status = 'failed';
    run.failureClass = 'unavailable';
    run.sessionOutcome = pre.reason;
    return run;
  }

  const created = await withTicketMintLock(() => createTask({
    title: `${suite.seedTitle} [${run.cell.framework}/${run.cell.model ?? 'default'}#${run.repetitionIndex}]`,
    body: suite.seedPrompt,
    status: 'Todo',
    kind: BENCHMARK_KIND,
    createdBy: 'Benchmark',
  } as never));
  const ticketId = (created as { id?: string })?.id ?? String(created);
  run.ticketId = ticketId;

  // The window opens here — before anything can dispatch, park, or finish.
  beginCollection(ticketId, budgetMs);
  let worktreePath: string | undefined;
  try {
    const isolation = await ensureTicketIsolation(ticketId, {
      worktree: true,
      baseBranch: suite.baseCommit, // pinned; a branch name would drift between cells
      pushBranch: false,            // nothing this suite does reaches origin
      updatedBy: 'Benchmark',
    });
    run.branch = isolation.branch;
    worktreePath = isolation.worktree ?? taskWorktreeDir(workspaceRoot, ticketId);
    run.worktreePath = worktreePath;

    run.status = 'running';
    run.startedAt = new Date().toISOString();

    // The start route resolves the ticket through the request's workspace, which is not guaranteed
    // to be the same cache instance createTask wrote into (observed live on a freshly restarted
    // engine: three tickets on disk and in this process's `ws.tasks`, "Task not found" from the
    // route for 12 s, then the watcher loaded them). Wait until the route itself can see the ticket.
    if (!opts.dispatch) await awaitTicketVisible(ticketId, workspaceRoot);

    const dispatch = opts.dispatch ?? dispatchRun;
    const result = await dispatchWithRetry(ticketId, run, workspaceRoot, dispatch);
    if (!result.sessionId) {
      run.status = 'failed';
      run.failureClass = 'crash';
      run.sessionOutcome = result.error ?? 'dispatch produced no session';
    } else {
      run.sessionId = result.sessionId;
      if (opts.awaitTerminal) await opts.awaitTerminal(ticketId, result.sessionId, budgetMs);
      refreshCollection(ticketId, budgetMs);
      // The in-memory session going terminal is NOT the same event as the ticket's durable entry
      // being written. Collecting on the former reads a half-written record and mis-scores a
      // finished run as a crash.
      await awaitDurableOutcome(ticketId, result.sessionId);
      refreshCollection(ticketId, budgetMs);
    }

    // Only advance to `collecting` when there is something to collect. Previously this ran
    // unconditionally and overwrote the `failed` status a dispatch failure had just set, so a run
    // that never started was left stuck at `collecting` with no failure class — invisible in the
    // report rather than counted as attrition.
    if (run.status !== 'failed') {
      run.status = 'collecting';
      await collectRun(suite, run, ticketId, workspaceRoot);
    }
  } catch (err) {
    run.status = 'failed';
    run.failureClass = isCapRejection(err) ? 'unavailable' : 'crash';
    run.sessionOutcome = err instanceof Error ? err.message : String(err);
  } finally {
    // Teardown happens INSIDE the window; only then may the ticket be archived.
    if (worktreePath) {
      const teardown = await teardownRun(workspaceRoot, worktreePath, run.runId);
      if (teardown.outcome !== 'failed') {
        await archiveRunTicket(ticketId);
      } else {
        // Leave the ticket at its current (non-terminal) status so the sweep declines to touch a
        // still-dirty tree, and keep the path on the record for diagnosis.
        log.warn(`[benchmark-runner] leaving ${ticketId} un-archived at ${worktreePath} — teardown failed`);
      }
    }
    endCollection(ticketId);
  }

  run.endedAt = new Date().toISOString();
  return run;
}

// ── Recollection ──────────────────────────────────────────────────────────────

/**
 * Which runs can be re-collected: the agent finished, but COLLECTION crashed.
 *
 * The distinguishing fact is a `crash` with a branch on record. A run that crashed before dispatch
 * has no branch; a run the agent genuinely crashed is classified from its session entry at
 * collection time and will simply classify the same way again. A finished run's evidence is durable
 * — the diff is committed onto its branch by teardown, cost and duration live on the ticket — so a
 * collector bug must never be what decides its score. Observed live: an EXDEV in the held-out
 * parking scored two solved runs as crashes.
 */
export function selectRecollectable(runs: BenchmarkRun[], runIds?: string[]): BenchmarkRun[] {
  const wanted = runIds && runIds.length > 0 ? new Set(runIds) : null;
  return runs.filter((r) =>
    (wanted ? wanted.has(r.runId) : r.status === 'failed' && r.failureClass === 'crash')
    && Boolean(r.ticketId) && Boolean(r.branch),
  );
}

/**
 * Re-run collection for one run whose agent work already finished.
 *
 * Recreates the worktree from the run's branch when teardown has already removed it (the diff is on
 * the branch; the worktree is disposable), then goes through the SAME collect → teardown → archive
 * sequence as a first collection, inside the same collection window.
 */
export async function recollectRun(suite: BenchmarkSuite, run: BenchmarkRun, workspaceRoot: string): Promise<BenchmarkRun> {
  const ticketId = run.ticketId;
  if (!ticketId || !run.branch) throw new Error(`run ${run.runId} has no ticket/branch to recollect from`);
  const budgetMs = suite.wallClockBudgetMs ?? DEFAULT_RUN_BUDGET_MS;
  let worktreePath = run.worktreePath ?? taskWorktreeDir(workspaceRoot, ticketId);

  beginCollection(ticketId, budgetMs);
  try {
    // A path with no `.git` is a HUSK — residue a failed teardown could not remove — not a worktree.
    // Reusing it makes every git command fail. Clear it and rebuild from the branch. Observed live.
    if (existsSync(worktreePath) && !existsSync(path.join(worktreePath, '.git'))) {
      log.warn(`[benchmark-runner] ${worktreePath} is a husk (no .git) — rebuilding from ${run.branch}`);
      await runGit(['worktree', 'prune'], { cwd: workspaceRoot }).catch(() => {});
      try {
        await fs.rm(worktreePath, { recursive: true, force: true });
      } catch (err) {
        // A husk whose directory is held open (EBUSY — observed live, holder unknown) cannot be
        // cleared from here. Route around it with a suffixed recovery path, the same shape
        // task-worktree.ts uses for unrepairable husks (FLUX-1644); the branch is what matters.
        worktreePath = `${worktreePath}-r2`;
        log.warn(`[benchmark-runner] husk could not be removed (${err instanceof Error ? err.message : String(err)}) — using ${worktreePath}`);
        if (existsSync(worktreePath) && !existsSync(path.join(worktreePath, '.git'))) {
          await fs.rm(worktreePath, { recursive: true, force: true });
        }
      }
    }
    if (!existsSync(worktreePath)) {
      await runGit(['worktree', 'add', worktreePath, run.branch], { cwd: workspaceRoot });
      await linkWorktreeDependencies(workspaceRoot, worktreePath).catch((err) =>
        log.warn(`[benchmark-runner] linking node_modules into recollect worktree failed: ${err instanceof Error ? err.message : String(err)}`),
      );
    }
    run.worktreePath = worktreePath;
    // The prior verdict was the collector's, not the run's. Clear it so collection decides afresh.
    delete run.failureClass;
    delete run.sessionOutcome;
    delete run.solved;
    delete run.validation;
    delete run.regression;
    delete run.regressed;
    run.status = 'collecting';
    await collectRun(suite, run, ticketId, workspaceRoot);
  } catch (err) {
    run.status = 'failed';
    run.failureClass = 'crash';
    run.sessionOutcome = `recollect: ${err instanceof Error ? err.message : String(err)}`;
  } finally {
    const teardown = await teardownRun(workspaceRoot, worktreePath, run.runId);
    if (teardown.outcome !== 'failed') await archiveRunTicket(ticketId);
    else log.warn(`[benchmark-runner] leaving ${ticketId} un-archived at ${worktreePath} — teardown failed`);
    endCollection(ticketId);
  }
  run.endedAt = new Date().toISOString();
  return run;
}

/** Re-collect every eligible run of a suite, one at a time, with the workspace pinned. */
export async function recollectSuite(suite: BenchmarkSuite, runs: BenchmarkRun[], workspaceRoot: string, runIds?: string[]): Promise<BenchmarkRun[]> {
  const targets = selectRecollectable(runs, runIds);
  return runWithWorkspace(resolveWorkspaceByRoot(workspaceRoot), async () => {
    for (const run of targets) {
      log.info(`[benchmark-runner] recollecting ${run.runId} (${run.ticketId}) for suite ${suite.id}`);
      await recollectRun(suite, run, workspaceRoot);
      // Replace, don't merge: recollection DELETES the prior verdict's fields, and a merge would let
      // the stale stored `solved: false` survive a run that is now attrition. Observed live.
      // `stored` may be the VERY SAME object as `run` (the route hands the in-memory record's runs
      // to this function), so snapshot first — clearing then assigning from itself emptied the run
      // and crashed the report. Observed live.
      const next = { ...run };
      await updateBenchmarkRun(suite.id, run.runId, (stored) => {
        for (const key of Object.keys(stored)) delete (stored as unknown as Record<string, unknown>)[key];
        Object.assign(stored, next);
      }, workspaceRoot).catch(() => {});
    }
    return targets;
  });
}

// ── Cleanup ───────────────────────────────────────────────────────────────────

/**
 * Which run branches a finished suite can drop.
 *
 * A run branch exists for exactly one reason after the run ends: recollection. Once a run is
 * `completed` its evidence is on the record (changed paths, validation output, cost, duration) and
 * the branch is a 31-branches-later liability. A `crash` run keeps its branch — that is the case
 * recollection exists for — and so does a run still in flight.
 */
export function selectCleanupBranches(runs: BenchmarkRun[]): BenchmarkRun[] {
  return runs.filter((r) =>
    Boolean(r.branch) && !r.branchRemovedAt
    && (r.status === 'completed' || (r.status === 'failed' && r.failureClass !== 'crash')),
  );
}

/** Delete the local run branches a finished suite no longer needs. Never touches the remote — run branches are never pushed. */
export async function cleanupSuite(suite: BenchmarkSuite, runs: BenchmarkRun[], workspaceRoot: string): Promise<BenchmarkRun[]> {
  const targets = selectCleanupBranches(runs);
  const done: BenchmarkRun[] = [];
  const stamp = async (run: BenchmarkRun) => {
    const at = new Date().toISOString();
    run.branchRemovedAt = at;
    done.push(run);
    await updateBenchmarkRun(suite.id, run.runId, (stored) => { stored.branchRemovedAt = at; }, workspaceRoot).catch(() => {});
  };
  for (const run of targets) {
    if (run.worktreePath && existsSync(path.join(run.worktreePath, '.git'))) {
      // A branch checked out in a live worktree cannot be deleted, and should not be.
      log.info(`[benchmark-runner] cleanup: ${run.runId} still has a worktree at ${run.worktreePath} — skipping`);
      continue;
    }
    try {
      await runGit(['branch', '-D', run.branch!], { cwd: workspaceRoot });
      await stamp(run);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Already gone is success; anything else is logged and left for the next pass.
      if (/not found/i.test(message)) await stamp(run);
      else log.warn(`[benchmark-runner] cleanup: could not delete ${run.branch}: ${message}`);
    }
  }
  return done;
}

async function archiveRunTicket(ticketId: string): Promise<void> {
  await updateTaskWithHistory(ticketId, {
    updatedBy: 'Benchmark',
    extraFields: { status: 'Archived' },
    entries: [],
  }).catch((err) => log.warn(`[benchmark-runner] archive of ${ticketId} failed: ${err instanceof Error ? err.message : String(err)}`));
}

/** Evidence + validation + friction, in the order the tamper guard requires. */
async function collectRun(
  suite: BenchmarkSuite,
  run: BenchmarkRun,
  ticketId: string,
  workspaceRoot: string,
): Promise<void> {
  const task = getWorkspace().tasks[ticketId] as EvidenceTaskView | undefined;
  if (!task) return;

  const evidence = await collectEvidence({
    task,
    sessionId: run.sessionId,
    workspaceRoot,
    baseCommit: suite.baseCommit,
  });

  run.inputTokens = evidence.inputTokens;
  run.outputTokens = evidence.outputTokens;
  run.costUSD = evidence.costUSD;
  run.changedFileCount = evidence.changedFileCount;
  run.hasDiff = evidence.hasDiff;
  run.changedPaths = evidence.changedPaths;
  if (evidence.durationMs !== undefined) run.durationMs = evidence.durationMs;
  if (evidence.sessionOutcome !== undefined) run.sessionOutcome = evidence.sessionOutcome;
  // Preserve a failure class already set by the dispatch path — it is more specific than
  // anything re-derivable from history.
  if (!run.failureClass && evidence.failureClass) run.failureClass = evidence.failureClass;

  if (suite.validation && run.worktreePath) {
    const { outcome, tampered, regression, regressed } = await runGuardedValidation({
      worktreePath: run.worktreePath,
      baseCommit: suite.baseCommit,
      validation: suite.validation,
      changedPaths: evidence.changedPaths, // recorded BEFORE any restore
      regression: suite.regression,
    });
    run.validation = outcome;
    run.tampered = tampered;
    if (regression) run.regression = regression;
    if (regressed !== undefined) run.regressed = regressed;
    // The harness could not judge the work (e.g. the held-out restore failed). That is
    // infrastructure, so the run leaves the denominator as attrition rather than scoring unsolved —
    // observed live on a worktree husk left by an earlier teardown failure.
    if (outcome.harnessError) {
      run.failureClass = 'crash';
      run.sessionOutcome = outcome.harnessError;
    }
  }

  // Preserve what a human needs to look at BEFORE teardown removes the worktree: the harness's
  // screenshots and the built artefact itself (build track). Copied, never linked; the worktree is
  // about to go. Failures here never affect the verdict — an artefact is evidence, not a clause.
  if (suite.artifacts && suite.artifacts.length > 0 && run.worktreePath) {
    run.artifacts = await preserveArtifacts(suite, run, workspaceRoot);
  }

  const solved = deriveSolved(run);
  // Left ABSENT (not false) when the suite has no validation block — the difference between
  // "this run failed" and "we never checked" is the difference between a denominator and attrition.
  if (solved !== undefined) run.solved = solved;

  const turns = await readTurns(ticketId).catch(() => []);

  // How much work the run did — recorded so configurations still separate when every run solves.
  // Line counts come from the agent's OWN tree (collectRun runs before teardown and validation has
  // already copied the held-out paths back), against the pinned base.
  run.work = { turns: turns.length, toolCalls: turns.reduce((n, t) => n + toolCallsInTurn(t).length, 0) };
  if (run.worktreePath) {
    try {
      const { stdout } = await runGit(['diff', '--numstat', suite.baseCommit], { cwd: run.worktreePath });
      let added = 0, removed = 0;
      for (const line of stdout.split(/\r?\n/)) {
        const [a, r] = line.split('\t');
        if (a && a !== '-') added += Number(a) || 0;
        if (r && r !== '-') removed += Number(r) || 0;
      }
      run.work.linesAdded = added;
      run.work.linesRemoved = removed;
    } catch (err) {
      log.warn(`[benchmark-runner] numstat for ${run.runId} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // `orientationCost` was documented as one of ten friction signals and was structurally dead: the
  // runner never passed a contextBudget, so the metric computed `null` on every run ever recorded.
  // `ehMeasurableTotalTokensEst` is the static prelude EventHorizon injects before the agent reads a
  // single line of code — the honest numerator for "what did the platform cost this run".
  const budget = await computeContextBudget(task as never)
    .then((b) => ({ injectedTokens: b.ehMeasurableTotalTokensEst }))
    .catch(() => undefined);

  // Frozen so friction can be re-derived later under newer rules (the archive that follows clears
  // needsAction, so it cannot be read back from the ticket).
  run.taskView = {
    status: evidence.finalStatus ?? '',
    needsAction: task.needsAction ?? null,
    swimlane: task.swimlane ?? null,
    sessionCount: evidence.sessionCount,
    inputTokens: evidence.inputTokens,
  };
  run.friction = extractFriction({
    ...(budget ? { contextBudget: budget } : {}),
    turns,
    progress: latestProgress(task),
    task: {
      needsAction: run.taskView.needsAction,
      swimlane: run.taskView.swimlane,
      status: run.taskView.status,
      sessionCount: run.taskView.sessionCount,
      // Collection runs after the run's sessions have ended, so "still in a working status" is a
      // hand-off failure, not work in progress.
      terminal: true,
    },
    inputTokens: evidence.inputTokens,
  });

  run.status = run.failureClass ? 'failed' : 'completed';
  await updateBenchmarkRun(suite.id, run.runId, (stored) => Object.assign(stored, run), workspaceRoot);
}

/**
 * Re-derive a run's friction under the CURRENT rules from what is still on disk: the transcript, the
 * ticket's durable progress, and the ticket state frozen at collection (`taskView`). Returns false
 * for a run collected before `taskView` existed — its friction stays as scored, and the caller says so.
 */
export async function recomputeRunFriction(run: BenchmarkRun, workspaceRoot: string): Promise<boolean> {
  if (!run.ticketId) return false;
  const task = resolveWorkspaceByRoot(workspaceRoot)?.tasks[run.ticketId] as EvidenceTaskView | undefined;
  if (!task) return false;
  // Runs collected before `taskView` existed: reconstruct it from what survived. The status the run
  // ENDED with is the last status_change before the runner's archive; the needsAction text (if any)
  // is in the stored friction evidence; a require-input park likewise. Sessions are counted from
  // history. This is a reconstruction and is labelled as one on the run.
  if (!run.taskView) {
    const history = Array.isArray(task.history) ? task.history as { type?: string; to?: string; user?: string }[] : [];
    const moves = history.filter((e) => e?.type === 'status_change' && e.to && e.to !== 'Archived');
    const lastStatus = moves.length > 0 ? String(moves[moves.length - 1]!.to) : (task.status ?? '');
    const na = run.friction?.protocolViolations?.evidence.find((e) => e.locator === 'frontmatter:needsAction');
    const parked = run.friction?.protocolViolations?.evidence.some((e) => e.locator === 'frontmatter:swimlane') ?? false;
    run.taskView = {
      status: lastStatus,
      needsAction: na?.detail ?? null,
      swimlane: parked ? 'require-input' : null,
      sessionCount: history.filter((e) => e?.type === 'agent_session').length,
      inputTokens: run.inputTokens,
    };
    log.info(`[benchmark-runner] ${run.runId}: taskView reconstructed from history for friction recompute (status ${lastStatus})`);
  }
  const turns = await readTurns(run.ticketId).catch(() => []);
  const budget = await computeContextBudget(task as never)
    .then((b) => ({ injectedTokens: b.ehMeasurableTotalTokensEst }))
    .catch(() => undefined);
  run.friction = extractFriction({
    ...(budget ? { contextBudget: budget } : {}),
    turns,
    progress: latestProgress(task),
    task: {
      needsAction: run.taskView.needsAction,
      swimlane: run.taskView.swimlane,
      status: run.taskView.status,
      sessionCount: run.taskView.sessionCount,
      terminal: true,
    },
    inputTokens: run.taskView.inputTokens,
  });
  return true;
}

/** Where a suite's preserved run artefacts live: `<benchmarks dir>/artifacts/<suiteId>/<runId>/`. */
export function artifactDir(suiteId: string, runId: string, workspaceRoot: string): string {
  return path.join(getBenchmarkDir(workspaceRoot), 'artifacts', suiteId, runId);
}

async function preserveArtifacts(suite: BenchmarkSuite, run: BenchmarkRun, workspaceRoot: string): Promise<{ path: string; bytes: number }[]> {
  const out: { path: string; bytes: number }[] = [];
  const dest = artifactDir(suite.id, run.runId, workspaceRoot);
  for (const rel of suite.artifacts ?? []) {
    const src = path.join(run.worktreePath!, rel);
    if (!existsSync(src)) continue;
    try {
      await fs.cp(src, path.join(dest, rel), {
        recursive: true,
        // The worktree links node_modules into place; never follow into it, and skip a build's own junk.
        filter: (p) => !/[\\/]node_modules([\\/]|$)|[\\/]\.git([\\/]|$)|[\\/]test-results([\\/]|$)/.test(p),
        dereference: false,
      });
      for (const file of await walk(path.join(dest, rel))) {
        const st = await fs.stat(file);
        out.push({ path: path.relative(dest, file).split(path.sep).join('/'), bytes: st.size });
      }
    } catch (err) {
      log.warn(`[benchmark-runner] preserving ${rel} for ${run.runId} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return out;
}

async function walk(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(full)));
    else out.push(full);
  }
  return out;
}

function latestProgress(task: EvidenceTaskView): { timestamp?: string; message?: string; type?: string; data?: unknown }[] {
  const history = Array.isArray(task.history) ? task.history : [];
  const out: { timestamp?: string; message?: string; type?: string; data?: unknown }[] = [];
  for (const e of history) {
    const entry = e as { type?: string; progress?: unknown[] };
    if (entry?.type === 'agent_session' && Array.isArray(entry.progress)) {
      out.push(...(entry.progress as typeof out));
    }
  }
  return out;
}

// ── Scheduling ────────────────────────────────────────────────────────────────

/**
 * The concurrency ceiling, derived from the LIVE pool cap rather than hard-coded.
 *
 * The task-worktree pool is board-wide and shared with the Furnace and every human session — this
 * suite does not own it. Leaving a slot free is not politeness: at full occupancy the user's own
 * session cannot start, and the suite's runs begin fighting each other through the cap backstop.
 */
export function concurrencyFor(suite: BenchmarkSuite): number {
  return resolveConcurrency(suite.concurrency, DEFAULT_MAX_TASK_WORKTREES);
}

/** Does a path still exist? Used by teardown assertions and diagnostics. */
export async function worktreeExists(p: string): Promise<boolean> {
  return await fs.access(p).then(() => true, () => false);
}

// ── Waiting for a run to finish ───────────────────────────────────────────────

/**
 * A session is DONE, from the runner's point of view, when it can no longer make progress.
 *
 * `waiting-input` counts as terminal here, unlike everywhere else in the engine. A benchmark run is
 * unattended by construction — nobody is going to answer — so a session parked on a question is
 * finished, and treating it as still-running would hang the suite until its wall-clock budget. That
 * the run stopped to ask is itself a measurement: the friction layer counts it as a `humanInterrupt`.
 */
const RUN_TERMINAL_STATUSES = new Set<CliSessionStatus>(['completed', 'failed', 'cancelled', 'waiting-input']);

export function isRunSessionTerminal(status: CliSessionStatus | undefined): boolean {
  return status != null && RUN_TERMINAL_STATUSES.has(status);
}

/** How often the waiter re-checks the session record. */
export const RUN_POLL_INTERVAL_MS = 2_000;

/**
 * Block until the run's session reaches a terminal state, its budget expires, or it never appears.
 *
 * Polls the in-memory session record rather than subscribing to events: the record is the same thing
 * every other engine-side driver reads, and a missed event would hang a run for its whole budget.
 * Refreshes the collection guard on every tick so a long but healthy run is never evicted mid-flight.
 */
export async function awaitRunTerminal(
  ticketId: string,
  sessionId: string | null,
  budgetMs: number,
  pollMs: number = RUN_POLL_INTERVAL_MS,
): Promise<'terminal' | 'timeout'> {
  if (!sessionId) return 'terminal';
  const deadline = Date.now() + budgetMs;
  for (;;) {
    const session = cliSessionsById.get(sessionId);
    if (session && isRunSessionTerminal(session.status)) return 'terminal';
    if (Date.now() >= deadline) return 'timeout';
    refreshCollection(ticketId, budgetMs);
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}

/**
 * Wait for the run ticket's DURABLE `agent_session` entry to stop being `active`.
 *
 * `awaitRunTerminal` watches the in-memory `CliSessionRecord`, which flips to a terminal status
 * BEFORE the adapter finishes writing the ticket's history entry, its `outcome`, and its
 * `tokenMetadata`. Collecting on the in-memory signal alone therefore reads a half-written record:
 * the entry is still `active`, `classifyFailure` maps that to `crash`, and cost/duration come back
 * null.
 *
 * Observed live, and it is a FALSE NEGATIVE rather than a wasted field: a run whose validation
 * passed 7/7 was scored `solved: false, failureClass: 'crash'`. A benchmark that under-reports
 * configurations which actually work is worse than one that over-reports — it would have you
 * discard the config that was winning.
 *
 * Bounded: after `timeoutMs` we collect anyway. A durable entry that never finalizes is itself a
 * real terminal condition, and hanging the suite on it would be worse than recording it.
 */
export async function awaitDurableOutcome(ticketId: string, sessionId: string | undefined, timeoutMs = 60_000, pollMs = 1_000): Promise<void> {
  if (!sessionId) return;
  const deadline = Date.now() + timeoutMs;
  const tokenDeadline = Date.now() + Math.min(timeoutMs, TOKEN_METADATA_GRACE_MS);
  for (;;) {
    const task = getWorkspace().tasks[ticketId] as { history?: unknown[] } | undefined;
    const entry = (Array.isArray(task?.history) ? task.history : [])
      .filter((e): e is { type?: string; sessionId?: string; status?: string } => (e as { type?: string })?.type === 'agent_session')
      .find((e) => e.sessionId === sessionId);
    if (entry && entry.status && entry.status !== 'active') {
      // The entry going non-active is NOT the last durable write. `tokenMetadata` lands after it,
      // and cost is not a cosmetic field: without it `costPerSolve` is null, and a null cost
      // coordinate excludes the cell from the Pareto frontier exactly as if it had solved nothing.
      // Observed live — a config that solved 2 of 2 would have vanished from the chart for want of
      // a number the ticket already had on disk.
      //
      // Bounded separately and much shorter than the outer wait: a genuinely failed run may never
      // produce token metadata, so this must not burn the whole timeout on every crash.
      const hasCost = (task as { tokenMetadata?: { costUSD?: unknown } } | undefined)?.tokenMetadata?.costUSD != null;
      if (hasCost || Date.now() >= tokenDeadline) return;
    }
    if (Date.now() >= deadline) {
      log.warn(`[benchmark-runner] durable outcome for ${ticketId} never finalized within ${timeoutMs}ms — collecting anyway`);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}

// ── Driving a whole suite ─────────────────────────────────────────────────────

export interface DriveOptions {
  /** Injected in tests so a suite can be driven without spawning real agents. */
  execute?: (suite: BenchmarkSuite, run: BenchmarkRun, workspaceRoot: string) => Promise<BenchmarkRun>;
  /** Cap on requeues per run before it is recorded unavailable rather than retried forever. */
  maxRequeues?: number;
  /** Backoff between requeue attempts. */
  requeueDelayMs?: number;
}

/** Suites currently being driven, so a second `start` cannot double-drive one. */
const driving = new Set<string>();

export function isDriving(suiteId: string): boolean {
  return driving.has(suiteId);
}

/**
 * Run every pending run in a suite, `concurrency` at a time.
 *
 * A worktree-cap rejection REQUEUES rather than failing: the pool is shared with the Furnace and
 * every human session, so a cell's effective `n` must never become a function of unrelated board
 * activity. A requeue produces no run record, no failure class and no friction record — it is a
 * scheduler wait state, not an outcome. The requeue cap exists so a permanently full pool ends the
 * suite instead of spinning on it forever.
 */
export async function driveSuite(
  suite: BenchmarkSuite,
  runs: BenchmarkRun[],
  workspaceRoot: string,
  opts: DriveOptions = {},
): Promise<BenchmarkRun[]> {
  if (driving.has(suite.id)) return runs;
  driving.add(suite.id);

  // FLUX-1548 discipline, applied to the runner. `driveSuite` is dispatched fire-and-forget from the
  // start route, so it executes with NO ambient workspace binding — every `getWorkspace()` inside
  // `createTask`, `ensureTicketIsolation` and evidence collection would resolve the DEFAULT board
  // instead of the suite's owning one. Observed live: tickets were minted into one board's cache
  // while the dispatch self-fetch named another, and every run died with "Task not found" despite
  // the ticket file existing on disk. Pin it once, here, so every ambient lookup below agrees.
  return runWithWorkspace(resolveWorkspaceByRoot(workspaceRoot), () => driveSuiteInner(suite, runs, workspaceRoot, opts, () => driving.delete(suite.id)));
}

async function driveSuiteInner(
  suite: BenchmarkSuite,
  runs: BenchmarkRun[],
  workspaceRoot: string,
  opts: DriveOptions,
  release: () => void,
): Promise<BenchmarkRun[]> {

  const execute = opts.execute ?? ((s, r, root) => runOne({ suite: s, run: r, workspaceRoot: root, awaitTerminal: awaitRunTerminal }));
  const maxRequeues = opts.maxRequeues ?? 20;
  const requeueDelayMs = opts.requeueDelayMs ?? 5_000;
  const limit = concurrencyFor(suite);
  const deadline = suite.wallClockBudgetMs ? Date.now() + suite.wallClockBudgetMs * runs.length : Infinity;

  const queue = runs.filter((r) => r.status === 'pending');
  const requeues = new Map<string, number>();
  const active = new Set<Promise<void>>();

  try {
    while (queue.length > 0 || active.size > 0) {
      // Whatever completed stays scoreable at its real denominator — an aborted suite is a smaller
      // benchmark, not an invalid one.
      if (Date.now() > deadline) {
        log.warn(`[benchmark] suite ${suite.id} aborted — wall-clock budget exhausted with ${queue.length} run(s) unstarted`);
        break;
      }

      while (queue.length > 0 && active.size < limit) {
        const run = queue.shift()!;
        const task = (async () => {
          try {
            await execute(suite, run, workspaceRoot);
          } catch (err) {
            if (isCapRejection(err)) {
              const n = (requeues.get(run.runId) ?? 0) + 1;
              requeues.set(run.runId, n);
              if (n <= maxRequeues) {
                // No record, no failure class, no friction — a wait state, not an outcome.
                run.status = 'waiting-for-slot';
                await new Promise((resolve) => setTimeout(resolve, requeueDelayMs));
                run.status = 'pending';
                queue.push(run);
                return;
              }
              run.status = 'failed';
              run.failureClass = 'unavailable';
              run.sessionOutcome = `worktree pool never freed a slot after ${n} attempts`;
              return;
            }
            run.status = 'failed';
            run.failureClass = 'crash';
            run.sessionOutcome = err instanceof Error ? err.message : String(err);
          }
        })();
        active.add(task);
        void task.finally(() => active.delete(task));
      }

      if (active.size > 0) await Promise.race(active);
    }
  } finally {
    release();
  }

  return runs;
}
