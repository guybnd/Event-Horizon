import type { QueuedMessage } from './hooks/useChatSession';

/**
 * FLUX-837: module-level per-conversation chat-queue cache — the same lifetime trick as
 * `transcriptCache.ts` (survives minimize/unmount, resets on a full page reload).
 *
 * The FLUX-748 mid-turn message queue (messages submitted while the agent is `working`/`busy`,
 * parked to auto-dispatch when the turn finishes) lived only in `useChatSession`'s local
 * `useState`. Minimizing a dock chat unmounts its `<ChatWindow>` (and the hook with it), which
 * DESTROYED that queue — so a message the user submitted mid-turn was lost and never dispatched
 * (and, being un-sent, was in no durable store either). Holding the queue in module scope
 * survives that unmount, mirroring how the composer draft text (DockProvider, FLUX-623) and the
 * transcript (this file's sibling, FLUX-750) already survive minimize.
 *
 * Module scope on purpose: `useChatSession` is the shared core for the modal pane and the dock
 * windows, so — like the transcript cache — it must NOT couple to the dock's React context.
 * The queue is naturally tiny and short-lived, so there's no LRU bound here.
 */
const queues = new Map<string, QueuedMessage[]>();

/** Parked queue for `id` (empty array on a miss). The array is owned by the cache; callers treat
 *  it as read-only and replace it wholesale via `setChatQueue`. */
export function getChatQueue(id: string): QueuedMessage[] {
  return queues.get(id) ?? [];
}

/** Write-through the current queue for `id`. An empty queue is pruned from the map so an idle
 *  conversation leaves nothing behind (mirrors how an emptied draft is pruned in DockProvider). */
export function setChatQueue(id: string, msgs: QueuedMessage[]): void {
  if (msgs.length === 0) queues.delete(id);
  else queues.set(id, msgs);
}
