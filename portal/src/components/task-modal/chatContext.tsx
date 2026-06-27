// Shared chat-context helpers (FLUX-642 / FLUX-643). ChatView stays transport-free, so the
// callers (ChatDock window + modal ChatPane) build these from data they already hold and pass
// them in as the `contextCard` node / `quickReplies` list. Centralized here so both surfaces
// behave identically without duplicating the parsing.

import { History, Sparkles } from 'lucide-react';
import type { Task, HistoryEntry, CliSessionSummary, Config } from '../../types';
import { isAgentSession } from '../../types';
import { relativeTime } from '../../workflow';
import { stripRunMarker } from './chatRunProposal';

/** The most recent "where this left off" entry — newest agent comment or session outcome. */
function lastContextEntry(task: Task): { label: string; text: string; date: string } | null {
  const history: HistoryEntry[] = task.history ?? [];
  for (let i = history.length - 1; i >= 0; i--) {
    const entry = history[i]!;
    if (isAgentSession(entry)) {
      // FLUX-805: this card shows agent text verbatim (not via react-markdown), so strip any run
      // marker so a proposal that was the session's final message never flashes as a raw comment.
      const text = stripRunMarker(entry.finalMessage?.trim() || entry.comment?.trim() || entry.outcome?.trim() || '');
      if (text) return { label: 'Last agent session', text, date: entry.endedAt || entry.date };
      continue;
    }
    if (entry.type === 'comment' && entry.comment?.trim()) {
      return { label: `${entry.user} commented`, text: entry.comment.trim(), date: entry.date };
    }
  }
  return null;
}

/**
 * FLUX-642: a muted "where this left off" card for an empty ticket chat. Renders the ticket's
 * most recent agent comment / session summary as history context (NOT a fake chat bubble).
 * Returns null when there's nothing worth surfacing (caller falls back to the empty hint).
 */
export function TicketContextCard({ task }: { task: Task }) {
  const ctx = lastContextEntry(task);
  if (!ctx) return null;
  return (
    <div className="rounded-xl border border-[var(--eh-border)] bg-[var(--eh-input-bg)] p-3">
      <div className="mb-1.5 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide text-[var(--eh-text-muted)]">
        <History className="h-3 w-3" />
        <span>{ctx.label}</span>
        <span className="font-normal normal-case">· {relativeTime(ctx.date)}</span>
      </div>
      <p className="line-clamp-6 whitespace-pre-wrap text-[12px] leading-relaxed text-[var(--eh-text-secondary)]">{ctx.text}</p>
    </div>
  );
}

/**
 * FLUX-686: a quiet, read-only cumulative token/cost readout for the chat's bound CLI session.
 * ChatView is transport-free, so the callers (modal ChatPane / dock ChatWindow) build this from
 * the session they already hold and pass it in as the `meter` node.
 *
 * Scope note: this is the *per-session* total (the safe deliverable). Per-turn usage isn't on the
 * wire — `TranscriptMessage` carries none — so per-turn is a follow-up. A context-fill % is also
 * out of scope: the engine doesn't expose a context-window size to divide by. Honors the board's
 * tokens-vs-cost display mode (same as TokenBadge); renders nothing until the session has recorded
 * any usage.
 */
export function SessionMeter({ session, config }: { session?: CliSessionSummary | null; config?: Config | null }) {
  const inTok = session?.inputTokens ?? 0;
  const outTok = session?.outputTokens ?? 0;
  const cost = session?.costUSD ?? 0;
  if (inTok === 0 && outTok === 0 && cost === 0) return null;

  const showTokens = config?.tokenDisplayMode === 'tokens';
  const tokensLabel = `↑${(inTok / 1000).toFixed(1)}k ↓${(outTok / 1000).toFixed(1)}k`;
  // Adaptive precision (matches TokenBadge / FLUX-652): 2 decimals once it reads as real money,
  // finer below a dollar so a few cents doesn't collapse to $0.00.
  const costLabel = cost > 0 ? `$${cost >= 1 ? cost.toFixed(2) : cost.toFixed(4)}${session?.costIsEstimated ? '~' : ''}` : null;
  // Lead with the configured mode; keep the other figure as a muted suffix when present.
  const primary = showTokens ? tokensLabel : costLabel ?? tokensLabel;
  const secondary = showTokens ? costLabel : costLabel ? tokensLabel : null;

  const tip = [
    `↑ ${inTok.toLocaleString()} input / ↓ ${outTok.toLocaleString()} output tokens (session total)`,
    costLabel ? `Cost: ${costLabel}${session?.costIsEstimated ? ' (estimated)' : ''}` : null,
  ]
    .filter(Boolean)
    .join(' · ');

  return (
    <span title={tip} className="select-none whitespace-nowrap text-[10px] tabular-nums text-[var(--eh-text-muted)]">
      {primary}
      {secondary ? <span className="opacity-60"> · {secondary}</span> : null}
    </span>
  );
}

/**
 * FLUX-642: board snapshot for the empty orchestrator chat — at-a-glance counts so the
 * orchestrator (and the user) see the field before typing.
 */
export function BoardSnapshotCard({ tasks, requireInputStatus }: { tasks: Task[]; requireInputStatus: string }) {
  const working = tasks.filter((t) => t.cliSession?.status === 'running').length;
  const awaiting = tasks.filter((t) => t.status === requireInputStatus).length;
  const inProgress = tasks.filter((t) => t.status === 'In Progress').length;
  const todo = tasks.filter((t) => t.status === 'Todo').length;
  const ready = tasks.filter((t) => t.status === 'Ready').length;

  const stats: { label: string; count: number; tone: string }[] = [
    { label: 'working', count: working, tone: 'text-blue-500' },
    { label: 'awaiting input', count: awaiting, tone: 'text-amber-500' },
    { label: 'in progress', count: inProgress, tone: 'text-[var(--eh-text-primary)]' },
    { label: 'todo', count: todo, tone: 'text-[var(--eh-text-primary)]' },
    { label: 'ready', count: ready, tone: 'text-emerald-500' },
  ].filter((s) => s.count > 0);

  return (
    <div className="rounded-xl border border-[var(--eh-border)] bg-[var(--eh-input-bg)] p-3">
      <div className="mb-2 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide text-[var(--eh-text-muted)]">
        <Sparkles className="h-3 w-3" />
        <span>Board snapshot</span>
      </div>
      {stats.length === 0 ? (
        <p className="text-[12px] text-[var(--eh-text-secondary)]">The board is quiet — nothing in flight.</p>
      ) : (
        <div className="flex flex-wrap gap-x-4 gap-y-1.5">
          {stats.map((s) => (
            <span key={s.label} className="flex items-baseline gap-1 text-[12px] text-[var(--eh-text-secondary)]">
              <span className={`text-[15px] font-bold ${s.tone}`}>{s.count}</span>
              {s.label}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
