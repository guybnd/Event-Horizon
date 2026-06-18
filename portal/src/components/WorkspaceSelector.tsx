import { useState } from 'react';
import { FolderOpen, Rocket, AlertCircle } from 'lucide-react';
import { setWorkspace, pickWorkspaceFolder } from '../api';
import { useApp } from '../AppContext';

export function WorkspaceSelector() {
  const { notifyWorkspaceSet } = useApp();
  const [folderPath, setFolderPath] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [picking, setPicking] = useState(false);

  async function handleBrowse() {
    setPicking(true);
    try {
      const picked = await pickWorkspaceFolder();
      if (picked) setFolderPath(picked);
    } finally {
      setPicking(false);
    }
  }

  async function handleOpen(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = folderPath.trim();
    if (!trimmed) return;
    setError(null);
    setLoading(true);
    try {
      await setWorkspace(trimmed);
      notifyWorkspaceSet();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to open workspace.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-gray-50 dark:bg-bg-dark p-8">
      <div className="w-full max-w-md">
        <div className="mb-8 flex flex-col items-center gap-3 text-center">
          <div className="flex items-center justify-center rounded-2xl bg-primary/10 p-4">
            <Rocket className="h-8 w-8 text-primary" />
          </div>
          <h1 className="text-2xl font-bold tracking-tight text-gray-900 dark:text-white">
            Event Horizon
          </h1>
          <p className="text-sm text-gray-500 dark:text-gray-400">
            Open a project folder to get started. The folder must contain a{' '}
            <code className="rounded bg-gray-100 px-1 py-0.5 font-mono text-xs dark:bg-white/10">
              .flux/
            </code>{' '}
            or{' '}
            <code className="rounded bg-gray-100 px-1 py-0.5 font-mono text-xs dark:bg-white/10">
              .flux-store/
            </code>{' '}
            directory. Run{' '}
            <code className="rounded bg-gray-100 px-1 py-0.5 font-mono text-xs dark:bg-white/10">
              event-horizon init
            </code>{' '}
            in a project to create one.
          </p>
        </div>

        <form onSubmit={handleOpen} className="flex flex-col gap-3">
          <div className="flex items-center gap-2 rounded-2xl border border-gray-200 bg-white px-4 py-3 shadow-sm dark:border-white/10 dark:bg-white/5">
            <FolderOpen className="h-5 w-5 shrink-0 text-gray-400" />
            <input
              autoFocus
              type="text"
              value={folderPath}
              onChange={(e) => setFolderPath(e.target.value)}
              placeholder={
                navigator.platform.toLowerCase().includes('win')
                  ? 'C:\\Users\\you\\my-project'
                  : '/home/you/my-project'
              }
              className="w-full bg-transparent text-sm text-gray-900 outline-none placeholder:text-gray-400 dark:text-white"
            />
            <button
              type="button"
              onClick={handleBrowse}
              disabled={picking}
              className="shrink-0 rounded-lg border border-gray-200 bg-gray-50 px-3 py-1 text-xs font-medium text-gray-600 transition-colors hover:bg-gray-100 disabled:opacity-50 dark:border-white/10 dark:bg-white/5 dark:text-gray-300 dark:hover:bg-white/10"
            >
              {picking ? '…' : 'Browse'}
            </button>
          </div>

          {error && (
            <div className="flex items-start gap-2 rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-700 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-400">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
              <span>{error}</span>
            </div>
          )}

          <button
            type="submit"
            disabled={loading || !folderPath.trim()}
            className="flex h-11 items-center justify-center rounded-2xl bg-primary px-6 text-sm font-semibold text-white shadow-sm transition-all hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-50"
          >
            {loading ? 'Opening…' : 'Open Project'}
          </button>
        </form>
      </div>
    </div>
  );
}
