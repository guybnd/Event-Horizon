import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ChevronDown, ChevronRight, Code2, ExternalLink, FileDiff, GitBranch, GitCommitHorizontal, Loader2 } from 'lucide-react';
import { useAppActions } from '../store/useAppSelector';
import { fetchUncommittedStatus, openWorkspaceEditor, fetchDiffOverview, fetchDiffFile, commitFiles, type DiffGroup } from '../api';
import { DiffLines } from './DiffLines';

const POLL_MS = 30000;

// Per-file change status → short letter badge (mirrors the Changes screen).
// GitHub-style status squares: colored badge + letter (A added, M modified,
// D deleted, R renamed, U untracked/new).
const STATUS_BADGE: Record<string, { letter: string; title: string; cls: string }> = {
  modified: { letter: 'M', title: 'Modified', cls: 'bg-amber-100 text-amber-700 dark:bg-amber-500/20 dark:text-amber-300' },
  added: { letter: 'A', title: 'Added', cls: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-500/20 dark:text-emerald-300' },
  deleted: { letter: 'D', title: 'Deleted', cls: 'bg-red-100 text-red-700 dark:bg-red-500/20 dark:text-red-300' },
  renamed: { letter: 'R', title: 'Renamed', cls: 'bg-blue-100 text-blue-700 dark:bg-blue-500/20 dark:text-blue-300' },
  untracked: { letter: 'U', title: 'Untracked (new)', cls: 'bg-gray-100 text-gray-600 dark:bg-white/10 dark:text-gray-300' },
};

// Diff/Changes ref for a group: 'main' for the working tree, else the branch.
function groupRef(g: DiffGroup): string {
  return g.kind === 'main' ? 'main' : (g.branch ?? g.path);
}

/**
 * Board-header working-changes control (FLUX-535 + FLUX-544). The button is a
 * stoplight (green clean / yellow some / red many) driven by a cheap uncommitted
 * count aggregated across the main tree AND every active task worktree; clicking it
 * opens a dropdown that lazy-loads the full cross-worktree overview. Each group (main
 * tree + every active worktree) is collapsible, has a select-all, shows its branch and
 * files; a file row expands its diff inline, opens in VS Code, or jumps to the full
 * Changes view. Hidden when the count can't be determined.
 */
export function UncommittedChangesStoplight() {
  const { setView, setChangesFocus } = useAppActions();
  const [count, setCount] = useState<number | null>(null);
  const [diverged, setDiverged] = useState<number>(0); // secondary "vs master" divergence count (FLUX-582)
  const [branch, setBranch] = useState<string | null>(null); // main-tree branch (for the badge + main group)
  const [editorMsg, setEditorMsg] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [groups, setGroups] = useState<DiffGroup[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null); // `${ref}::${file}`
  const [diffs, setDiffs] = useState<Record<string, string | null | 'loading'>>({});
  const [selected, setSelected] = useState<Set<string>>(new Set()); // `${ref}::${file}` picked for commit
  const [commitMsgs, setCommitMsgs] = useState<Record<string, string>>({}); // per-group commit message
  const [committing, setCommitting] = useState<string | null>(null); // ref currently committing
  const [commitErr, setCommitErr] = useState<Record<string, string>>({});
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set()); // refs of collapsed sections
  const [alignRight, setAlignRight] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const timerRef = useRef<number | null>(null);

  // Cheap count poll drives the always-visible badge (main tree only).
  useEffect(() => {
    let cancelled = false;
    const load = () => {
      fetchUncommittedStatus()
        .then((s) => { if (!cancelled) { setCount(s.count); setBranch(s.branch); setDiverged(s.diverged); } })
        .catch(() => { if (!cancelled) setCount(null); });
    };
    load();
    timerRef.current = window.setInterval(load, POLL_MS);
    return () => { cancelled = true; if (timerRef.current) clearInterval(timerRef.current); };
  }, []);

  // Full cross-worktree overview is fetched only when the panel opens.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    setLoadError(false);
    setExpanded(null);
    setDiffs({});
    setEditorMsg(null);
    setSelected(new Set());
    setCommitMsgs({});
    setCommitErr({});
    setCollapsed(new Set());
    fetchDiffOverview(true)
      .then((ov) => { if (!cancelled) setGroups(ov.groups); })
      .catch(() => { if (!cancelled) setLoadError(true); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [open]);

  // Outside-click + Escape close the panel.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  // Keep the panel inside the viewport: right-anchor when a left-anchored panel
  // would spill off the right edge.
  useLayoutEffect(() => {
    if (!open || !containerRef.current) return;
    const PANEL_W = 460;
    const rect = containerRef.current.getBoundingClientRect();
    setAlignRight(rect.left + PANEL_W > window.innerWidth - 8);
  }, [open]);

  const openChangesView = useCallback((ref: string) => {
    setChangesFocus(ref);
    setView('changes');
    setOpen(false);
  }, [setChangesFocus, setView]);

  const openInEditor = useCallback((file?: string, ref?: string) => {
    setEditorMsg(null);
    openWorkspaceEditor(file, ref).then((ok) => { if (!ok) setEditorMsg('VS Code CLI (`code`) not on PATH'); });
  }, []);

  const toggleFile = useCallback((ref: string, file: string) => {
    const key = `${ref}::${file}`;
    setExpanded((cur) => (cur === key ? null : key));
    if (diffs[key] === undefined) {
      setDiffs((d) => ({ ...d, [key]: 'loading' }));
      fetchDiffFile(ref, file)
        .then((text) => setDiffs((d) => ({ ...d, [key]: text })))
        .catch(() => setDiffs((d) => ({ ...d, [key]: null })));
    }
  }, [diffs]);

  const toggleSelect = useCallback((key: string) => {
    setSelected((cur) => {
      const next = new Set(cur);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  }, []);

  const toggleSelectGroup = useCallback((ref: string, groupFiles: string[]) => {
    setSelected((cur) => {
      const next = new Set(cur);
      const keys = groupFiles.map((f) => `${ref}::${f}`);
      const allSel = keys.every((k) => next.has(k));
      for (const k of keys) { if (allSel) next.delete(k); else next.add(k); }
      return next;
    });
  }, []);

  const toggleCollapse = useCallback((ref: string) => {
    setCollapsed((cur) => {
      const next = new Set(cur);
      if (next.has(ref)) next.delete(ref); else next.add(ref);
      return next;
    });
  }, []);

  const doCommit = useCallback(async (ref: string, groupFiles: string[]) => {
    const files = groupFiles.filter((f) => selected.has(`${ref}::${f}`));
    const message = (commitMsgs[ref] ?? '').trim();
    if (files.length === 0 || !message) return;
    setCommitting(ref);
    setCommitErr((e) => ({ ...e, [ref]: '' }));
    const result = await commitFiles(ref, files, message);
    setCommitting(null);
    if (result.error) { setCommitErr((e) => ({ ...e, [ref]: result.error! })); return; }
    setSelected((cur) => { const n = new Set(cur); for (const f of files) n.delete(`${ref}::${f}`); return n; });
    setCommitMsgs((m) => ({ ...m, [ref]: '' }));
    fetchDiffOverview(true).then((ov) => setGroups(ov.groups)).catch(() => {});
  }, [selected, commitMsgs]);

  // Unknown (not a repo / git error) — show nothing rather than a misleading 0.
  if (count === null) return null;

  const tone = count === 0 ? 'green' : count < 10 ? 'yellow' : 'red';
  const toneClasses = {
    green: 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-300',
    yellow: 'border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-300',
    red: 'border-red-200 bg-red-50 text-red-700 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-300',
  }[tone];
  const dotClasses = { green: 'bg-emerald-500', yellow: 'bg-amber-500', red: 'bg-red-500' }[tone];

  const nonEmpty = (groups ?? []).filter((g) => g.files.length > 0);

  return (
    <div ref={containerRef} className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        title={count === 0 ? 'Working tree clean' : `${count} uncommitted file${count === 1 ? '' : 's'}`}
        className={`group flex shrink-0 cursor-pointer items-center gap-1.5 rounded-xl border px-2.5 py-2 text-left transition-all duration-200 overflow-hidden ${toneClasses} ${open ? 'ring-2 ring-primary/30' : ''}`}
      >
        <div className="relative shrink-0">
          <FileDiff className="h-3.5 w-3.5" />
          <span className={`absolute -right-0.5 -top-0.5 h-1.5 w-1.5 rounded-full ${dotClasses}`} />
        </div>
        <span className="text-sm font-semibold leading-none">{count}</span>
        <span className="text-[10px] font-bold uppercase tracking-wider opacity-70">Uncommitted</span>
        {diverged > 0 && (
          <span
            className="ml-1 border-l border-current/20 pl-1.5 text-[10px] font-semibold leading-none opacity-70"
            title={`${diverged} file${diverged === 1 ? '' : 's'} diverged from master across worktrees (committed + uncommitted)`}
          >
            ↑{diverged} vs master
          </span>
        )}
        <ChevronDown className={`h-3 w-3 opacity-60 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>

      {open && (
        <div className={`absolute top-full z-[100] mt-2 w-[460px] max-w-[calc(100vw-2rem)] overflow-hidden rounded-2xl border border-gray-200 bg-white/95 shadow-2xl backdrop-blur-xl dark:border-white/10 dark:bg-[#1a1b23]/95 ${alignRight ? 'right-0' : 'left-0'}`}>
          <div className="flex items-center justify-between gap-2 border-b border-gray-100 px-3 py-2 dark:border-white/10">
            <span className="text-xs font-bold uppercase tracking-wider text-gray-500 dark:text-gray-400">Working changes</span>
            <div className="flex flex-none items-center gap-1">
              <button
                onClick={() => openInEditor()}
                title="Open workspace in VS Code"
                className="flex items-center gap-1 rounded-md px-1.5 py-1 text-[11px] font-medium text-gray-500 hover:bg-gray-100 hover:text-primary dark:text-gray-400 dark:hover:bg-white/10"
              >
                <Code2 className="h-3 w-3" /> VS Code
              </button>
              <button
                onClick={() => openChangesView('main')}
                className="flex items-center gap-1 rounded-md px-1.5 py-1 text-[11px] font-medium text-primary hover:bg-primary/10"
              >
                <ExternalLink className="h-3 w-3" /> Changes
              </button>
            </div>
          </div>
          {editorMsg && (
            <div className="border-b border-gray-100 px-3 py-1.5 text-[11px] text-amber-600 dark:border-white/10 dark:text-amber-400">{editorMsg}</div>
          )}

          <div className="max-h-[60vh] overflow-y-auto py-1">
            {loading && (
              <div className="flex items-center gap-2 px-3 py-4 text-xs text-gray-400">
                <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading changes…
              </div>
            )}
            {!loading && loadError && (
              <div className="px-3 py-4 text-xs text-red-500">Couldn't load changes.</div>
            )}
            {!loading && !loadError && nonEmpty.length === 0 && (
              <div className="px-3 py-4 text-xs text-gray-400">Working tree clean — nothing to show.</div>
            )}
            {!loading && !loadError && nonEmpty.map((g) => {
              const ref = groupRef(g);
              const label = g.kind === 'main' ? 'Main tree' : (g.ticketTitle ?? g.branch ?? 'Worktree');
              const gBranch = g.kind === 'main' ? branch : (g.branch ?? null);
              const groupFileNames = g.files.map((f) => f.file);
              const selCount = groupFileNames.filter((fn) => selected.has(`${ref}::${fn}`)).length;
              const allSel = groupFileNames.length > 0 && selCount === groupFileNames.length;
              const msg = commitMsgs[ref] ?? '';
              const isCollapsed = collapsed.has(ref);
              return (
                <div key={ref} className="border-b border-gray-100 last:border-0 dark:border-white/10">
                  {/* Group header — collapse toggle · branch belonging · select-all · open-changes */}
                  <div className="flex w-full items-center gap-2 bg-gray-50/80 px-2 py-1.5 dark:bg-white/5">
                    <button
                      onClick={() => toggleCollapse(ref)}
                      title={isCollapsed ? 'Expand section' : 'Collapse section'}
                      className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
                    >
                      {isCollapsed ? <ChevronRight className="h-3 w-3 shrink-0 text-gray-400" /> : <ChevronDown className="h-3 w-3 shrink-0 text-gray-400" />}
                      <span className="truncate text-[11px] font-semibold text-gray-600 dark:text-gray-300">{label}</span>
                      {gBranch && (
                        <span className="flex min-w-0 items-center gap-1 rounded border border-gray-200 px-1 py-0.5 font-mono text-[10px] text-gray-500 dark:border-white/10 dark:text-gray-400" title={`On branch ${gBranch}`}>
                          <GitBranch className="h-2.5 w-2.5 shrink-0" /> <span className="truncate">{gBranch}</span>
                        </span>
                      )}
                      <span className="shrink-0 text-[10px] text-gray-400">{g.files.length} file{g.files.length === 1 ? '' : 's'}{selCount > 0 ? ` · ${selCount} sel` : ''}</span>
                    </button>
                    <label
                      title="Select all in this section"
                      className="flex shrink-0 cursor-pointer items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium text-gray-500 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-white/10"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <input
                        type="checkbox"
                        checked={allSel}
                        onChange={() => toggleSelectGroup(ref, groupFileNames)}
                        className="h-3 w-3 cursor-pointer accent-emerald-500"
                      />
                      All
                    </label>
                    <button
                      onClick={() => openChangesView(ref)}
                      title="Open this group in the Changes view"
                      className="shrink-0 rounded p-1 text-gray-400 hover:bg-gray-100 hover:text-primary dark:hover:bg-white/10"
                    >
                      <ExternalLink className="h-3 w-3" />
                    </button>
                  </div>

                  {!isCollapsed && g.files.map((f) => {
                    const badge = STATUS_BADGE[f.status] ?? STATUS_BADGE.modified;
                    const key = `${ref}::${f.file}`;
                    const isOpen = expanded === key;
                    const diff = diffs[key];
                    return (
                      <div key={key}>
                        <div className="group/row flex items-center gap-2 px-2 py-1.5 hover:bg-gray-50 dark:hover:bg-white/5">
                          <input
                            type="checkbox"
                            checked={selected.has(key)}
                            onChange={() => toggleSelect(key)}
                            title="Select for commit"
                            className="h-3.5 w-3.5 shrink-0 cursor-pointer accent-emerald-500"
                          />
                          <button
                            onClick={() => toggleFile(ref, f.file)}
                            className="flex min-w-0 flex-1 items-center gap-2 text-left"
                          >
                            {isOpen ? <ChevronDown className="h-3 w-3 shrink-0 text-gray-400" /> : <ChevronRight className="h-3 w-3 shrink-0 text-gray-400" />}
                            <span className={`flex h-4 w-4 shrink-0 items-center justify-center rounded font-mono text-[10px] font-bold ${badge.cls}`} title={badge.title}>{badge.letter}</span>
                            <span className="truncate font-mono text-xs text-gray-700 dark:text-gray-300" title={f.file}>{f.file}</span>
                            <span className="ml-auto shrink-0 font-mono text-[11px]">
                              {f.additions > 0 && <span className="text-emerald-600 dark:text-emerald-400">+{f.additions}</span>}
                              {f.additions > 0 && f.deletions > 0 && ' '}
                              {f.deletions > 0 && <span className="text-red-600 dark:text-red-400">−{f.deletions}</span>}
                            </span>
                          </button>
                          <button
                            onClick={(e) => { e.stopPropagation(); openInEditor(f.file, ref); }}
                            title="Open file in VS Code"
                            className="shrink-0 rounded p-1 text-gray-400 opacity-0 transition-opacity hover:bg-gray-100 hover:text-primary group-hover/row:opacity-100 dark:hover:bg-white/10"
                          >
                            <Code2 className="h-3 w-3" />
                          </button>
                          <button
                            onClick={(e) => { e.stopPropagation(); openChangesView(ref); }}
                            title="Open in Changes view"
                            className="shrink-0 rounded p-1 text-gray-400 opacity-0 transition-opacity hover:bg-gray-100 hover:text-primary group-hover/row:opacity-100 dark:hover:bg-white/10"
                          >
                            <ExternalLink className="h-3 w-3" />
                          </button>
                        </div>
                        {isOpen && (
                          <div className="max-h-72 overflow-auto border-t border-gray-100 bg-gray-50/60 dark:border-white/10 dark:bg-black/20">
                            {diff === 'loading' && (
                              <div className="flex items-center gap-2 px-3 py-3 text-[11px] text-gray-400">
                                <Loader2 className="h-3 w-3 animate-spin" /> Loading diff…
                              </div>
                            )}
                            {diff === null && <div className="px-3 py-3 text-[11px] text-gray-400">No diff to show.</div>}
                            {typeof diff === 'string' && <DiffLines content={diff} />}
                          </div>
                        )}
                      </div>
                    );
                  })}

                  {/* Per-group commit bar (FLUX-554) — commit-only, this group's branch. */}
                  {!isCollapsed && (
                    <div className="flex items-center gap-2 border-t border-gray-100 bg-gray-50/40 px-2 py-1.5 dark:border-white/10 dark:bg-white/5">
                      <input
                        type="text"
                        value={msg}
                        onChange={(e) => setCommitMsgs((m) => ({ ...m, [ref]: e.target.value }))}
                        placeholder={selCount > 0 ? `Message for ${selCount} file${selCount === 1 ? '' : 's'}…` : 'Select files to commit…'}
                        className="min-w-0 flex-1 rounded-md border border-gray-200 bg-white px-2 py-1 text-[11px] outline-none focus:border-primary dark:border-white/10 dark:bg-black/30 dark:text-gray-200"
                      />
                      <button
                        disabled={committing === ref || selCount === 0 || !msg.trim()}
                        onClick={() => doCommit(ref, groupFileNames)}
                        title="Commit selected files (no push)"
                        className="flex shrink-0 items-center gap-1 rounded-md bg-primary px-2 py-1 text-[11px] font-semibold text-white transition-colors hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-40"
                      >
                        {committing === ref ? <Loader2 className="h-3 w-3 animate-spin" /> : <GitCommitHorizontal className="h-3 w-3" />}
                        {committing === ref ? 'Committing…' : `Commit${selCount > 0 ? ` (${selCount})` : ''}`}
                      </button>
                    </div>
                  )}
                  {!isCollapsed && commitErr[ref] && (
                    <div className="border-t border-gray-100 px-2 py-1 text-[11px] text-red-500 dark:border-white/10">{commitErr[ref]}</div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
