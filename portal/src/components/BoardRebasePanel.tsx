import { useMemo, useState } from 'react';
import { Layers, Check, X, ArrowRight, Archive, GitMerge, Play, Sparkles, PauseCircle, AlertTriangle } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { usePendingInteractions } from './pendingInteractions';
import { useAppSelector, useTaskById } from '../store/useAppSelector';
import { useDockActions } from './DockProvider';
import { StatusBadge } from './StatusBadge';
import { normalizeStatus } from '../workflow';
import { formatRelative } from '../lib/relativeTime';
import {
  resolveBoardRebase,
  type PendingBoardRebase,
  type BoardRebaseItem,
  type BoardRebaseKind,
  type BoardRebaseFailure,
} from '../api';

/**
 * FLUX-659 / FLUX-720 / FLUX-722: the board-rebase batch-approval surface. The orchestrator emits a
 * batch of proposed restructurings via `propose_board_rebase`; the engine parks it and broadcasts
 * `board-rebase-proposed`. This panel renders the batch with a per-item toggle (default checked),
 * a glanceable per-kind action header (FLUX-722 — e.g. a real `Todo → In Progress` status pill),
 * the referenced ticket's LIVE title/status/last-update, and a single "Apply approved" (executes
 * the checked subset) plus "Dismiss" (resolves with an empty set — applies nothing). The pending
 * queue is owned by `PendingInteractionsProvider`; the panel renders inline in the originating
 * chat's dock (routed by `conversationId`), and the same batch also mirrors in the unified
 * attention surface (`AttentionDock`, FLUX-898), so a closed-chat batch is never lost.
 *
 * Hard rule: nothing is applied until the user clicks Apply — the orchestrator proposes, the human
 * approves. "Leave" items are the safe default (the stream stays in the durable orchestrator thread).
 */

const KIND_META: Record<BoardRebaseKind, { label: string; Icon: LucideIcon; tone: string }> = {
  status: { label: 'Move', Icon: ArrowRight, tone: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300' },
  archive: { label: 'Archive', Icon: Archive, tone: 'bg-gray-200 text-gray-700 dark:bg-gray-700 dark:text-gray-200' },
  dispatch: { label: 'Run', Icon: Play, tone: 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300' },
  fold: { label: 'Fold', Icon: GitMerge, tone: 'bg-violet-100 text-violet-700 dark:bg-violet-900/30 dark:text-violet-300' },
  promote: { label: 'Promote', Icon: Sparkles, tone: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300' },
  leave: { label: 'Leave', Icon: PauseCircle, tone: 'bg-sky-100 text-sky-700 dark:bg-sky-900/30 dark:text-sky-300' },
};

const ARCHIVED_TONE = 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400';

/**
 * Inline panel for one chat pane — shows this conversation's pending board-rebase batches AND any
 * post-apply per-item failures (FLUX-729). The failure cards survive the SSE-driven drop of the
 * pending batch, so an item that failed to apply stays visible (and dismissable) instead of only
 * being `console.warn`'d.
 */
export function ChatBoardRebasePanel({ conversationId }: { conversationId: string }) {
  const { rebases, removeRebase, rebaseFailures, reportRebaseFailure, dismissRebaseFailure } =
    usePendingInteractions();
  const mine = rebases.filter((p) => p.conversationId === conversationId);
  const myFailures = rebaseFailures.filter((f) => f.conversationId === conversationId);
  if (mine.length === 0 && myFailures.length === 0) return null;

  return (
    <div className="flex flex-col gap-2">
      {mine.map((p) => (
        <RebaseCard
          key={p.id}
          batch={p}
          onResolved={() => removeRebase(p.id)}
          onFailures={reportRebaseFailure}
        />
      ))}
      {myFailures.map((f) => (
        <RebaseFailureCard key={`fail-${f.batchId}`} failure={f} onDismiss={() => dismissRebaseFailure(f.batchId)} />
      ))}
    </div>
  );
}

export function RebaseCard({
  batch,
  onResolved,
  onFailures,
}: {
  batch: PendingBoardRebase;
  onResolved: () => void;
  /** FLUX-729: hand off the failed-item subset so it persists after this card unmounts. */
  onFailures?: (failure: BoardRebaseFailure) => void;
}) {
  // Live ticket store — used to default-deselect already-satisfied "status" items (FLUX-722).
  const taskById = useAppSelector((s) => s.taskById);
  const isNoOp = (it: BoardRebaseItem) =>
    it.kind === 'status' && !!it.newStatus && taskById.get(it.targets[0])?.status === it.newStatus;

  // Per-item approval — default every actionable item checked; a status move that's already
  // satisfied (target already in newStatus) starts UNchecked so we don't re-apply a no-op.
  const [approved, setApproved] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(batch.items.map((it) => [it.id, !isNoOp(it)])),
  );
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  const approvedCount = batch.items.filter((it) => approved[it.id]).length;

  // Batch header summary: "1 Move · 1 Leave".
  const countSummary = useMemo(() => {
    const counts = new Map<BoardRebaseKind, number>();
    for (const it of batch.items) counts.set(it.kind, (counts.get(it.kind) ?? 0) + 1);
    return [...counts.entries()].map(([kind, n]) => `${n} ${KIND_META[kind].label}`).join(' · ');
  }, [batch.items]);

  function toggle(id: string) {
    setApproved((prev) => ({ ...prev, [id]: !prev[id] }));
  }

  async function apply(ids: string[]) {
    if (submitting) return;
    setSubmitting(true);
    setError('');
    const res = await resolveBoardRebase(batch.id, ids).catch(() => null);
    if (res === null) {
      // POST failed entirely — keep the card so the user can retry (no longer swallowed).
      setError('Couldn’t reach the engine — check it’s running and try again.');
      setSubmitting(false);
      return;
    }
    if (res.timedOut) {
      setError('The engine didn’t respond within 15s — it may be busy or hung. Restart it, then re-run the cleanup.');
      setSubmitting(false);
      return;
    }
    if (res.expired) {
      // Batch gone server-side (engine restarted, or already applied). In-memory proposals don't
      // survive a restart — say so plainly instead of failing silently; Dismiss clears the dead card.
      setError('This proposal expired (the engine restarted, or it was already applied). Ask the agent to re-run the board cleanup, then Dismiss.');
      setSubmitting(false);
      return;
    }
    const failed = res.results.filter((r) => !r.ok);
    if (failed.length > 0) {
      // The batch is resolved server-side (SSE will drop this card), so snapshot the failed items
      // into the provider's separate failure queue (FLUX-729) — surfaced as a persistent, dismissable
      // summary card instead of only a console.warn. Successful items have already cleared.
      console.warn('[board-rebase] some items failed to apply:', failed);
      onFailures?.({
        batchId: batch.id,
        conversationId: batch.conversationId,
        createdAt: new Date().toISOString(),
        items: batch.items,
        failed,
      });
    }
    // The engine also broadcasts board-rebase-resolved (idempotent); remove locally now.
    onResolved();
  }

  // Dismiss best-efforts the server resolve (apply nothing) but ALWAYS drops the card locally,
  // so a dead/expired/wedged batch can still be cleared from view (FLUX-773).
  function dismiss() {
    if (submitting) return;
    void resolveBoardRebase(batch.id, []).catch(() => null); // best-effort, don't block
    onResolved(); // drop the card now, even on a hung/dead engine
  }

  const relProposed = formatRelative(batch.createdAt);

  return (
    <div className="eh-border rounded-xl border border-primary/30 bg-primary/5 p-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-1.5 text-xs font-bold text-primary">
          <Layers className="h-3.5 w-3.5 shrink-0" />
          <span className="truncate">Board-rebase{countSummary ? ` · ${countSummary}` : ''}</span>
        </div>
        {relProposed && (
          <span className="shrink-0 text-[10px] text-[var(--eh-text-muted)]" title={batch.createdAt}>
            proposed {relProposed}
          </span>
        )}
      </div>
      <div className="flex flex-col gap-1.5">
        {batch.items.map((it) => (
          <RebaseRow key={it.id} item={it} checked={!!approved[it.id]} onToggle={() => toggle(it.id)} />
        ))}
      </div>
      {error && <p className="mt-2 text-[11px] font-medium text-red-600 dark:text-red-400">{error}</p>}
      <div className="mt-2.5 flex gap-2">
        <button
          type="button"
          onClick={() => void apply(batch.items.filter((it) => approved[it.id]).map((it) => it.id))}
          disabled={submitting || approvedCount === 0}
          className="flex items-center gap-1 rounded-lg bg-primary px-3 py-1.5 text-[12px] font-semibold text-white transition-colors hover:bg-primary-hover disabled:opacity-40"
        >
          <Check className="h-3.5 w-3.5" /> Apply approved ({approvedCount})
        </button>
        <button
          type="button"
          onClick={() => void dismiss()}
          disabled={submitting}
          className="flex items-center gap-1 rounded-lg bg-gray-200 px-3 py-1.5 text-[12px] font-semibold text-gray-700 transition-colors hover:bg-gray-300 disabled:opacity-40 dark:bg-white/10 dark:text-gray-200 dark:hover:bg-white/20"
        >
          <X className="h-3.5 w-3.5" /> Dismiss
        </button>
      </div>
    </div>
  );
}

/**
 * FLUX-729: a persistent summary of the items that FAILED to apply when a board-rebase batch was
 * resolved. Rendered from the provider's failure queue (which survives the SSE drop of the pending
 * batch), so failures stay visible after the approval card is gone. Successful items already cleared;
 * this card shows only the failures with their engine `message`, plus a Dismiss. There's no retry —
 * the batch is resolved server-side, so a failed item would need a fresh proposal, not a re-apply.
 */
export function RebaseFailureCard({ failure, onDismiss }: { failure: BoardRebaseFailure; onDismiss: () => void }) {
  const itemById = useMemo(() => new Map(failure.items.map((it) => [it.id, it])), [failure.items]);
  const n = failure.failed.length;

  return (
    <div className="eh-border rounded-xl border border-red-400/40 bg-red-500/5 p-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-1.5 text-xs font-bold text-red-600 dark:text-red-400">
          <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
          <span className="truncate">Board-rebase · {n} item{n === 1 ? '' : 's'} failed to apply</span>
        </div>
        <button
          type="button"
          onClick={onDismiss}
          className="flex shrink-0 items-center gap-1 rounded-lg bg-gray-200 px-2 py-1 text-[11px] font-semibold text-gray-700 transition-colors hover:bg-gray-300 dark:bg-white/10 dark:text-gray-200 dark:hover:bg-white/20"
        >
          <X className="h-3 w-3" /> Dismiss
        </button>
      </div>
      <div className="flex flex-col gap-1.5">
        {failure.failed.map((r) => {
          const item = itemById.get(r.id);
          const meta = KIND_META[r.kind];
          return (
            <div
              key={r.id}
              className="flex flex-col gap-1 rounded-lg border border-red-400/30 bg-[var(--eh-input-bg)] px-2.5 py-2"
            >
              <span className="flex flex-wrap items-center gap-1.5">
                <span className={`inline-flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide ${meta.tone}`}>
                  <meta.Icon className="h-3 w-3" /> {meta.label}
                </span>
                {item && <span className="min-w-0 truncate text-[12px] font-medium text-[var(--eh-text-primary)]">{item.summary}</span>}
              </span>
              <span className="text-[11px] font-medium text-red-600 dark:text-red-400">{r.message}</span>
              {item && (
                <span className="flex flex-col gap-0.5">
                  {item.targets.map((id) => (
                    <TicketRef key={id} id={id} />
                  ))}
                </span>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function RebaseRow({ item, checked, onToggle }: { item: BoardRebaseItem; checked: boolean; onToggle: () => void }) {
  const meta = KIND_META[item.kind];
  const primary = useTaskById(item.targets[0]);
  const noOp = item.kind === 'status' && !!item.newStatus && primary?.status === item.newStatus;

  return (
    <label
      className={`flex cursor-pointer items-start gap-2 rounded-lg border px-2.5 py-2 transition-colors ${
        checked ? 'border-primary/40 bg-[var(--eh-input-bg)]' : 'eh-border bg-transparent opacity-60'
      }`}
    >
      <input
        type="checkbox"
        checked={checked}
        onChange={onToggle}
        className="mt-1 h-3.5 w-3.5 flex-shrink-0 accent-[var(--eh-primary,#2563eb)]"
      />
      <span className="flex min-w-0 flex-1 flex-col gap-1">
        {/* Glanceable per-kind action header (FLUX-722). */}
        <span className="flex flex-wrap items-center gap-1.5">
          <span className={`inline-flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide ${meta.tone}`}>
            <meta.Icon className="h-3 w-3" /> {meta.label}
          </span>
          {item.kind === 'status' && item.newStatus && (
            <span className="inline-flex items-center gap-1">
              {primary && <StatusBadge status={normalizeStatus(primary.status)} className="text-[10px]" />}
              <ArrowRight className="h-3 w-3 text-[var(--eh-text-muted)]" />
              <StatusBadge status={normalizeStatus(item.newStatus)} className="text-[10px]" />
              {noOp && <span className="text-[10px] font-medium text-[var(--eh-text-muted)]">already there</span>}
            </span>
          )}
          {item.kind === 'archive' && (
            <span className="inline-flex items-center gap-1">
              <ArrowRight className="h-3 w-3 text-[var(--eh-text-muted)]" />
              <StatusBadge status="Archived" colorClass={ARCHIVED_TONE} className="text-[10px]" />
            </span>
          )}
          {item.kind === 'dispatch' && (
            <span className="text-[11px] font-medium text-[var(--eh-text-muted)]">{item.phase ? `phase: ${item.phase}` : 'default phase'}</span>
          )}
          {item.kind === 'fold' && item.into && (
            <span className="inline-flex items-center gap-1 text-[11px] text-[var(--eh-text-muted)]">
              <ArrowRight className="h-3 w-3" /> <span className="font-mono text-[10px]">{item.into}</span>
            </span>
          )}
          {item.kind === 'promote' && <span className="text-[11px] font-medium text-[var(--eh-text-muted)]">→ new card</span>}
          {item.kind === 'leave' && <span className="text-[11px] text-[var(--eh-text-muted)]">stays in thread</span>}
        </span>

        {/* The orchestrator's one-line rationale for THIS item. */}
        <span className="text-[12px] font-medium text-[var(--eh-text-primary)]">{item.summary}</span>

        {/* Live identity of every referenced ticket (FLUX-722). */}
        <span className="flex flex-col gap-0.5">
          {item.targets.map((id) => (
            <TicketRef key={id} id={id} />
          ))}
          {item.kind === 'fold' && item.into && <TicketRef id={item.into} intoBadge />}
        </span>

        {item.rationale && <span className="line-clamp-2 text-[11px] text-[var(--eh-text-muted)]">{item.rationale}</span>}
      </span>
    </label>
  );
}

/** A referenced ticket's LIVE identity: id · full current title · status chip · last-updated. */
function TicketRef({ id, intoBadge }: { id: string; intoBadge?: boolean }) {
  const task = useTaskById(id);
  const { openChat } = useDockActions();
  // FLUX-725: last-entry date comes from the list digest (was full history's last element).
  const lastUpdate = task?.historyDigest?.lastEntry?.date || undefined;
  const rel = formatRelative(lastUpdate);

  return (
    <button
      type="button"
      onClick={(e) => {
        // Inside the row <label> — don't let opening the ticket also toggle the checkbox.
        e.preventDefault();
        e.stopPropagation();
        openChat(id);
      }}
      title={`Open ${id}`}
      className="group/ref flex min-w-0 items-center gap-1.5 self-start rounded-md px-1 py-0.5 text-left transition-colors hover:bg-black/5 dark:hover:bg-white/5"
    >
      {intoBadge && <span className="shrink-0 text-[9px] font-semibold uppercase tracking-wide text-[var(--eh-text-muted)]">into</span>}
      <span className="shrink-0 font-mono text-[10px] text-[var(--eh-text-muted)] group-hover/ref:text-primary">{id}</span>
      {task ? (
        <>
          <span className="truncate text-[11px] text-[var(--eh-text-primary)]">{task.title || '(untitled)'}</span>
          <StatusBadge status={normalizeStatus(task.status)} className="shrink-0 text-[10px]" />
          {rel && <span className="shrink-0 text-[10px] text-[var(--eh-text-muted)]">· {rel}</span>}
        </>
      ) : (
        <span className="truncate text-[11px] italic text-[var(--eh-text-muted)]">not a board ticket</span>
      )}
    </button>
  );
}
