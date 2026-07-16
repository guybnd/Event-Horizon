// FLUX-1359: the styled replacement for the native `window.prompt`/`alert` that `changeStatus` /
// `finishViaEngine` used to fire directly. Electron's renderer doesn't implement `window.prompt` —
// calling it throws (no polyfill in `electron/`) — so those flows silently no-op there. Modeled on
// StartTaskPrompt/FinishMergeConfirm chrome (fixed inset-0 z-[9999], dark card).
import { useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { useEscapeKey } from '../../hooks/useEscapeKey';

export type PromptModalState =
  | { mode: 'input'; title: string; message?: string; defaultValue?: string; submitLabel?: string; multiline?: boolean }
  | { mode: 'error'; title: string; message: string };

interface PromptModalProps {
  state: PromptModalState;
  busy: boolean;
  onSubmit: (value: string) => void;
  onCancel: () => void;
}

export function PromptModal({ state, busy, onSubmit, onCancel }: PromptModalProps) {
  // FLUX-1022: ESC cancels, same as clicking the backdrop or the Cancel/Close button.
  // FLUX-1457: ignoreWhenTyping defaults to true, which made Escape a no-op in this modal's
  // default state (input always autofocused) — a regression from window.prompt, which does
  // cancel on Escape.
  useEscapeKey(onCancel, { enabled: !busy, ignoreWhenTyping: false });
  const [value, setValue] = useState(state.mode === 'input' ? (state.defaultValue ?? '') : '');

  const dismiss = () => { if (!busy) onCancel(); };

  return (
    <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/40 backdrop-blur-sm" onClick={dismiss}>
      <div
        role="dialog"
        aria-modal="true"
        className="w-96 rounded-xl border border-gray-200 bg-white p-5 shadow-2xl dark:border-white/10 dark:bg-[#1a1b23]"
        onClick={(e) => e.stopPropagation()}
      >
        {state.mode === 'input' && (
          <>
            <p className="mb-1 text-sm font-semibold text-gray-900 dark:text-white">{state.title}</p>
            {state.message && (
              <p className="mb-3 max-h-40 overflow-y-auto whitespace-pre-wrap break-words text-xs text-gray-500 dark:text-gray-400">
                {state.message}
              </p>
            )}
            {state.multiline ? (
              <textarea
                autoFocus
                value={value}
                onChange={(e) => setValue(e.target.value)}
                rows={4}
                className="w-full resize-none rounded-lg border border-gray-200 bg-white px-2.5 py-2 text-xs text-gray-900 outline-none focus:border-primary dark:border-white/10 dark:bg-white/5 dark:text-white"
              />
            ) : (
              <input
                autoFocus
                type="text"
                value={value}
                onChange={(e) => setValue(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' && value.trim()) onSubmit(value.trim()); }}
                className="w-full rounded-lg border border-gray-200 bg-white px-2.5 py-2 text-xs text-gray-900 outline-none focus:border-primary dark:border-white/10 dark:bg-white/5 dark:text-white"
              />
            )}
            <div className="mt-4 flex justify-end gap-2">
              <button
                onClick={dismiss}
                disabled={busy}
                className="rounded-md px-3 py-1.5 text-xs font-medium text-gray-500 hover:text-gray-700 disabled:opacity-50 dark:text-gray-400 dark:hover:text-gray-200"
              >
                Cancel
              </button>
              <button
                onClick={() => onSubmit(value.trim())}
                disabled={busy || !value.trim()}
                className="rounded-md bg-primary px-3 py-1.5 text-xs font-semibold text-white hover:bg-primary-hover disabled:opacity-50"
              >
                {busy ? 'Working…' : (state.submitLabel ?? 'Submit')}
              </button>
            </div>
          </>
        )}

        {state.mode === 'error' && (
          <>
            <p className="mb-1 flex items-center gap-1.5 text-sm font-semibold text-gray-900 dark:text-white">
              <AlertTriangle className="h-4 w-4 text-red-500" />
              {state.title}
            </p>
            <p className="mb-4 max-h-40 overflow-y-auto whitespace-pre-wrap break-words text-xs text-gray-500 dark:text-gray-400">
              {state.message}
            </p>
            <div className="flex justify-end">
              <button
                onClick={onCancel}
                className="rounded-md bg-primary px-3 py-1.5 text-xs font-semibold text-white hover:bg-primary-hover"
              >
                Close
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
