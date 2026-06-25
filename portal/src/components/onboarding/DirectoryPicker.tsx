import { useState, useEffect, useCallback } from 'react';
import {
  FolderOpen,
  Folder,
  ArrowUp,
  HardDrive,
  AlertCircle,
  Loader2,
  X,
} from 'lucide-react';
import { browseDirectory, type DirEntry } from '../../api';

interface DirectoryPickerProps {
  /** Called with the chosen absolute directory path when the user confirms. */
  onPick: (path: string) => void;
  /** Called when the user dismisses without choosing. */
  onClose: () => void;
}

/**
 * In-app styled directory browser (FLUX-758) that replaces the native OS folder
 * dialog during onboarding. Read-only: navigate into child folders, walk up to
 * the parent, then select the currently-open folder. The chosen path is fed
 * into the existing folderPath input / setWorkspace flow — no file creation.
 */
export function DirectoryPicker({ onPick, onClose }: DirectoryPickerProps) {
  // cwd === '' means we are showing the roots list.
  const [cwd, setCwd] = useState('');
  const [parent, setParent] = useState<string | null>(null);
  const [entries, setEntries] = useState<DirEntry[]>([]);
  const [atRoots, setAtRoots] = useState(true);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const navigate = useCallback(async (path?: string) => {
    setLoading(true);
    setError(null);
    try {
      const result = await browseDirectory(path);
      setCwd(result.path);
      setParent(result.parent);
      setEntries(result.entries);
      // When listing roots the engine returns path '' and a `roots` array.
      setAtRoots(!result.path);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to read folder');
    } finally {
      setLoading(false);
    }
  }, []);

  // Initial load → roots.
  useEffect(() => {
    void navigate();
  }, [navigate]);

  // Esc closes.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="flex max-h-[80vh] w-full max-w-lg flex-col overflow-hidden rounded-2xl border border-gray-200 bg-white shadow-xl dark:border-white/10 dark:bg-gray-900"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center gap-2 border-b border-gray-200 px-5 py-4 dark:border-white/10">
          <FolderOpen className="h-5 w-5 shrink-0 text-primary" />
          <div className="min-w-0 flex-1">
            <h2 className="text-sm font-semibold text-gray-900 dark:text-white">
              Select a project folder
            </h2>
            <p className="truncate text-xs text-gray-500 dark:text-gray-400">
              {atRoots ? 'Choose a drive or folder to browse' : cwd}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="shrink-0 rounded-lg p-1 text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-600 dark:hover:bg-white/10 dark:hover:text-gray-200"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Body */}
        <div className="min-h-[14rem] flex-1 overflow-y-auto px-2 py-2">
          {error && (
            <div className="m-2 flex items-start gap-2 rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-700 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-400">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
              <span>{error}</span>
            </div>
          )}

          {loading ? (
            <div className="flex h-40 items-center justify-center text-gray-400">
              <Loader2 className="h-5 w-5 animate-spin" />
            </div>
          ) : (
            <ul className="flex flex-col">
              {/* Up row — to parent, or back to roots from a drive root. */}
              {!atRoots && (
                <li>
                  <button
                    type="button"
                    onClick={() => navigate(parent ?? undefined)}
                    className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm text-gray-600 transition-colors hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-white/5"
                  >
                    <ArrowUp className="h-4 w-4 shrink-0 text-gray-400" />
                    <span className="text-gray-500 dark:text-gray-400">
                      {parent ? 'Up one level' : 'Back to drives'}
                    </span>
                  </button>
                </li>
              )}

              {entries.length === 0 && !error && (
                <li className="px-3 py-6 text-center text-xs text-gray-400">
                  No subfolders here.
                </li>
              )}

              {entries.map((entry) => (
                <li key={entry.path}>
                  <button
                    type="button"
                    onClick={() => navigate(entry.path)}
                    className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm text-gray-700 transition-colors hover:bg-gray-100 dark:text-gray-200 dark:hover:bg-white/5"
                  >
                    {atRoots ? (
                      <HardDrive className="h-4 w-4 shrink-0 text-primary/70" />
                    ) : (
                      <Folder className="h-4 w-4 shrink-0 text-primary/70" />
                    )}
                    <span className="truncate">{entry.name}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between gap-3 border-t border-gray-200 px-5 py-4 dark:border-white/10">
          <button
            type="button"
            onClick={onClose}
            className="rounded-xl px-3 py-2 text-sm font-medium text-gray-600 transition-colors hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-white/10"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={atRoots || loading || !cwd}
            onClick={() => onPick(cwd)}
            className="flex h-10 items-center justify-center rounded-xl bg-primary px-5 text-sm font-semibold text-white shadow-sm transition-all hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-50"
            title={atRoots ? 'Open a drive or folder first' : `Select ${cwd}`}
          >
            Select this folder
          </button>
        </div>
      </div>
    </div>
  );
}
