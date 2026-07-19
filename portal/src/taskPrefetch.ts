import { fetchTask } from './api';
import type { Task } from './types';

/** FLUX-1517: hover-intent prefetch cache. Warms the two detail readers (modal + sideview) so
 *  the open transition finds the ticket already fetched instead of firing a cold `GET /tasks/:id`.
 *
 *  Short TTL is the entire freshness story: an entry older than TTL is treated as absent, so
 *  `fetchTaskCached` falls through to a live fetch and `peekTask` returns undefined. The readers'
 *  existing `liveHistSig`/`refreshTrigger` revalidation effects fire well after this TTL, so they
 *  keep hitting the network and stay live — this cache only primes the initial warm-open window,
 *  it is never a data store. Serves only the detail readers; a prefetched value must never flow
 *  into the list `tasks` store or the `fetchTaskListShape` SSE-patch path (see api.ts:190-199). */

const TTL_MS = 5000;
// FLUX-1542 Fix 5: hard cap on the cache size — a Map preserves insertion order, so re-inserting
// a key on hit moves it to "most recently used" and the oldest key (first in iteration order) is
// evicted once the cap is exceeded. Defensive bound, not a real scheduler.
const MAX_ENTRIES = 40;
// Throttle window for `prefetchTask` calls — bounds how many GETs a fast pointer sweep across a
// full column of cards can fire (each card's 120ms hover-intent timer would otherwise fire one).
const THROTTLE_MS = 250;

interface CacheEntry {
  promise: Promise<Task>;
  task?: Task;
  ts: number;
}

const cache = new Map<string, CacheEntry>();
let lastFetchAt = 0;

function isFresh(entry: CacheEntry): boolean {
  return Date.now() - entry.ts < TTL_MS;
}

/** Drops completed-but-stale entries so a long session doesn't retain a full Task payload for
 *  every card ever hovered but never opened (hover-only ids are never consumed by fetchTaskCached). */
function pruneStale(): void {
  for (const [id, entry] of cache) {
    if (entry.task && !isFresh(entry)) cache.delete(id);
  }
}

/** Evict the least-recently-used entry once the cache exceeds MAX_ENTRIES. Re-inserting `id` on
 *  a cache hit (delete + set) moves it to the end of the Map's iteration order, so the entry at
 *  the front is always the true LRU victim. */
function touch(id: string, entry: CacheEntry): void {
  cache.delete(id);
  cache.set(id, entry);
  while (cache.size > MAX_ENTRIES) {
    const oldestKey = cache.keys().next().value;
    if (oldestKey === undefined) break;
    cache.delete(oldestKey);
  }
}

/** Fire-and-forget warm-up. No-op if an entry is already in-flight or fresh, or if called again
 *  within THROTTLE_MS of the last actual fetch (a fast sweep across a column of cards must not
 *  fan out one GET per card). Errors are swallowed — a failed prefetch must never surface; the
 *  real open path re-fetches. */
export function prefetchTask(id: string): void {
  pruneStale();
  const existing = cache.get(id);
  if (existing && (!existing.task || isFresh(existing))) return;
  const now = Date.now();
  if (lastFetchAt && now >= lastFetchAt && now - lastFetchAt < THROTTLE_MS) return;
  lastFetchAt = now;
  const promise = fetchTask(id);
  const entry: CacheEntry = { promise, ts: now };
  touch(id, entry);
  promise
    .then((task) => { entry.task = task; entry.ts = Date.now(); touch(id, entry); })
    .catch(() => { cache.delete(id); });
}

/** What an open path should await: reuses an in-flight or fresh-cached prefetch with zero extra
 *  network, consuming it (one-shot) so subsequent revalidations go live. Falls through to an
 *  uncached fetch — never populates the cache itself; only `prefetchTask` writes it. */
export function fetchTaskCached(id: string): Promise<Task> {
  const existing = cache.get(id);
  if (existing && (!existing.task || isFresh(existing))) {
    cache.delete(id);
    return existing.promise;
  }
  return fetchTask(id);
}

/** Synchronous peek so a reader can paint warm content on first render with no loading state.
 *  Only returns a completed, within-TTL entry. */
export function peekTask(id: string): Task | undefined {
  const existing = cache.get(id);
  if (!existing || !existing.task || !isFresh(existing)) return undefined;
  return existing.task;
}

/** Test-only: clears the cache and the module-global throttle timestamp. `lastFetchAt` is
 *  process-lifetime state, so back-to-back tests that install a fresh fake clock each run land
 *  within THROTTLE_MS of the previous test's timestamp and get spuriously throttled. Call from
 *  `beforeEach` alongside any mock resets. */
export function __resetTaskPrefetchForTests(): void {
  cache.clear();
  lastFetchAt = 0;
}
