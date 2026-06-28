import { createHmac, randomBytes, timingSafeEqual } from 'crypto';

/**
 * FLUX-841 — session→ticket binding for the human-in-the-loop channels.
 *
 * The HITL routes (permission-request / ask-question / board-rebase) select a transcript stream
 * from an agent-supplied `conversationId`. `isSafeStreamId` (FLUX-833 M4) blocks path traversal,
 * but a *valid sibling ticket id* is the same shape — so a session bound to ticket A could route a
 * `permission-request` / `permission-resolved` / `ask-answer` event into ticket B's transcript
 * (cross-ticket injection). The route has no independent session identity to distinguish "my own
 * ticket" from "a sibling", so a shape check alone can't close it.
 *
 * This module mints an unforgeable, per-session binding token: at spawn, each session is launched
 * with `EH_CONVERSATION_TOKEN = signConversation(its own bound conversationId)` (see
 * claude-code.ts/cleanChildEnv). The MCP tools forward that token on every HITL POST, and the route
 * requires it to match the *claimed* conversationId (verifyConversation). Because the HMAC secret is
 * process-private, a session can only ever produce a valid token for its OWN ticket — it cannot forge
 * one for a sibling. A claim with a missing/mismatched token is dropped to "unrouted" at the route.
 *
 * The secret is a per-process random value held only in memory:
 *  - It is never persisted (no credential written to disk on a local-first install).
 *  - Sessions are cancelled by reconcileOrphanedSessions on an engine restart, so a token signed by
 *    a prior process is never *expected* to verify against a new one — graceful degrade to unrouted.
 */

const SECRET = randomBytes(32);

/** HMAC-SHA256 of a conversationId under the per-process secret, hex-encoded. */
export function signConversation(conversationId: string): string {
  return createHmac('sha256', SECRET).update(conversationId).digest('hex');
}

/**
 * True iff `token` is the valid binding token for `conversationId` — i.e. it was produced by
 * `signConversation(conversationId)` in THIS process. Constant-time compare; tolerant of a
 * missing/garbage token (returns false rather than throwing).
 */
export function verifyConversation(conversationId: string, token: string | null | undefined): boolean {
  if (typeof token !== 'string' || token.length === 0) return false;
  const expected = signConversation(conversationId);
  const a = Buffer.from(token);
  const b = Buffer.from(expected);
  // timingSafeEqual throws on a length mismatch; short-circuit so a wrong-length token is a clean false.
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
