// FLUX-1739 follow-up: the "did it break anything else" check.
//
// This closes the benchmark's largest blind spot. Previously only the held-out check ran, so a run
// could fix its ticket perfectly, break thirty unrelated tests, and score `solved` — the first thing
// a human reviewer would have caught, and the benchmark could not see it at all.
//
// The comparison is against a RECORDED BASELINE, never against zero. That distinction is the whole
// design: a repo whose suite is already red at base (this one has six known Windows/ordering
// failures) would otherwise mark every single run a regression, and the signal would carry no
// information whatsoever.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { createGitFixture } from './test-helpers/git-fixture.js';
import { runGit } from './git-exec.js';
import { runGuardedValidation, calibrateSuite } from './benchmark-validation.js';
import type { BenchmarkValidation, BenchmarkRegressionCheck } from './models/benchmark.js';

const NODE = process.execPath;

/** Held-out check: passes only when src/answer.txt says 42. */
const heldOut = (): BenchmarkValidation => ({ command: NODE, args: ['check.js'], paths: ['check.js'], timeoutMs: 30_000 });

/** Broader check: passes only when src/other.txt is untouched. */
const broader = (over: Partial<BenchmarkRegressionCheck> = {}): BenchmarkRegressionCheck =>
  ({ command: NODE, args: ['suite.js'], timeoutMs: 30_000, ...over });

describe('regression check', () => {
  let repo: string;

  beforeAll(async () => {
    repo = await createGitFixture({
      templateKey: 'benchmark-regression',
      populate: async (root) => {
        await fs.writeFile(path.join(root, 'check.js'),
          'const fs=require("fs");process.exit(fs.readFileSync("src/answer.txt","utf8").trim()==="42"?0:1);', 'utf-8');
        await fs.writeFile(path.join(root, 'suite.js'),
          'const fs=require("fs");process.exit(fs.readFileSync("src/other.txt","utf8").trim()==="intact"?0:1);', 'utf-8');
        await fs.mkdir(path.join(root, 'src'), { recursive: true });
        await fs.writeFile(path.join(root, 'src', 'answer.txt'), 'wrong', 'utf-8');
        await fs.writeFile(path.join(root, 'src', 'other.txt'), 'intact', 'utf-8');
      },
    });
  });

  afterAll(async () => { await fs.rm(repo, { recursive: true, force: true }).catch(() => {}); });

  const head = async () => (await runGit(['rev-parse', 'HEAD'], { cwd: repo })).stdout.trim();
  const reset = async () => { await runGit(['checkout', '--', '.'], { cwd: repo }); };

  it('runs the broader check with the held-out paths REMOVED, at calibration and at run time', async () => {
    // A broader check that is red only because the held-out file exists (the FLUX-1700 shape: a
    // held-out test referencing the API the fix introduces cannot type-check at base). If the
    // held-out file stayed in the tree, the baseline would be red and a real regression would be
    // indistinguishable from it.
    const broaderSeesHeldOut: BenchmarkRegressionCheck = {
      command: NODE,
      args: ['-e', 'process.exit(require("fs").existsSync("check.js") ? 1 : 0)'],
      timeoutMs: 30_000,
    };
    const cal = await calibrateSuite(repo, await head(), heldOut(), broaderSeesHeldOut);
    expect(cal.regressionBaselineExitCode).toBe(0);

    const res = await runGuardedValidation({
      worktreePath: repo,
      baseCommit: await head(),
      validation: heldOut(),
      changedPaths: [],
      regression: { ...broaderSeesHeldOut, baselineExitCode: 0 },
    });
    expect(res.regression?.exitCode).toBe(0);
    expect(res.regressed).toBe(false);
    // ...and the held-out file is back where it was afterwards.
    expect(existsSync(path.join(repo, 'check.js'))).toBe(true);
  });

  it('records the broader suite\'s baseline at calibration', async () => {
    const cal = await calibrateSuite(repo, await head(), heldOut(), broader());
    expect(cal.failsAtBase).toBe(true);          // the seed is genuinely unsolved at base
    expect(cal.regressionBaselineExitCode).toBe(0); // ...and the broader suite is green there
  });

  it('THE HOLE THIS CLOSES: a run that fixes its ticket but breaks something else', async () => {
    const base = await head();
    await fs.writeFile(path.join(repo, 'src', 'answer.txt'), '42', 'utf-8');      // fixed the ticket
    await fs.writeFile(path.join(repo, 'src', 'other.txt'), 'BROKEN', 'utf-8');   // broke the build

    const res = await runGuardedValidation({
      worktreePath: repo, baseCommit: base, validation: heldOut(),
      changedPaths: ['src/answer.txt', 'src/other.txt'],
      regression: broader({ baselineExitCode: 0 }),
    });

    // `solved` still says yes — it did fix the thing it was asked to fix...
    expect(res.outcome.passed).toBe(true);
    // ...and the regression check is what stops that being the whole story.
    expect(res.regression?.passed).toBe(false);
    expect(res.regressed).toBe(true);
    await reset();
  });

  it('does not flag a clean fix as a regression', async () => {
    const base = await head();
    await fs.writeFile(path.join(repo, 'src', 'answer.txt'), '42', 'utf-8');
    const res = await runGuardedValidation({
      worktreePath: repo, baseCommit: base, validation: heldOut(),
      changedPaths: ['src/answer.txt'], regression: broader({ baselineExitCode: 0 }),
    });
    expect(res.outcome.passed).toBe(true);
    expect(res.regressed).toBe(false);
    await reset();
  });

  it('does NOT blame a run for failures that were already there at base', async () => {
    // The rule that makes this usable on a real repo. With a red baseline, an equally-red run is
    // not a regression — otherwise every run in a repo with known-flaky tests reads as one.
    const base = await head();
    await fs.writeFile(path.join(repo, 'src', 'other.txt'), 'BROKEN', 'utf-8');
    const res = await runGuardedValidation({
      worktreePath: repo, baseCommit: base, validation: heldOut(),
      changedPaths: ['src/other.txt'], regression: broader({ baselineExitCode: 1 }),
    });
    expect(res.regression?.passed).toBe(false);
    expect(res.regressed).toBe(false); // same as base — not this run's doing
    await reset();
  });

  it('treats a run that FIXES a red baseline as no regression', async () => {
    const base = await head();
    const res = await runGuardedValidation({
      worktreePath: repo, baseCommit: base, validation: heldOut(),
      changedPaths: [], regression: broader({ baselineExitCode: 1 }),
    });
    expect(res.regression?.passed).toBe(true);
    expect(res.regressed).toBe(false);
    await reset();
  });

  it('is absent entirely when no regression check is configured', async () => {
    const res = await runGuardedValidation({
      worktreePath: repo, baseCommit: await head(), validation: heldOut(), changedPaths: [],
    });
    expect(res.regression).toBeUndefined();
    expect(res.regressed).toBeUndefined();
  });
});
