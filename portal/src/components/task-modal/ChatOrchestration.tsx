import { useEffect, useState } from 'react';
import { Bot, ChevronDown, ChevronRight, Square, ExternalLink } from 'lucide-react';
import type { CliSessionSummary } from '../../types';
import { FRAMEWORK_ICONS } from '../../constants';
import { OrchestrationTopology, TopologyGlyph } from '../OrchestrationTopology';
import { OutputTail } from './OutputTail';
import { useLiveSession } from '../../store/useAppSelector';
import {
  type SessionGroup,
  aggregateGroup,
  isActiveSession,
  liveActivityFor,
  normalizeRoleLabel,
  patternLabel,
  statusDotColor,
  statusDotLabel,
  topologyShape,
} from '../../orchestration';

/**
 * FLUX-803: chat-native visibility of subagents. Two surfaces over the SAME live run group
 * (built by `selectChatRunGroup` from `task.cliSessions`, the union the engine already stamps with
 * a shared `groupId` for a chat-as-lead session):
 *
 *  - {@link ChatPresenceRail} — a slim ambient "who's live now" strip pinned to the top of the chat.
 *  - {@link ChatOrchestrationBlock} — a prominent, durable inline card anchored at the spawn point.
 *
 * Both are thin shells over the existing renderers (`OrchestrationTopology`, the RunView live-output
 * `<pre>` pattern) — no duplicated lane/topology logic. Live per-agent activity comes from the
 * FLUX-626 live slice (`useLiveSession`) overlaid on the poll-cadence summaries.
 */

const MAX_RAIL_CHIPS = 5;

/** Lead pinned left, delegates following in launch order. */
function orderedSessions(group: SessionGroup, lead?: CliSessionSummary): CliSessionSummary[] {
  if (!lead) return group.sessions;
  return [lead, ...group.sessions.filter((s) => s !== lead)];
}

interface RailProps {
  group: SessionGroup;
  taskId: string;
  onOpenRun: () => void;
  onStopSession: (sessionId: string) => void;
}

/**
 * FLUX-803 deliverable 1 — the presence rail. A slim strip of agent chips (framework icon +
 * normalized role + pulsing status dot + short activity), pinned above the transcript. Clicking a
 * chip expands an inline drawer with that agent's live output tail; the drawer also carries a Stop.
 * Rendered by the caller only while ≥1 session is active, so it simply vanishes when the run ends
 * (the durable record lives on in the inline block below).
 */
export function ChatPresenceRail({ group, taskId, onOpenRun, onStopSession }: RailProps) {
  const live = useLiveSession(taskId);
  const [openId, setOpenId] = useState<string | null>(null);
  const agg = aggregateGroup(group);
  const ordered = orderedSessions(group, agg.lead);
  const visible = ordered.slice(0, MAX_RAIL_CHIPS);
  const overflow = ordered.length - visible.length;
  const selected = openId ? group.sessions.find((s) => s.id === openId) : undefined;

  return (
    <div className="rounded-xl border border-l-2 border-violet-200 border-l-violet-400 bg-violet-50/40 px-2 py-1.5 dark:border-violet-500/20 dark:border-l-violet-500/60 dark:bg-violet-500/5">
      <div className="flex items-center gap-2">
        <span className="flex-shrink-0 text-violet-400 dark:text-violet-300">
          <TopologyGlyph shape={topologyShape(group.groupType, group.groupVariant)} className="h-3.5 w-3.5" />
        </span>
        <div className="flex min-w-0 flex-1 items-center gap-1.5 overflow-x-auto">
          {visible.map((s) => {
            const isLead = s === agg.lead;
            const Icon = FRAMEWORK_ICONS[s.framework] || Bot;
            const role = normalizeRoleLabel(s.role) || (isLead ? 'lead' : s.framework);
            const active = isActiveSession(s);
            const activity = liveActivityFor(s, isLead, live);
            const isOpen = openId === s.id;
            return (
              <button
                key={s.id}
                type="button"
                onClick={() => setOpenId(isOpen ? null : s.id)}
                title={activity ? `${role} — ${activity}` : role}
                className={`flex flex-shrink-0 items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] transition-colors ${
                  isOpen
                    ? 'border-violet-400 bg-violet-100 dark:border-violet-500/50 dark:bg-violet-500/15'
                    : 'border-violet-200 bg-white/70 hover:bg-white dark:border-white/10 dark:bg-white/5 dark:hover:bg-white/10'
                }`}
              >
                <span className={`inline-block h-2 w-2 flex-shrink-0 rounded-full bg-current ${statusDotColor(s.status)} ${active && s.status !== 'waiting-input' ? 'animate-pulse' : ''}`}>
                  <span className="sr-only">{statusDotLabel(s.status)}</span>
                </span>
                <Icon className="h-3 w-3 flex-shrink-0 text-gray-500 dark:text-gray-400" />
                <span className="font-semibold text-gray-800 dark:text-gray-100">{role}</span>
                {active && activity && (
                  <span className="max-w-[120px] truncate text-gray-500 dark:text-gray-400">{activity}</span>
                )}
              </button>
            );
          })}
          {overflow > 0 && (
            <button
              type="button"
              onClick={onOpenRun}
              title={`Show all ${ordered.length} agents in the Run View`}
              className="flex-shrink-0 rounded-full bg-violet-100 px-2 py-0.5 text-[10px] font-bold text-violet-600 transition-colors hover:bg-violet-200 dark:bg-violet-500/15 dark:text-violet-300 dark:hover:bg-violet-500/25"
            >
              +{overflow}
            </button>
          )}
        </div>
        <button
          type="button"
          onClick={onOpenRun}
          title="Open the full Run View"
          className="flex flex-shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-semibold text-violet-600 transition-colors hover:bg-violet-100 dark:text-violet-300 dark:hover:bg-violet-500/15"
        >
          <ExternalLink className="h-3 w-3" /> Run
        </button>
      </div>
      {selected && (
        <div className="mt-1.5 space-y-1.5">
          {selected.liveOutput ? (
            <OutputTail text={selected.liveOutput} />
          ) : (
            <p className="px-1 text-[11px] text-gray-500 dark:text-gray-400">No output yet.</p>
          )}
          {isActiveSession(selected) && (
            <button
              type="button"
              onClick={() => onStopSession(selected.id)}
              className="flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-semibold text-red-500 transition-colors hover:bg-red-500/10"
            >
              <Square className="h-2.5 w-2.5 fill-current" /> Stop this agent
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/** One agent's row inside the inline block — role + live activity + expandable output tail + Stop. */
function DelegateRow({ session, isLead, live, onStopSession }: {
  session: CliSessionSummary;
  isLead: boolean;
  live: ReturnType<typeof useLiveSession>;
  onStopSession: (sessionId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const Icon = FRAMEWORK_ICONS[session.framework] || Bot;
  const role = normalizeRoleLabel(session.role) || (isLead ? 'lead' : session.framework);
  const active = isActiveSession(session);
  const activity = liveActivityFor(session, isLead, live);
  const hasOutput = Boolean(session.liveOutput);

  return (
    <div className={`rounded-lg border ${isLead ? 'border-violet-200 bg-violet-50/40 dark:border-violet-500/20 dark:bg-violet-500/5' : 'border-gray-200 bg-white dark:border-white/10 dark:bg-white/5'}`}>
      <div className="flex items-center gap-2 px-2 py-1.5">
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          disabled={!hasOutput}
          className="flex min-w-0 flex-1 items-center gap-2 text-left disabled:cursor-default"
        >
          {hasOutput ? (
            open ? <ChevronDown className="h-3.5 w-3.5 flex-shrink-0 text-gray-400" /> : <ChevronRight className="h-3.5 w-3.5 flex-shrink-0 text-gray-400" />
          ) : (
            <span className="h-3.5 w-3.5 flex-shrink-0" />
          )}
          <span className={`inline-block h-2 w-2 flex-shrink-0 rounded-full bg-current ${statusDotColor(session.status)} ${active && session.status !== 'waiting-input' ? 'animate-pulse' : ''}`}>
            <span className="sr-only">{statusDotLabel(session.status)}</span>
          </span>
          <Icon className="h-3.5 w-3.5 flex-shrink-0 text-gray-500 dark:text-gray-400" />
          <span className="flex-shrink-0 text-[11px] font-semibold text-gray-800 dark:text-gray-100">{role}</span>
          {active && activity ? (
            <span className="min-w-0 truncate text-[11px] text-gray-500 dark:text-gray-400">{activity}</span>
          ) : active && !hasOutput ? (
            <span className="min-w-0 truncate text-[11px] italic text-gray-400 dark:text-gray-500">waiting…</span>
          ) : null}
        </button>
        {active && (
          <button
            type="button"
            onClick={() => onStopSession(session.id)}
            title="Stop this agent"
            aria-label="Stop this agent"
            className="flex flex-shrink-0 items-center justify-center rounded-md border border-gray-300 p-1 text-gray-600 transition-colors hover:bg-gray-100 dark:border-white/10 dark:text-gray-300 dark:hover:bg-white/5"
          >
            <Square className="h-3 w-3" />
          </button>
        )}
      </div>
      {open && hasOutput && (
        <div className="px-2 pb-2">
          <OutputTail text={session.liveOutput!} />
        </div>
      )}
    </div>
  );
}

interface BlockProps {
  group: SessionGroup;
  taskId: string;
  onOpenRun: () => void;
  onStopSession: (sessionId: string) => void;
  onStopAll: () => void;
}

/**
 * FLUX-803 deliverable 2 — the inline orchestration block. A prominent, durable record of a run,
 * anchored in the transcript at the spawn point (ChatView renders it in place of the
 * `delegate_parallel`/`delegate_to_agent` tool row). Deliberately NOT a minimal tool-call block:
 * full-width, violet orchestration accent, a topology identity header, an embedded
 * `OrchestrationTopology` map and a per-delegate row list. While the run is live it stays expanded
 * with a pulse; when every agent finishes it collapses to a re-expandable summary chip that keeps
 * the accent + count (so it still reads as "a run happened here").
 */
export function ChatOrchestrationBlock({ group, taskId, onOpenRun, onStopSession, onStopAll }: BlockProps) {
  const live = useLiveSession(taskId);
  const agg = aggregateGroup(group);
  const anyActive = group.sessions.some(isActiveSession);
  const [expanded, setExpanded] = useState(anyActive);
  // Auto-collapse to the summary chip when the run finishes (and re-expand if it goes live again);
  // fires only on the active→inactive edge so a manual toggle survives live progress ticks.
  useEffect(() => setExpanded(anyActive), [anyActive]);

  const label = patternLabel(group.groupType, group.groupVariant);
  const ordered = orderedSessions(group, agg.lead);

  if (!expanded) {
    return (
      <button
        type="button"
        onClick={() => setExpanded(true)}
        title="Show this run"
        className="group flex w-full items-center gap-2 rounded-lg border border-l-2 border-violet-200 border-l-violet-400 bg-violet-50/40 px-2.5 py-1.5 text-left transition-colors hover:bg-violet-50 dark:border-violet-500/20 dark:border-l-violet-500/60 dark:bg-violet-500/5 dark:hover:bg-violet-500/10"
      >
        <ChevronRight className="h-3.5 w-3.5 flex-shrink-0 text-violet-400 dark:text-violet-300" />
        <span className="flex-shrink-0 text-violet-400 dark:text-violet-300">
          <TopologyGlyph shape={topologyShape(group.groupType, group.groupVariant)} className="h-3.5 w-3.5" />
        </span>
        <span className="flex-shrink-0 text-[11px] font-bold uppercase tracking-wider text-violet-600 dark:text-violet-300">
          {label} Run
        </span>
        <span className="flex-shrink-0 rounded-full bg-violet-100 px-1.5 py-0.5 text-[10px] font-semibold text-violet-600 dark:bg-violet-500/15 dark:text-violet-300">
          {agg.total} agents
        </span>
        {agg.failed > 0 && (
          <span className="flex-shrink-0 rounded-full bg-red-100 px-1.5 py-0.5 text-[10px] font-semibold text-red-600 dark:bg-red-500/15 dark:text-red-300">
            ✕ {agg.failed} failed
          </span>
        )}
        <span className="ml-auto flex-shrink-0 text-[10px] text-gray-500 dark:text-gray-400">
          {agg.completed + agg.failed} of {agg.total} finished
        </span>
      </button>
    );
  }

  return (
    <div className="overflow-hidden rounded-xl border border-l-2 border-violet-200 border-l-violet-400 bg-violet-50/30 shadow-sm dark:border-violet-500/20 dark:border-l-violet-500/60 dark:bg-violet-500/5">
      {/* Identity header band — topology glyph + title + agent count + live pulse + controls. */}
      <div className="flex flex-wrap items-center gap-2 border-b border-violet-200/70 bg-violet-100/50 px-3 py-2 dark:border-violet-500/20 dark:bg-violet-500/10">
        <button
          type="button"
          onClick={() => setExpanded(false)}
          title="Collapse this run"
          className="flex-shrink-0 text-violet-500 transition-colors hover:text-violet-700 dark:text-violet-300 dark:hover:text-violet-100"
        >
          <ChevronDown className="h-3.5 w-3.5" />
        </button>
        <span className="flex-shrink-0 text-violet-500 dark:text-violet-300">
          <TopologyGlyph shape={topologyShape(group.groupType, group.groupVariant)} className="h-4 w-4" />
        </span>
        <span className="flex-shrink-0 text-xs font-bold uppercase tracking-wider text-violet-700 dark:text-violet-200">
          {label} Run
        </span>
        <span className="flex-shrink-0 rounded-full bg-violet-200 px-1.5 py-0.5 text-[10px] font-semibold text-violet-700 dark:bg-violet-500/20 dark:text-violet-200">
          {agg.total} agents
        </span>
        {agg.failed > 0 && (
          <span className="flex-shrink-0 rounded-full bg-red-100 px-1.5 py-0.5 text-[10px] font-semibold text-red-600 dark:bg-red-500/15 dark:text-red-300">
            ✕ {agg.failed} failed
          </span>
        )}
        {anyActive && (
          <span role="status" className="flex h-1.5 w-1.5 flex-shrink-0 rounded-full bg-emerald-500 animate-pulse" title="Live">
            <span className="sr-only">Live</span>
          </span>
        )}
        <div className="ml-auto flex flex-shrink-0 items-center gap-1">
          {anyActive && (
            <button
              type="button"
              onClick={onStopAll}
              className="flex items-center gap-1 rounded-md border border-violet-300 px-1.5 py-0.5 text-[11px] font-semibold text-violet-700 transition-colors hover:bg-violet-200/60 dark:border-violet-500/30 dark:text-violet-200 dark:hover:bg-violet-500/15"
            >
              <Square className="h-2.5 w-2.5" /> Stop all
            </button>
          )}
          <button
            type="button"
            onClick={onOpenRun}
            title="Open the full Run View"
            className="flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-semibold text-violet-600 transition-colors hover:bg-violet-200/60 dark:text-violet-300 dark:hover:bg-violet-500/15"
          >
            <ExternalLink className="h-3 w-3" /> Run View
          </button>
        </div>
      </div>

      {/* Embedded topology map (lead → workers). Left-aligned + horizontal-scroll safety valve —
          `justify-center` would center any overflow and clip both edges under this card's
          `overflow-hidden` (FLUX-1334); the topology's own flex-wrap should keep it from overflowing. */}
      <div className="flex overflow-x-auto border-b border-violet-200/50 bg-white/50 px-2 py-2.5 dark:border-violet-500/10 dark:bg-black/20">
        <OrchestrationTopology group={group} variant="map" />
      </div>

      {/* Per-agent rows. */}
      <div className="space-y-1.5 p-2.5">
        {ordered.map((s) => (
          <DelegateRow
            key={s.id}
            session={s}
            isLead={s === agg.lead}
            live={live}
            onStopSession={onStopSession}
          />
        ))}
      </div>
    </div>
  );
}
