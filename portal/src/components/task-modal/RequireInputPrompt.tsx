import { AlertCircle, Maximize2, SendHorizontal } from 'lucide-react';
import type { ReactNode, RefObject } from 'react';

interface RequireInputPromptProps {
  hasActiveSessionForPrompt: boolean;
  isSwimlaneOnly: boolean;
  requireInputBanner: ReactNode;
  groomingBanner: ReactNode;
  commentRef: RefObject<HTMLTextAreaElement | null>;
  requireInputDraft: string;
  setRequireInputDraft: (value: string) => void;
  saving: boolean;
  submitRequireInputResponse: () => void;
  setIsFullView: (value: boolean) => void;
  responseDestination: string;
  setResponseDestination: (value: string) => void;
  requireInputDestinations: string[];
}

export function RequireInputPrompt({
  hasActiveSessionForPrompt,
  isSwimlaneOnly,
  requireInputBanner,
  groomingBanner,
  commentRef,
  requireInputDraft,
  setRequireInputDraft,
  saving,
  submitRequireInputResponse,
  setIsFullView,
  responseDestination,
  setResponseDestination,
  requireInputDestinations,
}: RequireInputPromptProps) {
  return (
    <div className="rounded-2xl border border-amber-200 bg-gradient-to-br from-amber-50 to-white p-5 shadow-sm dark:border-amber-500/30 dark:from-amber-900/20 dark:to-[#1a1b23]">
      <div className="mb-4 flex items-start gap-3">
        <div className="rounded-xl bg-amber-100 p-2 text-amber-600 dark:bg-amber-500/10 dark:text-amber-300">
          <AlertCircle className="h-5 w-5" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-[11px] font-bold uppercase tracking-[0.18em] text-amber-600 dark:text-amber-300">Awaiting your input</p>
          <h3 className="mt-1 text-lg font-semibold text-gray-900 dark:text-gray-100">
            {hasActiveSessionForPrompt ? 'Reply to the agent' : isSwimlaneOnly ? 'Respond to clear the block' : 'Respond and route the ticket'}
          </h3>
          <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">
            {hasActiveSessionForPrompt
              ? 'Your response will be sent directly to the running agent session.'
              : isSwimlaneOnly
              ? 'Answer the question below. The ticket stays in its current column.'
              : 'Answer the pending question, then choose where the ticket should go next.'}
          </p>
        </div>
      </div>
      <div className="space-y-4">
        {requireInputBanner}
        {groomingBanner}
      </div>
      <div className={`mt-4 grid gap-4 ${!isSwimlaneOnly && !hasActiveSessionForPrompt ? 'lg:grid-cols-[minmax(0,1fr)_180px]' : ''}`}>
        <div>
          <label className="mb-1.5 block text-xs font-bold uppercase tracking-wider text-gray-400">Your response</label>
          <textarea
            ref={commentRef}
            autoFocus
            className="h-44 w-full resize-none rounded-xl border border-amber-200 bg-white px-4 py-3 text-sm outline-none placeholder:text-gray-400 focus:border-primary dark:border-amber-500/20 dark:bg-black/30"
            value={requireInputDraft}
            onChange={(event) => setRequireInputDraft(event.target.value)}
            placeholder="Type the answer you want to send back..."
          />
          {(isSwimlaneOnly || hasActiveSessionForPrompt) && (
            <div className="mt-3 flex items-center gap-3">
              <button
                disabled={saving || !requireInputDraft.trim()}
                onClick={submitRequireInputResponse}
                className="flex items-center gap-2 rounded-lg bg-primary px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-50"
              >
                <SendHorizontal className="h-4 w-4" />
                {saving ? 'Sending...' : hasActiveSessionForPrompt ? 'Send to Agent' : 'Send Response'}
              </button>
              <button
                onClick={() => setIsFullView(true)}
                className="flex items-center gap-2 rounded-lg border border-gray-200 px-4 py-2 text-sm font-medium text-gray-600 transition-colors hover:bg-gray-100 dark:border-white/10 dark:text-gray-300 dark:hover:bg-white/5"
              >
                <Maximize2 className="h-4 w-4" />
                Open full ticket
              </button>
            </div>
          )}
        </div>
        {!isSwimlaneOnly && !hasActiveSessionForPrompt && (
          <div className="space-y-4 rounded-xl border border-gray-200 bg-white/80 p-4 dark:border-white/10 dark:bg-black/20">
            <div>
              <label className="mb-1.5 block text-xs font-bold uppercase tracking-wider text-gray-400">Send ticket to</label>
              <select
                className="w-full cursor-pointer rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm font-medium outline-none focus:border-primary dark:border-white/10 dark:bg-[#252630]"
                value={responseDestination}
                onChange={(event) => setResponseDestination(event.target.value)}
              >
                {requireInputDestinations.map((item) => (
                  <option key={item} value={item}>{item}</option>
                ))}
              </select>
            </div>
            <div className="space-y-2">
              <button
                disabled={saving || !requireInputDraft.trim()}
                onClick={submitRequireInputResponse}
                className="flex w-full items-center justify-center gap-2 rounded-lg bg-primary px-4 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-50"
              >
                <SendHorizontal className="h-4 w-4" />
                {saving ? 'Submitting...' : 'Send Response'}
              </button>
              <button
                onClick={() => setIsFullView(true)}
                className="flex w-full items-center justify-center gap-2 rounded-lg border border-gray-200 px-4 py-2 text-sm font-medium text-gray-600 transition-colors hover:bg-gray-100 dark:border-white/10 dark:text-gray-300 dark:hover:bg-white/5"
              >
                <Maximize2 className="h-4 w-4" />
                Open full ticket
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
