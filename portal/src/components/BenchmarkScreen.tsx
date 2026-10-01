import { useCallback, useEffect, useMemo, useState } from 'react';
import { Gauge, RefreshCw, AlertTriangle, Check, X, Minus, Sparkles, Plus, Trash2 } from 'lucide-react';
import { useAppSelector } from '../store/useAppSelector';
import {
  fetchBenchmarks,
  fetchBenchmark,
  rebuildBenchmarkReport,
  requestBenchmarkAnalysis,
  fetchBenchmarkComparison,
  archiveBenchmark,
  fetchBenchmarkSeeds,
  createBenchmarkFromSeed,
  artifactUrl,
  type BenchmarkSeed,
  type BenchmarkComparisonData,
  type BenchmarkRecordData,
  type BenchmarkRunRow,
  type BenchmarkSuiteData,
  type BenchmarkCell,
  type BenchmarkCellReport,
} from '../api';
import { classifyRun, firstFailure, MODE_LABEL, type FailureMode } from '../benchmarkRun';

/**
 * Benchmark results (FLUX-1739).
 *
 * The screen's job is a decision: which configuration should I use, and where did EventHorizon get
 * in the way? Three choices follow from that and are worth stating, because each is easy to
 * "simplify" into something misleading:
 *
 *  1. **Uncertainty is drawn, never hidden.** A cell that solved 3 of 3 renders as a range bar
 *     spanning 44–100%, not a green "100%". Three runs is three runs; a bare percentage invites a
 *     conclusion the sample cannot support.
 *  2. **Zero-solve cells are listed, never plotted.** They have no cost-per-solve, so they have no
 *     coordinate — and a null would coerce to 0 and read as infinitely cheap.
 *  3. **`solved` is a three-clause conjunction**, so an unsolved run shows WHICH clause broke
 *     (terminated / produced a diff / passed the held-out check) rather than a bare "unsolved".
 */

type FrictionGrade = 'clean' | 'noisy' | 'obstructive' | 'blocking';

const GRADE_CLASS: Record<string, string> = {
  clean: 'text-emerald-700 bg-emerald-50 dark:text-emerald-300 dark:bg-emerald-500/15',
  noisy: 'text-amber-700 bg-amber-50 dark:text-amber-300 dark:bg-amber-500/15',
  obstructive: 'text-orange-700 bg-orange-50 dark:text-orange-300 dark:bg-orange-500/15',
  blocking: 'text-rose-700 bg-rose-50 dark:text-rose-300 dark:bg-rose-500/15',
};

const GRADE_DOT: Record<string, string> = {
  clean: '#10b981', noisy: '#f59e0b', obstructive: '#f97316', blocking: '#f43f5e',
};

const MODE_CLASS: Record<FailureMode, string> = {
  solved: GRADE_CLASS.clean!,
  regressed: GRADE_CLASS.obstructive!,
  'check-failed': GRADE_CLASS.blocking!,
  'empty-diff': GRADE_CLASS.noisy!,
  crashed: GRADE_CLASS.obstructive!,
  attrition: 'text-gray-500 bg-gray-100 dark:text-gray-400 dark:bg-white/5',
  running: 'text-sky-700 bg-sky-50 dark:text-sky-300 dark:bg-sky-500/15',
};

function cellLabel(cell: BenchmarkCell): string {
  const model = cell.model ? cell.model.replace(/^claude-/, '') : 'default';
  return cell.effortOverride ? `${model} · ${cell.effortOverride}` : model;
}

function money(v: number | null | undefined): string {
  return v == null ? '—' : `$${v.toFixed(2)}`;
}

function duration(ms: number | null | undefined): string {
  if (ms == null) return '—';
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
}

function pct(v: number | null | undefined): string {
  return v == null ? '—' : `${Math.round(v * 100)}%`;
}

export function BenchmarkScreen() {
  const [suites, setSuites] = useState<{ suite: BenchmarkSuiteData; runCount: number }[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [record, setRecord] = useState<BenchmarkRecordData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [comparison, setComparison] = useState<BenchmarkComparisonData | null>(null);
  const [showNew, setShowNew] = useState(false);

  const loadList = useCallback(() => {
    fetchBenchmarks()
      .then((r) => {
        setSuites(r.benchmarks);
        setSelected((cur) => cur ?? r.benchmarks[r.benchmarks.length - 1]?.suite.id ?? null);
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
    fetchBenchmarkComparison().then(setComparison).catch(() => setComparison(null));
  }, []);

  const loadOne = useCallback((id: string) => {
    setLoading(true);
    setError(null);
    // Recompute the report first so the view always reflects the stored records rather than a
    // snapshot taken before the last run landed.
    rebuildBenchmarkReport(id)
      .catch(() => undefined)
      .then(() => fetchBenchmark(id))
      .then(setRecord)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  }, []);

  // Suites are board-scoped (`ehFetch` sends the active board key), so a board switch while this
  // screen is open must drop the previous board's list and selection and fetch the new board's.
  const activeBoardId = useAppSelector((s) => s.activeBoardId);
  useEffect(() => {
    setSuites([]);
    setSelected(null);
    setRecord(null);
    setComparison(null);
    setError(null);
    loadList();
  }, [activeBoardId, loadList]);
  useEffect(() => { if (selected) loadOne(selected); }, [selected, loadOne]);

  // A running suite changes underneath the view; poll while it does, stop when it settles.
  useEffect(() => {
    if (!record || (record.suite.status !== 'running')) return;
    const t = setInterval(() => { if (selected) loadOne(selected); }, 10_000);
    return () => clearInterval(t);
  }, [record, selected, loadOne]);

  const modeCounts = useMemo(() => {
    const counts: Record<FailureMode, number> = { solved: 0, regressed: 0, 'check-failed': 0, 'empty-diff': 0, crashed: 0, attrition: 0, running: 0 };
    for (const r of record?.runs ?? []) counts[classifyRun(r)]++;
    return counts;
  }, [record]);

  return (
    <div className="max-w-6xl mx-auto py-8 px-4">
      <div className="flex items-center gap-3 mb-5">
        <Gauge className="w-7 h-7 text-amber-500" />
        <h1 className="text-3xl font-bold text-gray-900 dark:text-gray-100">Benchmarks</h1>
        {suites.length > 0 && (
          <select
            value={selected ?? ''}
            onChange={(e) => setSelected(e.target.value)}
            aria-label="Suite"
            className="ml-2 bg-white dark:bg-[#252630] border border-gray-200 dark:border-white/10 rounded-lg px-2.5 py-1.5 text-xs font-medium focus:border-primary outline-none cursor-pointer"
          >
            {suites.filter((s) => !s.suite.archived || s.suite.id === selected).map((s) => (
              <option key={s.suite.id} value={s.suite.id}>{s.suite.id} — {s.suite.seedTitle}{s.suite.archived ? ' (archived)' : ''}</option>
            ))}
            {suites.some((s) => s.suite.archived && s.suite.id !== selected) && (
              <optgroup label="Archived">
                {suites.filter((s) => s.suite.archived && s.suite.id !== selected).map((s) => (
                  <option key={s.suite.id} value={s.suite.id}>{s.suite.id} — {s.suite.seedTitle}</option>
                ))}
              </optgroup>
            )}
          </select>
        )}
        {record && record.suite.status !== 'running' && (
          <button
            type="button"
            onClick={() => { archiveBenchmark(record.suite.id, !record.suite.archived).then(() => { loadList(); loadOne(record.suite.id); }).catch((e: unknown) => setError(e instanceof Error ? e.message : String(e))); }}
            className="flex items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-2.5 py-1.5 text-xs font-medium text-gray-500 hover:bg-gray-50 dark:border-white/10 dark:bg-[#252630] dark:text-gray-400 dark:hover:bg-white/5"
            title={record.suite.archived ? 'Bring this suite back into the comparison' : 'Hide this suite from the comparison (the record stays)'}
          >
            {record.suite.archived ? 'Unarchive' : 'Archive'}
          </button>
        )}
        <button
          type="button"
          onClick={() => setShowNew((v) => !v)}
          className={`flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs font-medium ${showNew ? 'border-amber-300 bg-amber-50 text-amber-800 dark:border-amber-500/40 dark:bg-amber-500/15 dark:text-amber-200' : 'border-gray-200 bg-white text-gray-500 hover:bg-gray-50 dark:border-white/10 dark:bg-[#252630] dark:text-gray-400 dark:hover:bg-white/5'}`}
        >
          <Plus className="w-3.5 h-3.5" />
          New benchmark
        </button>
        <button
          type="button"
          onClick={() => { loadList(); if (selected) loadOne(selected); }}
          disabled={loading}
          className="ml-auto flex items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-2.5 py-1.5 text-xs font-medium text-gray-500 hover:bg-gray-50 disabled:opacity-50 dark:border-white/10 dark:bg-[#252630] dark:text-gray-400 dark:hover:bg-white/5"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
          Refresh
        </button>
      </div>

      {error && (
        <div className="flex items-center gap-2 text-sm text-rose-600 dark:text-rose-400 mb-4">
          <AlertTriangle className="w-4 h-4" /> {error}
        </div>
      )}

      {showNew && (
        <NewSuitePanel
          onCreated={(id) => { setShowNew(false); loadList(); setSelected(id); }}
          onClose={() => setShowNew(false)}
        />
      )}

      {!record && !loading && !error && !showNew && (
        <p className="text-sm text-gray-500 dark:text-gray-400">No benchmark suites yet. Start one with <b>New benchmark</b>.</p>
      )}

      {comparison && comparison.rows.length > 0 && (
        <Comparison data={comparison} selected={selected} onSelect={setSelected} />
      )}

      {record && (
        <>
          <Provenance record={record} />
          <ModeSummary counts={modeCounts} />
          {record.report && <Frontier report={record.report} />}
          {record.report && <CellTable report={record.report} />}
          {record.suite.track === 'build' && <BuildGallery record={record} />}
          <Narrative record={record} onChanged={() => loadOne(record.suite.id)} />
          <Runs suiteId={record.suite.id} runs={record.runs} heldOut={record.suite.validation?.paths ?? []} baseCommit={record.suite.baseCommit} />
        </>
      )}
    </div>
  );
}

const EFFORTS = ['low', 'medium', 'high', 'max'];
const MODEL_SUGGESTIONS = ['claude-sonnet-5', 'claude-opus-5', 'claude-haiku-4-5-20251001'];

type CellDraft = { framework: string; model: string; effortOverride: string; phase: string };

/**
 * "New benchmark": pick a curated seed, set the matrix, calibrate, start — no hand-written manifest.
 * The seed carries everything that must not vary between cells (base commit, prompt, held-out check);
 * the form only edits what a comparison is allowed to vary.
 */
function NewSuitePanel({ onCreated, onClose }: { onCreated: (id: string) => void; onClose: () => void }) {
  const [seeds, setSeeds] = useState<BenchmarkSeed[] | null>(null);
  const [seedId, setSeedId] = useState<string>('');
  // Filled from the seed's defaultMatrix once it loads; the engine, not the portal, knows the CLIs.
  const [cells, setCells] = useState<CellDraft[]>([]);
  const [reps, setReps] = useState(3);
  const [conc, setConc] = useState(3);
  const [budgetMin, setBudgetMin] = useState(30);
  const [suiteId, setSuiteId] = useState('');
  const [startNow, setStartNow] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<{ id: string; calibration?: string; started: boolean; refused?: string } | null>(null);

  useEffect(() => {
    fetchBenchmarkSeeds()
      .then((r) => { setSeeds(r.seeds); if (r.seeds[0] && !seedId) setSeedId(r.seeds[0].id); })
      .catch((e: unknown) => { setSeeds([]); setErr(e instanceof Error ? e.message : String(e)); });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const seed = seeds?.find((s) => s.id === seedId);
  useEffect(() => {
    if (!seed) return;
    if (seed.defaultMatrix && seed.defaultMatrix.length > 0) {
      setCells(seed.defaultMatrix.map((c) => ({ framework: c.framework, model: c.model ?? '', effortOverride: c.effortOverride ?? '', phase: c.phase })));
    }
    if (seed.repetitions) setReps(seed.repetitions);
    if (seed.concurrency) setConc(seed.concurrency);
    if (seed.wallClockBudgetMs) setBudgetMin(Math.round(seed.wallClockBudgetMs / 60000));
  }, [seed]);

  const runs = cells.length * reps;
  const canSubmit = !!seed && !!seed.baseCommit && cells.length > 0 && cells.every((c) => c.framework && c.model) && !busy;

  const submit = () => {
    if (!seed) return;
    setBusy(true);
    setErr(null);
    setOutcome(null);
    createBenchmarkFromSeed({
      seedId: seed.id,
      ...(suiteId.trim() ? { suiteId: suiteId.trim() } : {}),
      matrix: cells.map((c) => ({ framework: c.framework as BenchmarkCell['framework'], model: c.model, ...(c.effortOverride ? { effortOverride: c.effortOverride } : {}), phase: c.phase as BenchmarkCell['phase'] })),
      repetitions: reps,
      concurrency: conc,
      wallClockBudgetMs: budgetMin * 60000,
      calibrate: true,
      start: startNow,
    })
      .then((r) => {
        const cal = r.calibration;
        setOutcome({
          id: r.suite?.id ?? '',
          calibration: cal ? (cal.failsAtBase ? `fails at base (exit ${cal.exitCode}) — good seed` : `PASSES at base (exit ${cal.exitCode}) — refused`) : undefined,
          started: r.started,
          ...(r.refusedStart ? { refused: r.refusedStart } : {}),
        });
        if (r.suite?.id && (r.started || !startNow)) onCreated(r.suite.id);
      })
      .catch((e: unknown) => setErr(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(false));
  };

  const input = 'bg-white dark:bg-[#252630] border border-gray-200 dark:border-white/10 rounded-md px-2 py-1 text-xs focus:border-primary outline-none';

  return (
    <section className="mb-6 rounded-xl border border-amber-200 dark:border-amber-500/30 bg-white dark:bg-[#1c1d26] overflow-hidden">
      <div className="flex items-center gap-2.5 px-4 py-2.5 border-b border-gray-200 dark:border-white/10">
        <Plus className="w-4 h-4 text-amber-500" />
        <h2 className="text-sm font-semibold text-gray-800 dark:text-gray-200">New benchmark</h2>
        <span className="text-[11px] text-gray-400 dark:text-gray-500">a seed fixes the task, base commit and held-out check; you vary only the configuration</span>
        <button type="button" onClick={onClose} className="ml-auto text-gray-400 hover:text-gray-600 dark:hover:text-gray-200" aria-label="Close"><X className="w-4 h-4" /></button>
      </div>

      <div className="px-4 py-3 grid gap-4 lg:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)]">
        <div className="flex flex-col gap-3">
          <label className="flex flex-col gap-1 text-xs">
            <span className="text-[10px] uppercase tracking-wider text-gray-400 dark:text-gray-500">Seed</span>
            {seeds === null ? <span className="text-gray-400">loading…</span> : seeds.length === 0 ? (
              <span className="text-gray-500 dark:text-gray-400">No seeds in <span className="font-mono">bench/seeds/</span> for this board.</span>
            ) : (
              <select value={seedId} onChange={(e) => setSeedId(e.target.value)} className={input}>
                {seeds.map((s) => <option key={s.id} value={s.id}>{s.track === 'build' ? '🛠 ' : '🐛 '}{s.title}</option>)}
              </select>
            )}
          </label>
          {seed && (
            <div className="text-[12px] text-gray-600 dark:text-gray-300 leading-relaxed">
              <div>{seed.notes}</div>
              <div className="mt-1 font-mono text-[10.5px] text-gray-400 dark:text-gray-500">
                base {seed.baseRef} → {seed.baseCommit ? seed.baseCommit.slice(0, 8) : <span className="text-rose-500">{seed.resolveError ?? 'unresolved'}</span>} · held out: {seed.validation.paths.join(', ')}
              </div>
              <details className="mt-1">
                <summary className="cursor-pointer text-[11px] text-gray-400 dark:text-gray-500">prompt ({seed.prompt.length} chars)</summary>
                <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap text-[10.5px] text-gray-500 dark:text-gray-400 bg-gray-50 dark:bg-black/20 rounded p-2">{seed.prompt}</pre>
              </details>
            </div>
          )}
        </div>

        <div className="flex flex-col gap-3">
          <div>
            <div className="text-[10px] uppercase tracking-wider text-gray-400 dark:text-gray-500 mb-1">Configurations · {cells.length}</div>
            <div className="flex flex-col gap-1.5">
              {cells.map((c, i) => (
                <div key={i} className="flex items-center gap-1.5">
                  <input value={c.framework} onChange={(e) => setCells(cells.map((x, j) => j === i ? { ...x, framework: e.target.value } : x))} className={`${input} w-20`} placeholder="framework" />
                  <input list="bench-models" value={c.model} onChange={(e) => setCells(cells.map((x, j) => j === i ? { ...x, model: e.target.value } : x))} className={`${input} flex-1 font-mono`} placeholder="model id" />
                  <select value={c.effortOverride} onChange={(e) => setCells(cells.map((x, j) => j === i ? { ...x, effortOverride: e.target.value } : x))} className={`${input} w-24`}>
                    <option value="">default</option>
                    {EFFORTS.map((e) => <option key={e} value={e}>{e}</option>)}
                  </select>
                  <button type="button" onClick={() => setCells(cells.filter((_, j) => j !== i))} className="text-gray-400 hover:text-rose-500" aria-label="Remove configuration"><Trash2 className="w-3.5 h-3.5" /></button>
                </div>
              ))}
              <datalist id="bench-models">{MODEL_SUGGESTIONS.map((m) => <option key={m} value={m} />)}</datalist>
              <button type="button" onClick={() => setCells([...cells, { framework: cells[0]?.framework ?? '', model: '', effortOverride: 'high', phase: 'implementation' }])} className="self-start text-[11px] text-amber-700 dark:text-amber-300 hover:underline">+ add configuration</button>
            </div>
          </div>

          <div className="grid grid-cols-3 gap-2">
            <label className="flex flex-col gap-1 text-xs"><span className="text-[10px] uppercase tracking-wider text-gray-400 dark:text-gray-500">Repetitions</span><input type="number" min={1} max={10} value={reps} onChange={(e) => setReps(Math.max(1, Number(e.target.value) || 1))} className={input} /></label>
            <label className="flex flex-col gap-1 text-xs"><span className="text-[10px] uppercase tracking-wider text-gray-400 dark:text-gray-500">Concurrency</span><input type="number" min={1} max={3} value={conc} onChange={(e) => setConc(Math.min(3, Math.max(1, Number(e.target.value) || 1)))} className={input} /></label>
            <label className="flex flex-col gap-1 text-xs"><span className="text-[10px] uppercase tracking-wider text-gray-400 dark:text-gray-500">Budget / run (min)</span><input type="number" min={5} max={180} value={budgetMin} onChange={(e) => setBudgetMin(Math.max(5, Number(e.target.value) || 5))} className={input} /></label>
          </div>
          <label className="flex flex-col gap-1 text-xs"><span className="text-[10px] uppercase tracking-wider text-gray-400 dark:text-gray-500">Suite id (optional)</span><input value={suiteId} onChange={(e) => setSuiteId(e.target.value)} className={`${input} font-mono`} placeholder={seed ? `${seed.id}-<timestamp>` : ''} /></label>

          <div className="flex items-center gap-3 pt-1">
            <label className="flex items-center gap-1.5 text-xs text-gray-600 dark:text-gray-300"><input type="checkbox" checked={startNow} onChange={(e) => setStartNow(e.target.checked)} /> start after calibration</label>
            <span className="text-[11px] text-gray-400 dark:text-gray-500">{runs} run{runs === 1 ? '' : 's'}</span>
            <button type="button" disabled={!canSubmit} onClick={submit} className="ml-auto flex items-center gap-1.5 rounded-lg bg-amber-500 px-3 py-1.5 text-xs font-semibold text-white hover:bg-amber-600 disabled:opacity-50">
              {busy ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <Plus className="w-3.5 h-3.5" />}
              {busy ? 'Calibrating…' : startNow ? 'Calibrate and start' : 'Create and calibrate'}
            </button>
          </div>
          {err && <p className="text-xs text-rose-600 dark:text-rose-400">{err}</p>}
          {outcome && (
            <p className="text-xs text-gray-600 dark:text-gray-300">
              Created <span className="font-mono">{outcome.id}</span>{outcome.calibration ? ` · ${outcome.calibration}` : ''}{outcome.started ? ' · running' : ''}{outcome.refused ? ` · not started: ${outcome.refused}` : ''}
            </p>
          )}
        </div>
      </div>
    </section>
  );
}

/**
 * Build track: every run's final screenshot and its playable build in one row, so the comparison you
 * actually care about — what did each configuration make — is a glance, not six scrolls. Verdict and
 * cost sit under each so the picture never detaches from the numbers.
 */
function BuildGallery({ record }: { record: BenchmarkRecordData }) {
  const runs = record.runs.filter((r) => (r.artifacts ?? []).length > 0);
  if (runs.length === 0) return null;
  const pick = (r: BenchmarkRunRow) => {
    const shots = (r.artifacts ?? []).filter((a) => /\.png$/i.test(a.path)).sort((a, b) => a.path.localeCompare(b.path));
    // Prefer the "cleared" or "in progress" frame over the empty start frame.
    return shots.find((s) => /03-|02-/.test(s.path)) ?? shots[shots.length - 1];
  };
  return (
    <section className="mb-6 rounded-xl border border-gray-200 dark:border-white/10 bg-white dark:bg-[#1c1d26] overflow-hidden">
      <div className="flex items-baseline gap-2.5 px-4 py-2.5 border-b border-gray-200 dark:border-white/10">
        <h2 className="text-sm font-semibold text-gray-800 dark:text-gray-200">What each run built</h2>
        <span className="text-[11px] text-gray-400 dark:text-gray-500">click a frame for full size · Play opens the build in a new tab</span>
      </div>
      <div className="px-4 py-3 grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))' }}>
        {runs.map((r) => {
          const shot = pick(r);
          const playable = (r.artifacts ?? []).find((a) => /^game\/index\.html$/i.test(a.path));
          const mode = classifyRun(r);
          return (
            <div key={r.runId} className="rounded-lg border border-gray-200 dark:border-white/10 overflow-hidden bg-gray-50 dark:bg-black/20">
              {shot ? (
                <a href={artifactUrl(record.suite.id, r.runId, shot.path)} target="_blank" rel="noreferrer">
                  <img src={artifactUrl(record.suite.id, r.runId, shot.path)} alt={shot.path} className="w-full aspect-[8/5] object-cover bg-black/30" loading="lazy" />
                </a>
              ) : <div className="w-full aspect-[8/5] grid place-items-center text-[11px] text-gray-400">no screenshot</div>}
              <div className="px-2.5 py-2 text-[11.5px] flex items-center gap-2">
                <span className="font-medium text-gray-800 dark:text-gray-200 truncate">{cellLabel(r.cell)} #{r.repetitionIndex}</span>
                <span className={`ml-auto flex-none px-1.5 py-0.5 rounded text-[10px] font-semibold ${mode === 'solved' ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300' : 'bg-rose-50 text-rose-700 dark:bg-rose-500/15 dark:text-rose-300'}`}>{MODE_LABEL[mode]}</span>
              </div>
              <div className="px-2.5 pb-2 text-[11px] text-gray-500 dark:text-gray-400 flex items-center gap-2">
                <span>{money(r.costUSD)} · {duration(r.durationMs ?? null)}{r.work ? ` · +${r.work.linesAdded ?? 0}/−${r.work.linesRemoved ?? 0}` : ''}</span>
                {playable && <a href={artifactUrl(record.suite.id, r.runId, playable.path)} target="_blank" rel="noreferrer" className="ml-auto text-emerald-700 dark:text-emerald-300 font-medium hover:underline">▶ Play</a>}
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

const GRADE_CLS: Record<string, string> = {
  clean: 'text-emerald-700 bg-emerald-50 dark:text-emerald-300 dark:bg-emerald-500/15',
  noisy: 'text-amber-700 bg-amber-50 dark:text-amber-300 dark:bg-amber-500/15',
  obstructive: 'text-orange-700 bg-orange-50 dark:text-orange-300 dark:bg-orange-500/15',
  blocking: 'text-rose-700 bg-rose-50 dark:text-rose-300 dark:bg-rose-500/15',
};

/**
 * One row per configuration across every finished seed. This is the table the benchmark exists to
 * produce: the per-suite view answers "how did configs do on THIS task", this answers "which config".
 * Pooled numbers are computed over the union of runs, so the interval tightens with more seeds.
 */
function Comparison({ data, selected, onSelect }: { data: BenchmarkComparisonData; selected: string | null; onSelect: (id: string) => void }) {
  const seedShort = (title: string) => title.replace(/^FLUX-\d+\s*/, '').slice(0, 26);
  return (
    <section className="mb-6 rounded-xl border border-gray-200 dark:border-white/10 bg-white dark:bg-[#1c1d26] overflow-hidden">
      <div className="flex items-baseline gap-2.5 px-4 py-2.5 border-b border-gray-200 dark:border-white/10">
        <h2 className="text-sm font-semibold text-gray-800 dark:text-gray-200">Across seeds</h2>
        <span className="text-[11px] text-gray-400 dark:text-gray-500">
          {data.seeds.length} seed{data.seeds.length === 1 ? '' : 's'} · pooled over all scored runs · click a seed column to open it
          {data.excluded.length > 0 ? ` · ${data.excluded.length} suite${data.excluded.length === 1 ? '' : 's'} excluded (unfinished)` : ''}
        </span>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-[12px] tabular-nums">
          <thead>
            <tr className="text-[10px] uppercase tracking-wider text-gray-400 dark:text-gray-500">
              <th className="text-left px-4 py-2 font-medium">Config</th>
              {data.seeds.map((s) => (
                <th key={s.suiteId} className={`text-left px-3 py-2 font-medium cursor-pointer hover:text-gray-700 dark:hover:text-gray-200 ${selected === s.suiteId ? 'text-amber-600 dark:text-amber-400' : ''}`} onClick={() => onSelect(s.suiteId)} title={`${s.seedTitle} — ${s.suiteId}`}>
                  {seedShort(s.seedTitle)}
                </th>
              ))}
              <th className="text-left px-3 py-2 font-medium border-l border-gray-200 dark:border-white/10">Pooled solve</th>
              <th className="text-left px-3 py-2 font-medium">$/solve</th>
              <th className="text-left px-3 py-2 font-medium">Median time</th>
              <th className="text-left px-3 py-2 font-medium">Turns · calls · Δlines</th>
              <th className="text-left px-3 py-2 font-medium">Friction</th>
            </tr>
          </thead>
          <tbody>
            {data.rows.map((row) => {
              const p = row.pooled;
              const iv = p.solveRateInterval;
              return (
                <tr key={row.key} className="border-t border-gray-100 dark:border-white/5">
                  <td className="px-4 py-2 font-medium text-gray-800 dark:text-gray-200 whitespace-nowrap">{cellLabel(row.cell)}</td>
                  {row.perSeed.map((c, i) => (
                    <td key={i} className="px-3 py-2 whitespace-nowrap text-gray-700 dark:text-gray-300">
                      {c ? (
                        <span title={`${c.solvedRuns}/${c.scoredRuns} solved · ${money(c.costPerSolve)} per solve · ${duration(c.durationMedianMs)} median${c.regressedRuns ? ` · ${c.regressedRuns} regressed` : ''}`}>
                          <b className={c.solvedRuns === c.scoredRuns ? 'text-emerald-600 dark:text-emerald-400' : c.solvedRuns === 0 ? 'text-rose-600 dark:text-rose-400' : 'text-amber-600 dark:text-amber-400'}>{c.solvedRuns}/{c.scoredRuns}</b>
                          <span className="text-gray-400 dark:text-gray-500"> · {money(c.costPerSolve)} · {duration(c.durationMedianMs)}</span>
                          {c.regressedRuns > 0 && <span className="text-rose-500"> · broke {c.regressedRuns}</span>}
                        </span>
                      ) : <span className="text-gray-300 dark:text-gray-600">—</span>}
                    </td>
                  ))}
                  <td className="px-3 py-2 whitespace-nowrap border-l border-gray-200 dark:border-white/10">
                    <b className="text-gray-800 dark:text-gray-200">{p.solvedRuns}/{p.scoredRuns}</b>
                    <span className="text-gray-400 dark:text-gray-500"> · {iv ? `${pct(iv.low)}–${pct(iv.high)}` : 'n/a'}</span>
                    {p.attritionRuns > 0 && <span className="text-gray-400 dark:text-gray-500"> · {p.attritionRuns} attrition</span>}
                  </td>
                  <td className="px-3 py-2 whitespace-nowrap text-gray-700 dark:text-gray-300">{money(p.costPerSolve)} <span className="text-gray-400 dark:text-gray-500">({money(p.totalCostUSD)} total)</span></td>
                  <td className="px-3 py-2 whitespace-nowrap text-gray-700 dark:text-gray-300">{duration(p.durationMs.median)}</td>
                  <td className="px-3 py-2 whitespace-nowrap text-gray-700 dark:text-gray-300">
                    {p.turns.median == null ? <span className="text-gray-300 dark:text-gray-600">not recorded</span> : `${Math.round(p.turns.median)} · ${Math.round(p.toolCalls.median ?? 0)} · ${p.linesChanged.median == null ? '?' : Math.round(p.linesChanged.median)}`}
                  </td>
                  <td className="px-3 py-2 whitespace-nowrap">
                    {p.worstFriction && <span className={`inline-flex px-1.5 py-0.5 rounded text-[10.5px] font-semibold ${GRADE_CLS[p.worstFriction] ?? ''}`}>{p.worstFriction}</span>}
                    {p.ehToolFailureTotal > 0 && <span className="text-[11px] text-gray-400 dark:text-gray-500"> · {p.ehToolFailureTotal} EH fail</span>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

const ATTRIBUTION_CLS: Record<string, string> = {
  eventhorizon: 'bg-rose-50 text-rose-700 dark:bg-rose-500/15 dark:text-rose-300',
  adapter: 'bg-amber-50 text-amber-700 dark:bg-amber-500/15 dark:text-amber-300',
  effort: 'bg-sky-50 text-sky-700 dark:bg-sky-500/15 dark:text-sky-300',
  unknown: 'bg-gray-100 text-gray-600 dark:bg-white/10 dark:text-gray-300',
};

/**
 * The analyst's narrative — advisory text that cites the record, shown BELOW the numbers it is not
 * allowed to touch. Three states: no pass yet (offer one), in flight (say where), answered (show it).
 */
function Narrative({ record, onChanged }: { record: BenchmarkRecordData; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const finished = record.suite.status === 'done' || record.suite.status === 'aborted';
  const analysis = record.suite.analysis;
  const narrative = record.narrative;

  const start = (force: boolean) => {
    setBusy(true);
    setErr(null);
    requestBenchmarkAnalysis(record.suite.id, { force })
      .then(() => onChanged())
      .catch((e: unknown) => setErr(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(false));
  };

  if (!finished) return null;

  return (
    <section className="mb-6 rounded-xl border border-gray-200 dark:border-white/10 bg-white dark:bg-[#1c1d26] overflow-hidden">
      <div className="flex items-center gap-2.5 px-4 py-2.5 border-b border-gray-200 dark:border-white/10">
        <Sparkles className="w-4 h-4 text-violet-500" />
        <h2 className="text-sm font-semibold text-gray-800 dark:text-gray-200">Analyst narrative</h2>
        <span className="text-[11px] text-gray-400 dark:text-gray-500">advisory · every claim cites a run · numbers above are the record</span>
        <div className="ml-auto flex items-center gap-2">
          {analysis?.ticketId && (
            <span className="font-mono text-[11px] text-gray-400 dark:text-gray-500" title={analysis.sessionId ? `session ${analysis.sessionId}` : undefined}>{analysis.ticketId}</span>
          )}
          {(!analysis || analysis.error || narrative) && (
            <button
              type="button"
              disabled={busy}
              onClick={() => start(Boolean(narrative))}
              className="flex items-center gap-1.5 rounded-lg border border-violet-200 bg-violet-50 px-2.5 py-1 text-xs font-medium text-violet-700 hover:bg-violet-100 disabled:opacity-50 dark:border-violet-500/30 dark:bg-violet-500/10 dark:text-violet-300 dark:hover:bg-violet-500/20"
            >
              <Sparkles className="w-3.5 h-3.5" />
              {narrative ? 'Re-run analyst' : 'Run analyst'}
            </button>
          )}
        </div>
      </div>

      <div className="px-4 py-3 text-sm">
        {err && <p className="text-rose-600 dark:text-rose-400 mb-2">{err}</p>}

        {!analysis && !narrative && (
          <p className="text-gray-500 dark:text-gray-400">No analyst pass yet. The suite is complete and scoreable without one; the analyst adds a cited reading of what EventHorizon cost the agents.</p>
        )}

        {analysis?.error && !narrative && (
          <p className="text-rose-600 dark:text-rose-400">The analyst could not be started: {analysis.error}</p>
        )}

        {analysis && !analysis.error && !narrative && (
          <p className="text-gray-500 dark:text-gray-400">
            Analyst working on <span className="font-mono">{analysis.ticketId}</span> since {new Date(analysis.requestedAt).toLocaleTimeString()}. Its answer is harvested on the next refresh.
          </p>
        )}

        {narrative && (
          <div className="flex flex-col gap-4">
            <div className="whitespace-pre-wrap leading-relaxed text-gray-800 dark:text-gray-200">{narrative.summary || '(no summary)'}</div>

            {narrative.claims.length > 0 && (
              <div>
                <div className="text-[10px] uppercase tracking-wider text-gray-400 dark:text-gray-500 mb-1.5">Claims · {narrative.claims.length}{analysis?.droppedClaims ? ` · ${analysis.droppedClaims} dropped for citing no run` : ''}</div>
                <ol className="flex flex-col divide-y divide-gray-200 dark:divide-white/10">
                  {narrative.claims.map((c, i) => (
                    <li key={i} className="py-2 flex gap-3 items-baseline">
                      <span className={`inline-flex px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wide flex-none ${ATTRIBUTION_CLS[c.attribution] ?? ATTRIBUTION_CLS.unknown}`}>{c.attribution}</span>
                      <span className="flex-1 text-gray-700 dark:text-gray-300">{c.statement}</span>
                      <span className="font-mono text-[10.5px] text-gray-400 dark:text-gray-500 flex-none">{c.runId.slice(0, 8)} · {c.locator || '—'}</span>
                    </li>
                  ))}
                </ol>
              </div>
            )}
            {narrative.claims.length === 0 && (
              <p className="text-[12.5px] text-gray-500 dark:text-gray-400">The analyst made no admissible claims{analysis?.droppedClaims ? ` (${analysis.droppedClaims} dropped for citing no run)` : ''}.</p>
            )}

            {narrative.proposedDefects.length > 0 && (
              <div>
                <div className="text-[10px] uppercase tracking-wider text-gray-400 dark:text-gray-500 mb-1.5">Proposed EventHorizon defects · ranked · not filed</div>
                <ol className="list-decimal pl-5 flex flex-col gap-1 text-gray-700 dark:text-gray-300">
                  {narrative.proposedDefects.map((d, i) => <li key={i}>{d}</li>)}
                </ol>
              </div>
            )}

            {narrative.dissent && narrative.dissent.length > 0 && (
              <div>
                <div className="text-[10px] uppercase tracking-wider text-gray-400 dark:text-gray-500 mb-1.5">Dissent · stored beside the computed grade, never replacing it</div>
                {narrative.dissent.map((d, i) => (
                  <div key={i} className="text-[12.5px] text-gray-700 dark:text-gray-300">
                    <span className="font-mono text-[11px]">{cellLabel(d.cell)}</span> — analyst would grade <b>{d.grade}</b>: {d.reasoning}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </section>
  );
}

/** Trust before numbers: which engine produced these, and was its tree clean? */
function Provenance({ record }: { record: BenchmarkRecordData }) {
  const { suite } = record;
  const engine = record.runs.find((r) => r.engine)?.engine;
  const cal = suite.calibration;
  // FLUX-1759: one line per framework; more than one version under one framework means the CLI
  // changed mid-suite and the cells are not comparable, the same way a dirty engine is not.
  const cliVersions = new Map<string, Set<string>>();
  for (const r of record.runs) {
    if (!r.cli) continue;
    const set = cliVersions.get(r.cli.framework) ?? new Set<string>();
    set.add(r.cli.version ?? 'unknown');
    cliVersions.set(r.cli.framework, set);
  }
  const cliMixed = [...cliVersions.values()].some((s) => s.size > 1);
  // More than one engine commit across the runs means the platform under test changed mid-suite
  // (a rebuild between cells, or retried runs on a newer build) — the cells are not comparable.
  const engineCommits = [...new Set(record.runs.map((r) => r.engine?.commit?.slice(0, 8)).filter((c): c is string => Boolean(c)))];
  const items: { label: string; value: React.ReactNode }[] = [
    { label: 'Status', value: suite.status },
    {
      label: 'Engine',
      value: !engine
        ? '—'
        : engineCommits.length > 1
          ? <span className="font-mono text-orange-600 dark:text-orange-400 font-semibold" title="The engine changed between runs — cells are not comparable">{engine.version} · mixed: {engineCommits.join(' / ')}</span>
          : <span className="font-mono">{engine.version} · {engine.commit?.slice(0, 8) ?? '—'}</span>,
    },
    {
      label: 'Agent CLI',
      value: cliVersions.size === 0
        ? <span className="text-gray-400">not recorded</span>
        : <span className={`font-mono ${cliMixed ? 'text-orange-600 dark:text-orange-400 font-semibold' : ''}`} title={cliMixed ? 'The CLI version changed between runs — cells are not comparable' : undefined}>
            {[...cliVersions.entries()].map(([fw, vs]) => `${fw} ${[...vs].join(' / ')}`).join(' · ')}
          </span>,
    },
    {
      label: 'Working tree',
      value: engine?.dirty
        ? <span className="font-mono text-orange-600 dark:text-orange-400 font-semibold">dirty</span>
        : <span className="font-mono">clean</span>,
    },
    { label: 'Base commit', value: <span className="font-mono">{suite.baseCommit.slice(0, 8)}</span> },
    {
      label: 'Calibration',
      value: cal
        ? (cal.failsAtBase
            ? <span className="text-emerald-600 dark:text-emerald-400">fails at base · exit {cal.exitCode}</span>
            : <span className="text-rose-600 dark:text-rose-400">passes at base</span>)
        : 'none',
    },
  ];
  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 border border-gray-200 dark:border-white/10 rounded-lg overflow-hidden mb-7 bg-white dark:bg-[#1c1d26]">
      {items.map((it) => (
        <div key={it.label} className="px-3.5 py-2.5 border-r last:border-r-0 border-gray-200 dark:border-white/10">
          <div className="text-[10px] uppercase tracking-wider text-gray-400 dark:text-gray-500 mb-0.5">{it.label}</div>
          <div className="text-xs text-gray-900 dark:text-gray-100">{it.value}</div>
        </div>
      ))}
    </div>
  );
}

function ModeSummary({ counts }: { counts: Record<FailureMode, number> }) {
  const ALL: readonly { mode: FailureMode; label: string; sub: string }[] = [
    { mode: 'solved', label: 'Solved', sub: 'all three clauses' },
    { mode: 'regressed', label: 'Broke the build', sub: 'fixed it, broke something else' },
    { mode: 'check-failed', label: 'Check failed', sub: 'worked, got it wrong' },
    { mode: 'empty-diff', label: 'Empty diff', sub: 'changed nothing' },
    { mode: 'crashed', label: 'Crashed', sub: 'never terminated' },
    { mode: 'attrition', label: 'Attrition', sub: 'outside the denominator' },
    { mode: 'running', label: 'In flight', sub: 'not yet scored' },
  ];
  const order = ALL.filter((o) => counts[o.mode] > 0);
  if (order.length === 0) return null;

  return (
    <section className="mb-8">
      <h2 className="text-[11px] font-semibold uppercase tracking-wider text-gray-400 dark:text-gray-500 mb-1">Why runs did not solve</h2>
      <p className="text-xs text-gray-500 dark:text-gray-400 mb-3 max-w-2xl">
        Solving requires three things at once: the session ended normally, it produced a diff, and the held-out check
        passed against the restored tree. Each run is grouped by the clause that broke.
      </p>
      <div className="grid gap-px bg-gray-200 dark:bg-white/10 border border-gray-200 dark:border-white/10 rounded-lg overflow-hidden" style={{ gridTemplateColumns: `repeat(${order.length}, minmax(0, 1fr))` }}>
        {order.map((o) => (
          <div key={o.mode} className="bg-white dark:bg-[#1c1d26] px-3.5 py-3">
            <div className="text-xl font-bold font-mono tabular-nums leading-none" style={{ color: o.mode === 'attrition' ? undefined : GRADE_DOT[o.mode === 'solved' ? 'clean' : o.mode === 'check-failed' ? 'blocking' : o.mode === 'empty-diff' ? 'noisy' : 'obstructive'] }}>
              {counts[o.mode]}
            </div>
            <div className="text-[11px] text-gray-600 dark:text-gray-300 mt-1">{o.label}</div>
            <div className="text-[10px] text-gray-400 dark:text-gray-500 mt-0.5">{o.sub}</div>
          </div>
        ))}
      </div>
    </section>
  );
}

/** Solve rate against cost per solve. Zero-solve cells are excluded, never plotted. */
function Frontier({ report }: { report: { cells: BenchmarkCellReport[]; frontier: number[]; zeroSolveCells: number[] } }) {
  const plotted = report.cells
    .map((c, i) => ({ c, i }))
    .filter(({ i }) => !report.zeroSolveCells.includes(i));
  if (plotted.length === 0) return null;

  const maxCost = Math.max(...plotted.map((p) => p.c.costPerSolve ?? 0), 1);
  const W = 780, H = 300, L = 72, R = 40, T = 30, B = 60;
  const x = (cost: number) => L + (cost / maxCost) * (W - L - R);
  const y = (rate: number) => T + (1 - rate) * (H - T - B);

  return (
    <section className="mb-8">
      <h2 className="text-[11px] font-semibold uppercase tracking-wider text-gray-400 dark:text-gray-500 mb-1">Frontier</h2>
      <p className="text-xs text-gray-500 dark:text-gray-400 mb-3 max-w-2xl">
        Non-dominated on solve rate, cost per solve and median duration. No weighted score and no ranking — the
        trade-off is yours to make.
      </p>
      <div className="bg-white dark:bg-[#1c1d26] border border-gray-200 dark:border-white/10 rounded-lg p-4 overflow-x-auto">
        <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H} role="img" aria-label="Solve rate against cost per solve">
          {[0, 0.25, 0.5, 0.75, 1].map((r) => (
            <g key={r}>
              <line x1={L} y1={y(r)} x2={W - R} y2={y(r)} stroke="currentColor" className="text-gray-200 dark:text-white/10" strokeWidth={1} />
              <text x={L - 10} y={y(r) + 4} textAnchor="end" fontSize={11} className="fill-gray-400 dark:fill-gray-500" fontFamily="ui-monospace, monospace">{Math.round(r * 100)}%</text>
            </g>
          ))}
          {[0, 0.5, 1].map((f) => (
            <text key={f} x={x(maxCost * f)} y={H - B + 22} textAnchor="middle" fontSize={11} className="fill-gray-400 dark:fill-gray-500" fontFamily="ui-monospace, monospace">
              ${(maxCost * f).toFixed(2)}
            </text>
          ))}
          <text x={(L + W - R) / 2} y={H - 8} textAnchor="middle" fontSize={11.5} className="fill-gray-400 dark:fill-gray-500">Cost per solve →</text>

          {plotted.map(({ c, i }) => {
            const cx = x(c.costPerSolve ?? 0);
            const cy = y(c.solveRate ?? 0);
            const onFrontier = report.frontier.includes(i);
            return (
              <g key={i}>
                {onFrontier && <circle cx={cx} cy={cy} r={13} fill="none" stroke="#f59e0b" strokeWidth={1.5} />}
                <circle cx={cx} cy={cy} r={8} fill={GRADE_DOT[c.friction?.grade ?? 'clean'] ?? '#10b981'} opacity={onFrontier ? 1 : 0.45} />
                <text x={cx} y={cy - 19} textAnchor="middle" fontSize={11.5} fontWeight={onFrontier ? 600 : 400} className="fill-gray-700 dark:fill-gray-200">
                  {cellLabel(c.cell)}
                </text>
              </g>
            );
          })}
        </svg>
        <div className="flex flex-wrap gap-4 mt-3 pt-3 border-t border-gray-200 dark:border-white/10 text-[11px] text-gray-500 dark:text-gray-400">
          <span className="inline-flex items-center gap-1.5"><i className="w-2.5 h-2.5 rounded-full border-2 border-amber-500" />On the frontier</span>
          {(['clean', 'noisy', 'obstructive', 'blocking'] as FrictionGrade[]).map((g) => (
            <span key={g} className="inline-flex items-center gap-1.5">
              <i className="w-2.5 h-2.5 rounded-full" style={{ background: GRADE_DOT[g] }} />{g}
            </span>
          ))}
          <span className="ml-auto">Fill = friction grade</span>
        </div>
      </div>
    </section>
  );
}

function CellTable({ report }: { report: { cells: BenchmarkCellReport[]; frontier: number[]; zeroSolveCells: number[] } }) {
  return (
    <section className="mb-8">
      <h2 className="text-[11px] font-semibold uppercase tracking-wider text-gray-400 dark:text-gray-500 mb-1">Cells</h2>
      <p className="text-xs text-gray-500 dark:text-gray-400 mb-3 max-w-2xl">
        Every rate carries its denominator and a Wilson 95% interval. Three runs is three runs — the bar shows how
        little that pins down.
      </p>
      <div className="overflow-x-auto">
        <table className="w-full text-[13px] min-w-[720px]">
          <thead>
            <tr className="border-b border-gray-300 dark:border-white/15">
              {['Configuration', 'Solve rate', 'pass^n', 'Cost / solve', 'Median', 'Friction'].map((h, i) => (
                <th key={h} className={`text-[10px] font-semibold uppercase tracking-wider text-gray-400 dark:text-gray-500 pb-2 pr-3 whitespace-nowrap ${i >= 2 && i <= 4 ? 'text-right' : 'text-left'}`}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {report.cells.map((c, i) => {
              const zero = report.zeroSolveCells.includes(i);
              const onFrontier = report.frontier.includes(i);
              const ks = Object.keys(c.passHatK).map(Number).filter((k) => c.passHatK[String(k)] != null);
              const topK = ks.length ? Math.max(...ks) : null;
              return (
                <tr key={i} className={`border-b border-gray-200 dark:border-white/10 ${zero ? 'opacity-60' : ''}`}>
                  <td className={`py-3 pr-3 ${onFrontier ? 'border-l-2 border-amber-500 pl-2' : ''}`}>
                    <div className="font-semibold">{cellLabel(c.cell)}</div>
                    <div className="text-[11px] text-gray-400 dark:text-gray-500">
                      {c.solvedRuns}/{c.scoredRuns} solved{c.attritionRuns > 0 && ` · ${c.attritionRuns} attrition`}
                    </div>
                  </td>
                  <td className="py-3 pr-3">
                    {c.solveRate == null ? <span className="text-gray-400">no scored runs</span> : <WilsonBar rate={c.solveRate} lo={c.solveRateInterval?.low ?? 0} hi={c.solveRateInterval?.high ?? 1} />}
                  </td>
                  <td className="py-3 pr-3 text-right font-mono tabular-nums">
                    {topK == null ? '—' : (c.passHatK[String(topK)] ?? 0).toFixed(2)}
                    {topK != null && <span className="text-[10px] text-gray-400 ml-1">k={topK}</span>}
                  </td>
                  <td className="py-3 pr-3 text-right font-mono tabular-nums">
                    {c.costPerSolve == null ? <span className="text-gray-400" title="No solves — excluded from the frontier">—</span> : money(c.costPerSolve)}
                  </td>
                  <td className="py-3 pr-3 text-right font-mono tabular-nums">{duration(c.durationMs.median)}</td>
                  <td className="py-3">
                    <span className={`inline-flex px-2 py-0.5 rounded-full text-[11px] font-semibold ${GRADE_CLASS[c.friction?.grade ?? 'clean']}`}>
                      {c.friction?.grade ?? '—'}
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {report.zeroSolveCells.length > 0 && (
        <p className="text-[11px] text-gray-400 dark:text-gray-500 mt-2.5 max-w-2xl">
          Dimmed cells solved nothing, so they have no cost-per-solve and no coordinate to compare — they are listed
          but never plotted. Comparing them would let a null read as infinitely cheap and dominate the frontier.
        </p>
      )}
    </section>
  );
}

/** The point estimate as a tick inside its 95% interval — so a 3/3 cell cannot read as certainty. */
function WilsonBar({ rate, lo, hi }: { rate: number; lo: number; hi: number }) {
  return (
    <div className="flex items-center gap-2.5 min-w-[190px]">
      <span className="text-[13px] font-semibold w-9 text-right tabular-nums">{pct(rate)}</span>
      <span className="relative flex-1 h-[7px] rounded-full bg-gray-100 dark:bg-white/10 overflow-hidden">
        <i className="absolute inset-y-0 bg-amber-500/35 rounded-full" style={{ left: `${lo * 100}%`, right: `${(1 - hi) * 100}%` }} />
        <i className="absolute -top-[3px] w-0.5 h-[13px] bg-amber-500 rounded-sm" style={{ left: `${rate * 100}%` }} />
      </span>
      <span className="text-[11px] text-gray-400 dark:text-gray-500 font-mono tabular-nums whitespace-nowrap w-[72px]">
        {Math.round(lo * 100)} – {Math.round(hi * 100)}%
      </span>
    </div>
  );
}

function Runs({ suiteId, runs, heldOut, baseCommit }: { suiteId: string; runs: BenchmarkRunRow[]; heldOut: string[]; baseCommit: string }) {
  return (
    <section>
      <h2 className="text-[11px] font-semibold uppercase tracking-wider text-gray-400 dark:text-gray-500 mb-1">Runs</h2>
      <p className="text-xs text-gray-500 dark:text-gray-400 mb-3 max-w-2xl">
        {runs.length} dispatched. Every friction count carries the turn it came from.
      </p>
      <div className="flex flex-col gap-2">
        {runs.map((r) => <RunRow key={r.runId} suiteId={suiteId} run={r} heldOut={heldOut} baseCommit={baseCommit} />)}
      </div>
    </section>
  );
}

function RunRow({ suiteId, run, heldOut, baseCommit }: { suiteId: string; run: BenchmarkRunRow; heldOut: string[]; baseCommit: string }) {
  const shots = (run.artifacts ?? []).filter((a) => /\.png$/i.test(a.path)).sort((a, b) => a.path.localeCompare(b.path));
  const playable = (run.artifacts ?? []).find((a) => /^game\/index\.html$/i.test(a.path));
  const mode = classifyRun(run);
  const isHeldOut = (p: string) => heldOut.some((h) => p === h || p.startsWith(`${h}/`));

  return (
    <details className="border border-gray-200 dark:border-white/10 rounded-lg bg-white dark:bg-[#1c1d26]">
      <summary className="px-3.5 py-3 cursor-pointer flex items-center gap-3 text-[13px] list-none">
        <span className="font-mono text-gray-400 dark:text-gray-500 text-xs">{run.ticketId ?? run.runId.slice(0, 8)}</span>
        <span className="font-semibold">{cellLabel(run.cell)}</span>
        <span className={`ml-auto inline-flex px-2 py-0.5 rounded-full text-[11px] font-semibold ${MODE_CLASS[mode]}`}>{MODE_LABEL[mode]}</span>
        <span className="font-mono text-gray-400 dark:text-gray-500 text-xs w-14 text-right">{money(run.costUSD)}</span>
      </summary>

      <div className="px-3.5 pb-3.5 pt-1 grid gap-3.5 border-t border-gray-200 dark:border-white/10">
        {/* The verdict ladder: which of solved's three clauses actually broke. */}
        <div className="border border-gray-200 dark:border-white/10 rounded-md overflow-hidden">
          <Step
            state={run.failureClass ? 'fail' : 'ok'}
            title={run.failureClass ? `Did not terminate normally — ${run.failureClass}` : 'Terminated normally'}
            detail={run.failureClass
              ? (run.sessionOutcome || 'no outcome recorded')
              : `${run.status} · ${duration(run.durationMs)}`}
          />
          {mode === 'attrition' ? (
            <Step
              state="na"
              title="Left the denominator"
              detail={`Infrastructure failures are reported as attrition, never scored — scoring a provider down for being rate-limited measures the network, not the agent. Its ${money(run.costUSD)} enters neither side of cost-per-solve.`}
            />
          ) : (
            <>
              {(shots.length > 0 || playable) && (
                <div className="mb-2 flex items-center gap-2 overflow-x-auto">
                  {shots.map((s) => (
                    <a key={s.path} href={artifactUrl(suiteId, run.runId, s.path)} target="_blank" rel="noreferrer" title={s.path} className="flex-none">
                      <img src={artifactUrl(suiteId, run.runId, s.path)} alt={s.path} className="h-20 rounded border border-gray-200 dark:border-white/10 bg-black/20 object-cover" loading="lazy" />
                    </a>
                  ))}
                  {playable && (
                    <a href={artifactUrl(suiteId, run.runId, playable.path)} target="_blank" rel="noreferrer" className="flex-none inline-flex items-center gap-1.5 rounded-lg border border-emerald-200 bg-emerald-50 px-2.5 py-1.5 text-xs font-medium text-emerald-700 hover:bg-emerald-100 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-300">
                      ▶ Play this build
                    </a>
                  )}
                </div>
              )}
              <Step
                state={run.hasDiff === false ? 'fail' : run.hasDiff ? 'ok' : 'na'}
                title={run.hasDiff === false ? 'Produced no diff' : 'Produced a diff'}
                detail={run.hasDiff === false
                  ? 'The session ended having changed nothing — not a wrong answer; no answer.'
                  : `${run.changedFileCount ?? 0} file${run.changedFileCount === 1 ? '' : 's'}${run.work?.linesAdded != null ? ` · +${run.work.linesAdded} −${run.work.linesRemoved ?? 0} lines` : ''}${run.work ? ` · ${run.work.turns} turns, ${run.work.toolCalls} tool calls` : ''}`}
              >
                {run.changedPaths && run.changedPaths.length > 0 && (
                  <div className="flex flex-wrap gap-1.5 mt-1.5">
                    {run.changedPaths.slice(0, 12).map((p) => (
                      <span
                        key={p}
                        title={p}
                        className={`font-mono text-[10.5px] px-2 py-0.5 rounded border ${
                          isHeldOut(p)
                            ? 'text-rose-700 bg-rose-50 border-rose-300 dark:text-rose-300 dark:bg-rose-500/10 dark:border-rose-500/40'
                            : 'text-gray-600 bg-gray-50 border-gray-200 dark:text-gray-300 dark:bg-white/5 dark:border-white/10'
                        }`}
                      >
                        {p.split('/').pop()}
                      </span>
                    ))}
                  </div>
                )}
              </Step>
              <Step
                state={run.hasDiff === false ? 'na' : run.validation?.passed ? 'ok' : run.validation ? 'fail' : 'na'}
                title={run.hasDiff === false
                  ? 'Check not reached'
                  : run.validation?.passed
                    ? 'Held-out check passed'
                    : run.validation
                      ? (run.tampered ? 'Held-out check failed — and was edited' : 'Held-out check failed')
                      : 'No check configured'}
                detail={run.hasDiff === false
                  ? 'Skipped — an empty diff cannot solve, whatever the check would say.'
                  : run.validation
                    ? `exit ${run.validation.exitCode ?? '—'}${run.validation.timedOut ? ' · timed out' : ''}${
                        run.tampered ? ` · restored from ${baseCommit.slice(0, 8)} before running, so the edit bought nothing — recorded in tamperRate` : ''
                      }`
                    : 'This suite scores telemetry and friction only.'}
              >
                {run.validation?.outputTail && !run.validation.passed && (
                  <pre className="mt-2 px-3 py-2.5 rounded border-l-[3px] border-rose-500 bg-rose-50 dark:bg-rose-500/10 text-[11px] leading-relaxed overflow-x-auto font-mono text-gray-800 dark:text-gray-200 max-h-64">
                    {firstFailure(run.validation.outputTail)}
                  </pre>
                )}
              </Step>
            </>
          )}
        </div>

        {run.friction && <FrictionList friction={run.friction} />}
      </div>
    </details>
  );
}

function Step({ state, title, detail, children }: { state: 'ok' | 'fail' | 'na'; title: string; detail?: string; children?: React.ReactNode }) {
  return (
    <div className={`flex gap-3 items-start px-3.5 py-3 border-b last:border-b-0 border-gray-200 dark:border-white/10 ${state === 'fail' ? 'bg-rose-50/60 dark:bg-rose-500/[0.06]' : ''}`}>
      <span className={`flex-none w-[17px] h-[17px] rounded-full grid place-items-center mt-0.5 ${
        state === 'ok' ? 'bg-emerald-500' : state === 'fail' ? 'bg-rose-500' : 'bg-gray-300 dark:bg-white/20'
      }`}>
        {state === 'ok' ? <Check className="w-2.5 h-2.5 text-white" strokeWidth={3.5} />
          : state === 'fail' ? <X className="w-2.5 h-2.5 text-white" strokeWidth={3.5} />
          : <Minus className="w-2.5 h-2.5 text-white" strokeWidth={3.5} />}
      </span>
      <div className="min-w-0 flex-1">
        <div className="text-[12.5px] font-semibold text-gray-900 dark:text-gray-100">{title}</div>
        {detail && <div className="text-[12px] text-gray-500 dark:text-gray-400 mt-0.5">{detail}</div>}
        {children}
      </div>
    </div>
  );
}

function FrictionList({ friction }: { friction: NonNullable<BenchmarkRunRow['friction']> }) {
  const rows: { label: string; signal: { count: number; evidence: { locator: string; detail?: string }[] }; byDesign?: boolean }[] = [
    { label: 'EventHorizon tool failures', signal: friction.ehToolFailures },
    { label: 'Repeated identical calls', signal: friction.repeatCalls },
    { label: 'Re-reads', signal: friction.reReads },
    { label: 'Unexpected refusals', signal: friction.refusedUnexpected },
    { label: 'Denied tool attempts', signal: friction.deniedToolAttempts },
    { label: 'Protocol violations', signal: friction.protocolViolations },
    { label: 'Human interrupts', signal: friction.humanInterrupts },
    { label: 'Session restarts', signal: friction.sessionRestarts },
    { label: 'Refused by design', signal: friction.refusedByDesign, byDesign: true },
  ].filter((r) => r.signal?.count > 0);

  if (rows.length === 0) {
    return <div className="text-[12px] text-gray-400 dark:text-gray-500">No friction recorded.</div>;
  }

  return (
    <div>
      <div className="text-[10px] uppercase tracking-wider text-gray-400 dark:text-gray-500 mb-1.5">Friction</div>
      <div className="flex flex-col">
        {rows.map((r) => (
          <div key={r.label} className="flex gap-3 items-baseline py-1.5 border-b last:border-b-0 border-gray-200 dark:border-white/10 text-[12px]">
            <span className="font-mono text-amber-600 dark:text-amber-400 text-[11px] whitespace-nowrap w-24 shrink-0">
              {r.signal.evidence[0]?.locator ?? '—'}
            </span>
            <span className="text-gray-700 dark:text-gray-300">
              {r.label} <span className="font-mono tabular-nums">×{r.signal.count}</span>
              {r.byDesign && <span className="text-gray-400 dark:text-gray-500"> — not counted against the grade</span>}
            </span>
            {r.signal.evidence[0]?.detail && (
              <span className="ml-auto text-gray-400 dark:text-gray-500 truncate max-w-[46%]" title={r.signal.evidence[0].detail}>
                {r.signal.evidence[0].detail}
              </span>
            )}
          </div>
        ))}
      </div>
      {friction.orientationCost != null && (
        <div className="text-[11px] text-gray-400 dark:text-gray-500 mt-2">
          Orientation cost: <span className="font-mono">{pct(friction.orientationCost)}</span> of input tokens were EventHorizon-injected context.
        </div>
      )}
    </div>
  );
}
