// Shared chat-context helpers (FLUX-642 / FLUX-643). ChatView stays transport-free, so the
// callers (ChatDock window + modal ChatPane) build these from data they already hold and pass
// them in as the `contextCard` node / `quickReplies` list. Centralized here so both surfaces
// behave identically without duplicating the parsing.

import { History, Sparkles } from 'lucide-react';
import type { Task, HistoryEntry } from '../../types';
import { isAgentSession } from '../../types';
import { relativeTime } from '../../workflow';

/** The most recent "where this left off" entry — newest agent comment or session outcome. */
function lastContextEntry(task: Task): { label: string; text: string; date: string } | null {
  const history: HistoryEntry[] = task.history ?? [];
  for (let i = history.length - 1; i >= 0; i--) {
    const entry = history[i]!;
    if (isAgentSession(entry)) {
      const text = entry.finalMessage?.trim() || entry.comment?.trim() || entry.outcome?.trim();
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
