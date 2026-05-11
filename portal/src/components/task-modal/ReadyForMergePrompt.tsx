import { memo } from 'react';
import { AlertCircle, Bot, Maximize2, RotateCcw, SendHorizontal, X } from 'lucide-react';
import { CodeReviewButton } from '../CodeReviewButton';
import type { ReviewPersona } from '../CodeReviewButton';

export interface ReadyForMergePromptProps {
  taskId: string;
  readyForMergeBanner: React.ReactNode;
  saving: boolean;
  finishBusy: boolean;
  finishError: string;
  returnToWorkOpen: boolean;
  reviewBusy: boolean;
  reviewError: string;
  cliSessionActive: boolean;
  isFullView: boolean;
  returnToWorkReasonRef: React.RefObject<HTMLTextAreaElement | null>;
  onReturnToWork: () => void;
  onReturnToWorkAndLaunch: () => void;
  onFinish: () => void;
  onCodeReview: (persona: ReviewPersona) => void;
  onSetReturnToWorkOpen: (open: boolean) => void;
  onSetIsFullView: (v: boolean) => void;
  onSetIsPromptModalOpen: (open: boolean) => void;
}

export const ReadyForMergePrompt = memo(function ReadyForMergePrompt({
  taskId,
  readyForMergeBanner,
  saving,
  finishBusy,
  finishError,
  returnToWorkOpen,
  reviewBusy,
  reviewError,
  cliSessionActive,
  isFullView,
  returnToWorkReasonRef,
  onReturnToWork,
  onReturnToWorkAndLaunch,
  onFinish,
  onCodeReview,
  onSetReturnToWorkOpen,
  onSetIsFullView,
  onSetIsPromptModalOpen,
}: ReadyForMergePromptProps) {
  return (
    <div className="rounded-2xl border border-amber-200 bg-gradient-to-br from-amber-50 to-white p-5 shadow-sm dark:border-amber-500/30 dark:from-amber-900/20 dark:to-[#1a1b23]">
      <div className="mb-4 flex items-start gap-3">
        <div className="rounded-xl bg-amber-100 p-2 text-amber-600 dark:bg-amber-500/10 dark:text-amber-300">
          <AlertCircle className="h-5 w-5" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-[11px] font-bold uppercase tracking-[0.18em] text-amber-600 dark:text-amber-300">Ready for final review</p>
          <h3 className="mt-1 text-lg font-semibold text-gray-900 dark:text-gray-100">Review and finish the ticket</h3>
          <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">After reviewing the diff and ticket details, click <span className="font-semibold text-gray-900 dark:text-gray-100">Tell agent to finish</span> to send the close command directly to the agent.</p>
        </div>
      </div>

      {readyForMergeBanner}

      <div className="mt-4 grid gap-4 lg:grid-cols-[minmax(0,1fr)_220px]">
        <div className="rounded-xl border border-gray-200 bg-white/80 p-4 text-sm text-gray-600 dark:border-white/10 dark:bg-black/20 dark:text-gray-300">
          <p className="font-semibold text-gray-900 dark:text-gray-100">Suggested command</p>
          <p className="mt-2 rounded-lg bg-gray-100 px-3 py-2 font-mono text-sm text-gray-800 dark:bg-black/30 dark:text-gray-200">finish {taskId}</p>
          <p className="mt-3 text-xs text-gray-500 dark:text-gray-400">This status is configurable in Settings, but the finalization handoff is always driven by the agent command after your review.</p>
          {returnToWorkOpen && (
            <div className="mt-4 space-y-2">
              <label className="block text-xs font-bold uppercase tracking-wider text-gray-400">Reason for returning</label>
              <textarea
                autoFocus
                ref={returnToWorkReasonRef}
                className="h-24 w-full resize-none rounded-xl border border-gray-200 bg-white px-3 py-2 text-sm outline-none placeholder:text-gray-400 focus:border-primary dark:border-white/10 dark:bg-black/30"
                placeholder="Describe what needs to be changed..."
              />
              <div className="flex flex-col gap-2">
                <div className="flex gap-2">
                  <button
                    disabled={saving}
                    onClick={onReturnToWork}
                    className="flex flex-1 items-center justify-center gap-2 rounded-lg border border-amber-300 bg-amber-50 px-4 py-2 text-sm font-semibold text-amber-700 transition-colors hover:bg-amber-100 disabled:opacity-50 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-300 dark:hover:bg-amber-500/20"
                  >
                    <RotateCcw className="h-4 w-4" />
                    {saving ? 'Returning...' : 'Return to work'}
                  </button>
                  <button
                    onClick={() => { onSetReturnToWorkOpen(false); if (returnToWorkReasonRef.current) returnToWorkReasonRef.current.value = ''; }}
                    className="rounded-lg border border-gray-200 px-3 py-2 text-sm font-medium text-gray-600 transition-colors hover:bg-gray-100 dark:border-white/10 dark:text-gray-300 dark:hover:bg-white/5"
                  >
                    Cancel
                  </button>
                </div>
                <button
                  disabled={saving}
                  onClick={onReturnToWorkAndLaunch}
                  className="flex w-full items-center justify-center gap-2 rounded-lg bg-amber-500 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-amber-600 disabled:opacity-50"
                >
                  <Bot className="h-4 w-4" />
                  {saving ? 'Returning...' : 'Return + Launch Agent'}
                </button>
              </div>
            </div>
          )}
        </div>

        <div className="space-y-2 rounded-xl border border-gray-200 bg-white/80 p-4 dark:border-white/10 dark:bg-black/20">
          <button
              disabled={finishBusy || saving}
              onClick={onFinish}
              className="flex w-full items-center justify-center gap-2 rounded-lg bg-primary px-4 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-50"
            >
              <SendHorizontal className="h-4 w-4" />
              {finishBusy ? 'Sending…' : 'Tell agent to finish'}
            </button>
            {finishError && (
              <p className="text-xs text-red-600 dark:text-red-400">{finishError}</p>
            )}
            <button
              onClick={() => void navigator.clipboard.writeText(`finish ${taskId}`)}
              className="flex w-full items-center justify-center gap-2 rounded-lg border border-gray-200 px-4 py-2 text-sm font-medium text-gray-600 transition-colors hover:bg-gray-100 dark:border-white/10 dark:text-gray-300 dark:hover:bg-white/5"
            >
              Copy finish command
            </button>
            <button
              disabled={saving}
              onClick={() => onSetReturnToWorkOpen(true)}
              className="flex w-full items-center justify-center gap-2 rounded-lg border border-gray-200 px-4 py-2 text-sm font-medium text-gray-600 transition-colors hover:bg-gray-100 disabled:opacity-50 dark:border-white/10 dark:text-gray-300 dark:hover:bg-white/5"
            >
              <RotateCcw className="h-4 w-4" />
              Return to work
            </button>
            <CodeReviewButton
              busy={reviewBusy}
              disabled={saving || cliSessionActive}
              onReview={onCodeReview}
            />
            {reviewError && (
              <p className="text-xs text-red-600 dark:text-red-400">{reviewError}</p>
            )}
            <button
              onClick={() => isFullView ? onSetIsPromptModalOpen(false) : onSetIsFullView(true)}
              className="flex w-full items-center justify-center gap-2 rounded-lg border border-gray-200 px-4 py-2 text-sm font-medium text-gray-600 transition-colors hover:bg-gray-100 dark:border-white/10 dark:text-gray-300 dark:hover:bg-white/5"
            >
              {isFullView ? <X className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}
              {isFullView ? 'Close window' : 'Open full ticket'}
            </button>
        </div>
      </div>
    </div>
  );
});
