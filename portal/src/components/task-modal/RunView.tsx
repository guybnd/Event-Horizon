import { useState } from 'react';
import { ChevronDown, ChevronRight, Square, Bot } from 'lucide-react';
import type { CliSessionSummary, Config } from '../../types';
import { FRAMEWORK_ICONS } from '../../constants';
import { OrchestrationTopology } from '../OrchestrationTopology';
import { TokenBadge } from '../TokenBadge';
import {
  type SessionGroup,
  aggregateGroup,
  groupAggregateLine,
  normalizeRoleLabel,
  patternLabel,
  topologyShape,
  isActiveSession,
  statusDotColor,
} from '../../orchestration';

interface RunViewProps {
  group: SessionGroup;
  config: Config | null;
  busy: boolean;
  /** Stop a single session by id. */
  onStopSession: (sessionId: string) => void;
  /** Stop every active session in the group. */
  onStopAll: () => void;
}

const STATUS_PILL: Record<string, string> = {
  running: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300',
  pending: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300',
  'waiting-input': 'bg-amber-100 text-amber-700 dark:bg-amber-500/10 dark:text-amber-300',
  completed: 'bg-gray-100 text-gray-600 dark:bg-white/5 dark:text-gray-300',
  failed: 'bg-red-100 text-red-700 dark:bg-red-500/10 dark:text-red-300',
  cancelled: 'bg-red-100 text-red-700 dark:bg-red-500/10 dark:text-red-300',
};

function SessionRow({ session, config, busy, onStop }: {
  session: CliSessionSummary;
  config: Config | null;
  busy: boolean;
  onStop: (id: string) => void;
}) {
  const [open, setOpen] = useState(isActiveSession(session));
  const Icon = FRAMEWORK_ICONS[session.framework] || Bot;
  const label = normalizeRoleLabel(session.role) ?? session.label ?? session.framework;
  const active = isActiveSession(session);
  const hasOutput = Boolean(session.liveOutput);

  return (
    <div className="rounded-lg border border-gray-200 bg-white dark:border-white/10 dark:bg-white/5">
      <div className="flex items-center gap-2 px-2.5 py-2">
        <button
          type="button"
          onClick={() => setOpen(o => !o)}
          disabled={!hasOutput}
          className="flex min-w-0 flex-1 items-center gap-2 text-left disabled:cursor-default"
        >
          {hasOutput ? (
            open ? <ChevronDown className="h-3.5 w-3.5 shrink-0 text-gray-400" /> : <ChevronRight className="h-3.5 w-3.5 shrink-0 text-gray-400" />
          ) : (
            <span className="h-3.5 w-3.5 shrink-0" />
          )}
          <span className={`inline-block h-2 w-2 shrink-0 rounded-full bg-current ${statusDotColor(session.status)} ${active && session.status !== 'waiting-input' ? 'animate-pulse' : ''}`} />
          <Icon className="h-4 w-4 shrink-0 text-gray-500 dark:text-gray-400" />
          <span className="truncate text-xs font-semibold text-gray-800 dark:text-gray-100">{label}</span>
          {session.groupSeq != null && (
            <span className="shrink-0 rounded bg-gray-100 px-1 py-0.5 text-[9px] font-bold text-gray-500 dark:bg-white/10 dark:text-gray-400">#{session.groupSeq + 1}</span>
          )}
        </button>
        <span className={`shrink-0 rounded-full px-2 py-0.5 text-[9px] font-semibold uppercase tracking-wider ${STATUS_PILL[session.status] ?? STATUS_PILL.completed}`}>
          {session.status}
        </span>
        {active && (
          <button
            type="button"
            disabled={busy}
            onClick={() => onStop(session.id)}
            title="Stop this agent"
            className="flex shrink-0 items-center justify-center rounded-md border border-gray-300 p-1 text-gray-600 transition-colors hover:bg-gray-100 disabled:opacity-50 dark:border-white/10 dark:text-gray-300 dark:hover:bg-white/5"
          >
            <Square className="h-3 w-3" />
          </button>
        )}
      </div>
      {session.currentActivity && active && (
        <p className="px-2.5 pb-1.5 pl-9 text-[11px] text-gray-500 dark:text-gray-400">{session.currentActivity}</p>
      )}
      {open && hasOutput && (
        <pre className="mx-2.5 mb-2.5 max-h-40 overflow-y-auto whitespace-pre-wrap break-words rounded-lg bg-gray-900 p-2 text-[10px] leading-relaxed text-gray-200 dark:bg-black/60">
          {session.liveOutput}
        </pre>
      )}
      {(session.inputTokens != null || session.outputTokens != null || session.costUSD != null) && (
        <div className="px-2.5 pb-2 pl-9">
          <TokenBadge data={session} config={config} variant="panel" label="" />
        </div>
      )}
    </div>
  );
}

export function RunView({ group, config, busy, onStopSession, onStopAll }: RunViewProps) {
  const agg = aggregateGroup(group);
  const shape = topologyShape(group.groupType, group.groupVariant);
  const anyActive = group.sessions.some(isActiveSession);
  const isScatterGather = shape === 'fan';
  // Barrier: the combiner cannot synthesize until every worker has finished.
  const workersDone = agg.steps.filter(s => !isActiveSession(s)).length;
  const barrierPending = isScatterGather && agg.lead && workersDone < agg.steps.length;

  return (
    <div className="space-y-3 rounded-xl border border-gray-100 bg-gray-50 p-3 dark:border-white/5 dark:bg-black/20">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <p className="text-xs font-bold uppercase tracking-wider text-gray-400">
              {patternLabel(group.groupType, group.groupVariant)} Run
            </p>
            <span className="rounded-full bg-gray-200 px-1.5 py-0.5 text-[9px] font-semibold text-gray-600 dark:bg-white/10 dark:text-gray-300">
              {agg.total} agents
            </span>
          </div>
          <p className="mt-0.5 truncate text-[11px] text-gray-500 dark:text-gray-400">{groupAggregateLine(group, agg)}</p>
        </div>
        {anyActive && (
          <button
            type="button"
            disabled={busy}
            onClick={onStopAll}
            className="flex shrink-0 items-center gap-1.5 rounded-lg border border-gray-300 px-2.5 py-1.5 text-xs font-semibold text-gray-700 transition-colors hover:bg-gray-100 disabled:opacity-50 dark:border-white/10 dark:text-gray-200 dark:hover:bg-white/5"
          >
            <Square className="h-3.5 w-3.5" />
            Stop all
          </button>
        )}
      </div>

      <div className="flex justify-center rounded-lg border border-gray-100 bg-white px-2 py-3 dark:border-white/5 dark:bg-black/30">
        <OrchestrationTopology group={group} variant="map" />
      </div>

      {barrierPending && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 dark:border-amber-500/20 dark:bg-amber-500/10">
          <p className="text-xs font-semibold text-amber-700 dark:text-amber-300">Combiner waiting on reviewers</p>
          <p className="mt-0.5 text-[11px] text-amber-600 dark:text-amber-400">
            {workersDone} of {agg.steps.length} reviewers finished — synthesis starts once all complete.
          </p>
        </div>
      )}

      <div className="space-y-1.5">
        {group.sessions.map(s => (
          <SessionRow key={s.id} session={s} config={config} busy={busy} onStop={onStopSession} />
        ))}
      </div>
    </div>
  );
}
