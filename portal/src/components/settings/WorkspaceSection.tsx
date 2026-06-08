import { useState, useEffect, useCallback } from 'react';
import type { UserDef, DocsEditPermissions } from '../../types';
import { SimpleEditor } from './shared';
import { GroupSetupPreview } from '../GroupSetupPreview';
import { GroupWizard } from '../GroupWizard';
import { DocsPromotionPanel } from '../DocsPromotionPanel';
import { groupRegistrationGaps, parentDirOf, multiRepoNudge, groupWorkspaces } from '../../utils';
import { setWorkspace as apiSetWorkspace, pickWorkspaceFolder, fetchStorageMode, migrateStorage, restoreStorage, fetchWorkspaces, addWorkspace, removeWorkspace, updateWorkspaceLabel as apiUpdateLabel, switchWorkspace as apiSwitchWorkspace, fetchGroupStatus, ensureGroupRegistered, discoverGroupFolder, type WorkspaceInfo, type GroupStatus } from '../../api';

interface WorkspaceSectionProps {
  users: UserDef[];
  setUsers: (items: UserDef[]) => void;
  projects: string;
  setProjects: (v: string) => void;
  docsRoot: string;
  setDocsRoot: (v: string) => void;
  docsEditPermissions: DocsEditPermissions;
  setDocsEditPermissions: (v: DocsEditPermissions) => void;
  docsAllowedUsers: string[];
  setDocsAllowedUsers: (v: string[] | ((current: string[]) => string[])) => void;
  workspacePath: string | null;
  notifyWorkspaceSet: () => void;
  syncDebounceMs: number;
  setSyncDebounceMs: (v: number) => void;
  syncMaxWaitMs: number;
  setSyncMaxWaitMs: (v: number) => void;
  agentProgressEnabled: boolean;
  setAgentProgressEnabled: (v: boolean) => void;
  agentProgressDelay: number;
  setAgentProgressDelay: (v: number) => void;
}

export function WorkspaceSection({
  users,
  setUsers,
  projects,
  setProjects,
  docsRoot,
  setDocsRoot,
  docsEditPermissions,
  setDocsEditPermissions,
  docsAllowedUsers,
  setDocsAllowedUsers,
  workspacePath,
  notifyWorkspaceSet,
  syncDebounceMs,
  setSyncDebounceMs,
  syncMaxWaitMs,
  setSyncMaxWaitMs,
  agentProgressEnabled,
  setAgentProgressEnabled,
  agentProgressDelay,
  setAgentProgressDelay,
}: WorkspaceSectionProps) {
  const [newWorkspacePath, setNewWorkspacePath] = useState('');
  const [workspaceSwitchError, setWorkspaceSwitchError] = useState<string | null>(null);
  const [workspaceSwitching, setWorkspaceSwitching] = useState(false);
  const [workspacePicking, setWorkspacePicking] = useState(false);

  const [storageMode, setStorageMode] = useState<'in-repo' | 'orphan' | null>(null);
  const [storageBusy, setStorageBusy] = useState(false);
  const [storageError, setStorageError] = useState<string | null>(null);

  const [groupStatus, setGroupStatus] = useState<GroupStatus | null>(null);
  const [showGroupSetup, setShowGroupSetup] = useState(false);
  const [showGroupWizard, setShowGroupWizard] = useState(false);
  const [registering, setRegistering] = useState(false);
  const [registerError, setRegisterError] = useState<string | null>(null);
  const [siblingRepoCount, setSiblingRepoCount] = useState(0);
  const [nudgeDismissed, setNudgeDismissed] = useState(false);

  const [configuredWorkspaces, setConfiguredWorkspaces] = useState<WorkspaceInfo[]>([]);
  const [addingWorkspace, setAddingWorkspace] = useState(false);
  const [addWorkspacePath, setAddWorkspacePath] = useState('');
  const [addWorkspaceError, setAddWorkspaceError] = useState<string | null>(null);
  const [editingLabelIndex, setEditingLabelIndex] = useState<number | null>(null);
  const [editLabelValue, setEditLabelValue] = useState('');

  const loadWorkspaces = useCallback(() => {
    fetchWorkspaces().then(setConfiguredWorkspaces).catch(() => {});
  }, []);

  const loadGroupStatus = useCallback(() => {
    fetchGroupStatus().then(setGroupStatus).catch(() => setGroupStatus(null));
  }, []);

  const handleEnsureRegistered = useCallback(async () => {
    setRegisterError(null);
    setRegistering(true);
    try {
      await ensureGroupRegistered();
      loadGroupStatus();
      loadWorkspaces();
    } catch (err: any) {
      setRegisterError(err.message);
    } finally {
      setRegistering(false);
    }
  }, [loadGroupStatus, loadWorkspaces]);

  useEffect(() => { loadWorkspaces(); }, [loadWorkspaces]);

  useEffect(() => {
    if (!workspacePath) return;
    fetchStorageMode().then((r) => setStorageMode(r.mode)).catch(() => setStorageMode('in-repo'));
  }, [workspacePath]);

  useEffect(() => {
    if (!workspacePath) return;
    loadGroupStatus();
  }, [workspacePath, loadGroupStatus]);

  // Optional multi-repo nudge: if the active workspace's parent folder holds
  // sibling git repos and no group is configured, offer the wizard — once,
  // dismissible, never blocking. Detection is read-only.
  useEffect(() => {
    if (!workspacePath || groupStatus === null) return;
    if (groupStatus.configured) { setSiblingRepoCount(0); return; }
    const parent = parentDirOf(workspacePath);
    if (!parent) return;
    const dismissKey = `eh-group-nudge-dismissed:${parent}`;
    setNudgeDismissed(localStorage.getItem(dismissKey) === '1');
    let cancelled = false;
    discoverGroupFolder(parent)
      .then((r) => { if (!cancelled) setSiblingRepoCount(r.repos.length); })
      .catch(() => { if (!cancelled) setSiblingRepoCount(0); });
    return () => { cancelled = true; };
  }, [workspacePath, groupStatus]);

  const dismissNudge = useCallback(() => {
    const parent = workspacePath ? parentDirOf(workspacePath) : null;
    if (parent) localStorage.setItem(`eh-group-nudge-dismissed:${parent}`, '1');
    setNudgeDismissed(true);
  }, [workspacePath]);

  const handleBrowseWorkspace = async () => {
    setAddingWorkspace(true);
    try {
      const picked = await pickWorkspaceFolder();
      if (picked) setAddWorkspacePath(picked);
    } finally {
      setAddingWorkspace(false);
    }
  };

  const handleAddWorkspace = async () => {
    if (!addWorkspacePath.trim()) return;
    setAddWorkspaceError(null);
    setAddingWorkspace(true);
    try {
      const wsPath = addWorkspacePath.trim();
      const list = await addWorkspace(wsPath);
      setConfiguredWorkspaces(list);
      setAddWorkspacePath('');
      const added = list.find(w => w.path.toLowerCase() === wsPath.toLowerCase() || w.path === wsPath);
      if (added && !added.active && window.confirm(`"${added.displayName}" added. Switch to it now?`)) {
        setSwitchingPath(added.path);
        try {
          await apiSwitchWorkspace(added.path);
          notifyWorkspaceSet();
          loadWorkspaces();
        } finally {
          setSwitchingPath(null);
        }
      }
    } catch (err: any) {
      setAddWorkspaceError(err.message);
    } finally {
      setAddingWorkspace(false);
    }
  };

  const [switchingPath, setSwitchingPath] = useState<string | null>(null);

  const handleSwitchWorkspace = async (ws: WorkspaceInfo, force?: boolean) => {
    if (!force && !window.confirm(`Switch to "${ws.displayName}"?\n\nThis will reload the board with the new project's data.`)) return;
    setSwitchingPath(ws.path);
    try {
      const result = await apiSwitchWorkspace(ws.path, force);
      if ('blocked' in result && result.blocked) {
        const proceed = window.confirm(`${result.message}\n\nStop them and switch anyway?`);
        if (proceed) {
          await handleSwitchWorkspace(ws, true);
        }
        return;
      }
      notifyWorkspaceSet();
      loadWorkspaces();
    } catch (err: any) {
      alert(`Failed to switch: ${err.message}`);
    } finally {
      setSwitchingPath(null);
    }
  };

  const handleRemoveWorkspace = async (index: number) => {
    const list = await removeWorkspace(index);
    setConfiguredWorkspaces(list);
  };

  const handleSaveLabel = async (index: number) => {
    const list = await apiUpdateLabel(index, editLabelValue);
    setConfiguredWorkspaces(list);
    setEditingLabelIndex(null);
  };

  const renderWorkspaceRow = (ws: WorkspaceInfo, idx: number) => (
    <div key={ws.path} className={`flex items-center gap-3 rounded-lg border px-3 py-2 ${ws.active ? 'border-primary/30 bg-primary/5' : 'border-gray-200 dark:border-white/10'}`}>
      <div className="flex-1 min-w-0">
        {editingLabelIndex === idx ? (
          <div className="flex items-center gap-2">
            <input
              autoFocus
              value={editLabelValue}
              onChange={e => setEditLabelValue(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') handleSaveLabel(idx); if (e.key === 'Escape') setEditingLabelIndex(null); }}
              className="min-w-0 flex-1 rounded border border-gray-200 dark:border-white/10 bg-white dark:bg-black/20 px-2 py-1 text-xs outline-none focus:border-primary"
              placeholder="Display label (optional)"
            />
            <button onClick={() => handleSaveLabel(idx)} className="text-xs font-medium text-primary hover:underline">Save</button>
            <button onClick={() => setEditingLabelIndex(null)} className="text-xs text-gray-400 hover:underline">Cancel</button>
          </div>
        ) : (
          <>
            <div className="flex items-center gap-2">
              <span className="text-sm font-semibold text-gray-800 dark:text-gray-200 truncate">{ws.displayName}</span>
              {ws.group?.role === 'parent' && <span className="text-[10px] font-bold uppercase text-gray-400">Parent</span>}
              {ws.group?.role === 'member' && <span className="text-[10px] font-bold uppercase text-gray-400">Member</span>}
              {ws.active && <span className="text-[10px] font-bold uppercase text-primary">Active</span>}
              {!ws.available && <span className="text-[10px] font-bold uppercase text-red-400">Unavailable</span>}
            </div>
            <p className="text-[10px] font-mono text-gray-400 truncate">{ws.path}</p>
          </>
        )}
      </div>
      {editingLabelIndex !== idx && (
        <div className="flex items-center gap-1.5 shrink-0">
          {!ws.active && ws.available && (
            <button
              onClick={() => handleSwitchWorkspace(ws)}
              disabled={switchingPath === ws.path}
              className="rounded-md bg-primary/10 px-2 py-1 text-[10px] font-semibold text-primary hover:bg-primary/20 transition-colors disabled:opacity-50"
              title="Switch to this workspace"
            >
              {switchingPath === ws.path ? 'Switching…' : 'Switch'}
            </button>
          )}
          <button
            onClick={() => { setEditingLabelIndex(idx); setEditLabelValue(ws.label || ''); }}
            className="text-[10px] text-gray-400 hover:text-primary transition-colors"
            title="Edit label"
          >
            Rename
          </button>
          {!ws.active && (
            <button
              onClick={() => handleRemoveWorkspace(idx)}
              className="text-[10px] text-gray-400 hover:text-red-500 transition-colors"
              title="Remove from list"
            >
              Remove
            </button>
          )}
        </div>
      )}
    </div>
  );

  const workspaceGroups = groupWorkspaces(configuredWorkspaces);

  return (
    <div className="grid grid-cols-2 gap-10">
      {/* Configured Workspaces */}
      <div className="col-span-2 rounded-2xl border border-gray-200 bg-gray-50/80 p-5 dark:border-white/10 dark:bg-black/10">
        <h3 className="text-base font-bold text-gray-800 dark:text-gray-200 mb-1">Configured Workspaces</h3>
        <p className="text-xs text-gray-500 mb-4">Manage your workspace list. These appear in the header switcher for quick project switching.</p>

        {configuredWorkspaces.length === 0 ? (
          <p className="text-xs text-gray-400 italic mb-3">No workspaces registered yet. Your current workspace will be auto-registered on next startup.</p>
        ) : (
          <div className="space-y-2 mb-4">
            {workspaceGroups.groups.map((group) => (
              <div key={group.parentPath} className="rounded-lg border border-gray-200/70 dark:border-white/10 bg-white/40 dark:bg-white/[0.02] p-2">
                <div className="flex items-center gap-1.5 px-1 pb-1.5">
                  <span className="text-[10px] font-bold uppercase tracking-wide text-gray-400">Group · {group.groupName}</span>
                </div>
                <div className="space-y-2">
                  {group.items.map((item) => renderWorkspaceRow(item.ws, item.index))}
                </div>
              </div>
            ))}
            {workspaceGroups.ungrouped.map((item) => renderWorkspaceRow(item.ws, item.index))}
          </div>
        )}

        <div className="flex gap-2">
          <input
            type="text"
            value={addWorkspacePath}
            onChange={(e) => setAddWorkspacePath(e.target.value)}
            placeholder="Path to project folder…"
            className="min-w-0 flex-1 rounded-lg border border-gray-200 dark:border-white/10 bg-white dark:bg-black/20 px-3 py-2 text-sm outline-none focus:border-primary"
          />
          <button
            disabled={addingWorkspace}
            onClick={handleBrowseWorkspace}
            className="rounded-lg border border-gray-200 dark:border-white/10 bg-gray-50 dark:bg-white/5 px-3 py-2 text-sm font-medium text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-white/10 disabled:opacity-50"
          >
            {addingWorkspace ? '…' : 'Browse'}
          </button>
          <button
            disabled={addingWorkspace || !addWorkspacePath.trim()}
            onClick={handleAddWorkspace}
            className="rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-white hover:bg-primary-hover disabled:opacity-50 disabled:cursor-not-allowed"
          >
            Add
          </button>
        </div>
        {addWorkspaceError && (
          <p className="mt-2 text-xs text-red-500">{addWorkspaceError}</p>
        )}
      </div>

      <div className="col-span-2 rounded-2xl border border-gray-200 bg-gray-50/80 p-5 dark:border-white/10 dark:bg-black/10">
        <h3 className="text-base font-bold text-gray-800 dark:text-gray-200 mb-1">Project Folder</h3>
        <p className="text-xs text-gray-500 mb-4">Switch to a different project. The folder must contain a <code className="font-mono bg-gray-100 dark:bg-white/10 px-1 rounded">.flux/</code> or <code className="font-mono bg-gray-100 dark:bg-white/10 px-1 rounded">.flux-store/</code> directory.</p>
        {workspacePath && (
          <p className="mb-3 rounded-lg bg-gray-100 dark:bg-black/20 px-3 py-2 font-mono text-xs text-gray-600 dark:text-gray-300 break-all">{workspacePath}</p>
        )}
        <div className="flex gap-2">
          <input
            type="text"
            value={newWorkspacePath}
            onChange={(e) => setNewWorkspacePath(e.target.value)}
            placeholder="Path to project folder…"
            className="min-w-0 flex-1 rounded-lg border border-gray-200 dark:border-white/10 bg-white dark:bg-black/20 px-3 py-2 text-sm outline-none focus:border-primary"
          />
          <button
            disabled={workspacePicking}
            onClick={async () => {
              setWorkspacePicking(true);
              try {
                const picked = await pickWorkspaceFolder();
                if (picked) setNewWorkspacePath(picked);
              } finally {
                setWorkspacePicking(false);
              }
            }}
            className="rounded-lg border border-gray-200 dark:border-white/10 bg-gray-50 dark:bg-white/5 px-3 py-2 text-sm font-medium text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-white/10 disabled:opacity-50"
          >
            {workspacePicking ? '…' : 'Browse'}
          </button>
          <button
            disabled={workspaceSwitching || !newWorkspacePath.trim()}
            onClick={async () => {
              setWorkspaceSwitchError(null);
              setWorkspaceSwitching(true);
              try {
                await apiSetWorkspace(newWorkspacePath.trim());
                setNewWorkspacePath('');
                notifyWorkspaceSet();
              } catch (err: any) {
                setWorkspaceSwitchError(err.message);
              } finally {
                setWorkspaceSwitching(false);
              }
            }}
            className="rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-white hover:bg-primary-hover disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {workspaceSwitching ? 'Switching…' : 'Switch'}
          </button>
        </div>
        {workspaceSwitchError && (
          <p className="mt-2 text-xs text-red-500">{workspaceSwitchError}</p>
        )}
      </div>

      {workspacePath && (
        <div className="col-span-2 rounded-2xl border border-gray-200 bg-gray-50/80 p-5 dark:border-white/10 dark:bg-black/10">
          <h3 className="text-base font-bold text-gray-800 dark:text-gray-200 mb-1">Git Sync</h3>
          <p className="text-xs text-gray-500 mb-4">
            Tickets live in <code className="font-mono bg-gray-100 dark:bg-white/10 px-1 rounded">.flux/</code> by default.
            Enable Git Sync to move them to an orphan <code className="font-mono bg-gray-100 dark:bg-white/10 px-1 rounded">flux-data</code> branch,
            keeping ticket history off your main branch and enabling multi-machine sync.
          </p>
          <div className="flex items-center gap-4 flex-wrap mb-4">
            <span className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-semibold ${
              storageMode === 'orphan'
                ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400'
                : 'bg-gray-100 text-gray-600 dark:bg-white/10 dark:text-gray-300'
            }`}>
              <span className={`w-1.5 h-1.5 rounded-full ${storageMode === 'orphan' ? 'bg-green-500' : 'bg-gray-400'}`} />
              {storageMode === null ? 'Loading…' : storageMode === 'orphan' ? 'Git Sync active (orphan branch)' : 'In-Repo (.flux/)'}
            </span>
            {storageMode === 'in-repo' && (
              <button
                disabled={storageBusy}
                onClick={async () => {
                  setStorageError(null);
                  setStorageBusy(true);
                  try {
                    const result = await migrateStorage();
                    setStorageMode(result.mode as 'in-repo' | 'orphan');
                  } catch (err: any) {
                    setStorageError(err.message);
                  } finally {
                    setStorageBusy(false);
                  }
                }}
                className="rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-white hover:bg-primary-hover disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {storageBusy ? 'Migrating…' : 'Enable Git Sync'}
              </button>
            )}
            {storageMode === 'orphan' && (
              <button
                disabled={storageBusy}
                onClick={async () => {
                  setStorageError(null);
                  setStorageBusy(true);
                  try {
                    const result = await restoreStorage();
                    setStorageMode(result.mode as 'in-repo' | 'orphan');
                  } catch (err: any) {
                    setStorageError(err.message);
                  } finally {
                    setStorageBusy(false);
                  }
                }}
                className="rounded-lg border border-gray-200 dark:border-white/10 bg-gray-50 dark:bg-white/5 px-4 py-2 text-sm font-semibold text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-white/10 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {storageBusy ? 'Restoring…' : 'Restore to In-Repo'}
              </button>
            )}
          </div>
          {storageError && (
            <p className="mb-4 text-xs text-red-500">{storageError}</p>
          )}
          {storageMode === 'orphan' && <div className="border-t border-gray-200 dark:border-white/10 pt-4 mt-2">
            <p className="text-xs font-semibold uppercase tracking-wide text-gray-500 mb-3">Sync Timing</p>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">
                  Debounce delay (seconds)
                </label>
                <input
                  type="number"
                  min={5}
                  value={Math.round(syncDebounceMs / 1000)}
                  onChange={(e) => {
                    const v = Math.max(5, parseInt(e.target.value, 10) || 5);
                    setSyncDebounceMs(v * 1000);
                    if (v * 1000 > syncMaxWaitMs) setSyncMaxWaitMs(v * 1000);
                  }}
                  className="w-full rounded-lg border border-gray-200 dark:border-white/10 bg-white dark:bg-black/20 px-3 py-2 text-sm outline-none focus:border-primary"
                />
                <p className="mt-1 text-[11px] text-gray-500">Sync fires this many seconds after the last file change. Resets on each new change.</p>
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">
                  Max wait (seconds)
                </label>
                <input
                  type="number"
                  min={Math.round(syncDebounceMs / 1000)}
                  value={Math.round(syncMaxWaitMs / 1000)}
                  onChange={(e) => {
                    const v = Math.max(Math.round(syncDebounceMs / 1000), parseInt(e.target.value, 10) || Math.round(syncDebounceMs / 1000));
                    setSyncMaxWaitMs(v * 1000);
                  }}
                  className="w-full rounded-lg border border-gray-200 dark:border-white/10 bg-white dark:bg-black/20 px-3 py-2 text-sm outline-none focus:border-primary"
                />
                <p className="mt-1 text-[11px] text-gray-500">Sync is forced after this many seconds even if changes keep arriving. Prevents indefinite deferral.</p>
              </div>
            </div>
          </div>}
        </div>
      )}

      {workspacePath && (
        <div className="col-span-2 rounded-2xl border border-gray-200 bg-gray-50/80 p-5 dark:border-white/10 dark:bg-black/10">
          <h3 className="text-base font-bold text-gray-800 dark:text-gray-200 mb-1">Multi-repo group</h3>
          <p className="text-xs text-gray-500 mb-4">
            Link several repositories into a product group with a shared, fanned-out knowledge base.
            Creating a group writes <code className="font-mono bg-gray-100 dark:bg-white/10 px-1 rounded">group.json</code>,
            patches <code className="font-mono bg-gray-100 dark:bg-white/10 px-1 rounded">.gitignore</code>, and scaffolds the
            canonical store — so it always runs as a reviewable plan you confirm before anything is written.
          </p>

          {(() => {
            const nudge = multiRepoNudge({ groupConfigured: groupStatus?.configured || groupStatus?.membership != null, siblingRepoCount, dismissed: nudgeDismissed });
            if (nudge === null) return null;
            return (
              <div className="mb-4 flex items-start gap-3 rounded-xl border border-primary/30 bg-primary/5 p-4">
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-semibold text-gray-800 dark:text-gray-200">Found {nudge} repos next to this one</p>
                  <p className="mt-1 text-xs text-gray-500">
                    If some of these form one product, you can link them into a group with a shared knowledge base. This is optional.
                  </p>
                  <button
                    onClick={() => setShowGroupWizard(true)}
                    className="mt-3 rounded-lg bg-primary px-3.5 py-1.5 text-xs font-semibold text-white hover:bg-primary-hover"
                  >
                    Create group from repos…
                  </button>
                </div>
                <button onClick={dismissNudge} className="text-xs text-gray-400 hover:text-gray-600 dark:hover:text-gray-200">Dismiss</button>
              </div>
            );
          })()}

          {groupStatus?.membership?.role === 'member' ? (
            <div className="flex items-start gap-3 rounded-xl border border-sky-200 bg-sky-50/60 p-4 dark:border-sky-500/20 dark:bg-sky-500/5">
              <span className="mt-0.5 h-2 w-2 shrink-0 rounded-full bg-sky-500" />
              <div className="min-w-0">
                <p className="text-sm font-semibold text-gray-800 dark:text-gray-200">
                  Part of group “{groupStatus.membership.groupName}”
                </p>
                <p className="mt-1 text-xs text-gray-500">
                  This repo is the <span className="font-semibold">{groupStatus.membership.memberName}</span>
                  {groupStatus.membership.memberRole ? ` (${groupStatus.membership.memberRole})` : ''} member. The shared
                  knowledge base surfaces under its <code className="font-mono bg-gray-100 dark:bg-white/10 px-1 rounded">Product/</code> docs tree.
                  Group settings are managed from the parent workspace.
                </p>
                {groupStatus.membership.parentRoot && (
                  <p className="mt-1 font-mono text-[11px] text-gray-400 truncate">Parent: {groupStatus.membership.parentRoot}</p>
                )}
              </div>
            </div>
          ) : (
          <div className="flex items-center gap-4 flex-wrap">
            <span className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-semibold ${
              groupStatus?.configured
                ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400'
                : 'bg-gray-100 text-gray-600 dark:bg-white/10 dark:text-gray-300'
            }`}>
              <span className={`w-1.5 h-1.5 rounded-full ${groupStatus?.configured ? 'bg-green-500' : 'bg-gray-400'}`} />
              {groupStatus === null
                ? 'Loading…'
                : groupStatus.configured
                ? `Group “${groupStatus.name}” (${groupStatus.members?.length ?? 0} member${groupStatus.members?.length === 1 ? '' : 's'})`
                : 'No group configured'}
            </span>
            <button
              onClick={() => setShowGroupSetup(true)}
              className="rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-white hover:bg-primary-hover"
            >
              {groupStatus?.configured ? 'Reconfigure group…' : 'Set up group…'}
            </button>
            {!groupStatus?.configured && (
              <button
                onClick={() => setShowGroupWizard(true)}
                className="rounded-lg border border-primary/40 px-4 py-2 text-sm font-semibold text-primary hover:bg-primary/5"
              >
                Create group from repos…
              </button>
            )}
          </div>
          )}

          {groupStatus?.configured && groupStatus.registrationComplete === false && (() => {
            const { parentMissing, missingMembers, hasGap } = groupRegistrationGaps(groupStatus);
            if (!hasGap) return null;
            return (
              <div className="mt-4 rounded-xl border border-amber-300/60 bg-amber-50 p-4 dark:border-amber-500/30 dark:bg-amber-900/20">
                <div className="flex items-start gap-3">
                  <span className="mt-0.5 text-amber-500">⚠</span>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-semibold text-amber-800 dark:text-amber-300">Group not fully linked</p>
                    <p className="mt-1 text-xs text-amber-700/90 dark:text-amber-200/80">
                      For the shared knowledge base to surface inside each member repo, the parent and every checked-out
                      member must be registered as workspaces. The following aren’t registered yet:
                    </p>
                    <ul className="mt-2 space-y-1 text-xs text-amber-800 dark:text-amber-200">
                      {parentMissing && (
                        <li className="flex items-center gap-2">
                          <span className="rounded bg-amber-200/70 px-1.5 py-0.5 text-[10px] font-bold uppercase dark:bg-amber-500/20">Parent</span>
                          <span className="font-mono truncate">{groupStatus.parentRoot}</span>
                        </li>
                      )}
                      {missingMembers.map((m) => (
                        <li key={m.path} className="flex items-center gap-2">
                          <span className="rounded bg-amber-200/70 px-1.5 py-0.5 text-[10px] font-bold uppercase dark:bg-amber-500/20">Member</span>
                          <span className="font-medium">{m.name}</span>
                          <span className="font-mono text-amber-700/70 dark:text-amber-200/60 truncate">{m.path}</span>
                        </li>
                      ))}
                    </ul>
                    <p className="mt-2 text-[11px] text-amber-700/70 dark:text-amber-200/60">
                      Nothing is written until you confirm. This only adds the repos to your workspace list — it does not touch git.
                    </p>
                    {registerError && <p className="mt-2 text-xs text-red-600 dark:text-red-400">{registerError}</p>}
                    <button
                      onClick={handleEnsureRegistered}
                      disabled={registering}
                      className="mt-3 rounded-lg bg-amber-600 px-3.5 py-1.5 text-xs font-semibold text-white hover:bg-amber-700 disabled:opacity-60"
                    >
                      {registering ? 'Registering…' : 'Register missing workspaces'}
                    </button>
                  </div>
                </div>
              </div>
            );
          })()}

          {groupStatus?.configured && <DocsPromotionPanel onPromoted={loadGroupStatus} />}
        </div>
      )}

      {showGroupSetup && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/40 backdrop-blur-sm pointer-events-auto">
          <div className="eh-surface-overlay p-6 rounded-xl shadow-2xl w-[560px] max-h-[85vh] overflow-y-auto border eh-border">
            <h3 className="text-lg font-bold mb-4 text-gray-900 dark:text-white">{groupStatus?.configured ? 'Reconfigure multi-repo group' : 'Multi-repo group setup'}</h3>
            <GroupSetupPreview
              initial={
                groupStatus?.configured
                  ? {
                      name: groupStatus.name ?? '',
                      members: (groupStatus.members ?? []).map((m) => ({ name: m.name, role: m.role, remote: m.remote })),
                    }
                  : undefined
              }
              onComplete={() => { setShowGroupSetup(false); loadGroupStatus(); }}
              onCancel={() => setShowGroupSetup(false)}
            />
          </div>
        </div>
      )}

      {showGroupWizard && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/40 backdrop-blur-sm pointer-events-auto">
          <div className="eh-surface-overlay p-6 rounded-xl shadow-2xl w-[620px] max-h-[88vh] overflow-y-auto border eh-border">
            <h3 className="text-lg font-bold mb-4 text-gray-900 dark:text-white">Create a product group</h3>
            <GroupWizard
              onComplete={() => { setShowGroupWizard(false); loadGroupStatus(); loadWorkspaces(); notifyWorkspaceSet(); }}
              onCancel={() => setShowGroupWizard(false)}
            />
          </div>
        </div>
      )}

      <div>
        <h3 className="text-base font-bold text-gray-800 dark:text-gray-200 mb-1">Users & Agents</h3>
        <p className="text-xs text-gray-500 mb-4">Available assignees for tickets.</p>
        <SimpleEditor items={users} setItems={setUsers} placeholder="Username" />
      </div>

      <div>
        <h3 className="text-base font-bold text-gray-800 dark:text-gray-200 mb-1">Project Keys</h3>
        <p className="text-xs text-gray-500 mb-4">Comma-separated prefixes for Ticket IDs (e.g. FLUX, ART).</p>
        <input
          className="w-full bg-gray-50 dark:bg-black/20 border border-gray-200 dark:border-white/10 rounded-lg px-3 py-2 outline-none focus:border-primary text-sm font-medium"
          value={projects} onChange={e => setProjects(e.target.value)} placeholder="FLUX, DEV..."
        />
      </div>

      <div className="col-span-2 rounded-2xl border border-gray-200 bg-gray-50/80 p-5 dark:border-white/10 dark:bg-black/10">
        <h3 className="text-base font-bold text-gray-800 dark:text-gray-200 mb-1">Docs Workspace</h3>
        <p className="text-xs text-gray-500 mb-5">Configure the active docs storage path and control who can create, edit, and delete markdown files.</p>

        <div className="mb-6">
          <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-gray-500">Docs Root Path</label>
          <input
            type="text"
            value={docsRoot}
            onChange={(event) => setDocsRoot(event.target.value)}
            placeholder=".docs"
            className="w-full max-w-sm rounded-lg border border-gray-300 px-3 py-2 text-sm shadow-sm transition-colors focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary dark:border-white/20 dark:bg-black/20 dark:text-white"
          />
          <p className="text-[11px] text-gray-500 mt-1">The path relative to your repository root where wiki markdown files are stored.</p>
        </div>

        <div className="grid gap-6 lg:grid-cols-[220px,minmax(0,1fr)]">
          <div>
            <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-gray-500">Edit Access</label>
            <select
              value={docsEditPermissions}
              onChange={(event) => setDocsEditPermissions(event.target.value as DocsEditPermissions)}
              className="w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm font-medium outline-none focus:border-primary dark:border-white/10 dark:bg-[#252630]"
            >
              <option value="all">All users</option>
              <option value="specified">Only specified users</option>
            </select>
          </div>

          <div>
            <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-gray-500">Allowed Editors</label>
            {users.filter((user) => user.name.trim()).length === 0 ? (
              <div className="rounded-xl border border-dashed border-gray-200 px-4 py-3 text-sm text-gray-500 dark:border-white/10">
                Add at least one user before restricting docs editing.
              </div>
            ) : (
              <div className={`flex flex-wrap gap-2 rounded-xl border border-gray-200 bg-white p-3 dark:border-white/10 dark:bg-black/20 ${docsEditPermissions === 'all' ? 'opacity-60' : ''}`}>
                {users.filter((user) => user.name.trim()).map((user) => {
                  const isSelected = docsAllowedUsers.includes(user.name);
                  return (
                    <label
                      key={user.name}
                      className={`flex cursor-pointer items-center gap-2 rounded-full border px-3 py-2 text-sm font-medium transition-colors ${isSelected ? 'border-primary bg-primary/10 text-primary' : 'border-gray-200 text-gray-600 dark:border-white/10 dark:text-gray-300'}`}
                    >
                      <input
                        type="checkbox"
                        checked={isSelected}
                        disabled={docsEditPermissions === 'all'}
                        onChange={(event) => {
                          if (event.target.checked) {
                            setDocsAllowedUsers((current) => [...current, user.name]);
                          } else {
                            setDocsAllowedUsers((current) => current.filter((name) => name !== user.name));
                          }
                        }}
                        className="h-4 w-4 rounded border-gray-300"
                      />
                      {user.name}
                    </label>
                  );
                })}
              </div>
            )}
            <p className="mt-2 text-xs text-gray-500">
              {docsEditPermissions === 'all'
                ? 'Everyone can edit docs. The selected list is ignored.'
                : 'Only the checked users can edit docs. Other users see a read-only experience.'}
            </p>
          </div>
        </div>
      </div>

      <div className="col-span-2 rounded-2xl border border-gray-200 bg-gray-50/80 p-5 dark:border-white/10 dark:bg-black/10">
        <h3 className="text-base font-bold text-gray-800 dark:text-gray-200 mb-1">Agent Progress Display</h3>
        <p className="text-xs text-gray-500 mb-5">Control how AI agent activity is displayed on task cards.</p>

        <div className="mb-6">
          <label className="flex items-center gap-3 cursor-pointer">
            <input
              type="checkbox"
              checked={agentProgressEnabled}
              onChange={(e) => setAgentProgressEnabled(e.target.checked)}
              className="h-5 w-5 rounded border-gray-300 text-primary focus:ring-primary"
            />
            <div>
              <p className="text-sm font-semibold text-gray-800 dark:text-gray-200">Show AI progress on cards</p>
              <p className="text-xs text-gray-500">Display live agent activity and latest progress messages directly on task cards</p>
            </div>
          </label>
        </div>

        <div className={agentProgressEnabled ? '' : 'opacity-50 pointer-events-none'}>
          <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-gray-500">Progress Display Delay</label>
          <input
            type="range"
            min={0}
            max={10}
            value={agentProgressDelay}
            onChange={(e) => setAgentProgressDelay(parseInt(e.target.value, 10))}
            disabled={!agentProgressEnabled}
            className="w-full max-w-xs"
          />
          <p className="mt-1 text-sm text-gray-700 dark:text-gray-300">
            {agentProgressDelay === 0 ? 'Show immediately' : `Show after ${agentProgressDelay} second${agentProgressDelay > 1 ? 's' : ''}`}
          </p>
          <p className="mt-1 text-xs text-gray-500">How long to wait before displaying progress updates on cards</p>
        </div>
      </div>
    </div>
  );
}
