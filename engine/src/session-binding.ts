import { createHmac, randomBytes, timingSafeEqual } from 'crypto';
import fs from 'fs';
import path from 'path';
import { getActiveFluxDir } from './workspace.js';
import { getWorkspace } from './workspace-context.js';

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
 * workspace-private, a session can only ever produce a valid token for its OWN ticket — it cannot
 * forge one for a sibling. A claim with a missing/mismatched token is dropped to "unrouted" at the
 * route.
 *
 * The secret (FLUX-894): a 32-byte random value PERSISTED to the active flux dir
 * (`session-binding-secret`), loaded lazily on first sign/verify and cached PER WORKSPACE ROOT
 * (FLUX-1556 — a single process-wide cache meant every board's sign/verify used whichever board's
 * secret was resolved first, so all boards shared board-1's secret instead of each reading/minting
 * its own on-disk one).
 *  - It is local-only: gitignored and excluded from flux-data sync, exactly like `open-prompts.json`,
 *    so the FLUX-841 secrecy property still holds (the secret never leaves the machine).
 *  - It is durable across an engine restart. The original design held the secret only in memory and
 *    assumed reconcileOrphanedSessions kills every pre-restart session, so a token signed by a prior
 *    process was "never expected to verify". That assumption is false for a prompt still in flight
 *    across the restart, or a session resumed afterward (the rehydrate path) — such a session keeps
 *    forwarding a token signed by the OLD per-process secret, which a freshly-minted secret would
 *    reject, silently dropping the prompt to `null` → the board echo thread (FLUX-894). Persisting
 *    the secret lets that token still verify against the SAME workspace secret, so the prompt keeps
 *    its ticket attribution. A genuinely forged/sibling token still cannot verify.
 */

const SECRET_FILE = 'session-binding-secret';
/** The resolved per-workspace binding secret, keyed by workspace root and cached for the life of
 *  the process after first use per root (FLUX-1556). */
const cachedSecretsByRoot = new Map<string | null, Buffer>();

/**
 * Load the persisted binding secret for the CURRENT workspace, minting and persisting one on first
 * use. Cached per workspace root so every sign/verify for a given board is consistent and its
 * on-disk secret is touched at most once — a second board must never read/verify against the
 * first board's cached secret.
 *
 * Best-effort persistence: if the active flux dir cannot be resolved (no workspace bound — e.g. a
 * unit test) or the file system is unwritable, we fall back to a fresh in-memory secret. That is
 * still internally consistent within the process (sign/verify match), it simply degrades to the
 * pre-FLUX-894 behavior where tokens do not survive a restart — never a hard failure of the HITL
 * round-trip. In the real engine the workspace is always bound before the first session spawns, so
 * the on-disk secret is the live path.
 */
function getSecret(): Buffer {
  const root = getWorkspace().root;
  const cached = cachedSecretsByRoot.get(root);
  if (cached) return cached;
  let file: string | null = null;
  // FLUX-908: distinguish "file absent" from "file present but unreadable". A transient Windows
  // EBUSY/EACCES lock (AV/indexer) on the EXISTING valid secret must NOT trigger a re-mint+overwrite
  // — that invalidates every in-flight token AND permanently rotates the on-disk secret. On such an
  // error we degrade to an ephemeral in-process secret (consistent for this run's sign/verify) and
  // leave the on-disk file intact so a later, unlocked restart recovers it.
  let existedButUnreadable = false;
  try {
    file = path.join(getActiveFluxDir(), SECRET_FILE);
    const hex = fs.readFileSync(file, 'utf-8').trim();
    const buf = Buffer.from(hex, 'hex');
    if (buf.length === 32) {
      cachedSecretsByRoot.set(root, buf);
      return buf;
    }
    // Wrong length / garbage on disk (truncated/tampered) — fall through and re-mint a fresh one.
  } catch (err) {
    // ENOENT (or unbound workspace, no file path) → genuinely absent, safe to mint + persist below.
    // Any OTHER errno (EBUSY/EACCES/EPERM) → an existing file we just can't read right now: do NOT
    // overwrite it.
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code && code !== 'ENOENT') existedButUnreadable = true;
  }
  const buf = randomBytes(32);
  if (file && !existedButUnreadable) {
    // Atomic write-then-rename so a crash mid-write can't leave a torn secret that fails the
    // length check on next boot. mode 0o600 — readable only by the owner (no-op on Windows ACLs).
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = `${file}.tmp`;
      fs.writeFileSync(tmp, buf.toString('hex'), { encoding: 'utf-8', mode: 0o600 });
      fs.renameSync(tmp, file);
    } catch (err) {
      console.error('[session-binding] could not persist binding secret; tokens will not survive an engine restart', err);
    }
  } else if (existedButUnreadable) {
    console.warn('[session-binding] binding secret exists but was unreadable (transient lock?) — using an ephemeral in-process secret WITHOUT overwriting it; tokens will not survive this restart, but the on-disk secret is preserved for the next one');
  }
  cachedSecretsByRoot.set(root, buf);
  return buf;
}

/** HMAC-SHA256 of a conversationId under the persisted workspace secret, hex-encoded. */
export function signConversation(conversationId: string): string {
  return createHmac('sha256', getSecret()).update(conversationId).digest('hex');
}

/**
 * True iff `token` is the valid binding token for `conversationId` — i.e. it was produced by
 * `signConversation(conversationId)` under this workspace's secret (which, since FLUX-894, survives
 * an engine restart). Constant-time compare; tolerant of a missing/garbage token (returns false
 * rather than throwing).
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

/**
 * TEST-ONLY: drop the cached secret so the next sign/verify re-loads it from disk. Used to simulate
 * an engine restart (a fresh process re-reading the persisted secret) without resetting the module.
 * Not part of the runtime API.
 */
export function __resetBindingSecretForTest(): void {
  cachedSecretsByRoot.clear();
}
