import type { TranscriptMessage } from './api';

/**
 * FLUX-750: module-level transcript cache — a tiny in-memory LRU keyed by `conversationId`.
 *
 * Why a module singleton and not React state: `useChatSession` is the shared core for the modal
 * pane, the board popup, and the orchestrator dock window, so it must NOT couple to the dock's
 * context. Minimizing a dock chat unmounts its `<ChatWindow>` (and the hook's local `messages`
 * state with it); module scope survives that unmount for free, so a reopen can hydrate the
 * transcript synchronously — no blank flash, no cold re-fetch pop. This mirrors `DockProvider`'s
 * in-memory `drafts` map (survives minimize, resets on a full page reload) — same lifetime, just
 * in module scope because the consumer isn't dock-scoped.
 *
 * The cache is bounded by `MAX_CACHED_TRANSCRIPTS` (LRU): message arrays are tiny next to the DOM
 * trees + live listeners a mounted window keeps, so this stays well within the portal's memory
 * budget. Eviction only costs the evicted conversation a one-time cold load (with the spinner) on
 * its next open. The durable transcript on disk remains the source of truth; this is purely a
 * frontend render-latency cache reconciled by the hook's SWR revalidation on every mount.
 */

/** LRU cap — how many conversations' transcripts we keep warm in memory at once. */
const MAX_CACHED_TRANSCRIPTS = 12;

// Insertion order in a Map IS recency order: a `set` deletes-then-re-inserts the key so it moves
// to the newest slot, and the oldest (first) key is evicted once we exceed the cap.
const cache = new Map<string, TranscriptMessage[]>();

/** Cached transcript for `id`, or `undefined` on a miss. A hit does NOT bump recency — only
 *  `setTranscript` (a write-through update) does, which is the freshness signal we care about. */
export function getTranscript(id: string): TranscriptMessage[] | undefined {
  return cache.get(id);
}

/** True when `id` has a cached transcript — drives the hook's "render instantly vs show spinner"
 *  decision on mount (a miss is a genuine cold open). */
export function hasTranscript(id: string): boolean {
  return cache.has(id);
}

/** Write-through the latest transcript for `id`, bumping it to most-recently-used and evicting the
 *  oldest entry beyond the cap. */
export function setTranscript(id: string, msgs: TranscriptMessage[]): void {
  // Delete-then-set so the key lands in the newest slot (recency bump).
  cache.delete(id);
  cache.set(id, msgs);
  if (cache.size > MAX_CACHED_TRANSCRIPTS) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
}
