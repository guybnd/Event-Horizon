import { memo, useCallback, useEffect, useRef, useState } from 'react';
import type { MouseEvent } from 'react';
import { ChevronDown, FolderOpen, Layers, Loader2, RefreshCw, Settings as SettingsIcon, X } from 'lucide-react';
import { useAppSelector, useAppActions } from '../store/useAppSelector';
import { groupWorkspaces } from '../utils';
import type { WorkspaceInfo } from '../api';

// S10 (epic FLUX-1230): non-destructive workspace switcher. Decision 1 default from the mockup
// (rev 1) — a tab strip of already-open boards for instant switching, plus the pre-existing
// dropdown demoted to "open another / manage the full registered list". Only rendered when 2+
// boards are open; a single open board keeps the pre-S10 compact-button-only look (AC5).
export const WorkspaceSwitcher = memo(function WorkspaceSwitcher() {
  const { switchWorkspace, setActiveBoard, openBoard, closeBoard, setView } = useAppActions();
  const workspaces = useAppSelector(s => s.workspaces);
  const workspacePath = useAppSelector(s => s.workspacePath);
  const activeBoardId = useAppSelector(s => s.activeBoardId);
  const [open, setOpen] = useState(false);
  const [rebinding, setRebinding] = useState(false);
  // Path currently mid-open/mid-close, for a per-row/per-tab busy spinner. Only one such action is
  // ever in flight at a time from this component.
  const [busyPath, setBusyPath] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const openBoards = workspaces.filter(w => w.open);
  const activeWorkspace = workspaces.find(w => w.path === activeBoardId) ?? workspaces.find(w => w.active);
  const displayName = activeWorkspace?.displayName || (workspacePath ? workspacePath.split(/[\\/]/).pop() : 'No project');

  // Decision 3 default (last-resort, clearly labelled): the destructive engine rebind — stops every
  // live session on the current root and rebinds the engine's single-active workspace. Kept off the
  // normal row click (see `handleRowClick`); reachable only via the small "rebind" icon per
  // registered-not-open row.
  const handleRebind = useCallback(async (wsPath: string) => {
    setRebinding(true);
    setOpen(false);
    try {
      await switchWorkspace(wsPath);
    } catch (err) {
      console.error('Failed to switch workspace:', err);
    } finally {
      setRebinding(false);
    }
  }, [switchWorkspace]);

  const handleRowClick = useCallback(async (ws: WorkspaceInfo) => {
    if (ws.path === activeBoardId || !ws.available) return;
    if (ws.open) {
      setOpen(false);
      setActiveBoard(ws.path);
      return;
    }
    setBusyPath(ws.path);
    setOpen(false);
    try {
      await openBoard(ws.path);
    } catch (err) {
      console.error('Failed to open board:', err);
    } finally {
      setBusyPath(null);
    }
  }, [activeBoardId, setActiveBoard, openBoard]);

  const handleCloseTab = useCallback((e: MouseEvent, wsPath: string) => {
    e.stopPropagation();
    setBusyPath(wsPath);
    void closeBoard(wsPath).finally(() => setBusyPath(null));
  }, [closeBoard]);

  const renderRow = (ws: WorkspaceInfo, indented: boolean) => (
    <div key={ws.path} className={`flex items-center gap-1 ${indented ? 'pl-4' : ''}`}>
      <button
        disabled={ws.path === activeBoardId || !ws.available || busyPath === ws.path}
        onClick={() => handleRowClick(ws)}
        className={`flex-1 min-w-0 flex flex-col items-start gap-0.5 rounded-lg px-3 py-2 text-left transition-colors ${
          ws.path === activeBoardId
            ? 'bg-primary/10 text-primary cursor-default'
            : ws.available
              ? 'hover:bg-gray-100 dark:hover:bg-white/5 cursor-pointer text-gray-700 dark:text-gray-200'
              : 'opacity-40 cursor-not-allowed text-gray-400'
        }`}
      >
        <span className="text-xs font-semibold truncate w-full flex items-center gap-1.5">
          {busyPath === ws.path && <Loader2 className="h-3 w-3 animate-spin shrink-0" />}
          <span className="truncate">{ws.displayName}</span>
          {ws.group?.role === 'parent' && <span className="text-[10px] font-bold uppercase opacity-50 shrink-0">Parent</span>}
          {ws.path === activeBoardId && <span className="text-[10px] font-bold uppercase opacity-60 shrink-0">Active</span>}
          {ws.open && ws.path !== activeBoardId && <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 shrink-0" title="Open" />}
          {ws.liveSessionCount > 0 && <span className="text-[10px] font-bold text-primary shrink-0">{ws.liveSessionCount} live</span>}
          {!ws.available && <span className="text-[10px] font-bold uppercase text-red-400 shrink-0">Unavailable</span>}
        </span>
        <span className="text-[10px] text-gray-400 dark:text-gray-500 truncate w-full font-mono">{ws.path}</span>
      </button>
      {!ws.open && ws.available && (
        <button
          onClick={(e) => { e.stopPropagation(); setOpen(false); void handleRebind(ws.path); }}
          title="Rebind engine to this root (stops all live sessions) — last resort"
          className="shrink-0 rounded-lg p-1.5 text-gray-400 hover:bg-gray-100 hover:text-gray-600 dark:hover:bg-white/5 dark:hover:text-gray-300"
        >
          <RefreshCw className="h-3 w-3" />
        </button>
      )}
    </div>
  );

  const { groups, ungrouped } = groupWorkspaces(workspaces);

  useEffect(() => {
    if (!open) return;
    const handleClick = (e: globalThis.MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [open]);

  return (
    <div className="relative flex shrink-0 items-center gap-1" ref={containerRef}>
      {openBoards.length > 1 && (
        <div className="flex items-center gap-0.5 rounded-xl border border-gray-200 bg-white/60 p-1 dark:border-white/10 dark:bg-white/5">
          {openBoards.map((ws) => (
            <button
              key={ws.path}
              onClick={() => handleRowClick(ws)}
              disabled={busyPath === ws.path}
              title={ws.path}
              className={`group flex items-center gap-1.5 rounded-lg px-2 py-1 text-xs font-semibold transition-colors ${
                ws.path === activeBoardId
                  ? 'bg-primary/10 text-primary'
                  : 'text-gray-600 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-white/10'
              }`}
            >
              {busyPath === ws.path ? (
                <Loader2 className="h-3 w-3 shrink-0 animate-spin" />
              ) : (
                <span
                  className={`h-1.5 w-1.5 shrink-0 rounded-full ${ws.liveSessionCount > 0 ? 'bg-emerald-500' : 'bg-gray-300 dark:bg-white/20'}`}
                  title={ws.liveSessionCount > 0 ? `${ws.liveSessionCount} live session${ws.liveSessionCount > 1 ? 's' : ''}` : 'Open'}
                />
              )}
              <span className="max-w-[110px] truncate">{ws.displayName}</span>
              {ws.closable && (
                <span
                  role="button"
                  aria-label={`Close ${ws.displayName}`}
                  onClick={(e) => handleCloseTab(e, ws.path)}
                  className="ml-0.5 rounded p-0.5 opacity-0 hover:bg-black/10 group-hover:opacity-60 hover:!opacity-100 dark:hover:bg-white/10"
                >
                  <X className="h-2.5 w-2.5" />
                </span>
              )}
            </button>
          ))}
        </div>
      )}

      <button
        onClick={() => setOpen(prev => !prev)}
        disabled={rebinding}
        className={`matrix-accent-toggle group flex shrink-0 cursor-pointer items-center gap-1.5 rounded-xl border px-2.5 py-1.5 text-left transition-all duration-200 overflow-hidden border-gray-200 bg-white/60 text-gray-700 dark:border-white/10 dark:bg-white/5 dark:text-gray-200 hover:border-primary/30 hover:bg-primary/5 dark:hover:border-primary/30 dark:hover:bg-primary/10 ${open ? 'ring-2 ring-primary/30' : ''}`}
      >
        {rebinding ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin shrink-0" />
        ) : (
          <FolderOpen className="h-3.5 w-3.5 shrink-0" />
        )}
        <span className="text-xs font-semibold leading-none max-w-[120px] truncate">
          {openBoards.length > 1 ? 'Open another…' : displayName}
        </span>
        <ChevronDown className={`h-3 w-3 shrink-0 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>

      {open && (
        <div className="absolute right-0 top-full mt-1.5 z-50 min-w-[240px] max-w-[320px] rounded-xl border border-gray-200 bg-white shadow-lg dark:border-white/10 dark:bg-[#1e1f2a]">
          <div className="p-1.5 max-h-[280px] overflow-y-auto">
            {workspaces.length === 0 && (
              <p className="px-3 py-2 text-xs text-gray-500">No workspaces configured yet.</p>
            )}
            {groups.map((group) => (
              <div key={group.parentPath} className="mb-1">
                <div className="flex items-center gap-1.5 px-3 pt-1.5 pb-1">
                  <Layers className="h-3 w-3 text-primary/70" />
                  <span className="text-[10px] font-bold uppercase tracking-wide text-gray-400 truncate">{group.groupName}</span>
                </div>
                <div className="border-l border-gray-200 dark:border-white/10 ml-3 pl-0.5">
                  {group.items.map((item) => renderRow(item.ws, true))}
                </div>
              </div>
            ))}
            {ungrouped.map((item) => renderRow(item.ws, false))}
          </div>
          <div className="border-t border-gray-200 dark:border-white/10 p-1.5">
            <button
              onClick={() => { setOpen(false); setView('settings'); }}
              className="w-full flex items-center gap-2 rounded-lg px-3 py-2 text-xs font-medium text-gray-500 hover:bg-gray-100 dark:hover:bg-white/5 cursor-pointer transition-colors"
            >
              <SettingsIcon className="h-3 w-3" />
              Manage workspaces...
            </button>
          </div>
        </div>
      )}
    </div>
  );
});
