// FLUX-752: a compact, informational "Awaiting your input" strip for the shared chat surface
// (dock + in-modal pane). Mirrors the full-modal RequireInputPrompt header styling but is
// display-only — the reply flows through the existing composer / FLUX-643 quick-reply chips
// below, so there is no textarea, routing dropdown, or send button here. Renders nothing when
// there is no agent question to surface.

import { AlertCircle } from 'lucide-react';
import type { Task } from '../../types';
import { latestQuestionText } from './chatQuickReplies';

interface ChatRequireInputBannerProps {
  task: Task;
}

export function ChatRequireInputBanner({ task }: ChatRequireInputBannerProps) {
  const question = latestQuestionText(task);
  if (!question) return null;

  return (
    <div className="flex items-start gap-3 rounded-xl border border-amber-200 bg-gradient-to-br from-amber-50 to-white p-3 dark:border-amber-500/30 dark:from-amber-900/20 dark:to-[#1a1b23]">
      <div className="rounded-lg bg-amber-100 p-1.5 text-amber-600 dark:bg-amber-500/10 dark:text-amber-300">
        <AlertCircle className="h-4 w-4" />
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-amber-600 dark:text-amber-300">
          Awaiting your input
        </p>
        <p className="mt-1 whitespace-pre-wrap break-words text-sm text-gray-700 dark:text-gray-300">{question}</p>
      </div>
    </div>
  );
}
