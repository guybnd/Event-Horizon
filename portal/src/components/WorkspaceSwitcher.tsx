import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { ChevronDown, FolderOpen, Layers, Loader2, Settings as SettingsIcon } from 'lucide-react';
import { useApp } from '../AppContext';
import { groupWorkspaces } from '../utils';
import type { WorkspaceInfo } from '../api';

export const WorkspaceSwitcher = memo(function WorkspaceSwitcher() {
  const { workspaces, workspacePath, switchWorkspace, setView } = useApp();
  const [open, setOpen] = useState(false);
  const [switching, setSwitching] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const activeWorkspace = workspaces.find(w => w.active);
  const displayName = activeWorkspace?.displayName || (workspacePath ? workspacePath.split(/[\\/]/).pop() : 'No project');

  const handleSwitch = useCallback(async (wsPath: string) => {
    setSwitching(true);
    setOpen(false);
    try {
      await switchWorkspace(wsPath);
    } catch (err) {
      console.error('Failed to switch workspace:', err);
    } finally {
      setSwitching(false);
    }
  }, [switchWorkspace]);

  const renderRow = (ws: WorkspaceInfo, indented: boolean) => (
    <button
      key={ws.path}
      disabled={ws.active || !ws.available}
      onClick={() => handleSwitch(ws.path)}
      className={`w-full flex flex-col items-start gap-0.5 rounded-lg px-3 py-2 text-left transition-colors ${indented ? 'pl-5' : ''} ${
        ws.active
          ? 'bg-primary/10 text-primary cursor-default'
          : ws.available
            ? 'hover:bg-gray-100 dark:hover:bg-white/5 cursor-pointer text-gray-700 dark:text-gray-200'
            : 'opacity-40 cursor-not-allowed text-gray-400'
      }`}
    >
      <span className="text-xs font-semibold truncate w-full">
        {ws.displayName}
        {ws.group?.role === 'parent' && <span className="ml-1.5 text-[10px] font-bold uppercase opacity-50">Parent</span>}
        {ws.active && <span className="ml-1.5 text-[10px] font-bold uppercase opacity-60">Active</span>}
        {!ws.available && <span className="ml-1.5 text-[10px] font-bold uppercase text-red-400">Unavailable</span>}
      </span>
      <span className="text-[10px] text-gray-400 dark:text-gray-500 truncate w-full font-mono">{ws.path}</span>
    </button>
  );

  const { groups, ungrouped } = groupWorkspaces(workspaces);

  useEffect(() => {
    if (!open) return;
    const handleClick = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [open]);

  return (
    <div className="relative" ref={containerRef}>
      <button
        onClick={() => setOpen(prev => !prev)}
        disabled={switching}
        className={`matrix-accent-toggle group flex shrink-0 cursor-pointer items-center gap-1.5 rounded-xl border px-2.5 py-1.5 text-left transition-all duration-200 overflow-hidden border-gray-200 bg-white/60 text-gray-700 dark:border-white/10 dark:bg-white/5 dark:text-gray-200 hover:border-primary/30 hover:bg-primary/5 dark:hover:border-primary/30 dark:hover:bg-primary/10 ${open ? 'ring-2 ring-primary/30' : ''}`}
      >
        {switching ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin shrink-0" />
        ) : (
          <FolderOpen className="h-3.5 w-3.5 shrink-0" />
        )}
        <span className="text-xs font-semibold leading-none max-w-[120px] truncate">{displayName}</span>
        <ChevronDown className={`h-3 w-3 shrink-0 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>

      {open && (
        <div className="absolute right-0 top-full mt-1.5 z-50 min-w-[220px] max-w-[320px] rounded-xl border border-gray-200 bg-white shadow-lg dark:border-white/10 dark:bg-[#1e1f2a]">
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
