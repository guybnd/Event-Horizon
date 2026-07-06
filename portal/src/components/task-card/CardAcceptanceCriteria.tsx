import { useMemo } from 'react';
import { EpicProgressBar } from '../EpicProgressBar';
import { parseAcceptanceCriteriaProgress } from '../../lib/acceptanceCriteria';

/**
 * Advisory "X/Y criteria checked" indicator (FLUX-1148), parsed client-side from the
 * ticket's own `## Acceptance criteria` body section. Presentational only — no gate, no
 * schema field. Renders nothing when the ticket has no such section (never a "0/0" badge).
 */
export function CardAcceptanceCriteria({ body }: { body?: string }) {
  const progress = useMemo(() => parseAcceptanceCriteriaProgress(body), [body]);
  if (!progress) return null;

  return (
    <div
      className="flex items-center gap-2 mb-3 w-full"
      title="Acceptance criteria checked (advisory — not a gate)"
    >
      <EpicProgressBar done={progress.done} total={progress.total} fillClass="bg-sky-500 dark:bg-sky-400" />
      <span className="text-[10px] font-semibold text-gray-500 dark:text-gray-400 whitespace-nowrap">
        {progress.done}/{progress.total} criteria
      </span>
    </div>
  );
}
