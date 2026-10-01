// Benchmark suites — REST (FLUX-1739).
//
// Mounted at `/api/benchmarks` behind `requireWorkspace` (see index.ts), alongside `/api/furnace`,
// which is the closest template for this router's shape.
//
// TRUST BOUNDARY. `validation.command` is caller-supplied and reachable over this route. That does
// not widen the engine's existing boundary — it already spawns arbitrary agent CLIs behind
// `requireWorkspace` — and the validation runner spawns `execFile`-shaped with `shell: false`, so
// the command never reaches a shell. What WOULD widen it is a shell, which is why that is asserted
// in benchmark-validation.ts rather than left to convention.

import express from 'express';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { existsSync, statSync } from 'node:fs';
import { log } from '../log.js';
import { getWorkspaceRoot } from '../workspace.js';
import { runGit } from '../git-exec.js';
import {
  deleteBenchmark,
  ensureBenchmarksLoaded,
  getBenchmark,
  listBenchmarks,
  mutateBenchmark,
  saveBenchmark,
  type BenchmarkRecord,
} from '../benchmark-store.js';
import { expandMatrix, BenchmarkManifestError } from '../benchmark-matrix.js';
import { calibrateSuite } from '../benchmark-validation.js';
import { buildReport } from '../benchmark-score.js';
import { artifactDir, cleanupSuite, concurrencyFor, driveSuite, isDriving, recollectSuite, recomputeRunFriction, selectRecollectable } from '../benchmark-runner.js';
import { listWorkspaces, resolveWorkspaceByRoot, runWithWorkspace } from '../workspace-context.js';
import { harvestNarrative, requestAnalysis } from '../benchmark-analyst.js';
import { buildComparison } from '../benchmark-compare.js';
import { getSeedTemplate, listSeedTemplates, manifestFromSeed, type SeedOverrides } from '../benchmark-seeds.js';
import {
  DEFAULT_BENCHMARK_CONCURRENCY,
  DEFAULT_RUN_BUDGET_MS,
  type BenchmarkSuite,
} from '../models/benchmark.js';

const router = express.Router();

function badRequest(res: express.Response, message: string) {
  return res.status(400).json({ error: message });
}

/** GET / — every suite on this board. */
router.get('/', async (_req, res) => {
  await ensureBenchmarksLoaded();
  res.json({ benchmarks: listBenchmarks().map((r) => ({ suite: r.suite, runCount: r.runs.length })) });
});

/** GET /seeds — the curated seed templates in this repo's bench/seeds/, with baseRef resolved. Before `/:id`. */
router.get('/seeds', async (_req, res) => {
  const root = getWorkspaceRoot();
  if (!root) return badRequest(res, 'no workspace root');
  res.json({ seeds: await listSeedTemplates(root) });
});

/**
 * GET /compare — one row per configuration across every finished suite, with pooled numbers.
 * Registered BEFORE `/:id` so the literal path is not captured as a suite id.
 */
router.get('/compare', async (_req, res) => {
  await ensureBenchmarksLoaded();
  res.json(buildComparison(listBenchmarks()));
});

/** GET /:id — the suite, its runs, its report and (if any) the analyst narrative. */
router.get('/:id', async (req, res) => {
  await ensureBenchmarksLoaded();
  const id = String(req.params.id);
  let record = getBenchmark(id);
  if (!record) return res.status(404).json({ error: `Benchmark ${id} not found` });

  // Harvest on read. The analyst answers on its own ticket, asynchronously; the first read after it
  // finishes lifts the answer onto the record so every later read (and the portal) sees it without a
  // watcher. Idempotent: once `narrative` is set this is skipped.
  if (record.suite.analysis && !record.suite.analysis.error && !record.narrative) {
    const parsed = harvestNarrative(record);
    if (parsed) {
      await mutateBenchmark(id, (r) => {
        r.narrative = parsed.narrative;
        if (r.suite.analysis) {
          r.suite.analysis.harvestedAt = new Date().toISOString();
          r.suite.analysis.droppedClaims = parsed.droppedClaims;
        }
      });
      record = getBenchmark(id) ?? record;
    }
  }
  return res.json(record);
});

/**
 * POST /:id/analyze — dispatch the Benchmark Analyst over a finished suite.
 *
 * On demand, never automatic: an analyst pass is a paid model session, and a suite is complete and
 * scoreable without one. Body may carry `framework` / `model` for the analyst's own session, and
 * `force: true` to re-run over a suite that already has a narrative (the new answer replaces it).
 */
router.post('/:id/analyze', async (req, res) => {
  await ensureBenchmarksLoaded();
  const id = String(req.params.id);
  const record = getBenchmark(id);
  if (!record) return res.status(404).json({ error: `Benchmark ${id} not found` });
  if (record.suite.status !== 'done' && record.suite.status !== 'aborted') {
    return badRequest(res, `Benchmark ${id} is ${record.suite.status}; the analyst reads a finished suite`);
  }
  if (!record.report) return badRequest(res, `Benchmark ${id} has no report to analyse — POST /report first`);

  const body = (req.body ?? {}) as { framework?: string; model?: string; force?: boolean };
  const pending = record.suite.analysis && !record.suite.analysis.error && !record.narrative;
  if (pending && !body.force) {
    return res.status(409).json({ error: `An analyst pass is already in flight on ${record.suite.analysis?.ticketId}; pass force:true to start another`, analysis: record.suite.analysis });
  }
  if (record.narrative && !body.force) {
    return res.status(409).json({ error: `Benchmark ${id} already has a narrative; pass force:true to replace it`, analysis: record.suite.analysis });
  }

  const root = getWorkspaceRoot();
  if (!root) return badRequest(res, 'no workspace root');

  const result = await requestAnalysis(record, root, { framework: body.framework, model: body.model });
  await mutateBenchmark(id, (r) => {
    r.suite.analysis = {
      ticketId: result.ticketId,
      requestedAt: new Date().toISOString(),
      ...(result.sessionId ? { sessionId: result.sessionId } : {}),
      ...(result.error ? { error: result.error } : {}),
    };
    if (body.force) delete r.narrative;
  });
  log.info(`[benchmark] analyst ${result.sessionId ? 'started' : 'refused'} for suite ${id} on ${result.ticketId}${result.error ? `: ${result.error}` : ''}`);
  return res.status(result.sessionId ? 202 : 502).json({ analysis: getBenchmark(id)?.suite.analysis });
});

/**
 * POST / — create a suite from a manifest.
 *
 * Expansion runs here, BEFORE anything is persisted, so an invalid manifest is rejected without
 * leaving a half-built suite on disk (and, more importantly, without ever spawning a process).
 */
router.post('/', async (req, res) => {
  await ensureBenchmarksLoaded();
  const body = (req.body ?? {}) as Partial<BenchmarkSuite>;

  const suite: BenchmarkSuite = {
    id: body.id || `bench-${randomUUID().slice(0, 8)}`,
    ...(body.title ? { title: body.title } : {}),
    seedTitle: body.seedTitle ?? 'Benchmark run',
    seedPrompt: body.seedPrompt ?? '',
    baseCommit: body.baseCommit ?? '',
    ...(body.validation ? { validation: body.validation } : {}),
    ...(body.regression ? { regression: body.regression } : {}),
    matrix: body.matrix ?? [],
    repetitions: body.repetitions ?? 1,
    concurrency: body.concurrency ?? DEFAULT_BENCHMARK_CONCURRENCY,
    wallClockBudgetMs: body.wallClockBudgetMs ?? DEFAULT_RUN_BUDGET_MS,
    status: 'draft',
    createdAt: new Date().toISOString(),
  };

  const created = await createSuite(suite);
  if ('error' in created) return badRequest(res, created.error);
  return res.status(201).json(created.record);
});

/** Expand + verify + persist a manifest. Shared by the raw-manifest and from-seed routes. */
async function createSuite(suite: BenchmarkSuite): Promise<{ record: BenchmarkRecord } | { error: string }> {
  let runs;
  try {
    runs = expandMatrix(suite);
  } catch (err) {
    if (err instanceof BenchmarkManifestError) return { error: err.message };
    throw err;
  }
  // Shape is valid; now confirm the pinned commit actually resolves. Checked here rather than in the
  // pure expander so the expander stays unit-testable without a repo.
  const root = getWorkspaceRoot();
  if (root) {
    try {
      await runGit(['rev-parse', '--verify', `${suite.baseCommit}^{commit}`], { cwd: root });
    } catch {
      return { error: `baseCommit ${suite.baseCommit} does not resolve in this repository` };
    }
  }
  if (getBenchmark(suite.id)) return { error: `Benchmark ${suite.id} already exists` };
  const record: BenchmarkRecord = { suite, runs };
  await saveBenchmark(record);
  log.info(`[benchmark] created suite ${suite.id} — ${runs.length} run(s) across ${suite.matrix.length} cell(s)`);
  return { record };
}

/**
 * POST /from-seed — the portal's "start a benchmark" form. Body: `seedId`, optional `suiteId`,
 * `matrix`, `repetitions`, `concurrency`, `wallClockBudgetMs`, and `calibrate` / `start` flags.
 * Calibration runs inline (seconds to a minute); the start is fire-and-forget as in /:id/start. A
 * seed whose held-out check does not fail at base is created but refused a start, with the reason.
 */
router.post('/from-seed', async (req, res) => {
  await ensureBenchmarksLoaded();
  const root = getWorkspaceRoot();
  if (!root) return badRequest(res, 'no workspace root');
  const body = (req.body ?? {}) as { seedId?: string; calibrate?: boolean; start?: boolean } & SeedOverrides;
  if (!body.seedId) return badRequest(res, 'seedId is required');
  const seed = await getSeedTemplate(root, body.seedId);
  if (!seed) return res.status(404).json({ error: `Seed ${body.seedId} not found in bench/seeds/` });

  let suite: BenchmarkSuite;
  try {
    suite = manifestFromSeed(seed, body);
  } catch (err) {
    return badRequest(res, err instanceof Error ? err.message : String(err));
  }
  const created = await createSuite(suite);
  if ('error' in created) return badRequest(res, created.error);
  const id = suite.id;

  let calibration: BenchmarkSuite['calibration'] | undefined;
  let refusedStart: string | undefined;
  if (body.calibrate !== false && suite.validation) {
    const result = await calibrateSuite(root, suite.baseCommit, suite.validation, suite.regression);
    await mutateBenchmark(id, (r) => {
      r.suite.calibration = {
        baseCommit: r.suite.baseCommit,
        exitCode: result.exitCode,
        failsAtBase: result.failsAtBase,
        ...(result.outputTail ? { outputTail: result.outputTail } : {}),
        calibratedAt: new Date().toISOString(),
      };
      if (result.failsAtBase) r.suite.status = 'calibrated';
      if (r.suite.regression && result.regressionBaselineExitCode !== undefined) {
        r.suite.regression.baselineExitCode = result.regressionBaselineExitCode;
      }
    });
    calibration = getBenchmark(id)?.suite.calibration;
    if (!result.failsAtBase) refusedStart = `held-out check does not fail at ${suite.baseCommit.slice(0, 8)} (exit ${result.exitCode}) — the seed measures nothing as it stands`;
  } else if (body.start && suite.validation) {
    refusedStart = 'a suite with a held-out check must be calibrated before it starts';
  }

  let started = false;
  if (body.start && !refusedStart) {
    const record = getBenchmark(id)!;
    await mutateBenchmark(id, (r) => {
      r.suite.status = 'running';
      r.suite.startedAt = new Date().toISOString();
    });
    started = true;
    log.info(`[benchmark] suite ${id} started from seed ${seed.id} — ${record.runs.length} run(s), concurrency ${concurrencyFor(record.suite)}`);
    void driveSuite(record.suite, record.runs, root)
      .then(async (runs) => {
        await mutateBenchmark(id, (r) => {
          r.runs = runs;
          r.suite.status = 'done';
          r.suite.endedAt = new Date().toISOString();
          r.report = buildReport(r.suite.id, r.suite.baseCommit, r.suite.matrix, r.suite.repetitions, runs);
        });
      })
      .catch(async (err) => {
        const message = err instanceof Error ? err.message : String(err);
        await mutateBenchmark(id, (r) => {
          r.suite.status = 'aborted';
          r.suite.abortReason = message;
          r.suite.endedAt = new Date().toISOString();
          r.report = buildReport(r.suite.id, r.suite.baseCommit, r.suite.matrix, r.suite.repetitions, r.runs);
        });
      });
  }

  return res.status(201).json({ suite: getBenchmark(id)?.suite, calibration, started, ...(refusedStart ? { refusedStart } : {}) });
});

/**
 * POST /:id/calibrate — prove the seed is a real fail-to-pass task at `baseCommit`.
 *
 * Runs the validation command with NO agent. It must FAIL. A seed whose validation already passes
 * would score every configuration 100% and measure nothing — and that is invisible in the report,
 * because a uniformly perfect matrix reads as a great result rather than a broken benchmark.
 */
router.post('/:id/calibrate', async (req, res) => {
  await ensureBenchmarksLoaded();
  const id = String(req.params.id);
  const record = getBenchmark(id);
  if (!record) return res.status(404).json({ error: `Benchmark ${id} not found` });
  if (!record.suite.validation) return badRequest(res, 'suite has no validation block — nothing to calibrate');

  const root = getWorkspaceRoot();
  if (!root) return badRequest(res, 'no workspace root');

  const result = await calibrateSuite(root, record.suite.baseCommit, record.suite.validation, record.suite.regression);
  await mutateBenchmark(id, (r) => {
    r.suite.calibration = {
      baseCommit: r.suite.baseCommit,
      exitCode: result.exitCode,
      failsAtBase: result.failsAtBase,
      ...(result.outputTail ? { outputTail: result.outputTail } : {}),
      calibratedAt: new Date().toISOString(),
    };
    if (result.failsAtBase) r.suite.status = 'calibrated';
    // Pin the broader suite's behaviour at base onto the manifest, so every run is compared against
    // what this repo actually does rather than against an assumed-green zero.
    if (r.suite.regression && result.regressionBaselineExitCode !== undefined) {
      r.suite.regression.baselineExitCode = result.regressionBaselineExitCode;
    }
  });

  return res.json({ calibration: getBenchmark(id)?.suite.calibration });
});

/**
 * POST /:id/start — begin the burn.
 *
 * REFUSED until a calibration exists for the CURRENT `baseCommit` and shows the seed failing there.
 * Keyed on the commit, not just presence: re-pinning a suite to a new base invalidates the old
 * calibration, and running against a stale one would silently reintroduce the measure-nothing case.
 */
router.post('/:id/start', async (req, res) => {
  await ensureBenchmarksLoaded();
  const id = String(req.params.id);
  const record = getBenchmark(id);
  if (!record) return res.status(404).json({ error: `Benchmark ${id} not found` });

  const { suite } = record;
  if (suite.status === 'running') return badRequest(res, `Benchmark ${id} is already running`);

  if (suite.validation) {
    const cal = suite.calibration;
    if (!cal || cal.baseCommit !== suite.baseCommit) {
      return badRequest(res, `Benchmark ${id} must be calibrated for baseCommit ${suite.baseCommit} before it can start`);
    }
    if (!cal.failsAtBase) {
      return badRequest(
        res,
        `Benchmark ${id} cannot start: its validation already PASSES at ${suite.baseCommit} (exit ${cal.exitCode}). ` +
        'A seed that passes at base scores every configuration 100% and measures nothing.',
      );
    }
  }

  const root = getWorkspaceRoot();
  if (!root) return badRequest(res, 'no workspace root');
  if (isDriving(id)) return badRequest(res, `Benchmark ${id} is already being driven`);

  await mutateBenchmark(id, (r) => {
    r.suite.status = 'running';
    r.suite.startedAt = new Date().toISOString();
  });

  log.info(`[benchmark] suite ${id} started — ${record.runs.length} run(s), concurrency ${concurrencyFor(suite)}`);

  // Fire-and-forget: a suite is a multi-hour job, so the request returns immediately and the driver
  // runs on the engine's own event loop — the same shape the Stoker and Temper use. Progress is read
  // back through GET /:id, which serves the persisted sidecar the driver writes as it goes.
  void driveSuite(record.suite, record.runs, root)
    .then(async (runs) => {
      await mutateBenchmark(id, (r) => {
        r.runs = runs;
        r.suite.status = 'done';
        r.suite.endedAt = new Date().toISOString();
        r.report = buildReport(r.suite.id, r.suite.baseCommit, r.suite.matrix, r.suite.repetitions, runs);
      });
      log.info(`[benchmark] suite ${id} finished`);
    })
    .catch(async (err) => {
      const message = err instanceof Error ? err.message : String(err);
      log.warn(`[benchmark] suite ${id} aborted: ${message}`);
      // Still build a report over whatever completed — an aborted suite is a smaller benchmark, not
      // an invalid one, and its finished runs stay scoreable at their real denominator.
      await mutateBenchmark(id, (r) => {
        r.suite.status = 'aborted';
        r.suite.abortReason = message;
        r.suite.endedAt = new Date().toISOString();
        r.report = buildReport(r.suite.id, r.suite.baseCommit, r.suite.matrix, r.suite.repetitions, r.runs);
      });
    });

  return res.json({ suite: getBenchmark(id)?.suite, concurrency: concurrencyFor(suite), driving: true });
});

/**
 * POST /:id/retry — re-drive runs that never got to work: a `crash` with NO session (dispatch refused,
 * isolation failed). Their attrition was the harness's, not the configuration's, so they go back to
 * `pending` on a fresh ticket and the suite drives again. Runs that did dispatch are untouched —
 * re-running those would be a second measurement of the same cell, not a retry.
 */
router.post('/:id/retry', async (req, res) => {
  await ensureBenchmarksLoaded();
  const id = String(req.params.id);
  const record = getBenchmark(id);
  if (!record) return res.status(404).json({ error: `Benchmark ${id} not found` });
  if (record.suite.status === 'running' || isDriving(id)) return badRequest(res, `Benchmark ${id} is still running`);
  const root = getWorkspaceRoot();
  if (!root) return badRequest(res, 'no workspace root');

  const retried: string[] = [];
  await mutateBenchmark(id, (r) => {
    for (const run of r.runs) {
      if (run.status !== 'failed' || run.failureClass !== 'crash' || run.sessionId) continue;
      retried.push(run.runId);
      const keep = { runId: run.runId, cell: run.cell, repetitionIndex: run.repetitionIndex };
      for (const key of Object.keys(run)) delete (run as unknown as Record<string, unknown>)[key];
      Object.assign(run, keep, { status: 'pending', inputTokens: null, outputTokens: null, costUSD: null });
    }
    if (retried.length > 0) {
      r.suite.status = 'running';
      delete r.suite.endedAt;
      delete r.suite.abortReason;
    }
  });
  if (retried.length === 0) return res.json({ retried: [], suite: record.suite });

  const fresh = getBenchmark(id)!;
  log.info(`[benchmark] suite ${id} retrying ${retried.length} never-dispatched run(s)`);
  void driveSuite(fresh.suite, fresh.runs, root)
    .then(async (runs) => {
      await mutateBenchmark(id, (r) => {
        r.runs = runs;
        r.suite.status = 'done';
        r.suite.endedAt = new Date().toISOString();
        r.report = buildReport(r.suite.id, r.suite.baseCommit, r.suite.matrix, r.suite.repetitions, runs);
      });
    })
    .catch(async (err) => {
      const message = err instanceof Error ? err.message : String(err);
      await mutateBenchmark(id, (r) => {
        r.suite.status = 'aborted';
        r.suite.abortReason = message;
        r.suite.endedAt = new Date().toISOString();
        r.report = buildReport(r.suite.id, r.suite.baseCommit, r.suite.matrix, r.suite.repetitions, r.runs);
      });
    });
  return res.json({ retried, suite: getBenchmark(id)?.suite });
});

/**
 * POST /:id/recollect — re-run collection for runs whose agent work finished but whose COLLECTION
 * crashed (default: every `failed`/`crash` run with a branch; or an explicit `runIds` list).
 *
 * A collector defect must never be what decides a run's score: the diff is committed on the run's
 * branch and cost/duration live on the ticket, so the evidence is durable and the verdict can be
 * recomputed. Synchronous — a recollection is validation-time work (minutes at most), not a suite.
 */
router.post('/:id/recollect', async (req, res) => {
  await ensureBenchmarksLoaded();
  const id = String(req.params.id);
  const record = getBenchmark(id);
  if (!record) return res.status(404).json({ error: `Benchmark ${id} not found` });
  if (record.suite.status === 'running' || isDriving(id)) return badRequest(res, `Benchmark ${id} is still running`);
  const root = getWorkspaceRoot();
  if (!root) return badRequest(res, 'no workspace root');

  const body = (req.body ?? {}) as { runIds?: string[] };
  const eligible = selectRecollectable(record.runs, body.runIds);
  if (eligible.length === 0) return res.json({ recollected: [], report: record.report });

  const done = await recollectSuite(record.suite, record.runs, root, body.runIds);
  await mutateBenchmark(id, (r) => {
    r.report = buildReport(r.suite.id, r.suite.baseCommit, r.suite.matrix, r.suite.repetitions, r.runs);
  });
  return res.json({
    recollected: done.map((r) => ({ runId: r.runId, ticketId: r.ticketId, status: r.status, solved: r.solved, failureClass: r.failureClass })),
    report: getBenchmark(id)?.report,
  });
});

/**
 * POST /:id/cleanup — delete the local run branches a finished suite no longer needs.
 *
 * `completed` runs (and scored failures) have their evidence on the record; `crash` runs keep their
 * branch so they can still be recollected. Refused while the suite is running. Never touches the
 * remote — run branches are never pushed.
 */
router.post('/:id/cleanup', async (req, res) => {
  await ensureBenchmarksLoaded();
  const id = String(req.params.id);
  const record = getBenchmark(id);
  if (!record) return res.status(404).json({ error: `Benchmark ${id} not found` });
  if (record.suite.status === 'running' || isDriving(id)) return badRequest(res, `Benchmark ${id} is still running`);
  const root = getWorkspaceRoot();
  if (!root) return badRequest(res, 'no workspace root');

  const removed = await cleanupSuite(record.suite, record.runs, root);
  const kept = record.runs.filter((r) => r.branch && !r.branchRemovedAt).map((r) => ({ runId: r.runId, branch: r.branch, reason: r.failureClass === 'crash' ? 'crash (recollectable)' : r.status }));
  return res.json({ removed: removed.map((r) => ({ runId: r.runId, branch: r.branch })), kept });
});

/**
 * POST /:id/archive — hide a suite from the comparison and default listing without deleting it.
 * Body `{ archived: boolean }` (default true). The sidecar stays; it is the audit trail.
 */
router.post('/:id/archive', async (req, res) => {
  await ensureBenchmarksLoaded();
  const id = String(req.params.id);
  const record = getBenchmark(id);
  if (!record) return res.status(404).json({ error: `Benchmark ${id} not found` });
  if (record.suite.status === 'running' || isDriving(id)) return badRequest(res, `Benchmark ${id} is still running`);
  const archived = (req.body as { archived?: boolean } | undefined)?.archived !== false;
  await mutateBenchmark(id, (r) => { r.suite.archived = archived; });
  return res.json({ suite: getBenchmark(id)?.suite });
});

/**
 * DELETE /:id — remove a suite's sidecar. Refused while running. Run tickets and branches are not
 * touched here (tickets are archived by the runner; branches go through /cleanup).
 */
router.delete('/:id', async (req, res) => {
  await ensureBenchmarksLoaded();
  const id = String(req.params.id);
  const record = getBenchmark(id);
  if (!record) return res.status(404).json({ error: `Benchmark ${id} not found` });
  if (record.suite.status === 'running' || isDriving(id)) return badRequest(res, `Benchmark ${id} is still running`);
  await deleteBenchmark(id);
  return res.json({ deleted: id });
});

/**
 * GET /:id/artifacts/:runId/<path> — a file preserved from a run's worktree at collection (a harness
 * screenshot, the built game). Path-guarded to the run's artifact directory; HTML is served with a
 * restrictive CSP so a built page cannot reach the engine's API from the portal's origin.
 */
router.use('/:id/artifacts/:runId', async (req, res, next) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') return next();
  const id = String(req.params.id);
  const runId = String(req.params.runId);
  // The file path is the remainder of the URL (`router.use` strips the mount prefix into `req.path`),
  // so a built page's RELATIVE references (`./game.js`, `./src/sim.js`, `./style.css`) resolve back
  // into the same artefact directory — the `?p=` form broke every one of them, which is why a
  // "Play" page rendered blank. `?p=` is still accepted for older links. A wildcard route segment
  // was not an option: Express 5's `*rest` did not match multi-segment paths in this router.
  const tail = decodeURIComponent(req.path.replace(/^\/+/, ''));
  const rel = tail || (typeof req.query.p === 'string' ? req.query.p : '');
  if (!rel) return badRequest(res, 'artifact path is required');
  if (!/^[A-Za-z0-9_.-]+$/.test(id) || !/^[A-Za-z0-9]+$/.test(runId)) return badRequest(res, 'bad id');
  // Sub-resources loaded by the page carry no `?ws=`/header, so the request binds to the DEFAULT
  // board. Fall back to whichever open board actually holds this suite's artefact directory — the
  // (suiteId, runId) pair is unique across boards, so the first hit is the right one.
  const roots = [getWorkspaceRoot(), ...listWorkspaces().map((w) => w.root)].filter((r): r is string => !!r);
  const root = roots.find((r) => existsSync(artifactDir(id, runId, r)));
  if (!root) return res.status(404).json({ error: 'artifact not found' });
  const dir = path.resolve(artifactDir(id, runId, root));
  const file = path.resolve(dir, rel);
  if (!file.startsWith(dir + path.sep) || !existsSync(file) || !statSync(file).isFile()) {
    return res.status(404).json({ error: 'artifact not found' });
  }
  if (/\.html?$/i.test(file)) {
    res.setHeader('Content-Security-Policy', "default-src 'self' 'unsafe-inline' data: blob:; connect-src 'none'; frame-ancestors 'self'");
  }
  res.setHeader('Cache-Control', 'private, max-age=300');
  // The store lives under a dot-directory (`.flux/`, `.flux-store/`); `send` refuses those by default.
  return res.sendFile(file, { dotfiles: 'allow' });
});

/**
 * POST /:id/report — recompute the report from stored records.
 *
 * Deliberately recomputable on demand and from raw records ALONE: no re-run, no live session state,
 * no analyst pass. That is what makes a published report auditable.
 */
router.post('/:id/report', async (req, res) => {
  await ensureBenchmarksLoaded();
  const id = String(req.params.id);
  const record = getBenchmark(id);
  if (!record) return res.status(404).json({ error: `Benchmark ${id} not found` });

  // `recomputeFriction`: re-derive each run's friction under the CURRENT rules from transcript +
  // durable progress + the ticket state frozen at collection. Runs collected before that snapshot
  // existed keep their stored friction and are named in `frictionNotRecomputed`.
  const body = (req.body ?? {}) as { recomputeFriction?: boolean };
  const notRecomputed: string[] = [];
  if (body.recomputeFriction && record.suite.status !== 'running') {
    const root = getWorkspaceRoot();
    await runWithWorkspace(resolveWorkspaceByRoot(root ?? ''), async () => {
      for (const run of record.runs) {
        if (run.status !== 'completed' && run.status !== 'failed') continue;
        const ok = await recomputeRunFriction(run, root ?? '');
        if (!ok) notRecomputed.push(run.runId);
      }
    });
  }

  const report = buildReport(record.suite.id, record.suite.baseCommit, record.suite.matrix, record.suite.repetitions, record.runs);
  await mutateBenchmark(id, (r) => { r.report = report; });
  return res.json({ report, ...(body.recomputeFriction ? { frictionNotRecomputed: notRecomputed } : {}) });
});

export default router;
