import { useState, useEffect } from 'react';
import type { UserDef, DocsEditPermissions } from '../../types';
import { SimpleEditor } from './shared';
import { setWorkspace as apiSetWorkspace, pickWorkspaceFolder, fetchStorageMode, migrateStorage, restoreStorage } from '../../api';

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
}: WorkspaceSectionProps) {
  const [newWorkspacePath, setNewWorkspacePath] = useState('');
  const [workspaceSwitchError, setWorkspaceSwitchError] = useState<string | null>(null);
  const [workspaceSwitching, setWorkspaceSwitching] = useState(false);
  const [workspacePicking, setWorkspacePicking] = useState(false);

  const [storageMode, setStorageMode] = useState<'in-repo' | 'orphan' | null>(null);
  const [storageBusy, setStorageBusy] = useState(false);
  const [storageError, setStorageError] = useState<string | null>(null);

  useEffect(() => {
    if (!workspacePath) return;
    fetchStorageMode().then((r) => setStorageMode(r.mode)).catch(() => setStorageMode('in-repo'));
  }, [workspacePath]);

  return (
    <div className="grid grid-cols-2 gap-10">
      <div className="col-span-2 rounded-2xl border border-gray-200 bg-gray-50/80 p-5 dark:border-white/10 dark:bg-black/10">
        <h3 className="text-base font-bold text-gray-800 dark:text-gray-200 mb-1">Project Folder</h3>
        <p className="text-xs text-gray-500 mb-4">Switch to a different project. The folder must contain a <code className="font-mono bg-gray-100 dark:bg-white/10 px-1 rounded">.flux/</code> directory.</p>
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
          <h3 className="text-base font-bold text-gray-800 dark:text-gray-200 mb-1">Storage Mode</h3>
          <p className="text-xs text-gray-500 mb-4">
            Tickets live in <code className="font-mono bg-gray-100 dark:bg-white/10 px-1 rounded">.flux/</code> by default.
            Enable Git Sync to move them to an orphan <code className="font-mono bg-gray-100 dark:bg-white/10 px-1 rounded">flux-data</code> branch,
            keeping ticket history off your main branch and enabling multi-machine sync.
          </p>
          <div className="flex items-center gap-4 flex-wrap">
            <span className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-semibold ${
              storageMode === 'orphan'
                ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400'
                : 'bg-gray-100 text-gray-600 dark:bg-white/10 dark:text-gray-300'
            }`}>
              <span className={`w-1.5 h-1.5 rounded-full ${storageMode === 'orphan' ? 'bg-green-500' : 'bg-gray-400'}`} />
              {storageMode === null ? 'Loading…' : storageMode === 'orphan' ? 'Git Sync (orphan branch)' : 'In-Repo (.flux/)'}
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
            <p className="mt-2 text-xs text-red-500">{storageError}</p>
          )}
          {storageMode === 'orphan' && (
            <p className="mt-3 text-xs text-gray-500">
              Changes are auto-committed and pushed to <code className="font-mono bg-gray-100 dark:bg-white/10 px-1 rounded">flux-data</code> after 30 seconds of inactivity.
            </p>
          )}
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
    </div>
  );
}
