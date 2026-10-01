// Validation runner + tamper guard (FLUX-1739).
//
// The borrowed idea this whole benchmark rests on: THE SCORE IS NOT A JUDGMENT, IT IS AN EXIT CODE —
// from a command the agent could not tamper with. That property is produced entirely by the ordering
// below, so the ordering is load-bearing, not incidental:
//
//   1. Record the full change set FIRST and note which held-out paths it touched → tamperRate input.
//   2. Copy the agent's version of every held-out path aside, OUTSIDE the worktree (deletions too).
//   3. Restore the held-out paths from `baseCommit`.
//   4. Run validation against the restored tree.
//   5. Copy the agent's version back.
//
// Why 1 and 5 are not optional. Without (1), a run whose ONLY edits were inside `validation.paths`
// measures an empty diff after the restore, and L1's non-empty-diff clause flips a real solve to
// `unsolved`. Without (5), an uncommitted agent edit to a held-out path is destroyed outright,
// contradicting the cleanup decision to keep the branch as the record of what the run produced.
// Because (3) runs before (4), an agent that weakened or deleted the check still cannot pass it —
// while (1) still surfaces that it tried.
//
// The command is spawned `execFile`-shaped and NEVER through a shell: a suite manifest is
// caller-supplied, and a shell would turn `validation.command` into arbitrary command injection with
// a blast radius unlike anything else the engine already does.

import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runGit } from './git-exec.js';
import { linkWorktreeDependencies, unlinkWorktreeDependencies } from './task-worktree.js';
import { killProcessTree } from './kill-process-tree.js';
import { log } from './log.js';
import type { BenchmarkRegressionCheck, BenchmarkValidation, ValidationOutcome } from './models/benchmark.js';

/** Bounded output kept from a validation run — never the whole log. */
const OUTPUT_TAIL_CHARS = 4000;

export interface ValidationRunInput {
  worktreePath: string;
  baseCommit: string;
  validation: BenchmarkValidation;
  /**
   * Repo-relative paths the run changed, recorded BEFORE any restore. Passing this in (rather than
   * computing it here) is what keeps step 1 provably first: this function cannot run without it.
   */
  changedPaths: string[];
  /** The broader check, when the suite configures one. */
  regression?: BenchmarkRegressionCheck | undefined;
}

export interface ValidationRunResult {
  outcome: ValidationOutcome;
  /** True when the run modified a held-out path, whether or not it then passed. */
  tampered: boolean;
  /** Outcome of the broader "did it break anything else" check, when one is configured. */
  regression?: ValidationOutcome;
  /** Worse than the recorded baseline — never merely "non-zero". */
  regressed?: boolean;
}

/**
 * Did `changed` fall inside `heldOut`? Exact match, or a descendant when the held-out entry is a
 * directory. Compared on normalized POSIX separators so a Windows-shaped diff path still matches a
 * manifest written with forward slashes.
 */
export function pathIsHeldOut(changed: string, heldOut: string): boolean {
  const c = changed.replace(/\\/g, '/').replace(/^\.\//, '');
  const h = heldOut.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/$/, '');
  return c === h || c.startsWith(`${h}/`);
}

export function detectTamper(changedPaths: string[], heldOut: string[]): string[] {
  return changedPaths.filter((c) => heldOut.some((h) => pathIsHeldOut(c, h)));
}

interface StashedPath {
  relPath: string;
  /** Where the agent's version was parked; absent when the agent had deleted the file. */
  stashedAt?: string;
  existedBefore: boolean;
}

/**
 * Park the agent's version of each held-out path outside the worktree.
 *
 * Plain `fs` copy rather than `git stash`: this has to cover untracked AND deleted files, and it
 * runs on a tree that is about to be rewritten by a checkout — `git stash`/`pop` would bring
 * conflict semantics into a path where there is nothing sensible to do with a conflict.
 */
async function stashHeldOut(worktreePath: string, heldOut: string[], stashDir: string): Promise<StashedPath[]> {
  const stashed: StashedPath[] = [];
  for (const relPath of heldOut) {
    const src = path.join(worktreePath, relPath);
    if (!existsSync(src)) {
      stashed.push({ relPath, existedBefore: false });
      continue;
    }
    const dest = path.join(stashDir, relPath);
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.cp(src, dest, { recursive: true });
    stashed.push({ relPath, stashedAt: dest, existedBefore: true });
  }
  return stashed;
}

/** Put the agent's version back, including restoring a deletion it had made. */
async function unstashHeldOut(worktreePath: string, stashed: StashedPath[]): Promise<void> {
  for (const entry of stashed) {
    const dest = path.join(worktreePath, entry.relPath);
    try {
      if (entry.existedBefore && entry.stashedAt) {
        await fs.rm(dest, { recursive: true, force: true });
        await fs.mkdir(path.dirname(dest), { recursive: true });
        await fs.cp(entry.stashedAt, dest, { recursive: true });
      } else {
        // The agent had deleted it; the restore recreated it. Return the tree to what the agent left.
        await fs.rm(dest, { recursive: true, force: true });
      }
    } catch (err) {
      // Never throw from the restore path: losing the agent's work is worse than a stale tree, but
      // failing the whole run over a copy-back error would also discard a valid verdict.
      log.warn(`[benchmark-validation] failed to restore ${entry.relPath}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

/**
 * Run `fn` with the held-out paths temporarily ABSENT from the tree, then put them back exactly.
 *
 * The regression check asks "did the run break anything ELSE" — so the held-out check must not be
 * part of the tree it examines. Observed live (FLUX-1700 seed): a held-out test that references the
 * API the fix introduces cannot type-check at base, so `tsc` was red at calibration, the recorded
 * baseline was non-zero, and a run that introduced a genuine type error elsewhere would have exited
 * with the SAME code and been scored "no regression". Removing the held-out paths for the duration
 * of the check, at calibration and at run time alike, keeps the two questions separate.
 */
async function withHeldOutRemoved<T>(worktreePath: string, heldOut: string[], fn: () => Promise<T>): Promise<T> {
  // Copy + delete, NOT rename: the park dir is under the OS temp dir (it must be outside the tree,
  // and `.eh-worktrees` is swept for orphans), which on Windows is routinely a different volume
  // from the worktree. `fs.rename` across volumes fails with EXDEV — observed live, and it failed
  // at COLLECTION, so two finished runs were scored as crashes. Same primitive stashHeldOut uses.
  const parkDir = await fs.mkdtemp(path.join(os.tmpdir(), 'eh-bench-park-'));
  const parked: { src: string; dest: string }[] = [];
  try {
    for (const relPath of heldOut) {
      const src = path.join(worktreePath, relPath);
      if (!existsSync(src)) continue;
      const dest = path.join(parkDir, relPath);
      await fs.mkdir(path.dirname(dest), { recursive: true });
      await fs.cp(src, dest, { recursive: true });
      await fs.rm(src, { recursive: true, force: true });
      parked.push({ src, dest });
    }
    return await fn();
  } finally {
    for (const { src, dest } of parked.reverse()) {
      try {
        await fs.mkdir(path.dirname(src), { recursive: true });
        await fs.cp(dest, src, { recursive: true });
      } catch (err) {
        log.warn(`[benchmark-validation] failed to return held-out path ${src}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    await fs.rm(parkDir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Did the runner exit non-zero without running a single test? A heuristic over the common runners'
 * summary lines (vitest "Test Files  no tests" / "Errors  N error", jest "No tests found", a bare
 * "Unhandled Error" banner with no test counts). A false positive here refuses a real seed loudly at
 * calibration, which is recoverable; a false negative green-lights a suite that measures nothing.
 */
export function looksLikeNoTestsRan(outputTail: string | undefined): boolean {
  if (!outputTail) return false;
  const t = outputTail;
  if (/Test Files\s+no tests/i.test(t)) return true;
  if (/No tests found/i.test(t)) return true;
  if (/Errors\s+\d+ error/i.test(t) && !/Tests\s+\d+ (failed|passed)/i.test(t)) return true;
  return false;
}

/** Spawn the validation command. `execFile`-shaped, never a shell; tree-killed on timeout. */
export async function spawnValidation(
  validation: BenchmarkValidation,
  cwd: string,
): Promise<ValidationOutcome> {
  const startedAt = Date.now();
  return await new Promise<ValidationOutcome>((resolve) => {
    let settled = false;
    let timedOut = false;
    let output = '';

    const proc = spawn(validation.command, validation.args, {
      cwd,
      shell: false, // load-bearing — see the file header
      windowsHide: true,
    });

    const timer = setTimeout(() => {
      timedOut = true;
      killProcessTree(proc, 'SIGKILL', { label: 'benchmark-validation' });
    }, validation.timeoutMs);

    const capture = (chunk: Buffer | string) => {
      output += String(chunk);
      if (output.length > OUTPUT_TAIL_CHARS * 2) output = output.slice(-OUTPUT_TAIL_CHARS);
    };
    proc.stdout?.on('data', capture);
    proc.stderr?.on('data', capture);

    const settle = (exitCode: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        exitCode,
        // A timeout is never a pass, whatever exit code the kill produced.
        passed: !timedOut && exitCode === 0,
        timedOut,
        durationMs: Date.now() - startedAt,
        ...(output ? { outputTail: output.slice(-OUTPUT_TAIL_CHARS) } : {}),
      });
    };

    proc.on('error', (err) => {
      capture(`spawn error: ${err.message}`);
      settle(null);
    });
    proc.on('close', (code) => settle(code));
  });
}

/**
 * Calibration — SWE-bench's fail-to-pass precondition, checked before any agent spawns.
 *
 * Runs the validation command at `baseCommit` in a throwaway detached worktree with NO agent in the
 * loop. It must FAIL. A seed whose validation already passes at base would score every configuration
 * 100% and measure nothing at all — and that failure mode is invisible in the report, because a
 * uniformly perfect matrix looks like a great result rather than a broken benchmark.
 *
 * The worktree is detached (`--detach`) so calibration never creates or moves a branch.
 */
export async function calibrateSuite(
  workspaceRoot: string,
  baseCommit: string,
  validation: BenchmarkValidation,
  regression?: BenchmarkRegressionCheck | undefined,
): Promise<{ exitCode: number | null; failsAtBase: boolean; outputTail?: string; regressionBaselineExitCode?: number | null }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'eh-bench-calib-'));
  const worktree = path.join(dir, 'tree');
  try {
    await runGit(['worktree', 'add', '--detach', worktree, baseCommit], { cwd: workspaceRoot });
    // FLUX-518 parity: share the main tree's installed deps into the calibration worktree.
    //
    // Without this, calibration is actively DANGEROUS rather than merely incomplete: a validation
    // command that needs dependencies (any `vitest`/`jest`/`tsc` invocation — i.e. the realistic
    // case) dies with MODULE_NOT_FOUND, exits non-zero, and calibration reads that as "the seed
    // genuinely fails at base". It would then green-light a suite whose validation never actually
    // ran, which is precisely the meaningless benchmark this gate exists to prevent — inverted.
    // Run worktrees get these junctions from `createTaskWorktree`; calibration builds its tree with
    // a raw `git worktree add`, so it has to ask for them explicitly.
    await linkWorktreeDependencies(workspaceRoot, worktree).catch((err) =>
      log.warn(`[benchmark-validation] linking node_modules into the calibration worktree failed: ${err instanceof Error ? err.message : String(err)}`),
    );
    const outcome = await spawnValidation(validation, worktree);

    // Record what the broader suite does at BASE, in the same clean worktree. Without this there is
    // nothing to compare a run against: a repo whose suite is already red would mark every single
    // run a regression, and a repo that is green would give no way to tell "broke 30 tests" from
    // "broke 1". The baseline is what turns an exit code into a judgement.
    let regressionBaselineExitCode: number | null | undefined;
    if (regression) {
      // Held-out paths are removed for the baseline too, so calibration and runs measure the same tree.
      const base = await withHeldOutRemoved(worktree, validation.paths, () => spawnValidation({ ...regression, paths: [] }, worktree));
      regressionBaselineExitCode = base.exitCode;
      log.info(`[benchmark-validation] regression baseline at ${baseCommit.slice(0, 8)}: exit ${base.exitCode}`);
    }

    return {
      ...(regressionBaselineExitCode !== undefined ? { regressionBaselineExitCode } : {}),
      exitCode: outcome.exitCode,
      // A genuine fail-to-pass seed exits NON-ZERO. Neither a timeout nor a spawn failure
      // (`exitCode === null`) qualifies: those say the command hangs or does not exist, which is a
      // broken manifest, not a seed the agent has real work to do on. `exitCode !== 0` alone would
      // pass `null` through and calibrate a suite whose validation never ran.
      // ...and neither does a runner that exited non-zero WITHOUT RUNNING ANY TEST. Observed live: at
      // an older base the repo's vitest config was incompatible with the shared node_modules, vitest
      // exited 1 with "Test Files  no tests / Errors  1 error", and the suite calibrated as a genuine
      // fail-to-pass seed. Every run would then have "solved" nothing or "failed" for the same reason.
      failsAtBase: !outcome.timedOut && typeof outcome.exitCode === 'number' && outcome.exitCode !== 0
        && !looksLikeNoTestsRan(outcome.outputTail),
      ...(outcome.outputTail ? { outputTail: outcome.outputTail } : {}),
    };
  } finally {
    // Strip the junctions BEFORE the remove, exactly as removeTaskWorktree does — a recursive
    // delete that follows a junction would walk into the MAIN tree's node_modules.
    await unlinkWorktreeDependencies(worktree).catch(() => {});
    await runGit(['worktree', 'remove', '--force', worktree], { cwd: workspaceRoot }).catch(() => {});
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * The full guarded sequence. Returns the verdict plus whether the run tampered with its own check.
 *
 * The stash directory lives under the OS temp dir, never inside the worktree — a stash inside the
 * tree would itself be picked up as a change, and would be destroyed by the very checkout it exists
 * to survive.
 */
// Validations run ONE AT A TIME per engine process. A held-out check that builds real git fixtures
// under a per-test timeout is sensitive to what the rest of the machine is doing, and three runs
// collecting while two siblings still execute full test suites is exactly that. Observed: one run
// validated in 288 s against 42–95 s for its siblings, failed a 30 s per-test timeout, and was
// scored unsolved for a patch its own in-session run of the same file had passed. Serializing
// validations removes the benchmark's own contribution to that noise; the retry below covers what
// the agents' sessions still add.
let validationChain: Promise<unknown> = Promise.resolve();

export function runGuardedValidation(input: ValidationRunInput): Promise<ValidationRunResult> {
  const run = () => runGuardedValidationUnserialized(input);
  const result = validationChain.then(run, run);
  validationChain = result.then(() => {}, () => {});
  return result;
}

/** A per-test timeout in the runner's output — the run may be fine and the machine merely busy. */
export function looksLikeTestTimeout(outputTail: string | undefined): boolean {
  return !!outputTail && /Test timed out in \d+\s*ms|Exceeded timeout of \d+\s*ms|timed out after \d+/i.test(outputTail);
}

const TEST_TIMEOUT_RETRY_DELAY_MS = 20_000;

async function runGuardedValidationUnserialized(input: ValidationRunInput): Promise<ValidationRunResult> {
  const { worktreePath, baseCommit, validation, changedPaths } = input;

  // 1 — tamper is decided from the change set recorded BEFORE anything is restored.
  const tamperedPaths = detectTamper(changedPaths, validation.paths);
  const tampered = tamperedPaths.length > 0;

  const stashDir = await fs.mkdtemp(path.join(os.tmpdir(), 'eh-bench-heldout-'));
  let stashed: StashedPath[] = [];
  try {
    // 2 — park the agent's version outside the tree.
    stashed = await stashHeldOut(worktreePath, validation.paths, stashDir);

    // 3 — restore the held-out paths from the pinned base commit. `runGit` is mandatory:
    // check-git-exec.mjs fails the build on a bare git spawn.
    try {
      await runGit(['checkout', baseCommit, '--', ...validation.paths], { cwd: worktreePath });
    } catch (err) {
      // A held-out path that does not exist at baseCommit is a manifest error, not a run failure —
      // but it must not silently produce a "passing" verdict against an unrestored tree.
      const message = err instanceof Error ? err.message : String(err);
      log.warn(`[benchmark-validation] restore from ${baseCommit} failed: ${message}`);
      return {
        tampered,
        outcome: {
          exitCode: null,
          passed: false,
          timedOut: false,
          durationMs: 0,
          outputTail: `held-out restore failed: ${message}`,
          harnessError: `held-out restore failed: ${message}`,
        },
      };
    }

    // 4 — the only step whose exit code decides `solved`.
    let outcome = await spawnValidation(validation, worktreePath);
    // 4a — a per-test timeout is the machine's verdict, not the patch's. Give it one more attempt
    // after a pause; a genuine failure fails again, a load artefact usually does not. The retry is
    // recorded in the tail so the record shows it happened.
    if (!outcome.passed && !outcome.timedOut && looksLikeTestTimeout(outcome.outputTail)) {
      log.warn(`[benchmark-validation] held-out check hit a per-test timeout at ${worktreePath} — retrying once after ${TEST_TIMEOUT_RETRY_DELAY_MS / 1000}s`);
      await new Promise((resolve) => setTimeout(resolve, TEST_TIMEOUT_RETRY_DELAY_MS));
      const second = await spawnValidation(validation, worktreePath);
      outcome = { ...second, outputTail: `[retried after a per-test timeout; first attempt exit ${outcome.exitCode}]\n${second.outputTail ?? ''}` };
    }

    // 4b — did it break anything else? Run on the SAME restored tree, so a run that edited the
    // held-out check cannot use that edit to make the broader suite look green either — but with
    // the held-out paths themselves REMOVED for the duration (see withHeldOutRemoved): they are the
    // seed's own check, not "anything else". Scored separately from `solved`: this answers a
    // different question and deserves its own answer.
    let regression: ValidationOutcome | undefined;
    let regressed: boolean | undefined;
    if (input.regression) {
      const reg = input.regression;
      regression = await withHeldOutRemoved(worktreePath, validation.paths, () => spawnValidation({ ...reg, paths: [] }, worktreePath));
      const baseline = input.regression.baselineExitCode;
      // Compared against the BASELINE, not against zero. A repo already red at base would otherwise
      // mark every run a regression, and the signal would carry no information at all.
      regressed = baseline == null
        ? !regression.passed
        : (regression.exitCode !== baseline && !regression.passed);
    }

    return { outcome, tampered, ...(regression ? { regression, regressed: regressed === true } : {}) };
  } finally {
    // 5 — always give the agent its work back, even if validation threw.
    await unstashHeldOut(worktreePath, stashed);
    await fs.rm(stashDir, { recursive: true, force: true }).catch(() => {});
  }
}
