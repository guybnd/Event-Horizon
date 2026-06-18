import { useEffect, useState } from 'react';
import { ShieldAlert, Check, X } from 'lucide-react';
import { useAppActions } from '../store/useAppSelector';
import { fetchPendingApprovals, resolvePermission, type PendingApproval } from '../api';

/**
 * FLUX-605: surfaces gated tool calls awaiting human approval. A 'gated' session
 * (e.g. the orchestrator) routes destructive ops (change_status, delete_branch,
 * finish_ticket, Bash) through EH; the engine parks the call and broadcasts it,
 * and this prompt lets the user Allow/Deny. v1 is global (not yet routed to the
 * originating chat window); polls the pending queue.
 */
export function ApprovalPrompts() {
  const { subscribeToEvent } = useAppActions();
  const [pending, setPending] = useState<PendingApproval[]>([]);

  useEffect(() => {
    let cancelled = false;
    // One initial fetch catches anything already pending (e.g. after a reload). Thereafter the
    // engine pushes permission-request / permission-resolved over SSE — no 1s polling (FLUX-611).
    void (async () => {
      try {
        const p = await fetchPendingApprovals();
        if (!cancelled) setPending(p);
      } catch {
        /* ignore */
      }
    })();
    const onRequest = (d: unknown) => {
      const req = d as PendingApproval | null;
      if (!req || !req.id) return;
      setPending((prev) => (prev.some((p) => p.id === req.id) ? prev : [...prev, req]));
    };
    const onResolved = (d: unknown) => {
      const id = (d as { id?: string } | null)?.id;
      if (id) setPending((prev) => prev.filter((p) => p.id !== id));
    };
    const unsubs = [
      subscribeToEvent('permission-request', onRequest),
      subscribeToEvent('permission-resolved', onResolved),
    ];
    return () => { cancelled = true; unsubs.forEach((u) => u()); };
  }, [subscribeToEvent]);

  if (pending.length === 0) return null;

  async function decide(id: string, behavior: 'allow' | 'deny') {
    setPending((prev) => prev.filter((p) => p.id !== id));
    await resolvePermission(id, behavior);
  }

  return (
    <div className="fixed bottom-20 left-4 z-[60] flex w-[360px] flex-col gap-2">
      {pending.map((p) => (
        <div key={p.id} className="rounded-xl border border-amber-300 bg-amber-50 p-3 shadow-2xl dark:border-amber-500/40 dark:bg-amber-950/50">
          <div className="mb-1 flex items-center gap-1.5 text-xs font-bold text-amber-700 dark:text-amber-300">
            <ShieldAlert className="h-3.5 w-3.5" /> Approve agent action?
          </div>
          <div className="mb-2 text-[12px] text-gray-700 dark:text-gray-200">
            An agent wants to run <span className="font-mono font-semibold">{cleanTool(p.toolName)}</span>
            {summarizeInput(p.input) && <span className="text-gray-500"> · {summarizeInput(p.input)}</span>}
          </div>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => void decide(p.id, 'allow')}
              className="flex items-center gap-1 rounded-lg bg-emerald-600 px-3 py-1 text-[12px] font-semibold text-white hover:bg-emerald-500"
            >
              <Check className="h-3.5 w-3.5" /> Allow
            </button>
            <button
              type="button"
              onClick={() => void decide(p.id, 'deny')}
              className="flex items-center gap-1 rounded-lg bg-gray-200 px-3 py-1 text-[12px] font-semibold text-gray-700 hover:bg-gray-300 dark:bg-white/10 dark:text-gray-200 dark:hover:bg-white/20"
            >
              <X className="h-3.5 w-3.5" /> Deny
            </button>
          </div>
        </div>
      ))}
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
