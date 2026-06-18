import { useState } from 'react';
import { planDocsPromotion, applyDocsPromotion, type PromotionCandidate, type DocsPromotionResult } from '../api';

interface Row extends PromotionCandidate {
  selected: boolean;
}

/**
 * Promote existing `.docs/` files into the group store (FLUX-404). Plan → preview
 * (per-file opt-in with an editable target) → apply, with **move semantics**: a
 * promoted doc is removed from the repo main branch and becomes single-source-of-
 * truth in the shared knowledge base — no longer visible by browsing main.
 *
 * Parent-only: the engine rejects this from a member workspace.
 */
export function DocsPromotionPanel({ onPromoted }: { onPromoted?: () => void }) {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<DocsPromotionResult | null>(null);

  const loadPlan = async () => {
    setError(null);
    setResult(null);
    setLoading(true);
    try {
      const plan = await planDocsPromotion();
      setRows(plan.candidates.map((c) => ({ ...c, selected: false })));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to plan promotion');
    } finally {
      setLoading(false);
    }
  };

  const selected = rows?.filter((r) => r.selected) ?? [];

  const apply = async () => {
    if (selected.length === 0) return;
    setError(null);
    setApplying(true);
    try {
      const res = await applyDocsPromotion(selected.map(({ source, target }) => ({ source, target })));
      setResult(res);
      setRows(null);
      onPromoted?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to promote docs');
    } finally {
      setApplying(false);
    }
  };

  return (
    <div className="mt-4 rounded-xl border border-gray-200 bg-white/60 p-4 dark:border-white/10 dark:bg-black/20">
      <h4 className="text-sm font-semibold text-gray-800 dark:text-gray-200">Promote existing docs into the group store</h4>
      <p className="mt-1 text-xs text-gray-500">
        Move cross-project docs from this repo's <code className="font-mono bg-gray-100 dark:bg-white/10 px-1 rounded">.docs/</code> into the
        shared knowledge base. <strong>This is a move</strong> — a promoted doc is removed from the main branch and lives only in the group
        store afterward (no longer visible by plain GitHub/IDE browsing of main). Repo-local docs you don't select stay put.
      </p>

      {error && <p className="mt-2 text-xs text-red-600 dark:text-red-400">{error}</p>}

      {result && (
        <div className="mt-3 rounded-lg border border-green-300/60 bg-green-50 p-3 text-xs dark:border-green-500/30 dark:bg-green-900/20">
          <p className="font-semibold text-green-800 dark:text-green-300">
            Promoted {result.promoted.length} doc(s) · fanned out to {result.sync.pushed} member(s)
            {result.sync.failed > 0 ? `, ${result.sync.failed} failed` : ''}.
          </p>
          {result.failed.length > 0 && (
            <ul className="mt-1 space-y-0.5 text-red-600 dark:text-red-400">
              {result.failed.map((f) => (
                <li key={f.source} className="font-mono truncate">{f.source}: {f.error}</li>
              ))}
            </ul>
          )}
        </div>
      )}

      {rows === null ? (
        <button
          onClick={loadPlan}
          disabled={loading}
          className="mt-3 rounded-lg border border-primary/40 px-3.5 py-1.5 text-xs font-semibold text-primary hover:bg-primary/5 disabled:opacity-60"
        >
          {loading ? 'Scanning…' : 'Review .docs/ for promotion…'}
        </button>
      ) : rows.length === 0 ? (
        <p className="mt-3 text-xs text-gray-500">No files found under <code className="font-mono">.docs/</code>.</p>
      ) : (
        <div className="mt-3">
          <ul className="space-y-2">
            {rows.map((row, i) => (
              <li key={row.source} className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={row.selected}
                  onChange={(e) => setRows((rs) => rs!.map((r, j) => (j === i ? { ...r, selected: e.target.checked } : r)))}
                  className="h-4 w-4 shrink-0"
                />
                <span className="font-mono text-xs text-gray-700 dark:text-gray-300 truncate flex-1">{row.source}</span>
                <span className="text-gray-400">→</span>
                <input
                  type="text"
                  value={row.target}
                  onChange={(e) => setRows((rs) => rs!.map((r, j) => (j === i ? { ...r, target: e.target.value } : r)))}
                  className="font-mono text-xs w-44 rounded border border-gray-300 dark:border-white/15 bg-transparent px-2 py-1"
                />
              </li>
            ))}
          </ul>
          <div className="mt-3 flex items-center gap-3">
            <button
              onClick={apply}
              disabled={applying || selected.length === 0}
              className="rounded-lg bg-amber-600 px-3.5 py-1.5 text-xs font-semibold text-white hover:bg-amber-700 disabled:opacity-60"
            >
              {applying ? 'Promoting…' : `Promote ${selected.length} selected`}
            </button>
            <button
              onClick={() => setRows(null)}
              className="text-xs text-gray-500 hover:text-gray-700 dark:hover:text-gray-300"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
