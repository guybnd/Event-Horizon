import { useState } from 'react';
import { ShieldAlert, Check, X } from 'lucide-react';
import { usePendingInteractions } from './pendingInteractions';
import { resolvePermission, type PendingApproval } from '../api';

/**
 * FLUX-605 / FLUX-720: surfaces a gated tool call awaiting human approval. A 'gated' session
 * (e.g. the orchestrator) routes destructive ops (change_status, delete_branch, finish_ticket,
 * Bash) through EH; the engine parks the call and broadcasts it, and this prompt lets the user
 * Allow/Deny. The pending queue is owned by `PendingInteractionsProvider` (one shared SSE
 * subscription); this file renders the inline-in-chat panel + the card, routed by
 * `conversationId` like `ChatQuestionPicker`/`ChatBoardRebasePanel`. The detached bottom-left
 * overlay it used to be is gone — unrouted/closed-chat approvals fall through to the unified
 * global fallback (`PendingInteractionFallback`).
 */

/** Inline panel for one chat pane — shows only this conversation's pending approvals. */
export function ChatApprovalPanel({ conversationId }: { conversationId: string }) {
  const { approvals, removeApproval } = usePendingInteractions();
  const mine = approvals.filter((p) => p.conversationId === conversationId);
  if (mine.length === 0) return null;

  return (
    <div className="flex flex-col gap-2">
      {mine.map((p) => (
        <ApprovalCard key={p.id} pending={p} onResolved={() => removeApproval(p.id)} />
      ))}
    </div>
  );
}

/**
 * The approval card — an Allow/Deny prompt for one gated tool call. Used inline in the chat and
 * by the global fallback overlay. Resolution removes the card only after the engine accepts the
 * POST (the engine also broadcasts `permission-resolved`, which removes it via SSE — idempotent);
 * a failed POST keeps the card so the user can retry while the agent stays parked.
 */
export function ApprovalCard({ pending, onResolved }: { pending: PendingApproval; onResolved: () => void }) {
  const [submitting, setSubmitting] = useState(false);

  async function decide(behavior: 'allow' | 'deny') {
    if (submitting) return;
    setSubmitting(true);
    try {
      await resolvePermission(pending.id, behavior);
      onResolved();
    } catch {
      setSubmitting(false);
    }
  }

  return (
    <div className="rounded-xl border border-amber-300 bg-amber-50 p-3 shadow-sm dark:border-amber-500/40 dark:bg-amber-950/50">
      <div className="mb-1 flex items-center gap-1.5 text-xs font-bold text-amber-700 dark:text-amber-300">
        <ShieldAlert className="h-3.5 w-3.5" /> Approve agent action?
      </div>
      <div className="mb-2 text-[12px] text-gray-700 dark:text-gray-200">
        An agent wants to run <span className="font-mono font-semibold">{cleanTool(pending.toolName)}</span>
        {summarizeInput(pending.input) && <span className="text-gray-500"> · {summarizeInput(pending.input)}</span>}
      </div>
      <div className="flex gap-2">
        <button
          type="button"
          onClick={() => void decide('allow')}
          disabled={submitting}
          className="flex items-center gap-1 rounded-lg bg-emerald-600 px-3 py-1 text-[12px] font-semibold text-white transition-colors hover:bg-emerald-500 disabled:opacity-40"
        >
          <Check className="h-3.5 w-3.5" /> Allow
        </button>
        <button
          type="button"
          onClick={() => void decide('deny')}
          disabled={submitting}
          className="flex items-center gap-1 rounded-lg bg-gray-200 px-3 py-1 text-[12px] font-semibold text-gray-700 transition-colors hover:bg-gray-300 disabled:opacity-40 dark:bg-white/10 dark:text-gray-200 dark:hover:bg-white/20"
        >
          <X className="h-3.5 w-3.5" /> Deny
        </button>
      </div>
    </div>
  );
}

function cleanTool(name: string): string {
  return name.replace(/^mcp__.+?__/, '');
}

function summarizeInput(input: unknown): string {
  if (!input || typeof input !== 'object') return '';
  const o = input as Record<string, unknown>;
  const hint = o.ticketId ?? o.newStatus ?? o.command ?? o.id ?? o.file_path;
  return hint != null ? String(hint).replace(/\s+/g, ' ').slice(0, 50) : '';
}
