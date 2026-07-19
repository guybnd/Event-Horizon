import type { CliSessionSummary, Task } from '../types';
import { isGateParkedTicket } from '../components/pendingInteractions';
import type { BatchTicket, BatchTicketState } from '../furnaceTypes';
import { isSessionStale } from '../orchestration';

/**
 * Joined member-state selector (FLUX-1503) — the single source of truth for a folded PR/epic
 * member's live state, consumed identically by `MemberLine`, `MemberStateStrip`, and deck
 * pin/summary counts (no duplicate/divergent state logic per consumer).
 *
 * FLUX-1532: a live session is no longer flattened to one `implementing` bucket — `grooming` /
 * `implementing` / `reviewing` / `finalizing` label off the session's own `phase` (mirrors the dock
 * tab's phase glyph, FLUX-1281), and `stalled` demotes ANY of those when the session has gone quiet
 * past `SESSION_STALE_MS` (see `isSessionStale`) so a hung agent stops reading as actively working.
 */
export type MemberState =
  | 'tempering'
  | 'implementing'
  | 'grooming'
  | 'reviewing'
  | 'finalizing'
  | 'stalled'
  | 'parked'
  | 'failed'
  | 'done'
  | 'ready'
  | 'queued';

/** Live CLI session statuses that count as "an agent is actively working this ticket right now" —
 *  mirrors `hasActiveCliSession` in `useTaskCardController.tsx`. */
const LIVE_CLI_SESSION_STATUSES = ['pending', 'running', 'waiting-input'];

/** FLUX-1532: phase-labeled live states — a session is genuinely producing output under one of
 *  these, as opposed to `stalled` (same live CLI session, but gone quiet) or `tempering` (a furnace
 *  re-implementation loop, which has no CLI phase). Lets `MemberLine` gate showing a session's
 *  `currentActivity` verb to only while it's actually live. */
export const ACTIVE_MEMBER_STATES: ReadonlySet<MemberState> = new Set([
  'implementing',
  'grooming',
  'reviewing',
  'finalizing',
]);

/** FLUX-1532: map a live session's launch `phase` to its member-state label — mirrors the dock tab's
 *  `DISPATCH_PHASE_ICON` vocabulary (`lib/dispatch.ts`). An absent/unrecognized phase (including
 *  `'chat'`, or a session launched before FLUX-1281 started stamping phase) falls back to
 *  `'implementing'`, the pre-existing behavior for any live session. */
function phaseToMemberState(phase: CliSessionSummary['phase']): MemberState {
  switch (phase) {
    case 'grooming':
    case 'batch-grooming':
      return 'grooming';
    case 'review':
      return 'reviewing';
    case 'finalize':
      return 'finalizing';
    default:
      return 'implementing';
  }
}

/** Default done-status set, matching `getDoneStatuses()`'s defaults (`lib/epics.ts`) for callers
 *  that don't have a `Config` to thread through. Prefer passing the config-aware set when available. */
const DEFAULT_DONE_STATUSES = new Set(['Done', 'Released', 'Archived']);

const DEFAULT_READY_STATUS = 'Ready';

/**
 * Resolve a folded member's live state. `batchTicket` is an ENRICHMENT, never required — every
 * state except `failed` resolves fully from `task.tempering` + `task.cliSession` + board `status`
 * alone (non-furnace PR members, plain epic subtasks). `failed` has no non-batch signal: a
 * non-furnace member simply never reports `failed`, falling through to `ready`/`queued` instead.
 *
 * Precedence (first match wins): tempering > live-session (phase-labeled — grooming/implementing/
 * reviewing/finalizing, or demoted to stalled once the session goes quiet) > parked > failed > done
 * > ready > queued. Pass `opts.nowMs` to pin "now" for staleness (tests); defaults to `Date.now()`.
 */
export function getMemberState(
  task: Task,
  batchTicket?: BatchTicket,
  opts?: { doneStatuses?: ReadonlySet<string>; readyStatus?: string; nowMs?: number },
): MemberState {
  if (task.tempering === true) return 'tempering';
  if (task.cliSession && LIVE_CLI_SESSION_STATUSES.includes(task.cliSession.status)) {
    if (isSessionStale(task.cliSession, opts?.nowMs)) return 'stalled';
    return phaseToMemberState(task.cliSession.phase);
  }
  if (batchTicket?.state === 'parked' || isGateParkedTicket(task)) return 'parked';
  if (batchTicket?.state === 'failed') return 'failed';
  const doneStatuses = opts?.doneStatuses ?? DEFAULT_DONE_STATUSES;
  if (doneStatuses.has(task.status)) return 'done';
  const readyStatus = opts?.readyStatus ?? DEFAULT_READY_STATUS;
  if (task.status === readyStatus) return 'ready';
  return 'queued';
}

/** Promoted state-meta table for the shared `MemberLine`/`MemberStateStrip` primitives. Colors per
 *  the design vocabulary: done=emerald, implementing=violet (the reference pulsing/animated live
 *  state), grooming=teal, reviewing=sky (matches `STATE_META.reviewing` below), finalizing=indigo
 *  (all four are pulsing/live), stalled=slate (never pulses — a live session gone quiet), tempering=
 *  orange, parked=amber, failed=red, ready/queued=neutral. `label` is static — callers append
 *  `· attempt N` for tempering themselves rather than baking the count into this table. */
export const MEMBER_STATE_META: Record<MemberState, { label: string; color: string; glyphColor: string }> = {
  tempering: { label: 'tempering', color: '#f97316', glyphColor: '#f97316' },
  implementing: { label: 'implementing', color: '#8b5cf6', glyphColor: '#8b5cf6' },
  grooming: { label: 'grooming', color: '#14b8a6', glyphColor: '#14b8a6' },
  reviewing: { label: 'reviewing', color: '#0ea5e9', glyphColor: '#0ea5e9' },
  finalizing: { label: 'finalizing', color: '#6366f1', glyphColor: '#6366f1' },
  stalled: { label: 'stalled', color: '#64748b', glyphColor: '#64748b' },
  parked: { label: 'needs input', color: '#f59e0b', glyphColor: '#f59e0b' },
  failed: { label: 'failed', color: '#ef4444', glyphColor: '#ef4444' },
  done: { label: 'done', color: '#22c55e', glyphColor: '#22c55e' },
  ready: { label: 'ready', color: '#a8a29e', glyphColor: '#a8a29e' },
  queued: { label: 'queued', color: '#a8a29e', glyphColor: '#a8a29e' },
};

/** Live/actionable states (FLUX-1503; extended FLUX-1532) — a member in one of these always renders
 *  as a pinned `MemberLine`, outside/above any fold toggle, regardless of unwind state. Shared by
 *  `TaskDeck` (PR members) and `EpicStackDeck` (epic subtasks) so the pin rule can never diverge
 *  between them. `stalled` is included — a hung agent is exactly the kind of thing the user needs to
 *  keep seeing so they can find and kill it. */
export const PINNED_MEMBER_STATES: ReadonlySet<MemberState> = new Set([
  'tempering',
  'implementing',
  'grooming',
  'reviewing',
  'finalizing',
  'stalled',
  'parked',
  'failed',
]);

/**
 * Sort rank for the epic ghost card / rollup strip's "done → active → tempering → queued"
 * ordering (FLUX-1503) — terminal/done first, then live work, then the calm/not-yet-started tail.
 * Pass as `MemberStateStrip`'s `order` via `(item) => MEMBER_STATE_ORDER[getMemberState(...)]`.
 */
export const MEMBER_STATE_ORDER: Record<MemberState, number> = {
  done: 0,
  implementing: 1,
  grooming: 1,
  reviewing: 1,
  finalizing: 1,
  tempering: 2,
  stalled: 3,
  parked: 4,
  failed: 5,
  ready: 6,
  queued: 7,
};

/**
 * Furnace batch-ticket state-meta table (promoted from `FurnaceDrawer.tsx`'s local `STATE_META`,
 * FLUX-1503) — a single source shared by the drawer's own rendering and anything else keying off
 * a raw `BatchTicketState`. Colors kept byte-identical to the pre-promotion values.
 */
export const STATE_META: Record<BatchTicketState, { label: string; dot: string; text: string }> = {
  queued: { label: 'queued', dot: '#a8a29e', text: 'var(--eh-text-secondary)' },
  implementing: { label: 'impl', dot: '#22c55e', text: '#22c55e' },
  reviewing: { label: 'review', dot: '#0ea5e9', text: '#0ea5e9' },
  // FLUX-1487: was `#e05a00` — now sits too close to the fire-orange furnace accent to read as
  // distinct, so re-impl shifted to the deep-red end of the heat gradient instead.
  reimplementing: { label: 're-impl', dot: 'var(--eh-furnace-accent-deep)', text: 'var(--eh-furnace-accent-deep)' },
  'cooling-down': { label: 'cooling', dot: '#38bdf8', text: '#38bdf8' },
  'pr-open': { label: 'PR open', dot: 'var(--eh-furnace-accent)', text: 'var(--eh-furnace-accent)' },
  parked: { label: 'parked', dot: '#f59e0b', text: '#f59e0b' },
  failed: { label: 'failed', dot: '#ef4444', text: '#ef4444' },
  skipped: { label: 'skipped', dot: '#a8a29e', text: 'var(--eh-text-secondary)' },
};
