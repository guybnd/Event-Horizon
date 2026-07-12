import { Loader2 } from 'lucide-react';
import { useEscapeKey } from '../hooks/useEscapeKey';

/**
 * Shared destructive-confirm dialog behind every "Discard changes" control (FLUX-1333) — the
 * Changes window, the chat diff panel, and the uncommitted stoplight. Parents mount it only while
 * open; it registers on the shared Escape stack (FLUX-1022) so ESC closes this dialog before the
 * surface underneath it. Names every file it is about to touch, and always states the two limits
 * of the operation: uncommitted changes only (a file with committed + uncommitted work keeps the
 * committed part), and no undo.
 */
export function ConfirmDiscardDialog({
  files,
  scopeLabel,
  busy,
  onCancel,
  onConfirm,
}: {
  /** Repo-relative paths being discarded (all are named in the dialog). */
  files: string[];
  /** Where the discard applies — ticket/branch label or 'Main tree'. */
  scopeLabel?: string;
  busy?: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  useEscapeKey(() => { if (!busy) onCancel(); });
  const many = files.length > 1;
  return (
    <div className="pointer-events-auto fixed inset-0 z-[60] flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="w-[440px] rounded-xl border border-gray-200 bg-white p-6 shadow-2xl dark:border-white/10 dark:bg-[#1a1b23]">
        <h3 className="mb-2 text-lg font-bold text-red-500">Discard {many ? `changes to ${files.length} files` : 'changes'}?</h3>
        <p className="mb-2 text-sm text-gray-500">
          {many ? 'These files' : 'This file'}
          {scopeLabel ? <> in <span className="font-medium text-gray-700 dark:text-gray-300">{scopeLabel}</span></> : null}
          {' '}will be restored to the last committed state (a new file is deleted from disk):
        </p>
        <ul className="mb-3 max-h-32 overflow-y-auto rounded-lg bg-gray-50 px-3 py-2 font-mono text-xs text-gray-600 dark:bg-white/5 dark:text-gray-300">
          {files.map((f) => (
            <li key={f} className="truncate" title={f}>{f}</li>
          ))}
        </ul>
        <p className="mb-6 text-xs text-gray-500">
          Only uncommitted changes are discarded — committed work is untouched. This cannot be undone.
        </p>
        <div className="flex justify-end gap-3">
          <button
            onClick={onCancel}
            disabled={busy}
            className="cursor-pointer rounded-lg px-4 py-2 text-sm font-medium transition-colors hover:bg-gray-100 dark:hover:bg-white/5"
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            disabled={busy}
            className="flex cursor-pointer items-center gap-2 rounded-lg bg-red-500 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-red-600 disabled:opacity-60"
          >
            {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            {busy ? 'Discarding…' : many ? `Discard ${files.length} files` : 'Discard'}
          </button>
        </div>
      </div>
    </div>
  );
}
