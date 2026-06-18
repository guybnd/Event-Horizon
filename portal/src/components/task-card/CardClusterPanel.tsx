import { OrchestrationTopology } from '../OrchestrationTopology';
import { isActiveSession, groupAggregateLine, normalizeRoleLabel, statusDotColor } from '../../orchestration';
import type { TaskCardController } from '../../hooks/useTaskCardController';

export function CardClusterPanel({ c }: { c: TaskCardController }) {
  const { clusterGroup, clusterAgg, clusterCombinerPending } = c;
  if (!clusterGroup || !clusterAgg) return null;
  return (
    <div className="mb-3 rounded-lg border border-emerald-200/70 bg-emerald-50/60 p-2 dark:border-emerald-500/20 dark:bg-emerald-500/5">
      <div className="mb-1.5 flex items-center justify-between gap-2">
        <OrchestrationTopology group={clusterGroup} variant="glyph" />
        <span className="text-[10px] font-medium text-emerald-700 dark:text-emerald-300">
          {clusterAgg.active > 0 ? `${clusterAgg.active} running` : clusterCombinerPending ? 'combining…' : 'done'}
        </span>
      </div>
      <p className="mb-1.5 truncate text-[11px] text-gray-600 dark:text-gray-300">
        {groupAggregateLine(clusterGroup, clusterAgg)}
      </p>
      <div className="flex flex-wrap gap-1">
        {clusterGroup.sessions.map(s => (
          <span
            key={s.id}
            title={`${normalizeRoleLabel(s.role) ?? s.framework} — ${s.status}`}
            className="flex items-center gap-1 rounded-md border border-gray-200 bg-white px-1.5 py-0.5 text-[10px] font-medium text-gray-700 dark:border-white/10 dark:bg-white/5 dark:text-gray-200"
          >
            <span className={`inline-block h-1.5 w-1.5 rounded-full bg-current ${statusDotColor(s.status)} ${isActiveSession(s) && s.status !== 'waiting-input' ? 'animate-pulse' : ''}`} />
            <span className="max-w-[90px] truncate">{normalizeRoleLabel(s.role) ?? s.framework}</span>
          </span>
        ))}
        {clusterCombinerPending && (
          <span
            title="combiner — pending (waiting for workers to finish)"
            className="flex items-center gap-1 rounded-md border border-dashed border-violet-300 bg-violet-50/60 px-1.5 py-0.5 text-[10px] font-medium italic text-violet-600 dark:border-violet-500/30 dark:bg-violet-500/10 dark:text-violet-300"
          >
            <span className="inline-block h-1.5 w-1.5 rounded-full bg-amber-400 dark:bg-amber-500" />
            <span className="max-w-[90px] truncate">combiner</span>
          </span>
        )}
      </div>
    </div>
  );
}
