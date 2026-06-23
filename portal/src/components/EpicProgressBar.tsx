/**
 * The single completion-bar primitive (FLUX-678). Extracted from CardSubtaskProgress so the
 * board card and the Epics/roadmap screen render the exact same bar. Presentational only —
 * the `group-hover/progress:*` variants light up when an ancestor carries `group/progress`
 * (the board card does); outside that group they're inert, so the bar is safe to drop anywhere.
 *
 * `fillClass` overrides the fill colour; defaults to emerald (neutral, board-card safe).
 * Pass a completion-driven class from the Epics screen for at-risk colouring (FLUX-689).
 */
export function EpicProgressBar({
  done,
  total,
  fillClass,
}: {
  done: number;
  total: number;
  fillClass?: string;
}) {
  const pct = total > 0 ? (done / total) * 100 : 0;
  return (
    <div className="flex-1 h-2 rounded-full bg-gray-200 dark:bg-white/10 overflow-hidden group-hover/progress:bg-gray-300 dark:group-hover/progress:bg-white/15 transition-colors">
      <div
        className={`h-full rounded-full transition-all ${fillClass ?? 'bg-emerald-500 dark:bg-emerald-400'}`}
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}
