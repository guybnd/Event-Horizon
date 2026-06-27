// FLUX-815: the styled, actionable replacement for the native window.confirm/alert that
// `finishViaMerge` used to fire. The card Finish button can hit the shared-PR finish guard
// (FLUX-569) — a deliberate safety gate that sweeps non-Done branch siblings to Done. The old
// alert() reframed that as "Failed to finish …" and offered only OK, a dead end (the force the
// message instructed didn't exist as a button). This modal renders the engine's structured
// decision instead: it lists the siblings (from `sharedNonDone`, never the prose) and offers the
// real escalation. Modeled on StartTaskPrompt's chrome (fixed inset-0 z-[9999], dark card).
import { GitMerge, AlertTriangle } from 'lucide-react';
import type { Task } from '../../types';
import type { SharedNonDoneSibling } from '../../api';

/**
 * The merge decision the modal is showing. `confirm` is the plain pre-merge prompt; `shared`
 * surfaces the FLUX-569 guard with the bundled siblings; `parked` surfaces the parked-session
 * block (FLUX-636) with a Stop & merge escalation; `error` renders any other failure inline.
 */
export type FinishMergeState =
  | { mode: 'confirm' }
  | { mode: 'shared'; sharedNonDone: SharedNonDoneSibling[] }
  | { mode: 'parked'; message: string }
  | { mode: 'error'; message: string };

/** The merge-option delta a confirm action requests; the hook accumulates these across escalations. */
export type MergeConfirmOpts = { force?: boolean; stopParkedSessions?: boolean };

interface FinishMergeConfirmProps {
  task: Task;
  state: FinishMergeState;
  busy: boolean;
  onConfirm: (opts: MergeConfirmOpts) => void;
  onCancel: () => void;
}

export function FinishMergeConfirm({ task, state, busy, onConfirm, onCancel }: FinishMergeConfirmProps) {
  // Don't let a backdrop/Cancel click dismiss the modal while a merge request is in flight.
  const dismiss = () => { if (!busy) onCancel(); };
  const cancelBtn = (
    <button
      onClick={dismiss}
      disabled={busy}
      className="rounded-md px-3 py-1.5 text-xs font-medium text-gray-500 hover:text-gray-700 disabled:opacity-50 dark:text-gray-400 dark:hover:text-gray-200"
    >
      Cancel
    </button>
  );

  return (
    <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/40 backdrop-blur-sm" onClick={dismiss}>
      <div
        role="dialog"
        aria-modal="true"
        className="w-96 rounded-xl border border-gray-200 bg-white p-5 shadow-2xl dark:border-white/10 dark:bg-[#1a1b23]"
        onClick={(e) => e.stopPropagation()}
      >
        {state.mode === 'confirm' && (
          <>
            <p className="mb-1 text-sm font-semibold text-gray-900 dark:text-white">Finish {task.id}?</p>
            <p className="mb-4 text-xs text-gray-500 dark:text-gray-400">
              Merge {task.id}'s open PR and mark it Done. This can't be undone.
            </p>
            <div className="flex justify-end gap-2">
              {cancelBtn}
              <button
                onClick={() => onConfirm({})}
                disabled={busy}
                className="flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-xs font-semibold text-white hover:bg-primary-hover disabled:opacity-50"
              >
                <GitMerge className="h-3 w-3" />
                {busy ? 'Merging…' : 'Merge & finish'}
              </button>
            </div>
          </>
        )}

        {state.mode === 'shared' && (
          <>
            <p className="mb-1 text-sm font-semibold text-gray-900 dark:text-white">Merge the whole shared PR?</p>
            <p className="mb-3 text-xs text-gray-500 dark:text-gray-400">
              {task.id} shares its branch with other tickets. Merging it now also advances these unfinished
              ticket(s) to Done — there's no undo:
            </p>
            <ul className="mb-4 max-h-40 space-y-1 overflow-y-auto rounded-md bg-amber-50 p-2.5 text-[11px] dark:bg-amber-500/10">
              {state.sharedNonDone.map((s) => (
                <li key={s.id} className="flex items-start gap-2 text-amber-800 dark:text-amber-200">
                  <AlertTriangle className="mt-px h-3.5 w-3.5 shrink-0" />
                  <span className="min-w-0">
                    <span className="font-semibold">{s.id}</span>
                    <span className="text-amber-700/80 dark:text-amber-300/80"> ({s.status})</span>
                    {s.title && <span className="block truncate text-amber-700/70 dark:text-amber-300/70">{s.title}</span>}
                  </span>
                </li>
              ))}
            </ul>
            <div className="flex justify-end gap-2">
              {cancelBtn}
              <button
                onClick={() => onConfirm({ force: true })}
                disabled={busy}
                className="flex items-center gap-1.5 rounded-md bg-amber-500 px-3 py-1.5 text-xs font-semibold text-white hover:bg-amber-600 disabled:opacity-50"
              >
                <GitMerge className="h-3 w-3" />
                {busy ? 'Merging…' : 'Merge all & finish'}
              </button>
            </div>
          </>
        )}

        {state.mode === 'parked' && (
          <>
            <p className="mb-1 text-sm font-semibold text-gray-900 dark:text-white">Stop parked session(s) and merge?</p>
            <p className="mb-4 text-xs text-gray-500 dark:text-gray-400">{state.message}</p>
            <div className="flex justify-end gap-2">
              {cancelBtn}
              <button
                onClick={() => onConfirm({ stopParkedSessions: true })}
                disabled={busy}
                className="flex items-center gap-1.5 rounded-md bg-amber-500 px-3 py-1.5 text-xs font-semibold text-white hover:bg-amber-600 disabled:opacity-50"
              >
                <GitMerge className="h-3 w-3" />
                {busy ? 'Merging…' : 'Stop & merge'}
              </button>
            </div>
          </>
        )}

        {state.mode === 'error' && (
          <>
            <p className="mb-1 flex items-center gap-1.5 text-sm font-semibold text-gray-900 dark:text-white">
              <AlertTriangle className="h-4 w-4 text-red-500" />
              Couldn't finish {task.id}
            </p>
            <p className="mb-4 whitespace-pre-wrap break-words text-xs text-gray-500 dark:text-gray-400">{state.message}</p>
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
