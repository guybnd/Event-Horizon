import { useMemo } from 'react';
import { EpicProgressBar } from '../EpicProgressBar';
import { parseAcceptanceCriteriaProgress } from '../../lib/acceptanceCriteria';
import { useAppSelector } from '../../store/useAppSelector';

/**
 * Advisory "X/Y criteria checked" indicator (FLUX-1148), parsed client-side from the
 * ticket's own `## Acceptance criteria` body section. Presentational only — no gate, no
 * schema field. Renders nothing when the ticket has no such section (never a "0/0" badge).
 */
export function CardAcceptanceCriteria({ body }: { body?: string }) {
  const progress = useMemo(() => parseAcceptanceCriteriaProgress(body), [body]);
  const theme = useAppSelector((s) => s.theme);
  if (!progress) return null;

  // FLUX-1589 (C3): under the axis themes, an in-flight fill is stone/bone — success green is
  // reserved for 100% complete, so it reads as "the run-state colour", not decoration.
  const isAxisTheme = theme === 'axis-night' || theme === 'axis-day';
  const fillClass = isAxisTheme
    ? (progress.done >= progress.total ? 'bg-[var(--eh-state-success)]' : 'bg-[var(--eh-text-muted)]')
    : 'bg-sky-500 dark:bg-sky-400';

  return (
    <div
      className="flex items-center gap-2 mb-3 w-full"
      title="Acceptance criteria checked (advisory — not a gate)"
    >
      <EpicProgressBar done={progress.done} total={progress.total} fillClass={fillClass} />
      <span className="text-[10px] font-semibold text-gray-500 dark:text-gray-400 whitespace-nowrap">
        {progress.done}/{progress.total} criteria
      </span>
    </div>
  );
}
