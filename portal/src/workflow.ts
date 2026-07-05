import type { Config, Task } from './types';

export const DEFAULT_REQUIRE_INPUT_STATUS = 'Require Input';
export const DEFAULT_READY_FOR_MERGE_STATUS = 'Ready';
export const DEFAULT_ARCHIVE_STATUS = 'Archived';

/** Bucket for tickets with a missing/corrupted status (FLUX-1075) — mirrors the engine's
 *  board-digest convention (`t.status || 'Unknown'`) so counts agree across engine and portal. */
export const UNKNOWN_STATUS = 'Unknown';

/** A ticket's status should always be a non-empty string, but a corrupted/partially-repaired
 *  ticket file can leave it undefined or otherwise non-string. Normalize to `UNKNOWN_STATUS` so
 *  callers can safely use the result as a column id / map key instead of `undefined` slipping
 *  through into `.length`/string operations (FLUX-1075). */
export function normalizeStatus(status: unknown): string {
  return typeof status === 'string' && status.trim() ? status : UNKNOWN_STATUS;
}

/**
 * The system-owned status set. The workflow engine and agent instructions are written around
 * these names (phase derivation, the Needs-Action backstop, the skill routing table, PR flows),
 * so they are fixed: the settings editor lets you recolor them but not add / remove / rename.
 * Any status NOT in this set is a grandfathered "custom" lane — preserved (never deleted) but
 * flagged unsupported, since agents have no defined behavior for it. (FLUX-770)
 */
export const CANONICAL_STATUSES = new Set<string>([
  'Grooming', 'Todo', 'In Progress', 'Ready', 'Done', 'Backlog', 'Archived', 'Released', 'Require Input',
]);

export type StatusRole = { label: string; tone: 'role' | 'system' | 'legacy' };

/** Resolve a status's workflow role for the settings type badge — derived from the configured
 *  role statuses (which default to the canonical names), no per-status schema field needed. */
export function getStatusRole(
  name: string,
  roles: { requireInput: string; ready: string; archive: string },
): StatusRole {
  const n = name.trim();
  if (n === roles.requireInput) return { label: 'User Input', tone: 'role' };
  if (n === roles.ready) return { label: 'Ready / Review', tone: 'role' };
  if (n === roles.archive) return { label: 'Archive', tone: 'role' };
  if (CANONICAL_STATUSES.has(n)) return { label: 'System', tone: 'system' };
  return { label: 'Custom', tone: 'legacy' };
}

export function getRequireInputStatus(config?: Config | null) {
  return config?.requireInputStatus?.trim() || DEFAULT_REQUIRE_INPUT_STATUS;
}

export function getReadyForMergeStatus(config?: Config | null) {
  return config?.readyForMergeStatus?.trim() || DEFAULT_READY_FOR_MERGE_STATUS;
}

export function getArchiveStatus(config?: Config | null) {
  return config?.archiveStatus?.trim() || DEFAULT_ARCHIVE_STATUS;
}

export function getPromptableStatuses(config?: Config | null) {
  return Array.from(new Set([getRequireInputStatus(config), getReadyForMergeStatus(config)]));
}

export function isTaskAwaitingInput(task: Task): boolean {
  return task.swimlane === 'require-input';
}

// FLUX-558's `open-pr` swimlane + glow on normal tickets is retired (FLUX-569): a PR's surface
// is now its own `PR-<n>` deck card, so `hasOpenPr`/`OPEN_PR_SWIMLANE` were removed.

/** FLUX-651: a ticket an agent left parked in a working status without taking a board action.
 *  The engine sets `needsAction` (the reason string) at turn end and clears it on the next action. */
export function needsAction(task: Task): boolean {
  return !!task.needsAction;
}

/** FLUX-909: the card presentation state of a single CLI session. S10 (FLUX-996) adds 'failed'
 *  for a spawn/resume that crashed rather than ending cleanly. */
export type CardSessionState = 'running' | 'starting' | 'needs-input' | 'idle' | 'failed' | 'none';

/**
 * FLUX-909: classify a single CLI session into its card presentation state. The engine's
 * `waiting-input` status is *overloaded* — it covers both "genuinely blocked, awaiting the user"
 * and "clean resumable turn end, idle / nothing pending". The card has to tell these apart so the
 * idle case reads as calm (blue) instead of an alarm (amber): split `waiting-input` into
 * `needs-input` when something is actually pending the user (a `blockedReason`, the ticket sitting
 * at the Require Input status, the `require-input` swimlane, or a `needsAction` flag) and `idle`
 * otherwise.
 *
 * `liveStatus` is the SSE-fed session status — prefer it over the polled `cliSession.status` so the
 * pill flips the instant a turn ends (FLUX-626); pass `undefined` to fall back to the polled value.
 */
export function classifyCardSessionState(
  task: Task,
  liveStatus: string | undefined,
  config?: Config | null,
): CardSessionState {
  const status = liveStatus ?? task.cliSession?.status;
  if (status === 'pending') return 'starting';
  if (status === 'running') return 'running';
  // S10: a spawn/resume that crashed (never reached a clean exit) — distinct from 'idle' so it
  // reads as an alarm, not a calm "done for now".
  if (status === 'failed') return 'failed';
  if (status !== 'waiting-input') return 'none';
  const pendingUser =
    !!task.cliSession?.blockedReason ||
    task.status === getRequireInputStatus(config) ||
    isTaskAwaitingInput(task) ||
    needsAction(task);
  return pendingUser ? 'needs-input' : 'idle';
}

export function relativeTime(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(dateStr).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export function isPromptableStatus(status: string | undefined, config?: Config | null) {
  if (!status) return false;
  return getPromptableStatuses(config).includes(status);
}