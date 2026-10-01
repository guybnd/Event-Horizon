// Benchmark suite persistence (FLUX-1739).
//
// One JSON sidecar per suite at `<activeFluxDir>/benchmarks/<id>.json`, holding the suite manifest,
// every run record, the computed report and the analyst narrative. Structurally a copy of
// `furnace-store.ts` — atomic write, lazy per-root load, per-suite async lock — because that module
// already solved the same three problems (a long-running driver doing read-modify-write every tick
// while REST callers mutate the same object, restart survival, and multi-board isolation).
//
// WHY PERSISTED: a suite is a multi-hour job. Every field the scoring layer needs must be on disk as
// it is collected, because `CliSessionRecord` is an in-memory Map that an engine restart destroys —
// so a suite that read its telemetry only at the end would lose every completed run.
//
// WHY `getBenchmarkDir(root)` RESOLVES THROUGH THE OWNING ROOT, not the ambiently-active board: the
// FLUX-1554 split-brain lesson `getFurnaceDir` carries. A suite started on board A whose async
// continuation resumes while board B is active must still write to A's directory.

import fs from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import { getActiveFluxDir } from './workspace.js';
import { getWorkspace, resolveWorkspaceByRoot, runWithWorkspace } from './workspace-context.js';
import { atomicWriteFile } from './task-store.js';
import { broadcastEvent } from './events.js';
import { log } from './log.js';
import type { BenchmarkNarrative, BenchmarkReport, BenchmarkRun, BenchmarkSuite } from './models/benchmark.js';

/** The full on-disk shape of one suite. */
export interface BenchmarkRecord {
  suite: BenchmarkSuite;
  runs: BenchmarkRun[];
  report?: BenchmarkReport;
  narrative?: BenchmarkNarrative;
}

export function getBenchmarkDir(root: string | null = getWorkspace().root): string {
  return path.join(runWithWorkspace(resolveWorkspaceByRoot(root ?? ''), () => getActiveFluxDir()), 'benchmarks');
}

function suitePath(id: string, root: string | null): string {
  return path.join(getBenchmarkDir(root), `${id}.json`);
}

// ── Per-suite serialization ───────────────────────────────────────────────────
// Same chain-map shape as `withFurnaceLock`: the runner updates a suite on every run transition
// while REST callers read/mutate it, and an unserialized read-modify-write would silently drop
// whichever update lost the race — which for a benchmark means a lost run record, i.e. a wrong
// denominator in every rate.
const chains = new Map<string, Promise<void>>();

export function withBenchmarkLock<T>(id: string, fn: () => Promise<T>): Promise<T> {
  const prev = chains.get(id) ?? Promise.resolve();
  const result = prev.then(fn, fn);
  chains.set(id, result.then(() => {}, () => {}));
  return result;
}

// ── Cache ─────────────────────────────────────────────────────────────────────
// Keyed by workspace root first, suite id second — two boards can hold same-named suites.
const cache = new Map<string, Map<string, BenchmarkRecord>>();

function cacheFor(root: string | null): Map<string, BenchmarkRecord> {
  const key = root ?? '';
  let m = cache.get(key);
  if (!m) { m = new Map(); cache.set(key, m); }
  return m;
}

function looksLikeRecord(v: unknown): v is BenchmarkRecord {
  const r = v as Partial<BenchmarkRecord> | null;
  return !!r && !!r.suite && typeof r.suite.id === 'string' && Array.isArray(r.runs);
}

/** Load every suite sidecar for a root into the cache. Idempotent and cheap once warm. */
export async function ensureBenchmarksLoaded(root: string | null = getWorkspace().root): Promise<void> {
  const dir = getBenchmarkDir(root);
  const m = cacheFor(root);
  if (m.size > 0) return;
  if (!existsSync(dir)) return;
  const files = await fs.readdir(dir).catch(() => [] as string[]);
  for (const file of files) {
    if (!file.endsWith('.json')) continue;
    try {
      const parsed: unknown = JSON.parse(await fs.readFile(path.join(dir, file), 'utf-8'));
      if (looksLikeRecord(parsed)) m.set(parsed.suite.id, parsed);
    } catch (err) {
      log.warn(`[benchmark-store] skipping unreadable sidecar ${file}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

export function getBenchmark(id: string, root: string | null = getWorkspace().root): BenchmarkRecord | undefined {
  return cacheFor(root).get(id);
}

export function listBenchmarks(root: string | null = getWorkspace().root): BenchmarkRecord[] {
  return [...cacheFor(root).values()];
}

async function persist(record: BenchmarkRecord, root: string | null): Promise<void> {
  const dir = getBenchmarkDir(root);
  await fs.mkdir(dir, { recursive: true });
  await atomicWriteFile(suitePath(record.suite.id, root), JSON.stringify(record, null, 2));
  cacheFor(root).set(record.suite.id, record);
  broadcastEvent('benchmarkUpdated', { id: record.suite.id });
}

export async function saveBenchmark(record: BenchmarkRecord, root: string | null = getWorkspace().root): Promise<BenchmarkRecord> {
  return withBenchmarkLock(record.suite.id, async () => {
    await persist(record, root);
    return record;
  });
}

/**
 * Read-modify-write under the suite's lock. The ONLY sanctioned way to change a stored suite —
 * a bare `saveBenchmark` of a stale object is how a concurrent run record goes missing.
 */
export async function mutateBenchmark(
  id: string,
  fn: (record: BenchmarkRecord) => void | Promise<void>,
  root: string | null = getWorkspace().root,
): Promise<BenchmarkRecord | undefined> {
  return withBenchmarkLock(id, async () => {
    const record = cacheFor(root).get(id);
    if (!record) return undefined;
    await fn(record);
    await persist(record, root);
    return record;
  });
}

/** Update one run in place, matched on `runId`. Returns false when the run is not in the suite. */
export async function updateBenchmarkRun(
  suiteId: string,
  runId: string,
  fn: (run: BenchmarkRun) => void,
  root: string | null = getWorkspace().root,
): Promise<boolean> {
  let found = false;
  await mutateBenchmark(suiteId, (record) => {
    const run = record.runs.find((r) => r.runId === runId);
    if (!run) return;
    found = true;
    fn(run);
  }, root);
  return found;
}

export async function deleteBenchmark(id: string, root: string | null = getWorkspace().root): Promise<void> {
  await withBenchmarkLock(id, async () => {
    await fs.rm(suitePath(id, root), { force: true }).catch(() => {});
    cacheFor(root).delete(id);
    broadcastEvent('benchmarkUpdated', { id });
  });
}

/** Test seam — the module-scoped cache would otherwise leak between test files. */
export function __resetBenchmarkStoreForTests(): void {
  cache.clear();
  chains.clear();
}
