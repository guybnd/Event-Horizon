import type { ChatAttachment } from './api';

/** One in-flight optimistic user turn, parked so it survives a minimize/unmount. */
export interface PendingSend {
  text: string;
  attachments: ChatAttachment[];
  /** `messages.length` at submit time — the landing check only looks at turns appended after
   *  this point (mirrors `pendingBaselineRef` in useChatSession, FLUX-921). */
  baseline: number;
}

/**
 * FLUX-1495: module-level per-conversation cache for the optimistic `pendingUser` bubble — the
 * same lifetime trick as `chatQueueCache.ts` / `transcriptCache.ts` (survives minimize/unmount,
 * resets on a full page reload).
 *
 * `pendingUser` previously lived only in `useChatSession`'s local `useState`. Minimizing a dock
 * chat unmounts its `<ChatWindow>` (and the hook with it) the instant `send()` fires, which
 * DESTROYED the optimistic bubble. If the engine's transcript append lands after slow pre-spawn
 * awaits (git work, MCP setup — see `sendBoardInput`/`sendCliSessionInput`), a reopen inside that
 * gap re-seeds `messages` from the (still stale) transcript cache with no pending bubble to cover
 * for it, so the just-sent message is briefly invisible. Holding it in module scope survives the
 * unmount, mirroring the queue/transcript caches; the hook's landing effect still owns clearing it
 * once the committed turn appears in the transcript (or the turn errors/is stopped).
 */
const pending = new Map<string, PendingSend>();

/** Parked optimistic send for `id`, or `null` on a miss. */
export function getPendingSend(id: string): PendingSend | null {
  return pending.get(id) ?? null;
}

/** Write-through the parked send for `id`. Pass `null` to clear it. */
export function setPendingSend(id: string, value: PendingSend | null): void {
  if (value === null) pending.delete(id);
  else pending.set(id, value);
}
