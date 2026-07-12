import {
  memo,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { Bot, Square, Clock, CircleDot, Terminal } from 'lucide-react';
import type { CliSessionSummary, Config } from '../types';
import { FRAMEWORK_ICONS } from '../constants';
import {
  type SessionGroup,
  aggregateGroup,
  groupAggregateLine,
  patternLabel,
  topologyShape,
  normalizeRoleLabel,
  isActiveSession,
  isCombinerPending,
  statusDotColor,
  statusDotLabel,
} from '../orchestration';
import { TopologyGlyph } from './OrchestrationTopology';
import { TokenBadge } from './TokenBadge';

/**
 * FLUX-962: the reusable, topology-aware session card. Presentational only — every value comes in
 * via props (session/group + `now` + `config` + `onOpen`/`onStop` + an optional reused approval
 * `pendingSlot`); it fetches nothing. Handles a SOLO session and all three orchestration modes
 * (Serialized / Hand-off / Parallel), in a `full` variant (the Agent Management popover) and a
 * `compact` variant that is simply the collapsed state of the same markup — the detail body lives
 * in the DOM and reveals in place on hover/focus (no second surface, no portal clone). Clicking the
 * card opens that session's chat via the caller's `onOpen`; Stop and the inline approval controls
 * `stopPropagation` so they never trigger the open.
 */

export type SessionCardVariant = 'full' | 'compact';

export interface SessionCardProps {
  task: { id: string; title?: string };
  now: number;
  config: Config | null;
  variant?: SessionCardVariant;
  /** A solo (ungrouped) session. Mutually exclusive with `group`. */
  session?: CliSessionSummary | null;
  /** An orchestration run group. Mutually exclusive with `session`. */
  group?: SessionGroup | null;
  /** Open this session's chat. Receives the click/keydown so the caller can anchor the dock window
   *  (`e.currentTarget` is the card root either way). Fires on click and on Enter/Space activation. */
  onOpen: (e: ReactMouseEvent | ReactKeyboardEvent) => void;
  /** Stop the session (solo) or the whole run (group). Must `stopPropagation`. */
  onStop: (e: ReactMouseEvent) => void;
  /** Reused pending-interaction node (ChatApprovalPanel + ChatQuestionPicker) for a waiting-input
   *  session. Wired to the shared `usePendingInteractions` queue so resolving here syncs every
   *  surface. Rendered only inside the waiting-input block. */
  pendingSlot?: ReactNode;
  /** True when a pending approval/question exists for this conversation — when false, the waiting
   *  card falls back to `blockedReason` text instead of the (empty) reused panel. */
  hasPendingInteraction?: boolean;
  /** Compact-only: allow hover/focus expand-in-place. Default true. Set false where the mount can't
   *  safely reflow on grow (e.g. a dense/virtualized kanban column) — the card stays collapsed and
   *  the caller relies on click→chat for detail (FLUX-962 board-rendering constraint). */
  expandable?: boolean;
}

/** Compact running-duration label, e.g. "4s", "3m 12s", "1h 04m". FLUX-846: a terminal session
 *  freezes its duration at `endedAt` instead of counting from `startedAt` against `now` forever. */
function formatElapsed(startedAt: string | undefined, now: number, endedAt?: string): string {
  if (!startedAt) return '';
  const end = endedAt ? new Date(endedAt).getTime() : now;
  const ms = end - new Date(startedAt).getTime();
  if (!Number.isFinite(ms) || ms < 0) return '';
  const totalSecs = Math.floor(ms / 1000);
  const secs = totalSecs % 60;
  const mins = Math.floor(totalSecs / 60) % 60;
  const hours = Math.floor(totalSecs / 3600);
  if (hours > 0) return `${hours}h ${String(mins).padStart(2, '0')}m`;
  if (mins > 0) return `${mins}m ${String(secs).padStart(2, '0')}s`;
  return `${secs}s`;
}

function fmtTimestamp(iso?: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

/**
 * Instant, portal-rendered tooltip. Rendered via `createPortal` to `document.body` with
 * `position:fixed`, so it draws ON TOP of the popover and is never clipped by the list's
 * `overflow` scroll (unlike an in-flow absolutely-positioned tip) — and it shows with no OS
 * `title` delay. Positioned centered above the trigger.
 */
function InstantTooltip({ label, children }: { label: ReactNode; children: ReactNode }) {
  const ref = useRef<HTMLSpanElement>(null);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const show = () => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setPos({ x: r.left + r.width / 2, y: r.top });
  };
  const hide = () => setPos(null);
  return (
    <span ref={ref} onMouseEnter={show} onMouseLeave={hide} className="inline-flex outline-none">
      {children}
      {pos != null &&
        createPortal(
          <div
            role="tooltip"
            style={{ position: 'fixed', left: pos.x, top: pos.y - 8, transform: 'translate(-50%, -100%)' }}
            className="pointer-events-none z-[200] max-w-[240px] whitespace-nowrap rounded-lg bg-gray-900 px-2.5 py-1.5 text-[10px] font-medium leading-relaxed text-gray-100 shadow-xl ring-1 ring-black/20 dark:bg-black dark:ring-white/10"
          >
            {label}
            <span
              aria-hidden
              className="absolute left-1/2 top-full h-0 w-0 -translate-x-1/2 border-x-4 border-t-4 border-x-transparent border-t-gray-900 dark:border-t-black"
            />
          </div>,
          document.body,
        )}
    </span>
  );
}

function ElapsedPill({
  startedAt,
  endedAt,
  now,
  waiting,
  waitingSince,
  wakeAt,
}: {
  startedAt?: string;
  endedAt?: string;
  now: number;
  waiting: boolean;
  waitingSince?: string;
  /** FLUX-1390: set when the session is `scheduled` (honoring a ScheduleWakeup call) — overrides
   *  the running/waiting label with a "resumes HH:MM" badge distinct from both. */
  wakeAt?: string;
}) {
  const elapsed = formatElapsed(startedAt, now, endedAt);
  const scheduled = !!wakeAt;
  // Reuse formatElapsed's duration formatting for a countdown: "time until wakeAt" is the same
  // shape as "time since startedAt", just with the two endpoints swapped.
  const untilWake = scheduled ? formatElapsed(new Date(now).toISOString(), new Date(wakeAt!).getTime()) : '';
  if (!elapsed && !untilWake) return null;
  const label = (
    <span className="flex flex-col gap-0.5">
      <span className="font-semibold">
        {scheduled ? 'Scheduled' : waiting ? 'Waiting for input' : endedAt ? 'Ran for' : 'Running for'}
      </span>
      {startedAt && <span className="text-gray-300 dark:text-gray-400">Started {fmtTimestamp(startedAt)}</span>}
      {endedAt && <span className="text-gray-300 dark:text-gray-400">Finished {fmtTimestamp(endedAt)}</span>}
      {waiting && waitingSince && <span className="text-gray-300 dark:text-gray-400">Waiting since {fmtTimestamp(waitingSince)}</span>}
      {scheduled && <span className="text-gray-300 dark:text-gray-400">Resumes {fmtTimestamp(wakeAt)}</span>}
    </span>
  );
  return (
    <InstantTooltip label={label}>
      <span
        className={`flex items-center gap-0.5 text-[9px] font-semibold tabular-nums ${scheduled ? 'text-sky-500 dark:text-sky-400' : waiting ? 'text-amber-500 dark:text-amber-400' : 'text-gray-400 dark:text-gray-500'}`}
      >
        <Clock className="h-2.5 w-2.5" />
        {scheduled ? `resumes in ${untilWake || '0s'}` : elapsed}
      </span>
    </InstantTooltip>
  );
}

function StopButton({ onStop, title }: { onStop: (e: ReactMouseEvent) => void; title: string }) {
  return (
    <button
      type="button"
      onClick={onStop}
      onKeyDown={(e) => e.stopPropagation()}
      title={title}
      aria-label={title}
      className="shrink-0 rounded-lg p-1.5 text-gray-400 transition-colors hover:bg-red-50 hover:text-red-500 dark:hover:bg-red-500/10"
    >
      <Square className="h-3.5 w-3.5" />
    </button>
  );
}

function StatusDot({ session }: { session: CliSessionSummary }) {
  const pulse = isActiveSession(session) && session.status !== 'waiting-input';
  return (
    <span
      className={`inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-current ${statusDotColor(session.status)} ${pulse ? 'animate-pulse' : ''}`}
      aria-hidden
    />
  );
}

function agentLabel(s: CliSessionSummary): string {
  return normalizeRoleLabel(s.role) || s.label || s.framework;
}

/** One agent row for the hand-off / parallel breakdowns: glyph + role + status dot + live activity. */
function AgentRow({ session, isLead = false }: { session: CliSessionSummary; isLead?: boolean }) {
  const Icon = FRAMEWORK_ICONS[session.framework] || Bot;
  return (
    <div
      className={`flex items-center gap-2 rounded-lg border px-2 py-1 ${
        isLead
          ? 'border-violet-300 bg-violet-50 dark:border-violet-500/30 dark:bg-violet-500/10'
          : 'border-gray-200 bg-white dark:border-white/10 dark:bg-white/5'
      }`}
    >
      <Icon className="h-3 w-3 shrink-0 text-gray-500 dark:text-gray-400" />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="truncate text-[11px] font-medium text-gray-800 dark:text-gray-200">{agentLabel(session)}</span>
          <StatusDot session={session} />
          <span className="sr-only">{statusDotLabel(session.status)}</span>
        </div>
        {session.currentActivity && (
          <div className="truncate text-[9px] text-gray-400 dark:text-gray-500">{session.currentActivity}</div>
        )}
      </div>
    </div>
  );
}

/** Ghost lead row shown when a combiner/lead is owed but hasn't launched yet. */
function PendingLeadRow() {
  return (
    <div className="flex items-center gap-2 rounded-lg border border-dashed border-violet-300 bg-violet-50/50 px-2 py-1 opacity-70 dark:border-violet-500/30 dark:bg-violet-500/5">
      <Bot className="h-3 w-3 shrink-0 text-violet-400 dark:text-violet-500" />
      <span className="truncate text-[11px] font-medium italic text-violet-500 dark:text-violet-400">combiner</span>
      <span className="inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-amber-400 dark:bg-amber-500" aria-hidden />
      <span className="text-[9px] text-violet-400 dark:text-violet-500">pending</span>
    </div>
  );
}

/** Topology-aware per-agent breakdown for a group card's detail region. */
function GroupBreakdown({ group }: { group: SessionGroup }) {
  const agg = useMemo(() => aggregateGroup(group), [group]);
  const shape = topologyShape(group.groupType, group.groupVariant);
  const combinerPending = isCombinerPending(group, agg);

  if (shape === 'pipeline') {
    return (
      <div className="flex flex-col gap-1">
        {group.sessions.map((s, i) => {
          const active = isActiveSession(s);
          const done = !active;
          const Icon = FRAMEWORK_ICONS[s.framework] || Bot;
          return (
            <div
              key={s.id}
              className={`relative flex items-center gap-2 overflow-hidden rounded-lg border px-2 py-1 ${
                active
                  ? 'border-emerald-300 bg-emerald-50 dark:border-emerald-500/40 dark:bg-emerald-500/10'
                  : `border-gray-200 bg-white dark:border-white/10 dark:bg-white/5 ${done ? 'opacity-60' : ''}`
              }`}
            >
              <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-gray-200 text-[9px] font-bold text-gray-600 dark:bg-white/10 dark:text-gray-300">
                {i + 1}
              </span>
              <Icon className="h-3 w-3 shrink-0 text-gray-500 dark:text-gray-400" />
              <span className="min-w-0 flex-1 truncate text-[11px] font-medium text-gray-800 dark:text-gray-200">{agentLabel(s)}</span>
              <StatusDot session={s} />
              <span className="sr-only">{statusDotLabel(s.status)}</span>
              {active && s.status !== 'waiting-input' && (
                <span className="absolute inset-x-0 bottom-0 h-0.5 overflow-hidden">
                  <span className="eh-notif-indeterminate block h-full w-1/3 bg-emerald-400/80 dark:bg-emerald-400/60" />
                </span>
              )}
            </div>
          );
        })}
      </div>
    );
  }

  if (shape === 'tree') {
    return (
      <div className="flex flex-col gap-1.5">
        {agg.lead ? <AgentRow session={agg.lead} isLead /> : combinerPending ? <PendingLeadRow /> : null}
        {agg.steps.length > 0 && (
          <div className="ml-2 flex flex-col gap-1 border-l border-gray-200 pl-3 dark:border-white/10">
            {agg.steps.map((s) => (
              <AgentRow key={s.id} session={s} />
            ))}
          </div>
        )}
      </div>
    );
  }

  // fan / swarm — worker grid, plus the combiner (or its ghost) when the run expects one.
  return (
    <div className="flex flex-col gap-1.5">
      <div className="grid grid-cols-2 gap-1">
        {agg.steps.map((s) => (
          <AgentRow key={s.id} session={s} />
        ))}
      </div>
      {agg.lead ? <AgentRow session={agg.lead} isLead /> : combinerPending ? <PendingLeadRow /> : null}
    </div>
  );
}

export const SessionCard = memo(function SessionCard({
  task,
  now,
  config,
  variant = 'full',
  session,
  group,
  onOpen,
  onStop,
  pendingSlot,
  hasPendingInteraction,
  expandable = true,
}: SessionCardProps) {
  const isCompact = variant === 'compact';

  // The session that is blocked on input, if any (solo → itself; group → whichever member is waiting).
  const waitingSession = session?.status === 'waiting-input'
    ? session
    : group?.sessions.find((s) => s.status === 'waiting-input');
  const isWaiting = !!waitingSession;

  // Group aggregate (topology, counts, summed tokens) — recomputed only when the group changes.
  const agg = useMemo(() => (group ? aggregateGroup(group) : null), [group]);
  const groupStartedAt = useMemo(
    () =>
      group?.sessions.reduce<string | undefined>((earliest, s) => {
        if (!s.startedAt) return earliest;
        if (!earliest || new Date(s.startedAt).getTime() < new Date(earliest).getTime()) return s.startedAt;
        return earliest;
      }, undefined),
    [group],
  );

  // Live-output tail — memoized off `liveOutput` so the 1s `now` tick never re-slices it.
  const outputLines = useMemo(() => {
    if (!session?.liveOutput) return [];
    return session.liveOutput.trim().split('\n').slice(-5);
  }, [session?.liveOutput]);

  // Heartbeat: dim/steady the activity pulse once output has been quiet for a while.
  const stale =
    session?.status === 'running' && !!session.lastOutputAt && now - new Date(session.lastOutputAt).getTime() > 15000;

  const tone = isWaiting ? 'amber' : group ? 'emerald' : 'neutral';
  const toneClass = {
    amber:
      'border-amber-200/80 bg-amber-50/50 hover:border-amber-300/80 dark:border-amber-500/25 dark:bg-amber-500/[0.06] dark:hover:border-amber-500/40',
    emerald:
      'border-emerald-200/70 bg-emerald-50/40 hover:border-primary/30 hover:bg-primary/5 dark:border-emerald-500/20 dark:bg-emerald-500/5 dark:hover:bg-white/5',
    neutral:
      'border-gray-100 bg-white hover:border-primary/30 hover:bg-primary/5 dark:border-white/5 dark:bg-white/[0.03] dark:hover:bg-white/5',
  }[tone];

  // ---- Header ------------------------------------------------------------------------------------
  let header: ReactNode;
  if (group && agg) {
    const glyphColor = agg.active > 0 ? 'text-emerald-500' : 'text-gray-400';
    header = (
      <div className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <div className={`shrink-0 rounded-lg bg-gray-100 p-1.5 dark:bg-white/10 ${glyphColor}`}>
            <TopologyGlyph shape={topologyShape(group.groupType, group.groupVariant)} className="h-4 w-4" />
          </div>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-[10px] font-bold uppercase tracking-wider text-gray-400">{task.id}</span>
              <span className="rounded-full bg-violet-100 px-1.5 py-0.5 text-[9px] font-semibold text-violet-700 dark:bg-violet-500/10 dark:text-violet-300">
                {patternLabel(group.groupType, group.groupVariant)}
              </span>
              <ElapsedPill startedAt={groupStartedAt} now={now} waiting={isWaiting} waitingSince={waitingSession?.lastOutputAt} />
            </div>
            <div className="truncate text-xs font-semibold text-gray-900 dark:text-gray-100">{task.title}</div>
            <div className="truncate text-[10px] font-medium text-gray-400 dark:text-gray-500">
              {agg.total} agent{agg.total === 1 ? '' : 's'} · {agg.active} running
            </div>
          </div>
        </div>
        <StopButton onStop={onStop} title="Stop all sessions" />
      </div>
    );
  } else if (session) {
    const Icon = FRAMEWORK_ICONS[session.framework] || Bot;
    const statusColor = isWaiting ? 'text-amber-500' : session.status === 'running' ? 'text-emerald-500' : 'text-gray-400';
    header = (
      <div className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <div className={`shrink-0 rounded-lg bg-gray-100 p-1.5 dark:bg-white/10 ${statusColor}`}>
            <Icon className="h-4 w-4" />
          </div>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-[10px] font-bold uppercase tracking-wider text-gray-400">{task.id}</span>
              {session.role && (
                <span className="rounded-full bg-violet-100 px-1.5 py-0.5 text-[9px] font-semibold text-violet-700 dark:bg-violet-500/10 dark:text-violet-300">
                  {normalizeRoleLabel(session.role)}
                </span>
              )}
              <ElapsedPill
                startedAt={session.startedAt}
                endedAt={session.endedAt}
                now={now}
                waiting={isWaiting}
                waitingSince={session.lastOutputAt}
                wakeAt={session.status === 'scheduled' ? session.wakeAt : undefined}
              />
            </div>
            <div className="truncate text-xs font-semibold text-gray-900 dark:text-gray-100">{task.title}</div>
            <div className="truncate text-[10px] font-medium text-gray-400 dark:text-gray-500">Solo · {session.label || session.framework}</div>
          </div>
        </div>
        <StopButton onStop={onStop} title="Stop session" />
      </div>
    );
  }

  // ---- Glance row (always visible): activity / aggregate summary + token strip -------------------
  const tokenData = group && agg ? agg.tokens : session ?? null;
  const glance = (
    <div className="flex items-center justify-between gap-2">
      {group && agg ? (
        <div className="flex min-w-0 items-center gap-1.5 rounded bg-emerald-50 px-1.5 py-1 text-[10px] font-medium text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300">
          <CircleDot className={`h-2.5 w-2.5 shrink-0 ${agg.active > 0 ? 'animate-pulse' : ''}`} />
          <span className="truncate">{groupAggregateLine(group, agg)}</span>
        </div>
      ) : session?.currentActivity ? (
        <div
          className={`flex min-w-0 items-center gap-1.5 rounded px-1.5 py-1 text-[10px] font-medium ${
            isWaiting
              ? 'bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-300'
              : 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300'
          }`}
        >
          <CircleDot className={`h-2.5 w-2.5 shrink-0 ${isWaiting || stale ? '' : 'animate-pulse'}`} />
          <span className="truncate">{session.currentActivity}</span>
        </div>
      ) : (
        <span className="min-w-0" />
      )}
      {tokenData && <TokenBadge data={tokenData} config={config} variant="card" />}
    </div>
  );

  // Group dot-cluster — the at-a-glance "who is running" row (kept in the glance region so it shows
  // even while the compact card is collapsed).
  const dotCluster = group ? (
    <div className="flex flex-wrap gap-1">
      {group.sessions.map((s) => {
        const Icon = FRAMEWORK_ICONS[s.framework] || Bot;
        return (
          <span
            key={s.id}
            title={`${agentLabel(s)} — ${statusDotLabel(s.status)}`}
            className="flex items-center gap-1 rounded-md border border-gray-200 bg-white px-1.5 py-0.5 text-[10px] font-medium text-gray-700 dark:border-white/10 dark:bg-white/5 dark:text-gray-200"
          >
            <StatusDot session={s} />
            <Icon className="h-2.5 w-2.5 text-gray-400" />
            <span className="max-w-[80px] truncate">{agentLabel(s)}</span>
          </span>
        );
      })}
    </div>
  ) : null;

  // ---- Detail body (hover-reveal in compact) ----------------------------------------------------
  const detail = (
    <>
      {group ? (
        <GroupBreakdown group={group} />
      ) : (
        outputLines.length > 0 && (
          <div className="overflow-hidden rounded-lg bg-gray-900 dark:bg-black/50">
            <div className="flex items-center gap-1.5 border-b border-white/5 px-2 py-1 text-[8px] font-bold uppercase tracking-wider text-gray-500">
              <Terminal className="h-2.5 w-2.5" /> live output
            </div>
            <div className="max-h-[72px] overflow-y-auto px-2 py-1.5 font-mono text-[9px] leading-relaxed text-gray-300">
              {outputLines.map((line, i) => (
                <div key={i} className="truncate">
                  {line}
                </div>
              ))}
            </div>
          </div>
        )
      )}

      {isWaiting && (
        // stopPropagation (click + keydown) so resolving the approval/question never also opens the chat.
        <div onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()} className="flex flex-col gap-2">
          {hasPendingInteraction ? (
            pendingSlot
          ) : waitingSession?.blockedReason ? (
            <div className="rounded-lg border border-amber-300 bg-amber-50 px-2.5 py-1.5 text-[11px] text-amber-800 dark:border-amber-500/40 dark:bg-amber-950/40 dark:text-amber-200">
              {waitingSession.blockedReason}
            </div>
          ) : null}
        </div>
      )}
    </>
  );

  const handleKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    e.preventDefault();
    onOpen(e);
  };

  return (
    <div
      onClick={onOpen}
      onKeyDown={handleKeyDown}
      role="button"
      tabIndex={0}
      aria-label={`Open chat — ${task.title || task.id}`}
      className={`group/card relative flex cursor-pointer flex-col gap-2 rounded-xl border p-3 outline-none transition-all focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 dark:focus-visible:ring-offset-gray-900 ${toneClass}`}
    >
      {header}
      {glance}
      {dotCluster}
      {isCompact ? (
        <div
          className={`grid grid-rows-[0fr] transition-[grid-template-rows] duration-300 ease-out ${
            expandable ? 'group-hover/card:grid-rows-[1fr] group-focus-within/card:grid-rows-[1fr]' : ''
          }`}
        >
          <div className="min-h-0 overflow-hidden">
            <div className="flex flex-col gap-2 pt-0.5">{detail}</div>
          </div>
        </div>
      ) : (
        detail
      )}
    </div>
  );
});
