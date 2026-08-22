import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, RefreshCw } from 'lucide-react';
import { fetchBranchDiff, fetchDiffFile, type BranchDiffSummary, type DiffChangedFile } from '../../api';
import { DiffLines } from '../DiffLines';
import { SkeletonLines } from '../ui/Skeleton';
import type { Task } from '../../types';

/**
 * FLUX-1670: a focused, read-only two-pane diff viewer for a PR ticket's branch — the "Changes"
 * tab in `TicketSideView`. Deliberately NOT an extraction of `ChangesScreen` (the cross-worktree
 * dashboard): no discard controls, no collision radar, no "recently Done" aggregation, and no
 * polling — this panel only renders while its tab is active inside an already-open ticket, so a
 * manual Refresh button is enough.
 *
 * `STATUS_BADGE` is intentionally duplicated (not imported) from `ChangesScreen.tsx` — that
 * module keeps it as an unexported local const, and this panel's badge needs are identical but
 * small enough that reaching into that file's internals (or exporting just for this one extra
 * consumer) isn't worth the coupling.
 */

type FileStatus = DiffChangedFile['status'];

const STATUS_BADGE: Record<FileStatus, { letter: string; cls: string; title: string }> = {
  added: { letter: 'A', cls: 'text-emerald-600 dark:text-emerald-400', title: 'added' },
  modified: { letter: 'M', cls: 'text-amber-600 dark:text-amber-400', title: 'modified' },
  deleted: { letter: 'D', cls: 'text-red-600 dark:text-red-400', title: 'deleted' },
  renamed: { letter: 'R', cls: 'text-sky-600 dark:text-sky-400', title: 'renamed' },
  untracked: { letter: 'U', cls: 'text-gray-400', title: 'untracked (new, unstaged)' },
};

export function BranchChangesPanel({ task }: { task: Task }) {
  const [summary, setSummary] = useState<BranchDiffSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [fileDiff, setFileDiff] = useState<string | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setRefreshing(true);
    try {
      const data = await fetchBranchDiff(task.id);
      setSummary(data);
      setError(null);
      // Auto-select the first file once loaded — no selection persistence, this is a lightweight
      // viewer, not the full Changes dashboard.
      setSelectedPath(data.files[0]?.file ?? null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load the branch diff');
    } finally {
      setRefreshing(false);
    }
  }, [task.id]);

  useEffect(() => {
    setSummary(null);
    setError(null);
    setSelectedPath(null);
    void load();
    // `load` is stable per `task.id` (useCallback dep) — re-running on `task.id` change is exactly
    // the mount-or-ticket-switch behavior wanted here.
  }, [load]);

  useEffect(() => {
    if (!selectedPath || !task.branch) { setFileDiff(null); setFileError(null); return undefined; }
    let cancelled = false;
    setFileDiff(null);
    setFileError(null);
    fetchDiffFile(task.branch, selectedPath)
      .then((text) => {
        if (cancelled) return;
        if (text === null) setFileError('No diff to show for this file.');
        else setFileDiff(text);
      })
      .catch((err) => {
        if (!cancelled) setFileError(err instanceof Error ? err.message : 'Failed to load diff');
      });
    return () => { cancelled = true; };
  }, [selectedPath, task.branch]);

  const files = summary?.files ?? [];

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Header */}
      <div className="mb-2 flex flex-shrink-0 flex-wrap items-center gap-2">
        <div className="min-w-0 flex-1 text-[11px] text-[var(--eh-text-muted)]">
          {summary === null && !error
            ? 'Loading…'
            : `${files.length} changed file${files.length === 1 ? '' : 's'}`}
          {summary && summary.worktree === null && (
            <span className="ml-2 text-amber-600 dark:text-amber-400">
              No live worktree — showing the branch's last committed state
            </span>
          )}
        </div>
        <button
          type="button"
          onClick={() => void load()}
          disabled={refreshing}
          className="inline-flex flex-none items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-2.5 py-1 text-[11px] font-medium text-gray-600 transition-colors hover:bg-gray-100 disabled:opacity-60 dark:border-white/10 dark:bg-white/5 dark:text-gray-300 dark:hover:bg-white/10"
        >
          <RefreshCw className={`h-3 w-3 ${refreshing ? 'animate-spin' : ''}`} />
          Refresh
        </button>
      </div>

      {error && (
        <div className="mb-2 flex flex-shrink-0 items-start gap-2 rounded-lg border border-red-300/50 bg-red-50 px-3 py-2 text-xs text-red-600 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-400">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 flex-none" />
          <span className="min-w-0 flex-1">{error}</span>
        </div>
      )}

      {/* Two-pane body */}
      <div className="flex min-h-0 flex-1 gap-3">
        {/* Left: file list */}
        <div className="w-[240px] shrink-0 overflow-y-auto rounded-2xl border border-gray-200 bg-white/70 p-2 dark:border-white/10 dark:bg-[#181922]/70">
          {summary !== null && files.length === 0 && (
            <p className="px-2 py-6 text-center text-xs text-gray-400">No changes on this branch.</p>
          )}
          {summary === null && !error && (
            <div className="p-2">
              <SkeletonLines count={5} />
            </div>
          )}
          {files.map((f) => {
            const isSel = selectedPath === f.file;
            const badge = f.status ? STATUS_BADGE[f.status] : null;
            return (
              <button
                key={f.file}
                type="button"
                onClick={() => setSelectedPath(f.file)}
                className={`flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1 text-left text-[11px] transition-colors ${isSel ? 'bg-primary/10 text-primary' : 'text-gray-600 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-white/5'}`}
              >
                {badge
                  ? <span className={`flex-none font-mono font-bold ${badge.cls}`} title={badge.title}>{badge.letter}</span>
                  : <span className="w-[1ch] flex-none" />}
                <span className="min-w-0 flex-1 truncate font-mono" title={f.file}>{f.file}</span>
                {f.status !== 'untracked' && (
                  <span className="flex-none font-mono text-[10px] tabular-nums text-gray-400">
                    <span className="text-emerald-500">+{f.additions}</span>{' '}
                    <span className="text-red-500">−{f.deletions}</span>
                  </span>
                )}
              </button>
            );
          })}
        </div>

        {/* Right: selected file diff */}
        <div className="flex min-w-0 flex-1 flex-col overflow-hidden rounded-2xl border border-gray-200 bg-white/70 dark:border-white/10 dark:bg-[#181922]/70">
          {!selectedPath ? (
            <div className="flex flex-1 items-center justify-center text-xs text-gray-400">
              {files.length === 0 ? 'No changes to show.' : 'Select a file to view its diff.'}
            </div>
          ) : (
            <>
              <div className="flex items-center gap-2 border-b border-gray-200 px-3 py-2 dark:border-white/10">
                <span className="min-w-0 truncate font-mono text-xs text-gray-700 dark:text-gray-200" title={selectedPath}>
                  {selectedPath}
                </span>
              </div>
              <div className="flex-1 overflow-auto px-3 py-2">
                {fileError && <p className="text-xs text-red-500">{fileError}</p>}
                {!fileError && fileDiff === null && <SkeletonLines count={8} />}
                {!fileError && fileDiff !== null && <DiffLines content={fileDiff} />}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
