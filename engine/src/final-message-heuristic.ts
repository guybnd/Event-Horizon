/**
 * Heuristic for the session-end "blocking question can't die silently" backstop
 * (FLUX-570 → FLUX-777 → FLUX-945). Pure + dependency-free so it can be unit-tested directly.
 *
 * When a CLI session ends, its final assistant message sometimes asks the user a question that the
 * agent never routed to the board through a structured surface (`ask_user_question` / the
 * `require-input` swimlane). If that question lives only in the chat reply — especially on a ticket
 * the same session just moved to a terminal status (Done/Ready) — it vanishes the moment the user
 * looks away. This decides whether such a final message must be surfaced as a needs-action prompt.
 */

/** Phrasings that read like the agent is waiting on the user. */
const NEEDS_INPUT_RE =
  /\?|\breply\b|\bwhich\b|\bconfirm\b|\bchoose\b|\bdecision\b|\blet me know\b|\bproceed\b/i;

/**
 * Completion language (FLUX-777 false-positive guard): a "looks done" summary often contains a "?"
 * or a word like "proceed", and must NOT be mis-flagged as a pending question — UNLESS it also ends
 * with a real question (see below).
 */
const LOOKS_DONE_RE =
  /\b(done|completed?|finished|merged|shipped)\b|moved to done|implementation link|no further action|nothing (?:more |else )?(?:needed|to do|required)/i;

/**
 * A question at the VERY END of the message (after optional trailing markdown/quotes/whitespace).
 * This is the agent's actual ask — e.g. "…moved to Done. Want me to file a follow-up, or leave it?"
 * The FLUX-777 `looksDone` guard previously suppressed exactly this shape (FLUX-941), silently
 * dropping the question. A trailing question overrides `looksDone`.
 */
const TRAILING_QUESTION_RE = /\?["'`*_)\]\s]*$/;

/**
 * True when a session's final message is an unanswered question the user must see.
 *
 * - Already routed to the board (`require-input` swimlane) → not re-surfaced.
 * - No input-shaped phrasing → not surfaced.
 * - A trailing question surfaces even when the message also "looks done" (FLUX-945 fix).
 * - Otherwise, an input-shaped message that does NOT look like a completion summary surfaces.
 */
export function finalMessageNeedsUser(
  finalMessage: string | null | undefined,
  swimlane: string | null | undefined,
): boolean {
  if (!finalMessage) return false;
  if (swimlane === 'require-input') return false; // already routed to the board
  const fm = String(finalMessage);
  if (!NEEDS_INPUT_RE.test(fm)) return false;
  if (TRAILING_QUESTION_RE.test(fm.trim())) return true; // the agent's real ask, at the very end
  return !LOOKS_DONE_RE.test(fm);
}
