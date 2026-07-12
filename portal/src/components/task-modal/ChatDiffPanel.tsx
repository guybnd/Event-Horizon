import { useCallback, useEffect, useRef, useState } from 'react';
import { ChevronDown, ChevronRight, GitCompare, Loader2, RefreshCw, Undo2 } from 'lucide-react';
import { discardFiles, fetchBranchDiff, fetchDiffFile, type BranchDiffSummary, type DiffChangedFile } from '../../api';
import { useAppActions } from '../../store/useAppSelector';
import { ConfirmDiscardDialog } from '../ConfirmDiscardDialog';
import { DiffLines } from '../DiffLines';
import type { Task } from '../../types';

/** Per-file status marker (mirrors the cross-worktree Changes screen, FLUX-530). */
const STATUS_BADGE: Record<DiffChangedFile['status'], { letter: string; cls: string; title: string }> = {
  added: { letter: 'A', cls: 'text-emerald-600 dark:text-emerald-400', title: 'added' },
  modified: { letter: 'M', cls: 'text-amber-600 dark:text-amber-400', title: 'modified' },
  deleted: { letter: 'D', cls: 'text-red-600 dark:text-red-400', title: 'deleted' },
  renamed: { letter: 'R', cls: 'text-sky-600 dark:text-sky-400', title: 'renamed' },
  untracked: { letter: 'U', cls: 'text-gray-400', title: 'untracked (new, unstaged)' },
};

/** Coalesce a burst of SSE events into one refetch — `progress` fires often mid-turn. */
const LIVE_REFRESH_DEBOUNCE_MS = 700;

/**
 * FLUX-615 / FLUX-660: collapsible, LIVE branch/PR diff panel for the chat window.
 * Review happens inline (no jumping to VS Code): expand the panel to load the ticket
 * branch's changed-file summary vs the merge-base, then expand any file for its
 * syntax-highlighted hunks.
 *
 * "Live": while the panel is open it subscribes to the same per-task SSE stream the
 * chat uses (`activity`/`progress`/`taskUpdated`) and debounce-refetches the summary,
 * so the diff tracks the agent's edits as it works. When a session goes active the
 * panel auto-opens so the live picture is visible without a click.
 *
 * Renders nothing unless the ticket has a branch (AC: show only when there's a
 * branch/PR). The summary fetch is deferred until the panel is opened, so a closed,
 * idle panel costs nothing.
 *
 * Note (FLUX-660): the original FLUX-615 implementation got stuck on a permanent
 * "Loading diff…" spinner — the load effect kept `loading` in its dep array AND
 * returned a `cancelled = true` cleanup, so `setLoading(true)` re-ran the effect,
 * fired the cleanup, and cancelled the in-flight fetch before it resolved. This
 * version guards stale results with a request-id ref instead, which also makes the
 * overlapping live refetches safe.
 */
export function ChatDiffPanel({ task }: { task: Task }) {
  const { subscribeToEvent } = useAppActions();
  const [open, setOpen] = useState(false);
  const [summary, setSummary] = useState<BranchDiffSummary | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Per-file expansion: which files are open (each row lazily fetches its own hunk).
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const working = task.cliSession?.status === 'running';
  // FLUX-1333: an actively-executing session gates the Discard controls (the endpoint also
  // refuses 409 server-side) — a parked 'waiting-input' chat doesn't block a discard.
  const sessionActive = task.cliSession?.status === 'running' || task.cliSession?.status === 'pending';
  const [confirmDiscard, setConfirmDiscard] = useState<DiffChangedFile | null>(null);
  const [discarding, setDiscarding] = useState(false);

  // Only the latest request may write state — guards both the initial load and the
  // overlapping live refetches (and replaces the buggy cancel-on-rerender cleanup).
  const reqIdRef = useRef(0);
  const load = useCallback(() => {
    const reqId = ++reqIdRef.current;
    setLoading(true);
    setError(null);
    fetchBranchDiff(task.id)
      .then((s) => { if (reqIdRef.current === reqId) setSummary(s); })
      .catch((e) => { if (reqIdRef.current === reqId) setError(e?.message || 'Failed to load diff'); })
      .finally(() => { if (reqIdRef.current === reqId) setLoading(false); });
  }, [task.id]);

  // Switching tickets → drop the stale summary and invalidate any in-flight fetch so
  // the panel reloads for the new ticket on next open.
  useEffect(() => {
    setSummary(null);
    setExpanded(new Set());
    setError(null);
    setLoading(false);
    setConfirmDiscard(null);
    reqIdRef.current++;
  }, [task.id]);

  // Execute a confirmed discard (FLUX-1333). The panel refreshes on SSE too, but never rely on
  // push after a mutation — reload explicitly. Failures surface in the panel's error line and
  // the file stays listed.
  const doDiscard = useCallback(async () => {
    if (!confirmDiscard || !task.branch) return;
    setDiscarding(true);
    const res = await discardFiles(task.branch, [confirmDiscard.file]);
    setDiscarding(false);
    setConfirmDiscard(null);
    const failure = res.error ?? (res.results ?? []).find((r) => !r.ok)?.error;
    if (failure) {
      setError(failure);
      return;
    }
    setError(null);
    load();
  }, [confirmDiscard, task.branch, load]);

  // Lazy-load on first open; a re-open keeps the cached summary (Refresh / live events re-pull).
  useEffect(() => {
    if (open && summary === null && !loading && !error) load();
  }, [open, summary, loading, error, load]);

  // Live refresh: while open, refetch the summary (debounced) whenever the engine
  // pushes an event for THIS ticket — the same stream the chat transcript listens to.
  useEffect(() => {
    if (!open) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const matches = (d: unknown): boolean => {
      const o = d as { taskId?: string; id?: string } | null;
      return !!o && (o.taskId === task.id || o.id === task.id);
    };
    const onEvent = (d: unknown) => {
      if (!matches(d)) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => load(), LIVE_REFRESH_DEBOUNCE_MS);
    };
    const unsubs = [
      subscribeToEvent('activity', onEvent),
      subscribeToEvent('progress', onEvent),
      subscribeToEvent('taskUpdated', onEvent),
    ];
    return () => { if (timer) clearTimeout(timer); unsubs.forEach((u) => u()); };
  }, [open, task.id, subscribeToEvent, load]);

  // No branch → nothing to review here.
  if (!task.branch) return null;

  const files = summary?.files ?? [];
  const totalAdd = files.reduce((a, f) => a + f.additions, 0);
  const totalDel = files.reduce((a, f) => a + f.deletions, 0);

  return (
    <div className="eh-border-subtle border-b text-[11px]">
      <div className="flex items-center gap-1.5 px-3.5 py-1.5">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="flex min-w-0 flex-1 items-center gap-1.5 text-[var(--eh-text-secondary)] transition-colors hover:text-[var(--eh-text-primary)]"
          aria-expanded={open}
        >
          {open ? <ChevronDown className="h-3.5 w-3.5 flex-shrink-0" /> : <ChevronRight className="h-3.5 w-3.5 flex-shrink-0" />}
          <GitCompare className="h-3 w-3 flex-shrink-0 text-[var(--eh-text-muted)]" />
          <span className="font-semibold uppercase tracking-wide">Diff</span>
          {working && (
            <span className="flex items-center gap-1 text-emerald-600 dark:text-emerald-400" title="Updating live as the agent works">
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-500" />
              <span className="font-semibold uppercase tracking-wide">live</span>
            </span>
          )}
          {summary && files.length > 0 && (
            <span className="flex items-center gap-1.5 text-[var(--eh-text-muted)]">
              <span>{files.length} file{files.length !== 1 ? 's' : ''}</span>
              <span className="text-emerald-600 dark:text-emerald-400">+{totalAdd}</span>
              <span className="text-red-500 dark:text-red-400">−{totalDel}</span>
            </span>
          )}
        </button>
        {open && (
          <button
            type="button"
            onClick={() => { setExpanded(new Set()); load(); }}
            title="Refresh diff"
            disabled={loading}
            className="flex-shrink-0 rounded p-0.5 text-[var(--eh-text-muted)] transition-colors hover:bg-black/5 hover:text-[var(--eh-text-primary)] disabled:opacity-40 dark:hover:bg-white/5"
          >
            <RefreshCw className={`h-3 w-3 ${loading ? 'animate-spin' : ''}`} />
          </button>
        )}
      </div>

      {open && (
        <div className="max-h-64 overflow-y-auto px-2 pb-2">
          {loading && summary === null && (
            <div className="flex items-center gap-1.5 px-1.5 py-2 text-[var(--eh-text-muted)]">
              <Loader2 className="h-3 w-3 animate-spin" /> Loading diff…
            </div>
          )}
          {error && <p className="px-1.5 py-2 text-red-500">{error}</p>}
          {summary && files.length === 0 && !error && (
            <p className="px-1.5 py-2 text-[var(--eh-text-muted)]">No changes on this branch yet.</p>
          )}
          {files.map((f) => (
            <FileRow
              key={f.file}
              branch={task.branch as string}
              file={f}
              expanded={expanded.has(f.file)}
              onToggle={() =>
                setExpanded((prev) => {
                  const next = new Set(prev);
                  if (next.has(f.file)) next.delete(f.file);
                  else next.add(f.file);
                  return next;
                })
              }
              discardable={f.uncommitted === true}
              discardDisabled={sessionActive}
              onDiscard={() => setConfirmDiscard(f)}
            />
          ))}
        </div>
      )}

      {confirmDiscard && (
        <ConfirmDiscardDialog
          files={[confirmDiscard.file]}
          scopeLabel={task.branch ?? undefined}
          busy={discarding}
          onCancel={() => setConfirmDiscard(null)}
          onConfirm={() => void doDiscard()}
        />
      )}
    </div>
  );
}

/** One changed file: a toggle row + the lazily-fetched, syntax-highlighted hunk when open.
 *  Files flagged `uncommitted` get a hover-revealed Discard control (FLUX-1333). */
function FileRow({
  branch,
  file,
  expanded,
  onToggle,
  discardable,
  discardDisabled,
  onDiscard,
}: {
  branch: string;
  file: DiffChangedFile;
  expanded: boolean;
  onToggle: () => void;
  discardable: boolean;
  discardDisabled: boolean;
  onDiscard: () => void;
}) {
  const [diff, setDiff] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const badge = STATUS_BADGE[file.status];
  const reqIdRef = useRef(0);

  // Live: when this file's +/- counts change (the summary refetched after an edit),
  // drop the cached hunk so an open row re-pulls its fresh diff.
  const countsKey = `${file.additions}/${file.deletions}/${file.status}`;
  const prevCountsRef = useRef(countsKey);
  useEffect(() => {
    if (prevCountsRef.current !== countsKey) {
      prevCountsRef.current = countsKey;
      reqIdRef.current++;
      setDiff(null);
      setError(null);
    }
  }, [countsKey]);

  useEffect(() => {
    if (!expanded || diff !== null || loading || error) return;
    const reqId = ++reqIdRef.current;
    setLoading(true);
    fetchDiffFile(branch, file.file)
      .then((text) => { if (reqIdRef.current === reqId) setDiff(text ?? '(no diff available)'); })
      .catch((e) => { if (reqIdRef.current === reqId) setError(e?.message || 'Failed to load file diff'); })
      .finally(() => { if (reqIdRef.current === reqId) setLoading(false); });
  }, [expanded, diff, loading, error, branch, file.file]);

  return (
    <div>
      <div className="group/filerow flex items-center">
        <button
          type="button"
          onClick={onToggle}
          className="flex min-w-0 flex-1 items-center gap-1.5 rounded px-1.5 py-1 text-left transition-colors hover:bg-black/5 dark:hover:bg-white/5"
        >
          {expanded ? <ChevronDown className="h-3 w-3 flex-shrink-0 text-[var(--eh-text-muted)]" /> : <ChevronRight className="h-3 w-3 flex-shrink-0 text-[var(--eh-text-muted)]" />}
          <span className={`flex-shrink-0 font-mono font-semibold ${badge.cls}`} title={badge.title}>{badge.letter}</span>
          <span className="min-w-0 flex-1 truncate font-mono text-[var(--eh-text-secondary)]" title={file.file}>{file.file}</span>
          <span className="flex-shrink-0 text-[10px]">
            <span className="text-emerald-600 dark:text-emerald-400">+{file.additions}</span>{' '}
            <span className="text-red-500 dark:text-red-400">−{file.deletions}</span>
          </span>
        </button>
        {discardable && (
          <button
            type="button"
            onClick={onDiscard}
            disabled={discardDisabled}
            title={discardDisabled
              ? 'Agent session is active — wait for it to finish before discarding'
              : 'Discard this file’s uncommitted changes (restore to last commit)'}
            className={`flex-shrink-0 rounded p-1 transition-opacity ${discardDisabled
              ? 'cursor-not-allowed text-[var(--eh-text-muted)] opacity-0 group-hover/filerow:opacity-50'
              : 'text-[var(--eh-text-muted)] opacity-0 hover:bg-red-500/10 hover:text-red-500 group-hover/filerow:opacity-100'}`}
          >
            <Undo2 className="h-3 w-3" />
          </button>
        )}
      </div>
      {expanded && (
        <div className="mb-1 ml-2 overflow-x-auto rounded border border-[var(--eh-border)] bg-black/[0.02] py-1 dark:bg-white/[0.02]">
          {loading && <p className="px-2 py-1 text-[var(--eh-text-muted)]">Loading…</p>}
          {error && <p className="px-2 py-1 text-red-500">{error}</p>}
          {!loading && !error && diff !== null && <DiffLines content={diff} />}
        </div>
      )}
    </div>
  );
}
