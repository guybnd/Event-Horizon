import { useEffect, useState } from 'react';
import { Layers, Check, X } from 'lucide-react';
import { useAppActions } from '../store/useAppSelector';
import {
  fetchPendingBoardRebases,
  resolveBoardRebase,
  type PendingBoardRebase,
  type BoardRebaseItem,
  type BoardRebaseKind,
} from '../api';

/**
 * FLUX-659: the board-rebase batch-approval surface. The orchestrator emits a batch of proposed
 * restructurings via `propose_board_rebase`; the engine parks it and broadcasts
 * `board-rebase-proposed`. This panel renders the batch with a per-item toggle (default checked),
 * the summary + rationale, and a single "Apply approved" (executes the checked subset) plus
 * "Dismiss" (resolves with an empty set — applies nothing). Modeled on ApprovalPrompts /
 * ChatQuestionPicker (SSE subscribe + one catch-up fetch on mount), rendered inline in the
 * orchestrator dock so a parked proposal is impossible to miss.
 *
 * Hard rule: nothing is applied until the user clicks Apply — the orchestrator proposes, the human
 * approves. "Leave" items are the safe default (the stream stays in the durable orchestrator thread).
 */

const KIND_LABEL: Record<BoardRebaseKind, string> = {
  promote: 'Promote',
  fold: 'Fold',
  archive: 'Archive',
  dispatch: 'Dispatch',
  status: 'Status',
  leave: 'Leave',
};

const KIND_TONE: Record<BoardRebaseKind, string> = {
  promote: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300',
  fold: 'bg-violet-100 text-violet-700 dark:bg-violet-900/30 dark:text-violet-300',
  archive: 'bg-gray-200 text-gray-700 dark:bg-gray-700 dark:text-gray-200',
  dispatch: 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300',
  status: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300',
  leave: 'bg-sky-100 text-sky-700 dark:bg-sky-900/30 dark:text-sky-300',
};

/** Inline panel for one chat pane — shows only this conversation's pending board-rebase batches. */
export function ChatBoardRebasePanel({ conversationId }: { conversationId: string }) {
  const { subscribeToEvent } = useAppActions();
  const [pending, setPending] = useState<PendingBoardRebase[]>([]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const p = await fetchPendingBoardRebases();
        if (!cancelled) setPending(p);
      } catch {
        /* ignore — SSE will deliver new ones */
      }
    })();
    const onProposed = (d: unknown) => {
      const batch = d as PendingBoardRebase | null;
      if (!batch || !batch.id) return;
      setPending((prev) => (prev.some((p) => p.id === batch.id) ? prev : [...prev, batch]));
    };
    const onResolved = (d: unknown) => {
      const id = (d as { id?: string } | null)?.id;
      if (id) setPending((prev) => prev.filter((p) => p.id !== id));
    };
    const unsubs = [
      subscribeToEvent('board-rebase-proposed', onProposed),
      subscribeToEvent('board-rebase-resolved', onResolved),
    ];
    return () => { cancelled = true; unsubs.forEach((u) => u()); };
  }, [subscribeToEvent]);

  const mine = pending.filter((p) => p.conversationId === conversationId);
  if (mine.length === 0) return null;

  return (
    <div className="flex flex-col gap-2">
      {mine.map((p) => (
        <RebaseCard key={p.id} batch={p} onResolved={() => setPending((prev) => prev.filter((x) => x.id !== p.id))} />
      ))}
    </div>
  );
}

function RebaseCard({ batch, onResolved }: { batch: PendingBoardRebase; onResolved: () => void }) {
  // Per-item approval — default every item checked (the "approve in a batch" feel).
  const [approved, setApproved] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(batch.items.map((it) => [it.id, true])),
  );
  const [submitting, setSubmitting] = useState(false);

  const approvedCount = batch.items.filter((it) => approved[it.id]).length;

  function toggle(id: string) {
    setApproved((prev) => ({ ...prev, [id]: !prev[id] }));
  }

  async function apply(ids: string[]) {
    if (submitting) return;
    setSubmitting(true);
    try {
      await resolveBoardRebase(batch.id, ids);
      // The engine also broadcasts board-rebase-resolved (idempotent); remove locally now so the
      // panel clears immediately. If the POST failed we keep the card so the user can retry.
      onResolved();
    } catch {
      setSubmitting(false);
    }
  }

  return (
    <div className="eh-border rounded-xl border border-primary/30 bg-primary/5 p-3">
      <div className="mb-2 flex items-center gap-1.5 text-xs font-bold text-primary">
        <Layers className="h-3.5 w-3.5" /> Board-rebase proposal · {batch.items.length} item{batch.items.length === 1 ? '' : 's'}
      </div>
      <div className="flex flex-col gap-1.5">
        {batch.items.map((it) => (
          <RebaseRow key={it.id} item={it} checked={!!approved[it.id]} onToggle={() => toggle(it.id)} />
        ))}
      </div>
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
          onClick={() => void apply([])}
          disabled={submitting}
          className="flex items-center gap-1 rounded-lg bg-gray-200 px-3 py-1.5 text-[12px] font-semibold text-gray-700 transition-colors hover:bg-gray-300 disabled:opacity-40 dark:bg-white/10 dark:text-gray-200 dark:hover:bg-white/20"
        >
          <X className="h-3.5 w-3.5" /> Dismiss
        </button>
      </div>
    </div>
  );
}

function RebaseRow({ item, checked, onToggle }: { item: BoardRebaseItem; checked: boolean; onToggle: () => void }) {
  return (
    <label
      className={`flex cursor-pointer items-start gap-2 rounded-lg border px-2.5 py-1.5 transition-colors ${
        checked
          ? 'border-primary/40 bg-[var(--eh-input-bg)]'
          : 'eh-border bg-transparent opacity-60'
      }`}
    >
      <input
        type="checkbox"
        checked={checked}
        onChange={onToggle}
        className="mt-0.5 h-3.5 w-3.5 flex-shrink-0 accent-[var(--eh-primary,#2563eb)]"
      />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex items-center gap-1.5">
          <span className={`rounded px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide ${KIND_TONE[item.kind]}`}>
            {KIND_LABEL[item.kind]}
          </span>
          <span className="truncate text-[12px] font-medium text-[var(--eh-text-primary)]">{item.summary}</span>
        </span>
        {item.rationale && (
          <span className="text-[11px] text-[var(--eh-text-muted)]">{item.rationale}</span>
        )}
        {(item.targets.length > 0 || item.newStatus || item.phase || item.into) && (
          <span className="text-[10px] font-mono text-[var(--eh-text-muted)]">
            {item.targets.join(', ')}
            {item.into ? ` → ${item.into}` : ''}
            {item.newStatus ? ` → ${item.newStatus}` : ''}
            {item.phase ? ` · ${item.phase}` : ''}
          </span>
        )}
      </span>
    </label>
  );
}
