import { log } from './log.js';
import { randomUUID } from 'crypto';
import fs from 'fs';
import path from 'path';
import { broadcastEvent } from './events.js';
import { appendTranscriptEvent, isSafeStreamId } from './transcript.js';
import { raiseNeedsAction } from './parked-ticket.js';
import { getActiveFluxDir } from './workspace.js';

/**
 * FLUX-833 (Phase 2) — the unified, restart-durable store behind the two human-in-the-loop
 * prompt channels: gated-tool approvals (permission-prompts.ts, FLUX-605) and structured
 * questions (ask-questions.ts, FLUX-662). Both park a single held `fetch` from the agent's
 * MCP tool until a human resolves it (or it times out); their envelope is identical —
 * `{ id, kind, payload, conversationId, resumeSessionId, createdAt }` — so they share one core
 * here. The two original modules survive as thin, name-preserving wrappers so call sites and
 * the HTTP routes don't churn.
 *
 * What this core adds over the per-module in-memory maps it replaces:
 *  1. A durable index (`open-prompts.json` in the active flux dir, same convention as
 *     read-state.json / transcripts/) of every OPEN prompt. It is rewritten on every park and
 *     settle, so it is always exactly the set of prompts still awaiting a human.
 *  2. Re-hydration on boot (`rehydrateOpenPrompts`, called from the watcher `ready` hook next
 *     to reconcileOrphanedSessions): persisted open prompts are reloaded into the in-memory
 *     index and re-broadcast so the portal (SSE + the catch-up `listPending*` fetch) re-surfaces
 *     them with their ORIGINAL id — cards re-bind rather than orphan. The held fetch from the
 *     pre-restart turn is gone (the CLI got a connection reset), so a re-surfaced prompt can be
 *     dismissed/recorded but cannot yet reach the agent — delivering a post-restart answer to a
 *     live turn is the deliberately-gated Phase 3.
 *  3. A terminal-state guard: `settle` is the single funnel for every resolution (human decision
 *     OR timeout). It is idempotent — the prompt is removed from the durable index on the first
 *     settle, so a second settle (a late cross-restart answer racing a timeout that already wrote
 *     its `*-resolved`/`ask-answer` event) is a no-op and appends NO phantom transcript entry.
 *     In-process this used to be covered only by `clearTimeout`; the index makes it durable.
 *  4. Persisting `resumeSessionId` on each record (captured from the live session at park time)
 *     so a later Phase 3 has a `claude --resume` target after a restart — it lives only in-memory
 *     on the session record today and is lost when reconcileOrphanedSessions cancels the session.
 */

export type PromptKind = 'permission' | 'question';

/** Channel timeout windows. Authoritative here so the durable core can re-arm a re-surfaced
 *  prompt's timeout on rehydrate (FLUX-833 review M3); the thin wrappers import these.
 *  - permission: 120s snap deny (FLUX-605).
 *  - question: 240s deliberative window — MUST stay < undici's 300s headersTimeout; see the
 *    detailed rationale in ask-questions.ts. */
export const PERMISSION_TIMEOUT_MS = 120_000;
export const QUESTION_TIMEOUT_MS = 240_000;
function defaultTimeoutMs(kind: PromptKind): number {
  return kind === 'permission' ? PERMISSION_TIMEOUT_MS : QUESTION_TIMEOUT_MS;
}

/** Permission payload: the gated tool + its proposed input. */
export interface PermissionPayload {
  toolName: string;
  input: unknown;
}
/** Question payload: the structured questions[] put to the user. */
export interface QuestionPayload {
  questions: unknown[];
}

export interface OpenPromptRecord {
  id: string;
  kind: PromptKind;
  /** PermissionPayload for kind==='permission', QuestionPayload for kind==='question'. */
  payload: PermissionPayload | QuestionPayload;
  conversationId: string | null;
  /** The CLI session's `claude --resume` pointer at park time, if known — for Phase 3. */
  resumeSessionId?: string;
  createdAt: string;
  /** Absolute timeout deadline (createdAt + the channel's timeoutMs). Persisted so a re-surfaced
   *  prompt can re-arm its timeout after a restart (FLUX-833 review M3). Optional for back-compat
   *  with index files written before this field existed. */
  expiresAt?: string;
}

interface LivePrompt {
  /** Settles the held fetch from THIS process's parked turn (absent for rehydrated prompts). */
  resolve: (result: any) => void;
  timer: NodeJS.Timeout;
}

/** The durable set of open prompts (mirrored to disk). Keyed by stable id. */
const durable = new Map<string, OpenPromptRecord>();
/** The live, resolvable half — only for prompts parked in THIS process. */
const live = new Map<string, LivePrompt>();

function promptsFile() {
  return path.join(getActiveFluxDir(), 'open-prompts.json');
}

/** A persist is running; pending callers await it via flushOpenPrompts(). */
let persistInFlight: Promise<void> | null = null;
/** A mutation landed since the in-flight write captured its snapshot — re-loop once it drains. */
let persistDirty = false;

/** One atomic rewrite of the durable index (write-tmp-then-rename, FLUX-833 review M2): a crash
 *  mid-write must not leave a torn file that fails JSON.parse on next boot and silently drops the
 *  WHOLE open set. The `.tmp` sibling is excluded from git + flux-data sync alongside
 *  open-prompts.json itself (see storage-sync.ts). Best-effort: a failure is logged, never thrown. */
async function writeIndex(): Promise<void> {
  try {
    const file = promptsFile();
    await fs.promises.mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    await fs.promises.writeFile(tmp, JSON.stringify(Array.from(durable.values()), null, 2), 'utf-8');
    await fs.promises.rename(tmp, file);
  } catch (err) {
    console.error('[hitl] failed to persist open-prompts.json', err);
  }
}

/** Schedule an async, coalesced rewrite of the durable index (FLUX-854). The index is tiny and only
 *  needs *eventual* durability, so it must NOT block the single-threaded event loop the way the old
 *  synchronous `persist()` did (it ran on every park/settle, starving SSE + every portal API
 *  response). A single write is ever in flight; concurrent calls only mark the index dirty, and the
 *  in-flight write re-loops to flush the latest snapshot — so a burst of parks/settles collapses to
 *  at most one extra write. */
function persist(): void {
  persistDirty = true;
  if (persistInFlight) return; // a write is already running; it will re-loop on the dirty flag
  persistInFlight = (async () => {
    try {
      while (persistDirty) {
        persistDirty = false;
        await writeIndex();
      }
    } finally {
      persistInFlight = null;
    }
  })();
}

/** Await any in-flight + pending durable write so callers can assert on-disk state deterministically
 *  (used by hitl-prompts.test.ts). Resolves immediately when nothing is queued. */
export async function flushOpenPrompts(): Promise<void> {
  while (persistInFlight) await persistInFlight;
}

/** Validate a record loaded from the durable index before it is trusted (FLUX-833 review M1).
 *  Guards the payload shape per kind — `broadcastRequest`/the transcript appends dereference
 *  payload fields, so a record with a valid id+kind but a missing/wrong payload would otherwise
 *  throw out of rehydrate. */
function isValidRecord(rec: any): rec is OpenPromptRecord {
  if (!rec || typeof rec.id !== 'string') return false;
  if (rec.kind === 'permission') return !!rec.payload && typeof (rec.payload as any).toolName === 'string';
  if (rec.kind === 'question') return !!rec.payload && Array.isArray((rec.payload as any).questions);
  return false;
}

function broadcastRequest(rec: OpenPromptRecord) {
  if (rec.kind === 'permission') {
    const p = rec.payload as PermissionPayload;
    broadcastEvent('permission-request', {
      id: rec.id, toolName: p.toolName, input: p.input, conversationId: rec.conversationId, createdAt: rec.createdAt,
    });
  } else {
    const p = rec.payload as QuestionPayload;
    broadcastEvent('ask-question', {
      id: rec.id, questions: p.questions, conversationId: rec.conversationId, createdAt: rec.createdAt,
    });
  }
}

function broadcastResolved(rec: OpenPromptRecord) {
  broadcastEvent(rec.kind === 'permission' ? 'permission-resolved' : 'ask-question-resolved', { id: rec.id });
}

/** The board orchestrator thread — a real, projectable transcript stream — is the catch-all echo
 *  destination for an UNROUTED prompt (conversationId === null). Without it, a prompt answered via
 *  the pending board would write neither its question nor its answer to any stream and so vanish
 *  from every chat (FLUX-866); routing the echo here makes it surface in the board chat, matching
 *  the inline-picker behavior. Only the *transcript echo* is redirected — needsAction / Phase-3
 *  resume attribution stays keyed on the real (null) `conversationId`, so an unrouted prompt is
 *  never attributed to a sibling ticket (preserves FLUX-841). */
const BOARD_ECHO_STREAM = '__board__';

/** The transcript stream a prompt's round-trip echoes to: its own conversation, or the board thread
 *  when unrouted. Returns null only for a genuinely path-unsafe id (shouldn't occur — `__board__`
 *  is safe, and a non-null conversationId was already validated upstream / on rehydrate). */
function echoStream(rec: OpenPromptRecord): string | null {
  const id = rec.conversationId ?? BOARD_ECHO_STREAM;
  return isSafeStreamId(id) ? id : null;
}

/** Durable record that a prompt was raised (a cold resume sees the round-trip). An unrouted prompt
 *  (null conversation) echoes to the board thread; see `echoStream`. */
function appendRequestTranscript(rec: OpenPromptRecord) {
  const stream = echoStream(rec);
  if (!stream) return;
  if (rec.kind === 'permission') {
    const p = rec.payload as PermissionPayload;
    appendTranscriptEvent(stream, { type: 'permission-request', id: rec.id, toolName: p.toolName, input: p.input, timestamp: rec.createdAt });
  } else {
    const p = rec.payload as QuestionPayload;
    appendTranscriptEvent(stream, { type: 'ask-question', id: rec.id, questions: p.questions, timestamp: rec.createdAt });
  }
}

/** Durable record of the resolution. `reason` distinguishes a timeout from a human decision in
 *  the permission transcript; questions carry the answer (or the `unanswered` sentinel). An unrouted
 *  prompt echoes to the board thread; see `echoStream`. */
function appendResolveTranscript(rec: OpenPromptRecord, result: any, reason?: 'timeout') {
  const stream = echoStream(rec);
  if (!stream) return;
  const timestamp = new Date().toISOString();
  if (rec.kind === 'permission') {
    appendTranscriptEvent(stream, {
      type: 'permission-resolved', id: rec.id, behavior: result.behavior, ...(reason ? { reason } : {}), timestamp,
    });
  } else {
    appendTranscriptEvent(stream, {
      type: 'ask-answer', id: rec.id, answers: result.answers ?? {},
      ...(result.notes ? { notes: result.notes } : {}),
      ...(result.unanswered ? { unanswered: true } : {}),
      timestamp,
    });
  }
}

/** The timeout decision returned to the held fetch (deny for permission, unanswered for a question). */
function timeoutResult(rec: OpenPromptRecord): any {
  if (rec.kind === 'permission') {
    const p = rec.payload as PermissionPayload;
    return { behavior: 'deny', message: `Approval for ${p.toolName} timed out — denied.` };
  }
  return { answers: {}, unanswered: true };
}

/** The persistent needsAction nudge raised when a prompt times out unanswered (FLUX-826 parity). */
function timeoutNeedsAction(rec: OpenPromptRecord): string {
  if (rec.kind === 'permission') {
    const p = rec.payload as PermissionPayload;
    return `Agent requested approval for ${p.toolName} that timed out — it was denied. Re-open the ticket to act on it.`;
  }
  return 'Agent asked a question that timed out unanswered — re-open the ticket to respond, or it will proceed on its best judgment.';
}

/**
 * The single funnel for every resolution. Idempotent by design: the prompt is removed from the
 * durable index up front, so a second settle for the same id (e.g. a late human answer that
 * reaches a now-restarted engine after a timeout already wrote its resolved event) finds nothing
 * and writes nothing — the terminal-state / phantom-write guard. Returns false when already settled.
 */
function settle(id: string, result: any, reason?: 'timeout'): boolean {
  const rec = durable.get(id);
  if (!rec) return false; // already settled or unknown id — guard against a double / phantom write
  durable.delete(id);
  const l = live.get(id);
  if (l) {
    clearTimeout(l.timer);
    live.delete(id);
  }
  appendResolveTranscript(rec, result, reason);
  broadcastResolved(rec);
  if (reason === 'timeout' && rec.conversationId) {
    // No-op for the `__board__` sentinel / unrouted ids (raiseNeedsAction guards on a real
    // ticket), and best-effort so a failure never blocks settling the prompt.
    void raiseNeedsAction(rec.conversationId, timeoutNeedsAction(rec));
  }
  // Unblock the held fetch (only for a prompt parked in THIS process — rehydrated prompts have
  // no live resolver; their answer can't reach the dead turn until Phase 3) BEFORE the durable
  // write: the terminal-state guard above (the up-front `durable.delete`) already makes settle
  // idempotent, so the on-disk index only needs *eventual* consistency — the held fetch must not
  // wait on disk I/O (FLUX-854). The write is coalesced and runs off the event loop's hot path.
  if (l) l.resolve(result);
  persist();
  return true;
}

/**
 * Park a prompt: mint a stable id, record it durably (index + request transcript), broadcast the
 * request, and return a Promise that settles when a human resolves it or it times out.
 */
export function parkPrompt(args: {
  kind: PromptKind;
  payload: PermissionPayload | QuestionPayload;
  conversationId: string | null;
  resumeSessionId?: string | undefined;
  timeoutMs: number;
}): Promise<any> {
  const id = randomUUID();
  const now = Date.now();
  const createdAt = new Date(now).toISOString();
  const rec: OpenPromptRecord = {
    id, kind: args.kind, payload: args.payload, conversationId: args.conversationId,
    ...(args.resumeSessionId ? { resumeSessionId: args.resumeSessionId } : {}),
    createdAt,
    expiresAt: new Date(now + args.timeoutMs).toISOString(),
  };
  durable.set(id, rec);
  persist();
  appendRequestTranscript(rec);
  return new Promise((resolve) => {
    const timer = setTimeout(() => { settle(id, timeoutResult(rec), 'timeout'); }, args.timeoutMs);
    live.set(id, { resolve, timer });
    broadcastRequest(rec);
  });
}

/**
 * Resolve an open prompt with a human decision/answer. Returns false if the id is unknown or
 * already settled. For a prompt parked in this process the held fetch is unblocked; for a
 * rehydrated (post-restart) prompt the durable record is settled, the decision is recorded, and
 * the card clears — but the answer cannot reach the dead turn (Phase 3).
 */
export function resolvePrompt(id: string, result: any): boolean {
  return settle(id, result);
}

/** The open prompts of one kind, in the shape the legacy `listPending*` callers expect. */
export function listOpenPrompts(kind: PromptKind): OpenPromptRecord[] {
  return Array.from(durable.values()).filter((r) => r.kind === kind);
}

/**
 * FLUX-985: settle every OPEN prompt bound to a conversation (task) whose session(s) are being
 * force-torn-down — worktree detach / ticket delete / stop&merge (see stopAllSessionsForTask).
 * The held fetch belongs to a session that is being killed, so it can never be answered: without
 * this it would linger to its full 120s/240s timeout and then (a) fire a spurious `needsAction`
 * nudge on a ticket the user deliberately tore down, and (b) run `res.json()` on an already-closed
 * socket. We settle with the channel's non-answer result (deny / unanswered) but WITHOUT the
 * `'timeout'` reason, so the timer + durable record + held fetch clear immediately and NO needsAction
 * fires (the prompt was cancelled, not ignored). Idempotent via `settle`. Returns the count settled.
 *
 * NOT called on graceful shutdown (stopAllCliSessions) — there the durable index must survive so
 * `rehydrateOpenPrompts` can re-surface prompts after restart.
 */
export function settleOpenPromptsForConversation(conversationId: string): number {
  let settled = 0;
  for (const rec of Array.from(durable.values())) {
    if (rec.conversationId !== conversationId) continue;
    if (settle(rec.id, timeoutResult(rec))) settled++; // no 'timeout' reason ⇒ no needsAction nudge
  }
  return settled;
}

/**
 * Re-hydrate the durable index from disk on boot and re-broadcast each open prompt so the portal
 * re-surfaces it. Called from the watcher `ready` hook alongside reconcileOrphanedSessions.
 * Returns the count re-surfaced. The transcript already holds each prompt's request event, so we
 * do NOT re-append it — we only restore the in-memory index + live SSE view.
 *
 * Robustness (FLUX-833 review):
 *  - M1: each record is validated (id + kind + payload shape) and the per-record body is wrapped,
 *    so one malformed/tampered record is skipped — it can neither abort the whole rehydrate nor
 *    throw out of the (synchronous, unguarded) chokidar `ready` listener and crash boot.
 *  - M3: a re-surfaced prompt re-arms its timeout from the persisted `expiresAt`, so it still
 *    auto-denies / raises the FLUX-826 needsAction net and does not accumulate across restarts.
 *    A prompt already past its deadline (engine was down through it) is swept (settled as a
 *    timeout) rather than re-surfaced. The re-armed timer has a no-op resolver — the original held
 *    fetch died on restart, so there is nothing to unblock (delivering a late answer to a live turn
 *    is the gated Phase 3); this keeps the "no approval smuggling" property (settle still finds no
 *    real resolver, so a forged ALLOW records/broadcasts but executes nothing).
 *  - M4: an unsafe persisted `conversationId` is neutralized to null before it can re-enter the
 *    transcript path on settle.
 */
export function rehydrateOpenPrompts(): number {
  let records: unknown;
  try {
    const file = promptsFile();
    if (!fs.existsSync(file)) return 0;
    records = JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch (err) {
    console.error('[hitl] failed to load open-prompts.json', err);
    return 0;
  }
  if (!Array.isArray(records)) return 0;
  let count = 0;
  for (const rec of records) {
    try {
      if (!isValidRecord(rec)) continue;
      // M4: drop a path-unsafe conversationId so settle/broadcast can't escape the transcripts dir.
      if (rec.conversationId && !isSafeStreamId(rec.conversationId)) rec.conversationId = null;
      durable.set(rec.id, rec);
      // M3: re-arm the timeout (unless this id is already parked live in THIS process — e.g. an
      // in-process re-call — to avoid leaking the existing timer).
      if (!live.has(rec.id)) {
        let remaining = rec.expiresAt ? Date.parse(rec.expiresAt) - Date.now() : defaultTimeoutMs(rec.kind);
        if (!Number.isFinite(remaining)) remaining = defaultTimeoutMs(rec.kind);
        if (remaining <= 0) {
          // Deadline already passed while the engine was down — sweep it as a timeout instead of
          // re-surfacing a prompt that would never expire.
          settle(rec.id, timeoutResult(rec), 'timeout');
          continue;
        }
        const timer = setTimeout(() => { settle(rec.id, timeoutResult(rec), 'timeout'); }, remaining);
        live.set(rec.id, { resolve: () => {}, timer });
      }
      broadcastRequest(rec);
      count++;
    } catch (err) {
      console.error('[hitl] skipped a malformed open-prompt record on rehydrate', err);
    }
  }
  if (count > 0) log.info(`[hitl] re-surfaced ${count} open prompt(s) after restart`);
  return count;
}
