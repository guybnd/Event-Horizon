import { RotateCcw, ExternalLink } from 'lucide-react';
import type { Task } from '../../types';
import { useApp } from '../../AppContext';

/**
 * Banner on a retry ticket (FLUX-593): points back at the merged PR it retries. Reads the
 * ticket's `retries` link (the first instance of the typed-relationships model, epic FLUX-596).
 */
export function RetryBanner({ task, className = '' }: { task: Partial<Task>; className?: string }) {
  const { openTaskFullView, taskById } = useApp();
  const retry = (task.links ?? []).find((l) => l.type === 'retries');
  if (!retry) return null;
  const target = taskById.get(retry.target);
  return (
    <div className={`flex items-center gap-2 rounded-lg border border-violet-200 bg-violet-50 px-3 py-2 text-xs text-violet-800 dark:border-violet-500/30 dark:bg-violet-500/10 dark:text-violet-200 ${className}`}>
      <RotateCcw className="h-3.5 w-3.5 shrink-0" />
      <span className="flex-1">
        Retry of <span className="font-semibold">{retry.label || retry.target}</span> — that PR merged, but the work is being continued here.
      </span>
      {target && (
        <button
          onClick={() => openTaskFullView(target)}
          className="flex shrink-0 items-center gap-1 rounded-md border border-violet-300 px-2 py-0.5 font-semibold transition-colors hover:bg-violet-100 dark:border-violet-500/40 dark:hover:bg-violet-500/15"
        >
          <ExternalLink className="h-3 w-3" /> View PR
        </button>
      )}
    </div>
  );
}
