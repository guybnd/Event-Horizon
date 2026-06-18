import { useEffect, useState } from 'react';
import { FolderGit2, FolderX, ExternalLink, Loader2, RefreshCw } from 'lucide-react';
import { fetchWorktrees, detachWorktree, openWorktreeWindow, type WorktreeInfo } from '../../api';

/**
 * Worktrees management surface (FLUX-516): the one place worktrees get their own
 * list — open the window, or detach (remove the worktree, keep the branch,
 * preserve uncommitted work). Independent of ticket status, so it doubles as
 * cleanup / disk awareness.
 */
export function WorktreesPanel() {
  const [worktrees, setWorktrees] = useState<WorktreeInfo[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  const load = () => fetchWorktrees().then(setWorktrees).catch(() => setWorktrees([]));
  useEffect(() => { void load(); }, []);

  const handleOpen = async (w: WorktreeInfo) => {
    if (!w.ticketId) return;
    setBusy(w.path); setMsg(null);
    try { await openWorktreeWindow(w.ticketId); } catch (e) { setMsg(e instanceof Error ? e.message : 'Failed to open worktree window'); } finally { setBusy(null); }
  };

  const handleDetach = async (w: WorktreeInfo) => {
    if (!w.ticketId) { setMsg('This worktree has no associated ticket — remove it from the terminal with `git worktree remove`.'); return; }
    if (!window.confirm(`Detach the worktree for ${w.branch}? The branch is kept; any uncommitted work is surfaced onto master (or kept as a stash).`)) return;
    setBusy(w.path); setMsg(null);
    try {
      const r = await detachWorktree(w.ticketId);
      setMsg(r.message);
      await load();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : 'Failed to detach worktree');
    } finally { setBusy(null); }
  };

  return (
    <div className="rounded-lg border border-gray-200 p-4 dark:border-white/10">
      <div className="mb-2 flex items-center justify-between">
        <div className="flex items-center gap-1.5 text-sm font-semibold text-gray-800 dark:text-gray-100">
          <FolderGit2 className="h-4 w-4 text-primary" /> Active worktrees
        </div>
        <button
          onClick={() => void load()}
          title="Refresh"
          className="rounded p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-600 dark:hover:bg-white/5 dark:hover:text-gray-200"
        >
          <RefreshCw className="h-3.5 w-3.5" />
        </button>
      </div>
      <p className="mb-3 text-[11px] text-gray-400">
        Each task worktree lives at <code className="rounded bg-gray-100 px-1 dark:bg-white/10">&lt;repo-parent&gt;/.eh-worktrees/</code>. Detach keeps the branch and never discards uncommitted work.
      </p>

      {worktrees === null ? (
        <div className="flex items-center gap-2 text-[11px] text-gray-400"><Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading…</div>
      ) : worktrees.length === 0 ? (
        <p className="text-[11px] text-gray-400">No active worktrees.</p>
      ) : (
        <div className="space-y-1.5">
          {worktrees.map((w) => (
            <div key={w.path} className="flex items-center gap-2 rounded-md border border-gray-100 bg-gray-50 px-2.5 py-1.5 text-[11px] dark:border-white/5 dark:bg-black/20">
              <FolderGit2 className="h-3.5 w-3.5 shrink-0 text-primary" />
              <div className="min-w-0 flex-1">
                <div className="truncate font-mono text-gray-700 dark:text-gray-200">
                  {w.branch}{w.ticketId ? <span className="text-gray-400"> · {w.ticketId}</span> : <span className="text-amber-500"> · orphan</span>}
                </div>
                <div className="truncate text-[10px] text-gray-400" title={w.path}>{w.path}</div>
              </div>
              <button
                onClick={() => void handleOpen(w)}
                disabled={!w.ticketId || busy === w.path}
                title="Open in a new VS Code window"
                className="flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-gray-500 hover:bg-gray-200 hover:text-gray-700 disabled:opacity-40 dark:text-gray-400 dark:hover:bg-white/10 dark:hover:text-gray-200"
              >
                {busy === w.path ? <Loader2 className="h-3 w-3 animate-spin" /> : <ExternalLink className="h-3 w-3" />} Open
              </button>
              <button
                onClick={() => void handleDetach(w)}
                disabled={busy === w.path}
                title="Remove the worktree, keep the branch"
                className="flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-gray-500 hover:bg-gray-200 hover:text-gray-700 disabled:opacity-40 dark:text-gray-400 dark:hover:bg-white/10 dark:hover:text-gray-200"
              >
                <FolderX className="h-3 w-3" /> Detach
              </button>
            </div>
          ))}
        </div>
      )}

      {msg && <p className="mt-2 text-[10px] text-gray-400">{msg}</p>}
    </div>
  );
}
