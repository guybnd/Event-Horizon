import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  GitCompare, RefreshCw, FolderGit2, GitBranch, History, AlertTriangle,
  ChevronDown, ChevronRight, Loader2,
} from 'lucide-react';
import {
  fetchDiffOverview, fetchDiffFile, fetchTaskDiff,
  type DiffOverview, type DiffGroup, type DiffChangedFile,
} from '../../api';
import { useAppActions, useAppSelector } from '../../store/useAppSelector';
import { getTaskActivityTimestamp } from '../../taskSearch';
import { DiffLines } from '../DiffLines';
import type { Task } from '../../types';

const POLL_MS = 6000;
const DONE_LIMIT = 15;
const DONE_STATUSES = new Set(['Done', 'Released', 'Archived']);

type FileStatus = DiffChangedFile['status'];

interface FileRow {
  file: string;
  additions: number;
  deletions: number;
  status: FileStatus | null;
  collidesWith?: string[];
}

type FetchSource = { kind: 'live'; ref: string } | { kind: 'done'; ticketId: string };

interface Section {
  key: string;
  kind: 'worktree' | 'main' | 'done';
  /** Primary label — the ticket title (falls back to branch/path). */
  label: string;
  /** Ticket id, shown appended to the label (and in its tooltip). */
  idLabel?: string;
  status?: string;
  files: FileRow[];
  source: FetchSource;
}

interface Selection { sectionKey: string; path: string; label: string; source: FetchSource }

function groupRef(g: DiffGroup): string {
  return g.kind === 'main' ? 'main' : (g.branch ?? g.path);
}

const STATUS_BADGE: Record<FileStatus, { letter: string; cls: string; title: string }> = {
  added: { letter: 'A', cls: 'text-emerald-600 dark:text-emerald-400', title: 'added' },
  modified: { letter: 'M', cls: 'text-amber-600 dark:text-amber-400', title: 'modified' },
  deleted: { letter: 'D', cls: 'text-red-600 dark:text-red-400', title: 'deleted' },
  renamed: { letter: 'R', cls: 'text-sky-600 dark:text-sky-400', title: 'renamed' },
  untracked: { letter: 'U', cls: 'text-gray-400', title: 'untracked (new, unstaged)' },
};

export function ChangesScreen() {
  const { setChangesFocus } = useAppActions();
  const tasks = useAppSelector(s => s.tasks);
  const changesFocus = useAppSelector(s => s.changesFocus);
  const [overview, setOverview] = useState<DiffOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [focus, setFocus] = useState<string>('all');
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [pathFilter, setPathFilter] = useState('');
  const [excludeDone, setExcludeDone] = useState(false);
  const [selected, setSelected] = useState<Selection | null>(null);
  const [fileDiff, setFileDiff] = useState<string | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);

  // Monotonic load counter — drop any poll response superseded by a newer load
  // (out-of-order responses would otherwise clobber fresher data).
  const loadSeq = useRef(0);
  const load = useCallback(async () => {
    const seq = ++loadSeq.current;
    setRefreshing(true);
    try {
      const data = await fetchDiffOverview();
      if (seq !== loadSeq.current) return;
      setOverview(data);
      setError(null);
    } catch (err) {
      if (seq !== loadSeq.current) return;
      setError(err instanceof Error ? err.message : 'Failed to load changes');
    } finally {
      if (seq === loadSeq.current) setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void load();
    const id = window.setInterval(() => void load(), POLL_MS);
    return () => window.clearInterval(id);
  }, [load]);

  // Map worktree branch → owning ticket (for status + labels).
  const taskByBranch = useMemo(() => {
    const m = new Map<string, Task>();
    for (const t of tasks) if (t.branch) m.set(t.branch, t);
    return m;
  }, [tasks]);

  // Build a unified section list: live worktree/main groups + recent Done tickets.
  const sections = useMemo<Section[]>(() => {
    const out: Section[] = [];
    const liveBranches = new Set<string>();
    for (const g of overview?.groups ?? []) {
      const key = groupRef(g);
      // The fetch ref MUST be a git ref ('main' or a branch) — never the worktree path.
      const fetchRef = g.kind === 'main' ? 'main' : (g.branch ?? '');
      if (g.kind === 'worktree' && g.branch) liveBranches.add(g.branch);
      const ticket = g.kind === 'worktree' && g.branch ? taskByBranch.get(g.branch) : undefined;
      out.push({
        key,
        kind: g.kind,
        // Show the ticket name; the id is appended via idLabel.
        label: g.kind === 'main'
          ? 'Main tree (uncommitted)'
          : (g.ticketTitle ?? ticket?.title ?? g.branch ?? g.path),
        ...(g.kind === 'worktree' && g.ticketId ? { idLabel: g.ticketId } : {}),
        status: ticket?.status,
        files: g.files.map((f) => ({
          file: f.file, additions: f.additions, deletions: f.deletions, status: f.status,
          ...(f.collidesWith ? { collidesWith: f.collidesWith } : {}),
        })),
        source: { kind: 'live', ref: fetchRef },
      });
    }
    // Recently merged (Done) tickets with a stored committed diff — post-hoc review.
    const done = tasks
      .filter((t) => DONE_STATUSES.has(t.status) && (t.diffSummary?.length ?? 0) > 0)
      .filter((t) => !(t.branch && liveBranches.has(t.branch))) // not still live in a worktree
      .sort((a, b) => getTaskActivityTimestamp(b) - getTaskActivityTimestamp(a))
      .slice(0, DONE_LIMIT);
    // Always include a directly-focused merged ticket (e.g. a card "Diffs"
    // click-through), even if it's older than the recent-merged cutoff.
    const focusKey = changesFocus ?? focus;
    const focusedDoneId = focusKey.startsWith('done:') ? focusKey.slice('done:'.length) : null;
    if (focusedDoneId && !done.some((t) => t.id === focusedDoneId)) {
      const extra = tasks.find((t) => t.id === focusedDoneId
        && DONE_STATUSES.has(t.status)
        && (t.diffSummary?.length ?? 0) > 0
        && !(t.branch && liveBranches.has(t.branch)));
      if (extra) done.push(extra);
    }
    for (const t of done) {
      out.push({
        key: `done:${t.id}`,
        kind: 'done',
        label: t.title || t.id,
        idLabel: t.id,
        status: t.status,
        files: (t.diffSummary ?? []).map((f) => ({
          file: f.file, additions: f.additions, deletions: f.deletions, status: null,
        })),
        source: { kind: 'done', ticketId: t.id },
      });
    }
    return out;
  }, [overview, tasks, taskByBranch, changesFocus, focus]);

  // Consume a board click-through focus once the matching section actually exists
  // (a poll could remove it before this runs — don't strand focus on a dead key).
  useEffect(() => {
    if (changesFocus && sections.some((s) => s.key === changesFocus)) {
      setFocus(changesFocus);
      setChangesFocus(null);
    }
  }, [changesFocus, setChangesFocus, sections]);

  // Drop a selection whose section was evicted on refresh (stale diff/highlight).
  useEffect(() => {
    if (selected && !sections.some((s) => s.key === selected.sectionKey)) setSelected(null);
  }, [sections, selected]);

  // Load the selected file's diff (live → /api/diffs/file; done → committed sidecar).
  useEffect(() => {
    if (!selected) { setFileDiff(null); setFileError(null); return undefined; }
    let cancelled = false;
    setFileDiff(null);
    setFileError(null);
    const p = selected.source.kind === 'live'
      ? fetchDiffFile(selected.source.ref, selected.path)
      : fetchTaskDiff(selected.source.ticketId, selected.path);
    p.then((text) => { if (!cancelled) { if (text === null) setFileError('No diff to show for this file.'); else setFileDiff(text); } })
      .catch((err) => { if (!cancelled) setFileError(err instanceof Error ? err.message : 'Failed to load diff'); });
    return () => { cancelled = true; };
  }, [selected]);

  const collisionCount = overview?.collisions.length ?? 0;
  const availableStatuses = useMemo(
    () => [...new Set(sections.map((s) => s.status).filter((s): s is string => !!s))],
    [sections],
  );

  // Apply focus + exclude-done + status + path filters.
  const visibleSections = useMemo(() => {
    const q = pathFilter.trim().toLowerCase();
    return sections
      .filter((s) => focus === 'all' || s.key === focus)
      .filter((s) => !excludeDone || s.kind !== 'done')
      .filter((s) => statusFilter === 'all' || s.status === statusFilter)
      .map((s) => (q ? { ...s, files: s.files.filter((f) => f.file.toLowerCase().includes(q)) } : s))
      .filter((s) => !q || s.files.length > 0);
  }, [sections, focus, statusFilter, pathFilter, excludeDone]);

  // If active filters leave a focused section with nothing to show, fall back to
  // "all" rather than stranding the user on a silently-empty view.
  useEffect(() => {
    if (focus !== 'all' && overview !== null && visibleSections.length === 0) setFocus('all');
  }, [focus, overview, visibleSections]);

  const totalChanged = useMemo(() => sections.reduce((n, s) => n + s.files.length, 0), [sections]);

  const toggle = (key: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });

  // Done sections default collapsed (the `collapsed` set means "expanded" for them);
  // live sections default expanded ("collapsed" when in the set).
  const isCollapsed = (s: Section) => {
    if (s.files.length === 0) return true;
    const inSet = collapsed.has(s.key);
    return s.kind === 'done' ? !inSet : inSet;
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Header */}
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="flex h-8 w-8 items-center justify-center rounded-xl bg-gray-100 text-gray-500 dark:bg-white/5 dark:text-gray-300">
          <GitCompare className="h-4 w-4" />
        </div>
        <div className="min-w-0">
          <div className="text-sm font-semibold text-gray-900 dark:text-white">Changes</div>
          <div className="text-xs text-gray-500 dark:text-gray-400">
            {overview === null ? 'Loading…' : `${totalChanged} changed file${totalChanged === 1 ? '' : 's'} across ${sections.length} location${sections.length === 1 ? '' : 's'}`}
          </div>
        </div>

        {sections.length > 1 && (
          <select
            value={focus}
            onChange={(e) => setFocus(e.target.value)}
            className="ml-2 rounded-lg border border-gray-200 bg-white px-2 py-1.5 text-xs text-gray-600 outline-none dark:border-white/10 dark:bg-white/5 dark:text-gray-300"
          >
            <option value="all">All locations</option>
            {sections.map((s) => (
              <option key={s.key} value={s.key}>{s.label}{s.idLabel ? ` (${s.idLabel})` : ''} ({s.files.length})</option>
            ))}
          </select>
        )}
        {availableStatuses.length > 0 && (
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            className="rounded-lg border border-gray-200 bg-white px-2 py-1.5 text-xs text-gray-600 outline-none dark:border-white/10 dark:bg-white/5 dark:text-gray-300"
            title="Filter by ticket status"
          >
            <option value="all">Any status</option>
            {availableStatuses.map((s) => (<option key={s} value={s}>{s}</option>))}
          </select>
        )}
        <input
          value={pathFilter}
          onChange={(e) => setPathFilter(e.target.value)}
          placeholder="Filter by path…"
          className="w-40 rounded-lg border border-gray-200 bg-white px-2 py-1.5 text-xs text-gray-600 outline-none placeholder:text-gray-400 dark:border-white/10 dark:bg-white/5 dark:text-gray-300"
        />
        <button
          onClick={() => setExcludeDone((v) => !v)}
          title={excludeDone ? 'Showing recently merged (Done) tickets' : 'Hiding recently merged (Done) tickets'}
          className={`rounded-lg border px-2.5 py-1.5 text-xs font-medium transition-colors ${
            excludeDone
              ? 'border-primary/40 bg-primary/10 text-primary'
              : 'border-gray-200 bg-white text-gray-600 hover:bg-gray-100 dark:border-white/10 dark:bg-white/5 dark:text-gray-300 dark:hover:bg-white/10'
          }`}
        >
          {excludeDone ? 'Merged hidden' : 'Exclude done'}
        </button>

        <div className="flex-1" />

        {collisionCount > 0 && (
          <span
            className="inline-flex items-center gap-1.5 rounded-lg border border-amber-300/60 bg-amber-50 px-2.5 py-1.5 text-xs font-medium text-amber-700 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-400"
            title="Files changed in more than one worktree (or also loose on the main tree) — potential merge collisions"
          >
            <AlertTriangle className="h-3.5 w-3.5" />
            {collisionCount} collision{collisionCount === 1 ? '' : 's'}
          </span>
        )}
        <button
          onClick={() => void load()}
          disabled={refreshing}
          className="inline-flex items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-xs font-medium text-gray-600 transition-colors hover:bg-gray-100 disabled:opacity-60 dark:border-white/10 dark:bg-white/5 dark:text-gray-300 dark:hover:bg-white/10"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${refreshing ? 'animate-spin' : ''}`} />
          Refresh
        </button>
      </div>

      {error && (
        <div className="mb-3 rounded-lg border border-red-300/50 bg-red-50 px-3 py-2 text-xs text-red-600 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-400">
          {error}
        </div>
      )}

      {/* Two-pane body */}
      <div className="flex min-h-0 flex-1 gap-4">
        {/* Left: sections + files */}
        <div className="w-[360px] shrink-0 overflow-y-auto rounded-2xl border border-gray-200 bg-white/70 p-2 dark:border-white/10 dark:bg-[#181922]/70">
          {overview !== null && visibleSections.length === 0 && (
            <p className="px-3 py-6 text-center text-xs text-gray-400">No changes match the current filters.</p>
          )}
          {visibleSections.map((s) => {
            const sectionCollapsed = isCollapsed(s);
            return (
              <div key={s.key} className="mb-1.5">
                <button
                  onClick={() => s.files.length > 0 && toggle(s.key)}
                  className={`flex w-full items-center gap-1.5 rounded-lg px-2 py-1.5 text-left text-xs font-semibold ${s.files.length > 0 ? 'text-gray-700 hover:bg-gray-100 dark:text-gray-200 dark:hover:bg-white/5' : 'text-gray-400'}`}
                >
                  {s.files.length > 0
                    ? (sectionCollapsed ? <ChevronRight className="h-3.5 w-3.5 flex-none" /> : <ChevronDown className="h-3.5 w-3.5 flex-none" />)
                    : <span className="w-3.5 flex-none" />}
                  {s.kind === 'main' ? <GitBranch className="h-3.5 w-3.5 flex-none text-gray-400" />
                    : s.kind === 'done' ? <History className="h-3.5 w-3.5 flex-none text-gray-400" />
                    : <FolderGit2 className="h-3.5 w-3.5 flex-none text-primary" />}
                  <span className="min-w-0 truncate" title={s.idLabel ? `${s.label} (${s.idLabel})` : s.label}>{s.label}</span>
                  {s.idLabel && (
                    <span className="flex-none font-mono text-[9px] font-normal text-gray-400">{s.idLabel}</span>
                  )}
                  <span className="flex-1" />
                  {s.status && s.kind !== 'main' && (
                    <span className="flex-none rounded px-1 text-[9px] font-medium text-gray-400">{s.status}</span>
                  )}
                  <span className="flex-none rounded-full bg-gray-100 px-1.5 text-[10px] font-medium text-gray-500 dark:bg-white/10 dark:text-gray-400">{s.files.length}</span>
                </button>
                {!sectionCollapsed && s.files.map((f) => {
                  const isSel = selected?.sectionKey === s.key && selected?.path === f.file;
                  const badge = f.status ? STATUS_BADGE[f.status] : null;
                  return (
                    <button
                      key={f.file}
                      onClick={() => setSelected({ sectionKey: s.key, path: f.file, label: s.label, source: s.source })}
                      className={`flex w-full items-center gap-2 rounded-md py-1 pl-8 pr-2 text-left text-[11px] transition-colors ${isSel ? 'bg-primary/10 text-primary' : 'text-gray-600 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-white/5'}`}
                    >
                      {badge
                        ? <span className={`flex-none font-mono font-bold ${badge.cls}`} title={badge.title}>{badge.letter}</span>
                        : <span className="w-[1ch] flex-none" />}
                      <span className="min-w-0 flex-1 truncate font-mono" title={f.file}>{f.file}</span>
                      {f.collidesWith && f.collidesWith.length > 0 && (
                        <span className="flex-none" title={`Also changed in: ${f.collidesWith.join(', ')}`}>
                          <AlertTriangle className="h-3 w-3 text-amber-500" />
                        </span>
                      )}
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
            );
          })}
        </div>

        {/* Right: selected file diff */}
        <div className="flex min-w-0 flex-1 flex-col overflow-hidden rounded-2xl border border-gray-200 bg-white/70 dark:border-white/10 dark:bg-[#181922]/70">
          {!selected ? (
            <div className="flex flex-1 items-center justify-center text-xs text-gray-400">Select a file to view its diff.</div>
          ) : (
            <>
              <div className="flex items-center gap-2 border-b border-gray-200 px-4 py-2.5 dark:border-white/10">
                <span className="flex-none rounded bg-primary/10 px-1.5 py-0.5 text-[10px] font-semibold text-primary">{selected.label}</span>
                <span className="min-w-0 truncate font-mono text-xs text-gray-700 dark:text-gray-200" title={selected.path}>{selected.path}</span>
              </div>
              <div className="flex-1 overflow-auto px-4 py-3">
                {fileError && <p className="text-xs text-red-500">{fileError}</p>}
                {!fileError && fileDiff === null && (
                  <p className="flex items-center gap-2 text-xs text-gray-400"><Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading diff…</p>
                )}
                {!fileError && fileDiff !== null && <DiffLines content={fileDiff} />}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
