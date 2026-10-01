// Ticket read guard (FLUX-1754).
//
// A ticket file can be READ while something else is writing it: the sync-watcher's git merge
// rewrites files in place, an external editor saves in two steps, a crash leaves a truncated file.
// The engine then holds the last good copy in memory and a worse copy on disk, and the question is
// which one wins. Before this guard the answer was "the disk", twice over: the loader would
// auto-repair the truncated parse and WRITE IT BACK, and a status change would read the empty body
// from disk and persist it. FLUX-1739's ticket lost its 51 KB body and twelve frontmatter fields
// that way, in a 14-minute window with four concurrent review writes.
//
// The rule: an incoming read that has LOST things the cache has — the body, or identity/linkage
// fields — is a suspect read. A legitimate edit adds, changes or clears one field on purpose; it does
// not silently drop the body and `branch` and `implementationLink` at the same time.

export interface TicketReadView {
  body?: string | undefined;
  frontmatter: Record<string, unknown>;
}

/** Fields a legitimate write essentially never removes once set. Clearing one is done by setting null, not by omission. */
export const LOAD_BEARING_FIELDS = ['id', 'title', 'status', 'branch', 'implementationLink', 'baselineCommit', 'createdBy'] as const;

/** Below this many cached entries the history-shrink rule stays silent (see detectSuspectRead). */
export const HISTORY_SHRINK_MIN_ENTRIES = 8;

export interface SuspectRead {
  reasons: string[];
}

function has(fm: Record<string, unknown>, key: string): boolean {
  return fm[key] !== undefined;
}

/**
 * Compare an incoming read against the cached ticket. Returns the reasons it looks like a partial or
 * corrupt read, or null when it is plausibly a real edit.
 *
 * `allowBodyClear` is for the one caller that is allowed to empty a body on purpose (an explicit
 * body replacement); every other path treats a non-empty → empty body as loss.
 */
export function detectSuspectRead(
  cached: TicketReadView | undefined,
  incoming: TicketReadView,
  opts: { allowBodyClear?: boolean } = {},
): SuspectRead | null {
  if (!cached) return null;
  const reasons: string[] = [];

  const cachedBody = (cached.body ?? '').trim();
  const incomingBody = (incoming.body ?? '').trim();
  if (!opts.allowBodyClear && cachedBody.length > 0 && incomingBody.length === 0) {
    reasons.push(`body ${cachedBody.length} chars → empty`);
  }

  const lost = LOAD_BEARING_FIELDS.filter((k) => has(cached.frontmatter, k) && !has(incoming.frontmatter, k));
  if (lost.length > 0) reasons.push(`lost ${lost.join(', ')}`);

  // A history that got SHORTER is not a real edit either: history is append-only. Only judged once
  // the cached history is substantial — the cache carries a synthesized "Created ticket" entry that a
  // bare fixture file never had, so on tiny histories a ratio says nothing.
  const cachedHistory = Array.isArray(cached.frontmatter.history) ? cached.frontmatter.history.length : 0;
  const incomingHistory = Array.isArray(incoming.frontmatter.history) ? incoming.frontmatter.history.length : 0;
  if (cachedHistory >= HISTORY_SHRINK_MIN_ENTRIES && incomingHistory < cachedHistory * 0.5) {
    reasons.push(`history ${cachedHistory} → ${incomingHistory} entries`);
  }

  return reasons.length > 0 ? { reasons } : null;
}
