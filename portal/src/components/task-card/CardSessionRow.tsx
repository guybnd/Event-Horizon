import { Bot } from 'lucide-react';
import type { Task } from '../../types';
import type { TaskCardController } from '../../hooks/useTaskCardController';

/**
 * Dedicated full-width lane for a single live agent session (FLUX-652). The live progress /
 * activity text is variable-length and effectively unbounded; hosting it inline in the footer let
 * it push the card wider (the "npm run check 2>…" pill spilling past the rounded border). As a
 * block-level `w-full` row with `min-w-0` + `truncate` it is structurally incapable of widening
 * the card — it clips to the available width instead. Mirrors the CardBranchRow / CardClusterPanel
 * stacked-row pattern, sitting above the footer.
 *
 * Multi-session / orchestration runs render through CardClusterPanel instead, so the caller gates
 * this on `!clusterGroup`; this row only covers the single-session case.
 */
export function CardSessionRow({ task, c }: { task: Task; c: TaskCardController }) {
  const label = task.cliSession?.label ?? 'Agent';
  // Prefer an explicit progress note once it's past the inline delay; otherwise the live tool
  // activity (Thinking / Running command / …). Both are bounded by the truncate cell below.
  const detail =
    c.shouldShowProgress && c.latestProgress ? c.latestProgress.message : c.currentActivity ?? 'Running';

  return (
    <div
      className="bot-assignee-glow mb-2 flex min-w-0 max-w-full items-center gap-1.5 overflow-hidden rounded-md border border-emerald-200 bg-emerald-50 px-2 py-1 text-[11px] text-emerald-700 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-300"
      title={`${label}: ${detail}`}
    >
      <Bot className="h-3 w-3 shrink-0" />
      <span className="max-w-[40%] shrink-0 truncate font-semibold">{label}</span>
      <span aria-hidden className="shrink-0 opacity-40">·</span>
      <span className="min-w-0 flex-1 truncate text-emerald-600/90 dark:text-emerald-300/80">{detail}</span>
    </div>
  );
}
