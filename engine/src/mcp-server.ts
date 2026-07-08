import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { McpError, ErrorCode as McpErrorCode } from '@modelcontextprotocol/sdk/types.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { AsyncLocalStorage } from 'node:async_hooks';
import { z } from 'zod';
import fs from 'fs/promises';
import path from 'path';

import { tasksCache, serializeTaskForAgent, updateTaskWithHistory, workspaceActivating, readTaskFromDisk, docsCache, createTask, getTerminalStatuses, syncParentSubtaskLinks, validateParentLink, type CreateTaskOptions, type TaskRecord } from './task-store.js';
import { configCache, autoRegisterUnknownTags, nextColumnAfter } from './config.js';
import { normalizeDocPathInput, type StoredDoc } from './file-utils.js';
import { resolveDefaultFramework } from './agents/index.js';
import { broadcastEvent } from './events.js';
import { validateTicketFrontmatter, formatValidationErrors } from './schema.js';
import { extractTicket } from './extract.js';
import { mergeTickets } from './merge.js';
import { buildActivityEntry, type AgentSessionEntry, type AgentSessionProgress } from './history.js';
import { sanitizeCompletion, completionInputSchema } from './completion-payload.js';
import { getActiveFluxDir, getWorkspacesList, workspaceRoot } from './workspace.js';
import { getTicketBranchStatus, deleteTicketBranch, createPullRequest, mergePullRequest, checkGhAuth, captureDiff, resolveCommit, planFinishPr, type DiffFileSummary } from './branch-manager.js';
import { detachTaskWorktree, taskWorktreeDir, findWorktreeForBranch, worktreeUncommittedCount, reclaimWorktrees } from './task-worktree.js';
import { ensureTicketIsolation } from './ticket-isolation.js';
import { cleanupMergedBranch, isWorktreeReclaimable } from './pr-cleanup.js';
import { sharedNonDoneSiblings, prTicketsOnBranch } from './pr-tickets.js';
import { existsSync } from 'fs';
import { getActiveSessionsForTask, getLiveStandaloneSessionForTask, stopAllSessionsForTask, reapStaleParkedSessions } from './session-store.js';
import { generatePromptNotification, generateReviewNotification, dismissNotificationsForTicket, addNotification } from './notifications.js';
import { getGroupContext, getMemberBinding, groupDocsLabel, summarizeGroup, groupDocPathToStoreRelative, activeGroupDocsLabel } from './group.js';
import { submitGroupEdit } from './group-edit.js';
import { writeArtifactRevision, isSafeTicketId } from './artifacts.js';
import { ensureFurnaceLoaded, getFurnaceBatch, getFurnaceBatchesCache, updateFurnaceBatch, createFurnaceBatch, deleteFurnaceBatch, mutateFurnaceBatch, globalSlotsInUse, freeSlots, FURNACE_SLOT_CAP } from './furnace-store.js';
import { buildBatchTickets, toBuildCandidate, validateBatchTickets } from './furnace-builder.js';
import { igniteBatch, stopBatch, burnRateClampWarning, retryTicket, resumeBatch, dismissTicketFlag, takeoverTicket, handBackTicket, reconcileBatchCached, reconcileAllBatchesCached, refreshWorktreePool, isDispatching, clearTakeoverTracking, evictReconcileReadCache } from './furnace-stoker.js';
import { newBatchTicket, isBatchActive, isTerminalTicketState, validateBatchTrigger, DEFAULT_RETRY_CAP, type BatchKind, type BatchTrigger } from './models/furnace.js';
import { maybeStartTemper } from './temper.js';
import { planBodyHash, resolveGateValue, hasHumanGateTouch, SELF_ATTESTED_AUTHOR_FIELD } from './models/gate-policy.js';
import { startPlanGateNow, type PlanGateMode } from './gate-runner.js';
import type { OrchestrationPersonaMeta } from './orchestration-personas.js';

function textResult(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

/**
 * Stable, machine-readable discriminants for MCP error results (FLUX-880, AXI structured
 * errors). MCP has no CLI exit codes; the idiomatic port is a stable `code` an agent (or a
 * wrapper) can branch on — most importantly to tell *retryable* (`transient_retry`) from
 * *terminal* failures without parsing the human text.
 *
 *   not_found           — a referenced entity (ticket, session, branch, group doc) does not exist
 *   validation_failed   — input failed schema/precondition checks (missing comment, bad path, …)
 *   invalid_state       — the call is not valid for the entity's current state (wrong status,
 *                         already has a branch/swimlane, shared-PR finish guard, …)
 *   transient_retry     — a temporary condition (workspace activating); retrying may succeed
 *   channel_unavailable — an out-of-band channel (ask-user, board-rebase, delegation, roster)
 *                         was unreachable; the underlying work was not attempted
 *   operation_failed    — an underlying operation failed unexpectedly (the catch-all default)
 */
type ErrorCode =
  | 'not_found'
  | 'validation_failed'
  | 'invalid_state'
  | 'transient_retry'
  | 'channel_unavailable'
  | 'operation_failed';

/**
 * Build an MCP error result. The human-readable `text` is preserved unchanged in `content`;
 * a stable machine-readable `code` is added in `structuredContent` so agents/wrappers can
 * branch programmatically (FLUX-880). `structuredContent` is safe on error results — the SDK
 * skips output-schema validation when `isError` is set (and these tools declare no
 * outputSchema anyway), so it passes through untouched to the client. Pass `extra` to merge
 * additional fields into `structuredContent` (e.g. a partial accounting the caller needs even
 * though the overall call failed — FLUX-1051).
 */
function errorResult(text: string, code: ErrorCode = 'operation_failed', extra?: Record<string, unknown>) {
  return {
    content: [{ type: 'text' as const, text }],
    isError: true as const,
    structuredContent: { code, message: text, ...(extra ?? {}) },
  };
}

/** Extract a human-readable message from a caught value of unknown shape — a `throw` is not
 * guaranteed to produce an `Error` instance, so every `catch` in this file types its binding
 * `unknown` and routes through this instead of an unchecked `err.message`. */
function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** FLUX-1157: render a `no_slots` refusal's slot holders as a human-readable suffix, or '' when none. */
function formatSlotHolders(holders?: { ticketId: string; reason: string }[]): string {
  if (!holders || holders.length === 0) return '';
  return ` Holding the slots: ${holders.map((h) => `${h.ticketId} (${h.reason})`).join(', ')}.`;
}

function jsonResult(data: unknown) {
  // Compact (no-indent) JSON: agent readers gain nothing from indentation
  // whitespace, and every list/get tool response pays for it in tokens. FLUX-876.
  return textResult(JSON.stringify(data));
}

// FLUX-950: structured-output result for tools registered with an `outputSchema`.
// Emits `structuredContent` as the SINGLE wire representation and leaves `content`
// empty — the typed JSON is never *also* stringified into a text block. Returning
// both would put two full copies of the payload on the wire and double per-call
// tokens, the exact opposite of AXI #1 (token budget is first-class — the pinned
// constraint on this ticket). There is therefore no text JSON left for FLUX-876 to
// compact; structuredContent is the compact form. `content: []` is sent explicitly
// (not omitted) so the SDK's `validateToolOutput` still runs the payload through the
// tool's `outputSchema` as a guardrail (it early-returns when `content` is absent).
function structuredResult(data: Record<string, unknown>) {
  return { content: [] as { type: 'text'; text: string }[], structuredContent: data };
}

/**
 * AXI #9 contextual disclosure (FLUX-877): a terse next-step hint for a `change_status`
 * result, so the agent's next move is discoverable in the response itself rather than
 * only in static tool docs. Status names are config-driven, so the caller passes the
 * resolved labels for every status the hint text references (Ready / Require-Input, plus
 * the In-Progress / Todo targets the Todo / Grooming hints advance toward). Returns ''
 * when there is no useful next step (terminal/unknown statuses), so the caller appends
 * nothing. Pure + exported for test. (FLUX-889: case-insensitive Ready match so a
 * lowercase `'ready'` agrees with the case-insensitive switch below; config-driven
 * target labels so a renamed board never points at a non-existent status.)
 */
export function nextStepForStatus(
  newStatus: string,
  opts: {
    readyStatus: string;
    requireInputStatus: string;
    inProgressStatus?: string;
    todoStatus?: string;
  },
): string {
  const inProgressStatus = opts.inProgressStatus || 'In Progress';
  const todoStatus = opts.todoStatus || 'Todo';
  if (newStatus.toLowerCase() === opts.readyStatus.toLowerCase()) {
    return `Next: finish_ticket to merge + close, or change_status back to ${inProgressStatus} if changes are needed.`;
  }
  switch (newStatus.toLowerCase()) {
    case 'in progress':
      return `Next: add_note (type:"activity") as you work; change_status to ${opts.readyStatus} (or ${opts.requireInputStatus}) when done.`;
    case 'todo':
      return `Next: start_session to begin, or change_status to ${inProgressStatus} when you pick it up.`;
    case 'grooming':
      return `Next: tighten the plan with update_ticket, then change_status to ${todoStatus} when it is ready.`;
    default:
      return '';
  }
}

/**
 * FLUX-1089: what `change_status` should write to `reviewState` this call, factored out of the
 * handler as a pure function (mirrors the `evaluateWorktreeReadyRefusal` idiom). An explicit
 * `reviewState` on the call always wins — a reviewer recording a fresh verdict (e.g.
 * 'changes-requested' while moving back to In Progress) must not be overridden. Otherwise, leaving
 * Ready without a fresh verdict clears any prior reviewState: an 'approved' (or stale
 * 'changes-requested') from the last review no longer describes a ticket that's active work again,
 * and leaving it in place would read as still-current. Returns `{}` (no-op) in every other case —
 * a ticket that was never Ready, or is moving between two non-Ready statuses, keeps whatever
 * reviewState it already has.
 */
export function resolveReviewStateOnMove(
  explicitReviewState: 'approved' | 'changes-requested' | null | undefined,
  priorStatus: string,
  newStatus: string,
  readyStatus: string,
): { reviewState?: 'approved' | 'changes-requested' | null } {
  if (explicitReviewState !== undefined) return { reviewState: explicitReviewState };
  if (priorStatus === readyStatus && newStatus !== readyStatus) return { reviewState: null };
  return {};
}

/**
 * FLUX-1263: the `planReviewState` analog of `resolveReviewStateOnMove` above — same shape, keyed to
 * `Grooming` instead of `Ready`. An explicit `planReviewState` on the call always wins (the plan-review
 * gate's own review session recording its verdict while staying in Grooming); otherwise leaving Grooming
 * clears any prior verdict — it described a plan that either just got approved (consumed by the move) or
 * no longer describes the ticket's current plan once it's left the gate's scope entirely.
 */
export function resolvePlanReviewStateOnMove(
  explicitPlanReviewState: 'approved' | 'changes-requested' | null | undefined,
  priorStatus: string,
  newStatus: string,
  groomingStatus: string,
): { planReviewState?: 'approved' | 'changes-requested' | null } {
  if (explicitPlanReviewState !== undefined) return { planReviewState: explicitPlanReviewState };
  if (priorStatus === groomingStatus && newStatus !== groomingStatus) return { planReviewState: null };
  return {};
}

/**
 * FLUX-1263: should `change_status` REFUSE a direct Grooming -> Todo move and redirect it through the
 * plan-review gate instead? Pure (mirrors `evaluateWorktreeReadyRefusal`'s idiom) so the trigger-per-gate-
 * value behavior (AC: "trigger behavior exactly matches the gate value for all three states") is unit
 * testable without spinning up the MCP handler.
 *   `you`           -> never intercepts (no automatic trigger at all — a human/agent can still explicitly
 *                      run one pass via the `start_plan_review` tool, but a direct move is never blocked).
 *   `auto`/`auto-then-you`, no verdict yet -> intercept: the gate runs instead of the direct move.
 *   `auto`/`auto-then-you`, a verdict already exists -> let it through (this IS the human's confirm of an
 *      `auto-then-you` pass, or of a manually-run one under `you`) — `resolvePlanReviewStateOnMove` clears it.
 */
export function evaluatePlanGateTrigger(input: {
  priorStatus: string;
  newStatus: string;
  groomingStatus: string;
  todoStatus: string;
  gateValue: 'auto' | 'auto-then-you' | 'you';
  planReviewState: 'approved' | 'changes-requested' | null | undefined;
}): boolean {
  const { priorStatus, newStatus, groomingStatus, todoStatus, gateValue, planReviewState } = input;
  if (priorStatus !== groomingStatus || newStatus !== todoStatus) return false;
  if (gateValue === 'you') return false;
  if (planReviewState != null) return false;
  return true;
}

/**
 * FLUX-1269: once `evaluatePlanGateTrigger` fires and `change_status` calls `startPlanGateNow`, is the
 * "gate runs instead" success story actually true? Yes when a pass is freshly dispatched (`ok: true`) or
 * was already in flight (`already-running` — the one benign refusal; the gate genuinely IS running, so
 * the claim still holds). Any other refusal (chiefly: the ticket is owned by an active Furnace batch)
 * means nothing started at all — the caller must not report success, and the redirect should instead
 * fall through to the ordinary status move rather than leave the ticket wedged in Grooming behind a
 * false "it's running" message.
 */
export function planGateRedirectSucceeded(started: { ok: boolean; message: string; reason?: string }): boolean {
  return started.ok || started.reason === 'already-running';
}

/**
 * FLUX-1288: gate value -> the loop shape `startPlanGateNow` should run. `auto` loops and auto-moves on
 * approval; `auto-then-you` loops the same way but always stops on approval to flag a human to confirm;
 * `you` never auto-triggers (see `evaluatePlanGateTrigger`) but a manual `start_plan_review` call always
 * passes `one-pass` directly rather than through this function — this mapping only concerns the two
 * gate values `evaluatePlanGateTrigger` actually redirects.
 */
export function resolvePlanGateMode(gateValue: 'auto' | 'auto-then-you' | 'you'): PlanGateMode {
  return gateValue === 'auto' ? 'loop-auto' : 'loop-confirm';
}

// ─── Permission policy for gated sessions (--permission-prompt-tool) ──────────
// Hoisted to module scope (pure, no closure state) so the action-aware gating can be exercised as a
// unit — same idiom as nextStepForStatus. Used by the `permission_prompt` handler in buildMcpServer.

const SAFE_PERMISSION_TOOLS = new Set([
  'get_ticket', 'list_tickets', 'get_board_config', 'get_project_group', 'get_board_state',
  'list_available_agents', 'get_session_log',
  // The proposal path is always safe — it parks a batch for human approval, never mutates.
  'propose_board_rebase',
  'Read', 'Glob', 'Grep', 'LS', 'WebFetch', 'WebSearch', 'TodoWrite', 'NotebookRead',
]);
// The restructuring verbs join the CONFIRM tier so a DIRECT orchestrator call to mutate the board
// is gated even if it bypasses the board-rebase ritual — "never silently restructure" is enforced
// by the gate, not just the prompt. `archive` (both directions) stays confirm-gated; `branch`,
// `furnace_batch` and `group_doc` are action-aware (see ACTION_AWARE_PERMISSION_TOOLS below); the
// merged tools that absorbed a confirm-tier op are handled there too.
const CONFIRM_PERMISSION_TOOLS = new Set([
  'change_status', 'finish_ticket', 'Bash',
  'archive', 'extract_ticket', 'merge_tickets',
]);

// Declarative per-(tool, action) permission tiers (FLUX-939) for tools that folded exactly one
// destructive action into a broader action-taking surface. Each entry lists the actions that are
// safe to auto-allow; any action NOT in the set — including an unrecognized value or a missing
// `input` altogether — confirms. This is deliberately fail-safe: the old ad-hoc `bare === 'branch'`
// special-case defaulted to 'allow' when `input` was absent (fail-open on a destructive op), which
// is only harmless today because the handler requires `action` as a strict enum and
// `permission_prompt` always passes `input` through — but a gate shouldn't depend on callers
// upholding that. `group_doc` delete is cross-repo destructive (fans out to all member repos) and
// now gets the same confirm-gating `branch` delete already had (previously auto-allowed —
// pre-existing asymmetry, not a regression, called out in the FLUX-882 review).
const ACTION_AWARE_PERMISSION_TOOLS: Record<string, Set<string>> = {
  branch: new Set(['create', 'status']),
  furnace_batch: new Set(['ignite', 'stop', 'resume']),
  group_doc: new Set(['list', 'read', 'submit']),
};

/**
 * Action-aware permission decision for a gated tool call. Pure + exported for test (FLUX-882): the
 * 34→24 consolidation folded a destructive op into several merged tools, so gating can no longer key
 * on the bare tool name alone. A tool in ACTION_AWARE_PERMISSION_TOOLS is allow only for its listed
 * safe actions (fail-safe: an unknown/missing action confirms); everything else falls back to the
 * static SAFE/CONFIRM tiers, defaulting to allow.
 */
export function permissionDecisionFor(toolName: string, input?: unknown): 'allow' | 'deny' | 'confirm' {
  const bare = toolName.replace(/^mcp__.+?__/, '');
  // Declarative action-aware tiers (FLUX-939) subsume the old ad-hoc `branch`/`furnace_batch`
  // branches with identical semantics (delete/discard confirm; create/status/ignite/stop/resume
  // allow) and add `group_doc` (delete confirms). `furnace_ticket` (retry/dismiss/takeover/
  // handback/add/remove) has no destructive action, so it has no entry — it falls through to the
  // allow default, same as the old furnace_add_ticket/furnace_remove_ticket tier.
  const action = input && typeof input === 'object' ? (input as Record<string, unknown>).action : undefined;
  const actionTiers = ACTION_AWARE_PERMISSION_TOOLS[bare];
  if (actionTiers) return typeof action === 'string' && actionTiers.has(action) ? 'allow' : 'confirm';
  if (SAFE_PERMISSION_TOOLS.has(bare)) return 'allow';
  if (CONFIRM_PERMISSION_TOOLS.has(bare)) return 'confirm';
  return 'allow';
}

/**
 * AXI #5 (definitive empty states, FLUX-878): build a filter-echoing note for a
 * `list_tickets` call that matched zero rows. A bare `[]` can't tell an agent
 * "the filter matched nothing" apart from "something went wrong / I queried the
 * wrong field" — echoing the active filters makes the zero-result definitive.
 * Pure + exported for unit test (mirrors the `evaluateWorktreeReadyRefusal` idiom).
 */
export function describeEmptyTicketList(filters: {
  status?: string | undefined;
  assignee?: string | undefined;
  tag?: string | undefined;
  priority?: string | undefined;
}): string {
  const active = [
    filters.status && `status=${filters.status}`,
    filters.assignee && `assignee=${filters.assignee}`,
    filters.tag && `tag=${filters.tag}`,
    filters.priority && `priority=${filters.priority}`,
  ].filter(Boolean) as string[];
  return active.length
    ? `No tickets match ${active.join(', ')}.`
    : 'No tickets on the board yet.';
}

/**
 * FLUX-489: the `list_tickets` selection/cap *decision*, factored out of the handler so it
 * can be unit-tested as a pure function (mirrors the `describeEmptyTicketList` /
 * `evaluateWorktreeReadyRefusal` idiom).
 *
 * The default result set is now ACTIVE-BY-DEFAULT + BOUNDED: a no-filter call no longer
 * dumps the whole board (~480 rows) into context. We
 *  - drop terminal statuses (Done/Released/Archived) unless an explicit `status` is given;
 *  - case-insensitively substring-match `search` over id + title;
 *  - cap rows at `limit` (default 40).
 * `includeAll:true` is the escape hatch: ignore both the active default and the limit.
 *
 * Discoverability (critical): whenever rows are omitted — by the active-default filter or by
 * the limit — `note` explains total matched, returned count, and how to widen the call, so a
 * truncation is never silent.
 */
export type ListTicketRow = {
  id: string;
  title: string;
  status: string;
  priority: string;
  effort: string;
  assignee: string;
  tags: string[];
};

const DEFAULT_LIST_LIMIT = 40;

/**
 * Minimal shape `selectTicketsForList` reads off a raw task record. Tickets are loosely-typed,
 * runtime-validated frontmatter (schema.ts), not a canonical `Ticket` interface — this covers
 * only the fields this projection actually touches, not the full record.
 */
interface TaskListInput {
  id?: string;
  title?: string;
  status?: string;
  priority?: string;
  effort?: string;
  assignee?: string;
  tags?: unknown;
  kind?: string;
}

export function selectTicketsForList(
  allTasks: TaskListInput[],
  filters: {
    status?: string | undefined;
    assignee?: string | undefined;
    tag?: string | undefined;
    priority?: string | undefined;
    search?: string | undefined;
    active?: boolean | undefined;
    limit?: number | undefined;
    includeAll?: boolean | undefined;
  },
  terminalStatuses: string[] = getTerminalStatuses(),
): { rows: ListTicketRow[]; note?: string } {
  const { status, assignee, tag, priority, search, includeAll } = filters;
  // active defaults to true; an explicit status filter, or includeAll, overrides it.
  const activeOnly = includeAll ? false : (filters.active ?? true) && !status;

  let tasks = allTasks;
  if (status) tasks = tasks.filter((t) => t.status === status);
  if (assignee) tasks = tasks.filter((t) => t.assignee === assignee);
  if (tag) tasks = tasks.filter((t) => Array.isArray(t.tags) && t.tags.includes(tag));
  if (priority) tasks = tasks.filter((t) => t.priority === priority);
  if (search) {
    const needle = search.toLowerCase();
    tasks = tasks.filter(
      (t) =>
        String(t.id ?? '').toLowerCase().includes(needle) ||
        String(t.title ?? '').toLowerCase().includes(needle),
    );
  }

  // After the explicit filters, the active-by-default screen removes terminal statuses AND scratch
  // chats (FLUX-1225): a Scratch Chat is a freeform conversation, not board work, so it never
  // belongs in the default active listing (mirrors its exclusion from board columns). The escape
  // hatches still reach it — an explicit `status` filter or `includeAll` turns activeOnly off, so a
  // scratch entity is fetchable when explicitly asked for. Scratch rows drop silently (no
  // "pass includeAll" nudge — they aren't work to surface); the disclosure note below still counts
  // ONLY terminal tickets so its wording stays accurate.
  if (activeOnly) {
    tasks = tasks.filter((t) => t.kind !== 'scratch');
  }
  const afterScratch = tasks.length;
  if (activeOnly) {
    tasks = tasks.filter((t) => !terminalStatuses.includes(t.status ?? ''));
  }
  const matched = tasks.length; // rows that pass active screen (the universe for limit)
  const droppedByActive = afterScratch - matched;

  const effectiveLimit = includeAll
    ? Infinity
    : filters.limit != null && filters.limit > 0
      ? filters.limit
      : DEFAULT_LIST_LIMIT;
  const capped = Number.isFinite(effectiveLimit) ? tasks.slice(0, effectiveLimit) : tasks;
  const droppedByLimit = matched - capped.length;

  // FLUX-985: coerce nullable/absent frontmatter to the schema's declared string/array types.
  // list_tickets' outputSchema rows are strict per-field (.partial() → optional, which still
  // REJECTS null), so a single hand-edited/legacy ticket with an empty `priority:`/`assignee:`/
  // `tags:` line (YAML → null) would otherwise fail SDK output validation and make the ENTIRE
  // list_tickets call error out. Normalize here so one bad row can't poison the whole board.
  const rows: ListTicketRow[] = capped.map((t) => ({
    id: String(t.id ?? ''),
    title: String(t.title ?? ''),
    status: t.status ?? '',
    priority: t.priority ?? 'None',
    effort: t.effort ?? 'None',
    assignee: t.assignee ?? 'unassigned',
    tags: Array.isArray(t.tags) ? t.tags.filter((x): x is string => typeof x === 'string') : [],
  }));

  const notes: string[] = [];
  if (droppedByActive > 0) {
    notes.push(
      `${droppedByActive} terminal-status ticket${droppedByActive === 1 ? '' : 's'} ` +
        `(${terminalStatuses.join('/')}) hidden by active-default — pass includeAll:true or an explicit status to include them.`,
    );
  }
  if (droppedByLimit > 0) {
    notes.push(
      `Showing ${rows.length} of ${matched} matched — raise limit (default ${DEFAULT_LIST_LIMIT}) or pass includeAll:true to see the rest.`,
    );
  }
  return notes.length ? { rows, note: notes.join(' ') } : { rows };
}

// ─── MCP Resource resolvers (FLUX-949) ───────────────────────────────────────
// The read-only resource surface (ticket:// board:// docs://) mirrors the
// existing agent tool projections EXACTLY — no new data shaping. These resolvers
// are factored as pure, cache-injected helpers so the not-found / traversal /
// active-filter logic is unit-testable without spinning up a transport (mirrors
// the selectTicketsForList / describeEmptyTicketList idiom).

/** Machine-readable discriminant carried in a thrown McpError's `data.code`. */
export type ResourceErrorCode = 'not_found' | 'validation_failed' | 'channel_unavailable';

export type ResourceResolution<T> =
  | ({ ok: true } & T)
  | { ok: false; code: ResourceErrorCode; message: string };

/**
 * Resolve a `ticket://{id}` URI variable to a task. Exact-id match only — the
 * canonical `FLUX-949` form every ticket tool uses. A bare numeric id (`949`) is
 * rejected as ambiguous with `validation_failed` rather than silently guessing a
 * project key; any other unmatched id is `not_found` (never empty content).
 */
export function resolveTicketResource(
  rawId: unknown,
  tasks: Record<string, unknown>,
): ResourceResolution<{ task: unknown }> {
  if (typeof rawId !== 'string' || !rawId.trim()) {
    return { ok: false, code: 'validation_failed', message: `Invalid ticket id: ${String(rawId)}` };
  }
  const id = rawId.trim();
  if (/^\d+$/.test(id)) {
    return {
      ok: false,
      code: 'validation_failed',
      message: `Ticket id "${id}" is a bare number — use the canonical id (e.g. FLUX-${id}).`,
    };
  }
  const task = tasks[id];
  if (!task) return { ok: false, code: 'not_found', message: `Ticket ${id} not found` };
  return { ok: true, task };
}

/**
 * Resolve a `docs://{path}` URI variable to a repo doc body. Routes EVERY lookup
 * through `normalizeDocPathInput` (rejects `..`, `.`, absolute, empty → null) and
 * only ever indexes `docsCache` — it never builds a filesystem path from the URI,
 * so a read outside `.docs/` is impossible. Cross-project group docs (`Product/…`,
 * surfaced read-only) are out of this surface's scope — read them via the
 * `group_doc` tool — so they resolve as `not_found` here.
 */
export function resolveDocResource(
  rawPath: unknown,
  docs: Record<string, StoredDoc>,
): ResourceResolution<{ key: string; title: string; body: string }> {
  const key = normalizeDocPathInput(rawPath);
  if (!key) {
    return { ok: false, code: 'validation_failed', message: `Invalid doc path: ${String(rawPath)}` };
  }
  const doc = docs[key];
  if (!doc || doc.group) {
    return { ok: false, code: 'not_found', message: `Doc not found: ${key}` };
  }
  return { ok: true, key, title: doc.title, body: doc.body };
}

/**
 * Enumerate `ticket://{id}` resources for `resources/list`. Active (non-terminal)
 * tickets only — reuses `selectTicketsForList` so a board with hundreds of
 * Done/Released/Archived tickets never dumps them all into the resource list
 * (which would re-bill discovery on every client refresh).
 */
export function listActiveTicketResources(
  tasks: Record<string, unknown>,
  terminalStatuses: string[],
): { uri: string; name: string; title: string; mimeType: string }[] {
  const { rows } = selectTicketsForList(Object.values(tasks) as TaskListInput[], { active: true }, terminalStatuses);
  return rows.map((t) => ({
    uri: `ticket://${t.id}`,
    name: t.id,
    title: t.title,
    mimeType: 'application/json',
  }));
}

/**
 * Enumerate `docs://{path}` resources for `resources/list` — the repo's own
 * `.docs/` entries (bounded, ~dozens). Group docs (`d.group`) are excluded; they
 * belong to the `group_doc` surface, not the repo-docs resource.
 */
export function listDocResources(
  docs: Record<string, StoredDoc>,
): { uri: string; name: string; title: string; mimeType: string }[] {
  return Object.values(docs)
    .filter((d) => !d.group)
    .sort((a, b) => a.path.localeCompare(b.path))
    .map((d) => ({
      uri: `docs://${d.path}`,
      name: d.path,
      title: d.title,
      mimeType: 'text/markdown',
    }));
}

/**
 * Minimal shape of a config-driven `{name, ...}` entry (columns/hiddenStatuses/tags — see
 * config.ts). `configCache` itself stays `any` (config.ts, out of scope here); these narrow
 * the loop variables so the projection logic below is actually type-checked.
 */
interface ConfigNamedEntry {
  name?: unknown;
}

/** Minimal shape of a config priority entry (columns/priorities — see config.ts). */
interface ConfigPriorityEntry {
  name?: unknown;
  icon?: unknown;
}

/** Minimal shape of a configured swimlane definition (see config.ts). */
interface ConfigSwimlane {
  id: string;
  label: string;
  commentRequired?: boolean;
}

/**
 * Agent-facing board-config projection (FLUX-928). Shared by the `get_board_config`
 * tool and the `board://config` resource so the two never diverge. CLONE — never
 * mutates configCache (the portal/REST GET /api/config path keeps the full config
 * with Tailwind colors).
 */
export function buildBoardConfigProjection() {
  // FLUX-985: the get_board_config / board://config outputSchema types statuses & tag names as
  // string[] and priority name/icon as string; a malformed config entry (missing/non-string name)
  // would otherwise fail SDK output validation and make the whole config unreadable. Filter/coerce
  // so a degraded config still returns.
  const statuses = [
    ...(configCache.columns || []).map((c: ConfigNamedEntry) => c?.name),
    ...(configCache.hiddenStatuses || []).map((s: ConfigNamedEntry) => s?.name),
  ].filter((n: unknown): n is string => typeof n === 'string');
  const { projects, tags, priorities, users, requireInputStatus, readyForMergeStatus } = configCache;
  const agentTags = (tags || [])
    .map((t: ConfigNamedEntry) => t?.name)
    .filter((n: unknown): n is string => typeof n === 'string');
  const agentPriorities = (priorities || [])
    .filter((p: ConfigPriorityEntry): p is ConfigPriorityEntry & { name: string } => !!p && typeof p.name === 'string')
    .map((p: ConfigPriorityEntry & { name: string }) => ({ name: p.name, icon: typeof p.icon === 'string' ? p.icon : undefined }));
  return { statuses, projects, tags: agentTags, priorities: agentPriorities, users, requireInputStatus, readyForMergeStatus };
}

/**
 * Template URI variables (`Variables` = string | string[]) arrive raw from the
 * UriTemplate regex match. Our `list` callbacks emit plain-ASCII URIs (ticket ids,
 * doc slugs), but a client may percent-encode — decode defensively, falling back
 * to the raw value when it isn't valid percent-encoding. A `{/path*}`-style array
 * is re-joined with '/'.
 */
function decodeResourceVar(value: string | string[] | undefined): string {
  const raw = Array.isArray(value) ? value.join('/') : value ?? '';
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

// Soft ceiling for ticket bodies written by agents. The body is injected in
// full into every future agent session, so oversized bodies tax every session
// on the ticket. The write is accepted either way — this only nudges.
const BODY_WARN_CHARS = 10_000;

function bodySizeWarning(body: string | undefined | null): string | undefined {
  if (!body || body.length <= BODY_WARN_CHARS) return undefined;
  return `Body is ${body.length} chars (soft limit ${BODY_WARN_CHARS}). Large bodies bloat every agent session on this ticket — keep the body a concise plan and move bulk material (logs, dumps, research) to .docs/ with a link.`;
}

/**
 * FLUX-730/FLUX-731: the commit-before-Ready refusal *decision*, factored out of the
 * `change_status` handler so it can be unit-tested without an MCP-handler harness. Pure:
 * inputs in, decision out — no I/O.
 *
 * Refuse ONLY a worktree branch that exists and has 0 commits ahead of base — a dedicated
 * worktree means an agent did (or should have done) real work in an isolated tree, so 0
 * commits ahead means it was never committed and no PR can ever open (the FLUX-716/717/719
 * incident). Everything else allows: a worktree branch with commits ahead (falls through to
 * PR), a plain (non-worktree) branch with 0 commits ahead (kept as a soft warning per scope),
 * and branchless tickets (which legitimately stay uncommitted until finish).
 */
export function evaluateWorktreeReadyRefusal(input: {
  worktreePath: string | null;
  branchStatus: { exists: boolean; aheadCount: number } | null;
  ticketId: string;
  branch: string;
  readyStatus: string;
  /** Genuinely uncommitted change count in the worktree (git status, not a diff-vs-base), used only to phrase the message. */
  changeCount?: number;
  /**
   * FLUX-1267: explicit caller acknowledgment that this ticket's scope legitimately produces no
   * code diff (a verification/investigation/spike ticket), passed as `noDiffExpected` on
   * `change_status`. Only lifts the refusal when the worktree is ALSO clean (changeCount === 0) —
   * if there are uncommitted changes sitting in the tree, that contradicts a zero-diff claim, so
   * the FLUX-730 guard still fires and the caller must commit or reconsider.
   */
  noDiffAcknowledged?: boolean;
}): { refuse: boolean; message?: string } {
  const { worktreePath, branchStatus, ticketId, branch, readyStatus, changeCount = 0, noDiffAcknowledged = false } = input;
  if (!(worktreePath && branchStatus && branchStatus.exists && branchStatus.aheadCount === 0)) {
    return { refuse: false };
  }
  if (noDiffAcknowledged && changeCount === 0) {
    return { refuse: false };
  }
  const didWork = changeCount > 0
    ? `Its worktree has ${changeCount} uncommitted change${changeCount === 1 ? '' : 's'} — the work was done but never committed.`
    : `Its worktree has no changes yet.`;
  return {
    refuse: true,
    message:
      `Cannot move ${ticketId} to ${readyStatus}: its worktree branch \`${branch}\` has no commits ahead of base. ${didWork} ` +
      `Commit the worktree's work with a real message (in the worktree: \`git add -A && git commit\`), then retry the move to ${readyStatus} — that opens the PR for review. ` +
      `If this ticket's scope genuinely produces no code diff (verification/investigation-only), retry with noDiffExpected:true instead. Status left unchanged.`,
  };
}

/** Extra fields `finish_ticket` writes onto the ticket record via `updateTaskWithHistory` —
 * covers only the fields that handler actually sets. */
interface FinishExtraFields {
  implementationLink: string;
  swimlane: null;
  diffSummary?: DiffFileSummary[];
  [key: string]: unknown;
}

/** Minimal shape of the `/api/tasks/:id/cli-session/delegate` response the `delegate` tool
 * reads to report a child agent's outcome back to the caller. */
interface DelegationResult {
  status: string;
  output: string;
  succeeded: boolean;
}

/** Shape of the engine's `/api/board/permission-request` response (FLUX-1026 CLI contract) —
 * mirrors the {behavior, updatedInput|message} decision the `permission_prompt` tool itself
 * returns. */
interface PermissionDecisionResponse {
  behavior?: 'allow' | 'deny';
  updatedInput?: unknown;
  message?: unknown;
}

/**
 * Build a fully-configured Event Horizon MCP server with every tool registered, WITHOUT
 * connecting a transport. HTTP-only (FLUX-646): the sole caller is the in-process
 * Streamable-HTTP mount on the engine (`handleMcpHttpRequest`, FLUX-645). The caller owns
 * transport + workspace activation; the tools operate on the engine's already-active
 * task-store cache.
 */
export function buildMcpServer(): McpServer {
  const server = new McpServer(
    {
      name: 'event-horizon',
      version: '1.0.0',
    },
    {
      // Server-level `instructions` are folded into the client's system prompt on
      // `initialize` (the "MCP Server Instructions" block). This is a compact
      // projection of the orchestrator contract from .claude/rules/event-horizon.md,
      // so clients that never load that rules file (Cursor, raw SDK agents, …) still
      // get the non-negotiable workflow rules. Keep it short — it bills every session.
      instructions: [
        'Event Horizon is a local-first, markdown-backed ticket board. Manage tickets EXCLUSIVELY through these tools.',
        '',
        'Rules:',
        '- NEVER edit files under .flux/ or .flux-store/ directly — those paths are engine-managed. All ticket changes go through these tools.',
        '- Read a ticket with get_ticket before acting on it. Find tickets with list_tickets; read board config with get_board_config.',
        '- Move tickets between columns with change_status (NOT update_ticket). A comment is REQUIRED when moving to Require Input (the question) or Ready (the completion summary).',
        '- End every working turn on a board action (status move / Require Input / created subtasks). Never finish work and only summarize in chat — the board flags such tickets "Needs Action".',
        '- Raise ANY decision or question for the user through a structured surface — ask_user_question or a Require Input status — never plain chat prose, regardless of ticket status.',
        '- Destructive actions (archive, merge_tickets, finish_ticket) are one-way or removal operations and may require explicit human approval.',
      ].join('\n'),
    },
  );

  // ─── Context Tools ──────────────────────────────────────────────────────────

  server.registerTool(
    'get_ticket',
    {
      title: 'Get ticket',
      description: 'Read a ticket by ID — returns frontmatter, body, and a digested history (agent_session entries collapsed to summaries; older summarized entries shown collapsed with an id; windowed to recent entries). Pass `expand:[ids]` to un-collapse specific entries (prefer this over `fullHistory:true`).',
      inputSchema: {
      ticketId: z.string().describe('Ticket ID, e.g. FLUX-42'),
      historyLimit: z.number().int().positive().optional().describe('Max history entries to return (default 20)'),
      expand: z.array(z.string()).optional().describe('History entry ids to return in FULL (un-collapse). Pass the `id` shown on a collapsed entry when its summary is not enough.'),
      fullHistory: z.boolean().optional().describe('Return all history uncollapsed. Discouraged — defeats the digest and re-inflates context; prefer expand:[ids].'),
      fullBody: z.boolean().optional().describe('Return the full ticket body even when it is oversized. By default a very large body is truncated with a recoverable size hint to save context; normal bodies are never truncated.'),
      },
      // FLUX-950: permissive/shallow output schema — every field optional so the
      // SDK's structuredContent validation never throws on payload variation (a
      // truncated body, a ticket missing optional frontmatter, extra fields). It
      // documents the stable shape for typed clients without coupling to the full
      // serializeTaskForAgent projection.
      // `.catchall` keeps the schema LOOSE: the SDK's client-side validator enforces
      // the generated JSON Schema strictly (additionalProperties:false by default),
      // which would reject the rich, open-ended task projection (and the shared error
      // envelope's {code,message}). Documented fields stay optional for typed clients.
      // FLUX-985: frontmatter fields use .nullish() (accepts null AND undefined) not .optional()
      // (undefined only). serializeTaskForAgent coerces the common ones, but a hand-edited/legacy
      // ticket can still carry a null (e.g. parentId), and .optional() would make the SDK reject
      // the whole structuredContent — turning get_ticket into an error instead of returning the
      // ticket (the FLUX-950 outputSchema regression).
      outputSchema: z.object({
        id: z.string().optional().describe('Ticket ID'),
        title: z.string().nullish(),
        status: z.string().nullish(),
        priority: z.string().nullish(),
        effort: z.string().nullish(),
        assignee: z.string().nullish(),
        tags: z.array(z.string()).nullish(),
        parentId: z.string().nullish(),
        body: z.string().nullish().describe('Markdown body — may be truncated with a recoverable size hint when oversized (AXI #3 / FLUX-879)'),
        history: z.array(z.unknown()).optional().describe('Digested history (agent_session entries collapsed to summaries; windowed to recent entries)'),
        collapsedCount: z.number().optional(),
        olderHistoryEntries: z.number().optional(),
      }).catchall(z.unknown()),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ ticketId, historyLimit, expand, fullHistory, fullBody }) => {
      const task = tasksCache[ticketId];
      if (!task) return errorResult(`Ticket ${ticketId} not found`, 'not_found');
      const { _path, ...output } = serializeTaskForAgent(task, historyLimit, { expand, fullHistory, fullBody });
      return structuredResult(output);
    },
  );

  server.tool(
    'get_session_log',
    'Read the full progress log of one past agent session on a ticket. Use only when investigating what a specific prior session did — get_ticket already returns a digest of every session (sessionId + progressCount). Pass tail to fetch just the last N progress entries.',
    {
      ticketId: z.string().describe('Ticket ID, e.g. FLUX-42'),
      sessionId: z.string().describe('Session ID from a get_ticket agent_session history entry'),
      tail: z.number().int().positive().optional().describe('Return only the last N progress entries'),
    },
    { title: 'Get session log', readOnlyHint: true, openWorldHint: false },
    async ({ ticketId, sessionId, tail }) => {
      const task = tasksCache[ticketId];
      if (!task) return errorResult(`Ticket ${ticketId} not found`, 'not_found');
      const isAgentSessionEntry = (e: unknown): e is AgentSessionEntry =>
        !!e && typeof e === 'object' && (e as Record<string, unknown>).type === 'agent_session';
      const history: unknown[] = Array.isArray(task.history) ? task.history : [];
      const entry = history.find((e): e is AgentSessionEntry => isAgentSessionEntry(e) && e.sessionId === sessionId);
      if (!entry) {
        const known = history.filter(isAgentSessionEntry).map((e) => e.sessionId);
        return errorResult(
          `Session ${sessionId} not found on ${ticketId}.` +
          (known.length > 0 ? ` Known sessions: ${known.join(', ')}` : ' This ticket has no agent sessions.'),
          'not_found',
        );
      }
      const progress: AgentSessionProgress[] = Array.isArray(entry.progress) ? entry.progress : [];
      if (tail != null && progress.length > tail) {
        return jsonResult({ ...entry, progress: progress.slice(-tail), omittedProgressEntries: progress.length - tail });
      }
      return jsonResult(entry);
    },
  );

  server.registerTool(
    'list_tickets',
    {
      title: 'List tickets',
      description: 'List tickets with optional filtering by status, assignee, tag, or priority. Active-by-default and bounded (FLUX-489): with no explicit status it returns only non-terminal tickets (excludes Done/Released/Archived) and caps at 40 rows. Use search to substring-match id+title, raise limit, or pass includeAll:true to see everything.',
      inputSchema: {
      status: z.string().optional().describe('Filter by status (e.g. "In Progress", "Todo"). An explicit status overrides the active-by-default screen (so you CAN list Done/Released/Archived by naming the status).'),
      assignee: z.string().optional().describe('Filter by assignee'),
      tag: z.string().optional().describe('Filter by tag name'),
      priority: z.string().optional().describe('Filter by priority (Critical, High, Medium, Low, None)'),
      search: z.string().optional().describe('Case-insensitive substring match over ticket id + title.'),
      active: z.boolean().optional().describe('Default true: when no explicit status is given, return only NON-terminal tickets (exclude Done, Released, Archived). Set false to include terminal statuses.'),
      limit: z.number().int().positive().optional().describe('Max rows to return (default 40). Ignored when includeAll is true.'),
      includeAll: z.boolean().optional().describe('Escape hatch: return every matched row, ignoring the active-default screen AND the limit.'),
      },
      // FLUX-950: structuredContent must be an object, so the result is always the
      // `{ tickets, note? }` envelope (never a bare array). Rows are permissive/partial
      // and `note` carries the FLUX-489/878 disclosure so a bounded/empty result is
      // never a silent truncation.
      outputSchema: z.object({
        tickets: z.array(z.object({
          id: z.string(),
          title: z.string(),
          status: z.string(),
          priority: z.string(),
          effort: z.string(),
          assignee: z.string(),
          tags: z.array(z.string()),
        }).partial()).optional().describe('Matching ticket rows (bounded; see `note` when a screen or limit omitted rows)'),
        note: z.string().optional().describe('Disclosure note when the result was bounded or empty (FLUX-489 / FLUX-878)'),
      }).catchall(z.unknown()),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ status, assignee, tag, priority, search, active, limit, includeAll }) => {
      const { rows, note } = selectTicketsForList(
        Object.values(tasksCache),
        { status, assignee, tag, priority, search, active, limit, includeAll },
        getTerminalStatuses(),
      );
      // AXI #5 definitive empty state (FLUX-878): on zero matches return a
      // filter-echoing note instead of a bare [].
      if (rows.length === 0) {
        // FLUX-489: an empty result is not always "nothing matched" — the
        // active-default screen may have hidden every match (all terminal). In
        // that case `selectTicketsForList` produced a disclosure note; surface
        // it alongside the filter echo so the truncation is never silent and the
        // agent learns includeAll:true would reveal the hidden terminal tickets.
        const emptyNote = describeEmptyTicketList({ status, assignee, tag, priority });
        return structuredResult({ tickets: [], note: note ? `${emptyNote} ${note}` : emptyNote });
      }
      // FLUX-489: when rows were omitted (active-default screen / limit), attach a
      // discoverability note so a bounded result is never silently truncated.
      // Always an object envelope (never a bare array) — structuredContent requires it.
      return structuredResult(note ? { tickets: rows, note } : { tickets: rows });
    },
  );

  server.registerTool(
    'get_board_config',
    {
      title: 'Get board config',
      description: 'Read board configuration — statuses, tags, priorities, project key',
      // FLUX-950: shallow/permissive output schema (all fields optional) — documents
      // the agent-facing projection (FLUX-928) without coupling to configCache.
      outputSchema: z.object({
        statuses: z.array(z.string()).optional(),
        projects: z.array(z.unknown()).optional(),
        tags: z.array(z.string()).optional().describe('Tag names only (colors stripped for agents, FLUX-928)'),
        priorities: z.array(z.object({ name: z.string().optional(), icon: z.string().optional() })).optional(),
        users: z.array(z.unknown()).optional(),
        requireInputStatus: z.string().optional(),
        readyForMergeStatus: z.string().optional(),
      }).catchall(z.unknown()),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => {
      // Agent-facing projection (FLUX-928): the orchestrator reads this every
      // session and the result re-bills each turn, so strip the Tailwind color
      // classes agents never use. Shared with the `board://config` resource (FLUX-949)
      // via buildBoardConfigProjection so the two never diverge; returned via the
      // FLUX-950 structuredResult (structured output) rather than jsonResult.
      return structuredResult(buildBoardConfigProjection());
    },
  );

  server.tool(
    'get_project_group',
    'Read the multi-repo group (if configured): group name + member repos (name, role, git remote, resolved local path, test command, registration state). Also reports `membership` when the current workspace is the parent or a bound member of a group. Returns a clear notice when no group is configured.',
    {},
    { title: 'Get project group', readOnlyHint: true, openWorldHint: false },
    async () => {
      const registeredPaths = (await getWorkspacesList()).map((w) => w.path);
      const ctx = getGroupContext();
      if (ctx) {
        const summary = summarizeGroup(ctx, registeredPaths);
        summary.membership = { role: 'parent', groupName: ctx.config.name, parentRoot: ctx.parentRoot };
        return jsonResult(summary);
      }
      const binding = getMemberBinding();
      if (binding) {
        const summary = summarizeGroup(null, registeredPaths);
        summary.docsLabel = groupDocsLabel(binding.parentGroup);
        const self = binding.parentGroup.config.members.find((m) => m.name === binding.memberName);
        summary.membership = {
          role: 'member',
          groupName: binding.parentGroup.config.name,
          parentRoot: binding.parentRoot,
          memberName: binding.memberName,
          ...(self?.role ? { memberRole: self.role } : {}),
        };
        return jsonResult(summary);
      }
      return jsonResult(summarizeGroup(null, registeredPaths));
    },
  );

  // ─── Mutation Tools ─────────────────────────────────────────────────────────

  server.tool(
    'create_ticket',
    'Create a new ticket on the board. Pass parentId to create it as a subtask — the child is linked into the parent\'s subtasks array atomically.',
    {
      title: z.string().describe('Ticket title'),
      parentId: z.string().optional().describe('Parent ticket ID — when set, the new ticket is created as a linked subtask of this parent.'),
      status: z.string().optional().describe('Initial status (default: Todo)'),
      priority: z.string().optional().describe('Priority level (default: None)'),
      effort: z.string().optional().describe('Effort estimate: XS, S, M, L, XL, or None'),
      assignee: z.string().optional().describe('Assignee name (default: unassigned)'),
      tags: z.array(z.string()).optional().describe('Tags array'),
      body: z.string().optional().describe('Markdown body/description'),
      author: z.string().optional().describe('Author name (default: Agent)'),
    },
    async ({ title, parentId, status, priority, effort, assignee, tags, body, author }) => {
      if (workspaceActivating) return errorResult('Workspace is activating, please retry', 'transient_retry');

      // Subtask path: resolve + validate the parent, create the child with skipBroadcast, then
      // TOCTOU-safe link it into the parent's subtasks array before emitting taskCreated.
      const parent = parentId ? tasksCache[parentId] : undefined;
      if (parentId && !parent) return errorResult(`Parent ticket ${parentId} not found`, 'not_found');

      try {
        const opts: CreateTaskOptions = { title, author: author || 'Agent' };
        if (parentId) { opts.parentId = parentId; opts.skipBroadcast = true; }
        if (status !== undefined) opts.status = status;
        if (priority !== undefined) opts.priority = priority;
        if (effort !== undefined) opts.effort = effort;
        if (assignee !== undefined) opts.assignee = assignee;
        if (tags) opts.tags = tags;
        if (body !== undefined) opts.body = body;
        const { id, task } = await createTask(opts);
        const warning = bodySizeWarning(body);

        if (parentId && parent) {
          // Link to parent through the locked write path (FLUX-987): appendSubtask reads
          // frontmatter.subtasks fresh from disk under the parent's per-ticket write lock, so a
          // concurrent add_note/change_status/another create_ticket on the same parent can't
          // interleave with this read-modify-write and drop history/subtasks.
          const updatedParent = await updateTaskWithHistory(parentId, { entries: [], appendSubtask: id });
          if (!updatedParent) return errorResult(`Failed to link ${id} under ${parentId} — parent may no longer exist`, 'not_found');

          // Now that both child + parent link are persisted, emit the deferred creation event.
          broadcastEvent('taskCreated', { id, parentId });
          broadcastEvent('taskUpdated', { id: parentId });
          return jsonResult({
            id, parentId, title: task.title, status: task.status, ...(warning ? { warning } : {}),
            nextSteps: `Created subtask ${id} under ${parentId}. Next: start_session on ${id}, or create_ticket with parentId again for more children.`,
          });
        }

        return jsonResult({
          id, title: task.title, status: task.status, ...(warning ? { warning } : {}),
          nextSteps: `Created ${id} (${task.status}). Next: start_session to begin work, or update_ticket to refine the plan first.`,
        });
      } catch (err: unknown) {
        return errorResult(errMessage(err) || 'Failed to create ticket');
      }
    },
  );

  // FLUX-656: the `extract` curation verb — carve a topic-slice out of a conversation stream
  // (the orchestrator thread `__board__` by default) into a NEW card. Gated in the CONFIRM
  // tier (below) and surfaced via the board-rebase `promote` proposal — never auto-applied.
  // It is additive (one op-log entry + a new ticket); the source turns are never moved —
  // EXCEPT a `kind:"scratch"` source, which promotion consumes (archives) so no live duplicate
  // remains (FLUX-1249).
  server.tool(
    'extract_ticket',
    'Carve a topic-slice out of a conversation stream into a NEW ticket (the promotion gate) — address the slice by seq range on the source stream. Human-approved only (CONFIRM gate / board-rebase proposal); the source turns are never moved or copied — the new card re-derives the slice. Exception: promoting a scratch chat CONSUMES it (the scratch is archived, pointing at the new ticket) so exactly one live card remains.',
    {
      from: z.string().optional().describe('Source stream id to carve from (default: __board__, the orchestrator thread).'),
      fromSeq: z.number().int().describe('Inclusive start seq of the topic-slice on the source stream.'),
      toSeq: z.number().int().describe('Inclusive end seq of the topic-slice on the source stream.'),
      title: z.string().describe('Title for the new ticket.'),
      priority: z.string().optional().describe('Priority (default: None).'),
      effort: z.string().optional().describe('Effort estimate (default: None).'),
      tags: z.array(z.string()).optional().describe('Tags array.'),
      body: z.string().optional().describe('Markdown body for the new ticket.'),
    },
    async ({ from, fromSeq, toSeq, title, priority, effort, tags, body }) => {
      if (workspaceActivating) return errorResult('Workspace is activating, please retry', 'transient_retry');
      try {
        const result = await extractTicket({
          ...(from !== undefined ? { from } : {}),
          fromSeq,
          toSeq,
          title,
          ...(priority !== undefined ? { priority } : {}),
          ...(effort !== undefined ? { effort } : {}),
          ...(tags ? { tags } : {}),
          ...(body !== undefined ? { body } : {}),
        });
        return jsonResult(result);
      } catch (err: unknown) {
        return errorResult(errMessage(err) || 'Failed to extract ticket');
      }
    },
  );

  // FLUX-657: the `merge` curation verb — fold several chat-streams/tickets into ONE survivor
  // effort (the inverse of extract). Gated in the CONFIRM tier (below) and surfaced via the
  // board-rebase `fold` proposal — never auto-applied. Additive (one op-log entry); the source
  // turns are never moved, and each source is tombstoned + archived (not deleted).
  server.tool(
    'merge_tickets',
    'Fold several tickets/chat-streams into ONE survivor effort — the inverse of extract. The survivor re-derives as the chronological union of its own turns plus every source stream\'s turns; each source is tombstoned and archived, never deleted. Additive and reversible. Human-approved only (CONFIRM gate / board-rebase `fold` proposal).',
    {
      into: z.string().describe('Survivor ticket id the sources fold into.'),
      from: z.array(z.string()).describe('Source ticket/stream ids to fold into the survivor (each gets tombstoned + archived). Must be non-empty and exclude `into`.'),
    },
    { title: 'Merge tickets', readOnlyHint: false, destructiveHint: true },
    async ({ into, from }) => {
      if (workspaceActivating) return errorResult('Workspace is activating, please retry', 'transient_retry');
      try {
        const result = await mergeTickets({ into, from });
        return jsonResult(result);
      } catch (err: unknown) {
        return errorResult(errMessage(err) || 'Failed to merge tickets');
      }
    },
  );

  server.tool(
    'update_ticket',
    'Update ticket metadata ONLY — title, priority, effort, tags, assignee, body, implementationLink, or parentId. Does NOT move status (use change_status for that). Pass parentId to (re)link this ticket under a parent (updates the parent\'s subtasks and detaches it from any old parent); pass parentId:null to detach it entirely.',
    {
      ticketId: z.string().describe('Ticket ID'),
      title: z.string().optional().describe('New title'),
      priority: z.string().optional().describe('New priority'),
      effort: z.string().optional().describe('New effort estimate'),
      assignee: z.string().optional().describe('New assignee'),
      tags: z.array(z.string()).optional().describe('Replace tags array'),
      body: z.string().optional().describe('Replace markdown body'),
      implementationLink: z.string().optional().describe('PR URL or commit hash'),
      // FLUX-1068: .nullish() — a string (re)parents this ticket, null detaches it. Omit to leave
      // the parent link unchanged. The parent's subtasks array is kept in sync both ways.
      parentId: z.string().nullish().describe('Parent ticket ID to (re)link under; null detaches. Self-parenting and cycles are rejected.'),
    },
    async ({ ticketId, title, priority, effort, assignee, tags, body, implementationLink, parentId }) => {
      const task = tasksCache[ticketId];
      if (!task) return errorResult(`Ticket ${ticketId} not found`, 'not_found');

      // FLUX-1068: parentId (re)linking. A string sets/moves the parent; null detaches. Omitted →
      // leave unchanged. Validate the target + reject self-parenting/cycles BEFORE any write.
      const reparenting = parentId !== undefined;
      const oldParentId = task.parentId || null;
      const newParentId = reparenting ? (parentId ? parentId : null) : oldParentId;
      if (reparenting && newParentId) {
        if (!tasksCache[newParentId]) return errorResult(`Parent ticket ${newParentId} not found`, 'not_found');
        const linkError = validateParentLink(ticketId, newParentId);
        if (linkError) return errorResult(linkError, 'validation_failed');
      }

      // Build the merged frontmatter for a pre-write schema check. The authoritative write below
      // re-reads + re-applies these inside the per-ticket lock (updateTaskWithHistory).
      const { frontmatter } = await readTaskFromDisk(task);
      if (title !== undefined) frontmatter.title = title;
      if (priority !== undefined) frontmatter.priority = priority;
      if (effort !== undefined) frontmatter.effort = effort;
      if (assignee !== undefined) frontmatter.assignee = assignee;
      if (tags !== undefined) frontmatter.tags = tags;
      if (implementationLink !== undefined) frontmatter.implementationLink = implementationLink;
      if (reparenting) {
        if (newParentId) frontmatter.parentId = newParentId;
        else delete frontmatter.parentId;
      }

      const validationErrors = validateTicketFrontmatter(frontmatter);
      if (validationErrors.length > 0) {
        return errorResult(`Schema validation failed:\n${formatValidationErrors(validationErrors)}`, 'validation_failed');
      }

      if (tags !== undefined && Array.isArray(tags)) {
        await autoRegisterUnknownTags(tags);
      }

      const fieldChanges: string[] = [];
      if (title !== undefined && title !== task.title) fieldChanges.push('Updated title.');
      if (body !== undefined && body !== task.body) fieldChanges.push('Updated description.');
      if (priority !== undefined && priority !== task.priority) fieldChanges.push(`Changed priority to ${priority}.`);
      if (effort !== undefined && effort !== task.effort) fieldChanges.push(`Changed effort to ${effort}.`);
      if (assignee !== undefined && assignee !== task.assignee) fieldChanges.push(`Changed assignee to ${assignee}.`);
      if (tags !== undefined) fieldChanges.push('Updated tags.');
      if (implementationLink !== undefined) fieldChanges.push('Updated implementation link.');
      if (reparenting && newParentId !== oldParentId) {
        fieldChanges.push(newParentId ? `Linked under ${newParentId}.` : 'Detached from parent.');
      }

      const extraFields: Record<string, unknown> = {};
      if (priority !== undefined) extraFields.priority = priority;
      if (effort !== undefined) extraFields.effort = effort;
      if (assignee !== undefined) extraFields.assignee = assignee;
      if (tags !== undefined) extraFields.tags = tags;
      if (implementationLink !== undefined) extraFields.implementationLink = implementationLink;
      // FLUX-1068: set parentId via extraFields; detach by deleting the key (not persisting null).
      if (reparenting && newParentId) extraFields.parentId = newParentId;
      const deleteFields: string[] = reparenting && !newParentId ? ['parentId'] : [];

      // FLUX-788: route through the locked + atomic write path (FLUX-645/290) instead of a bare
      // fs.writeFile read-modify-write, which raced concurrent add_comment/log_progress/change_status
      // on the same ticket and could drop the history append or expose a half-written file.
      try {
        const result = await updateTaskWithHistory(ticketId, {
          updatedBy: 'Agent',
          entries: fieldChanges.length > 0
            ? [buildActivityEntry(fieldChanges.join(' '), 'Agent', new Date().toISOString())]
            : [],
          ...(Object.keys(extraFields).length > 0 ? { extraFields } : {}),
          ...(deleteFields.length > 0 ? { deleteFields } : {}),
          ...(title !== undefined ? { newTitle: title } : {}),
          ...(body !== undefined ? { newBody: body } : {}),
        });
        if (!result) return errorResult(`Failed to update ${ticketId}`);
      } catch (err: unknown) {
        return errorResult(`Failed to update ${ticketId}: ${errMessage(err)}`);
      }

      // FLUX-1068: reconcile the parent's subtasks (and any old parent) through the shared helper —
      // the child's own parentId was written above; this fixes up the related tickets.
      if (reparenting && newParentId !== oldParentId) {
        await syncParentSubtaskLinks({ id: ticketId, oldParentId, newParentId, actor: 'Agent' });
      }

      broadcastEvent('taskUpdated', { id: ticketId });
      const warning = body !== undefined ? bodySizeWarning(body) : undefined;
      return textResult(`Updated ${ticketId}${warning ? `\nWarning: ${warning}` : ''}`);
    },
  );

  server.tool(
    'change_status',
    'Move a ticket to a new status (the board state machine) — this is the ONLY tool that changes status; update_ticket never does. A comment is REQUIRED when moving to Require Input or Ready. Set callerRole to your role (e.g. "orchestrator") when calling from a multi-session context.',
    {
      ticketId: z.string().describe('Ticket ID'),
      newStatus: z.string().describe('Target status'),
      comment: z.string().optional().describe('Required for Require Input/Ready transitions. Provide the question or completion summary.'),
      callerRole: z.string().optional().describe('Role of the calling session (e.g. "orchestrator"). Required to change status when scatter-gather sessions are active.'),
      reviewState: z.enum(['approved', 'changes-requested']).nullable().optional().describe('The EH review verdict to record on the card. Set "approved" when concluding a review to Ready, "changes-requested" when sending back to In Progress. Pass null to clear. Surfaces a review badge; distinct from the GitHub-synced reviewDecision.'),
      planReviewState: z.enum(['approved', 'changes-requested']).nullable().optional().describe('FLUX-1263: the plan-review gate\'s verdict, parallel to `reviewState` but for the Grooming -> Todo gate (never overloads `reviewState`). Set by a plan-review session while leaving `newStatus` as "Grooming". Pass null to clear.'),
      completion: completionInputSchema,
      noDiffExpected: z.boolean().optional().describe('Ready transitions only. Set true ONLY when this ticket\'s scope genuinely produces no code diff (a verification/investigation/spike ticket that confirmed there was nothing to change) — lifts the FLUX-730 commit-before-Ready refusal for a worktree branch with 0 commits ahead of base, and skips opening a PR since there is nothing to merge. Still refused if the worktree has uncommitted changes sitting in it (that contradicts a zero-diff claim). Do NOT set this to route around forgotten/uncommitted work.'),
    },
    async ({ ticketId, newStatus, comment, callerRole, reviewState, planReviewState, completion, noDiffExpected }) => {
      const task = tasksCache[ticketId];
      if (!task) return errorResult(`Ticket ${ticketId} not found`, 'not_found');
      // FLUX-922 review fix: capture the prior verdict before the update so the review notification
      // only fires on an actual change (a re-affirming change_status with the same reviewState must
      // not re-mark the card unread).
      const priorReviewState = task.reviewState;
      // FLUX-1147: best-effort, never blocks the transition below even on garbage input.
      const sanitizedCompletion = sanitizeCompletion(completion);

      // Scatter-gather guard: if there are active step sessions on this task,
      // only an orchestrator (or explicit lead) can change status. Scope the check
      // to active sessions so concurrent reviewers in the same run hold the barrier.
      const activeSessions = getActiveSessionsForTask(ticketId);
      const activeStepSessions = activeSessions.filter(s => s.patternPosition === 'step');
      if (activeStepSessions.length > 0 && activeSessions.length >= 2) {
        const isOrchestrator = callerRole === 'orchestrator' || callerRole === 'lead';
        if (!isOrchestrator) {
          return errorResult(
            `Cannot change status: ${activeStepSessions.length} scatter-gather sessions are active on ${ticketId}. ` +
            `Only the orchestrator can change status while parallel reviews are running. ` +
            `Post your findings via add_note (type:"comment") instead.`,
            'invalid_state'
          );
        }
      }

      const requireInputStatus = configCache.requireInputStatus || 'Require Input';
      const readyStatus = configCache.readyForMergeStatus || 'Ready';

      // Backwards-compat: change_status to "Require Input" routes through the swimlane system.
      // The ticket stays in its current status but gets the require-input swimlane set.
      if (newStatus === requireInputStatus && task.status !== requireInputStatus) {
        if (!comment) {
          return errorResult('Transitioning to Require Input requires a comment (the question to ask).', 'validation_failed');
        }

        const entries: Record<string, unknown>[] = [
          { type: 'comment', user: 'Agent', comment, date: new Date().toISOString(), ...(sanitizedCompletion !== undefined ? { completion: sanitizedCompletion } : {}) },
          { type: 'swimlane_change', swimlane: 'require-input', action: 'set', user: 'Agent', date: new Date().toISOString(), comment },
        ];

        const result = await updateTaskWithHistory(ticketId, {
          entries,
          updatedBy: 'Agent',
          extraFields: { swimlane: 'require-input' },
        });
        if (!result) return errorResult(`Failed to update ${ticketId}`);

        const sessions = getActiveSessionsForTask(ticketId);
        for (const s of sessions) {
          s.status = 'waiting-input';
          s.pausedForInput = true;
        }

        broadcastEvent('taskUpdated', { id: ticketId });
        generatePromptNotification(ticketId, task.title || ticketId, 'Require Input');
        return textResult(`${ticketId} swimlane set to 'require-input' (status remains ${task.status})\nNext: wait for the user's answer — the session resumes when they respond. Do not keep working this ticket meanwhile.`);
      }

      // FLUX-1263: the plan-review gate — a Grooming -> Todo move under `auto`/`auto-then-you` with no
      // verdict recorded yet runs the gate INSTEAD of moving directly (the whole point of the gate: a
      // recorded verdict, not just an agent's say-so). `evaluatePlanGateTrigger` is pure/unit-tested;
      // this is the one place its answer is acted on.
      const groomingStatus = 'Grooming';
      const todoStatusForGate = nextColumnAfter(groomingStatus) || 'Todo';
      const planGateValue = resolveGateValue(configCache.gatePolicy, task.gatePolicyOverride, 'plan');
      if (evaluatePlanGateTrigger({
        priorStatus: task.status,
        newStatus,
        groomingStatus,
        todoStatus: todoStatusForGate,
        gateValue: planGateValue,
        planReviewState: task.planReviewState ?? null,
      })) {
        const planGateMode = resolvePlanGateMode(planGateValue);
        const started = await startPlanGateNow(ticketId, { mode: planGateMode });
        if (planGateRedirectSucceeded(started)) {
          // The caller's comment (if any) would otherwise be silently dropped by this early return —
          // record it before redirecting, same attribution/shape as the normal comment-entry path below.
          if (comment) {
            await updateTaskWithHistory(ticketId, {
              entries: [{ type: 'comment', user: 'Agent', comment, date: new Date().toISOString(), ...(sanitizedCompletion !== undefined ? { completion: sanitizedCompletion } : {}) }],
              updatedBy: 'Agent',
            });
          }
          return textResult(
            `${ticketId} stays in ${groomingStatus} — the plan-review gate (${planGateValue}) runs instead of a direct move to ${todoStatusForGate}. ${started.message} ` +
            (planGateMode === 'loop-auto'
              ? `It will loop review → revise until approved (then move straight to ${todoStatusForGate}), or park after ${DEFAULT_RETRY_CAP} revise attempt(s).`
              : `It will loop review → revise until approved, then flag you to confirm the move to ${todoStatusForGate}, or park after ${DEFAULT_RETRY_CAP} revise attempt(s).`)
          );
        }
        // Gate refused to start — fall through to the ordinary status-change path below (which records
        // `comment`, if any, as part of its own entries) instead of reporting a phantom review.
      }

      if (newStatus === readyStatus && task.status !== readyStatus && !comment && configCache.requireCommentOnStatusChange !== false) {
        return errorResult('Transitioning to Ready requires a completion comment.', 'validation_failed');
      }

      const entries: Record<string, unknown>[] = [];
      if (comment) {
        // FLUX-1147: attach the structured completion payload (if any) to the same comment entry —
        // it only makes sense alongside the prose comment it's a machine-readable companion to.
        // FLUX-1205: tag the comment as the completion summary when it accompanies a transition into
        // a completion status (Ready/Done) so deriveGist (release.ts) targets it over a later comment.
        const isCompletionComment = newStatus === readyStatus || newStatus === 'Done';
        entries.push({ type: 'comment', user: 'Agent', comment, date: new Date().toISOString(), ...(isCompletionComment ? { completionComment: true } : {}), ...(sanitizedCompletion !== undefined ? { completion: sanitizedCompletion } : {}) });
      }

      const extraFields: Record<string, unknown> = {};

      // FLUX-816: record the EH review verdict alongside the status move so the card reflects it.
      // Passed explicitly by the review orchestrator (approved→Ready, changes-requested→In Progress)
      // or null to clear. FLUX-1089: an explicit verdict always wins; otherwise leaving Ready
      // clears a now-stale prior verdict — see resolveReviewStateOnMove.
      Object.assign(extraFields, resolveReviewStateOnMove(reviewState, task.status, newStatus, readyStatus));
      // FLUX-1263: same shape for the plan gate's verdict — either the plan-review session recording it
      // (explicit, while staying in Grooming) or a departure from Grooming clearing a stale one (the
      // guard above already redirected the one case that must NOT clear it: a fresh, un-reviewed move).
      const planVerdictMove = resolvePlanReviewStateOnMove(planReviewState, task.status, newStatus, groomingStatus);
      Object.assign(extraFields, planVerdictMove);
      // FLUX-1303: stamp/clear the reviewed-body hash in lockstep with the verdict — surfaces use it
      // to tell whether the plan changed since this review (gates the panel's "Re-review plan").
      if ('planReviewState' in planVerdictMove) {
        extraFields.planReviewBodyHash = planVerdictMove.planReviewState != null
          ? planBodyHash(typeof task.body === 'string' ? task.body : '')
          : null;
      }

      // Clear swimlane when moving out of a blocked state (e.g. user answered the question)
      if (task.swimlane && newStatus !== requireInputStatus) {
        extraFields.swimlane = null;
        entries.push({ type: 'swimlane_change', swimlane: task.swimlane, action: 'cleared', user: 'Agent', date: new Date().toISOString() });
        dismissNotificationsForTicket(ticketId);
      }

      // When moving to Ready with a branch, push and create a PR for review (FLUX-555).
      // The work MUST be committed before Ready — a branch with no commits ahead of base
      // can't open a PR.
      if (newStatus === readyStatus && task.branch) {
        const branchStatus = await getTicketBranchStatus(task.branch).catch(() => null);

        // FLUX-730: ENFORCE commit-before-Ready for *worktree* branches. A dedicated worktree
        // means an agent did (or should have done) real work in an isolated tree; reaching Ready
        // with 0 commits ahead means it was never committed, so no PR can ever open and the work
        // sits silently uncommitted (the FLUX-716/717/719 incident). Refuse the transition —
        // don't just warn — so the agent is forced to commit. Git-only (no gh dependency), so it
        // holds even when gh is unauthed. Scope: ONLY worktree branches. Plain-branch tickets and
        // branchless tickets keep their existing behavior (branchless legitimately stays
        // uncommitted until finish), so the refusal is gated on an actual worktree existing.
        const worktreePath = await findWorktreeForBranch(workspaceRoot!, task.branch).catch(() => null);
        if (worktreePath && branchStatus && branchStatus.exists && branchStatus.aheadCount === 0) {
          // FLUX-1121: count genuine uncommitted changes (git status), NOT a diff against the base
          // branch — the latter also picks up base-branch drift for a 0-commit branch (a
          // review-confirmation ticket whose fix shipped elsewhere), misattributing files master
          // changed AFTER the branch was cut as "uncommitted work" in this worktree.
          const changeCount = await worktreeUncommittedCount(worktreePath).catch(() => 0);
          const decision = evaluateWorktreeReadyRefusal({
            worktreePath,
            branchStatus,
            ticketId,
            branch: task.branch,
            readyStatus,
            changeCount,
            noDiffAcknowledged: noDiffExpected === true,
          });
          if (decision.refuse) return errorResult(decision.message!, 'invalid_state');
        }

        // FLUX-1267: an explicitly-acknowledged zero-diff ticket (verification/investigation-only)
        // has nothing to open a PR for — reaching here means the refusal above already let it
        // through (which for a worktree branch only happens when the tree is also clean). Skip the
        // PR-creation/soft-warning path entirely and record a clear, non-alarming activity entry
        // instead — this is the "real Ready stop" the tooling gap was missing.
        const zeroDiffAcknowledged = noDiffExpected === true && !!branchStatus?.exists && branchStatus.aheadCount === 0;
        if (zeroDiffAcknowledged) {
          entries.push({
            type: 'activity',
            user: 'Agent',
            comment: `Zero-diff ticket acknowledged — branch \`${task.branch}\` has no commits ahead of base, so no PR was opened (nothing to merge). Reviewed on the ticket's scope/verification alone.`,
            date: new Date().toISOString(),
          });
        } else {
          // Rather than fail silently in a buried activity line, surface a no-commit branch
          // LOUDLY (notification + comment) so the user/agent knows to commit (FLUX-563).
          const ghAvailable = await checkGhAuth();
          if (ghAvailable) {
            if (branchStatus && branchStatus.exists && branchStatus.aheadCount === 0) {
              // Non-worktree (plain) branch with no commits: can't open a PR. Plain-branch tickets
              // are NOT enforced (per scope) — keep the existing soft warning + notification.
              const msg = `${ticketId} moved to ${readyStatus} but its branch \`${task.branch}\` has no commits yet — commit the work to open a PR for review.`;
              entries.push({ type: 'activity', user: 'Agent', comment: `⚠️ ${msg}`, date: new Date().toISOString() });
              addNotification({
                type: 'info',
                title: 'Commit needed to open PR',
                message: msg,
                ticketId,
                actions: [{ label: 'Open worktree', actionId: 'open-worktree' }],
              });
            } else {
              try {
                const prBody = `${task.body ? task.body.slice(0, 800) : ''}\n\n---\nTicket: ${ticketId}`;
                const prUrl = await createPullRequest(task.branch, task.title || ticketId, prBody, ticketId);
                extraFields.implementationLink = prUrl;
                extraFields.swimlane = 'open-pr';
                entries.push({ type: 'activity', user: 'Agent', comment: `PR created: ${prUrl}`, date: new Date().toISOString() });
              } catch (err: unknown) {
                const msg = `PR creation failed: ${errMessage(err)}. Push the branch / commit work manually.`;
                entries.push({ type: 'activity', user: 'Agent', comment: `⚠️ ${msg}`, date: new Date().toISOString() });
                addNotification({ type: 'error', title: 'PR creation failed', message: `${ticketId}: ${msg}`, ticketId, actions: [{ label: 'Open worktree', actionId: 'open-worktree' }] });
              }
            }
          }
        }
      }

      const prevStatus = task.status;
      const result = await updateTaskWithHistory(ticketId, {
        entries,
        updatedBy: 'Agent',
        nextStatus: newStatus,
        ...(Object.keys(extraFields).length > 0 ? { extraFields } : {}),
      });

      if (!result) return errorResult(`Failed to update ${ticketId}`);

      // FLUX-721: a forward transition abandons any session still parked (waiting-input) on an
      // EARLIER phase — reap them so they don't linger as merge-gating (FLUX-636 Tier-2) or
      // start-blocking (FLUX-667) zombies. The Require-Input branch above returns early (parking
      // is legitimate there), so this runs only on forward moves; the helper preserves the live
      // caller ('running') and the persistent per-ticket 'chat' session (FLUX-602).
      if (newStatus !== prevStatus) {
        const reaped = reapStaleParkedSessions(ticketId, `ticket moved to ${newStatus}`);
        if (reaped.length > 0) {
          await updateTaskWithHistory(ticketId, {
            updatedBy: 'Agent',
            entries: [{ type: 'activity', user: 'Agent', comment: `Reaped ${reaped.length} stale parked session${reaped.length > 1 ? 's' : ''} from an earlier phase on move to ${newStatus}.`, date: new Date().toISOString() }],
          });
        }
      }

      broadcastEvent('taskUpdated', { id: ticketId });

      // FLUX-1031: reclaim this ticket's worktree the moment it reaches Ready — its work is
      // committed (commit-before-Ready invariant, enforced above) and pushed to the PR branch,
      // so freeing the slot from the board-wide pool loses nothing (resolveTaskExecutionRoot
      // self-heals the worktree if the ticket bounces back to In Progress). isWorktreeReclaimable
      // reads the just-written cache status and SKIPS while a session is still live on the
      // worktree's branch — the caller that just moved it OR a joined sibling (FLUX-1031 review) —
      // and the reconcile sweep reclaims it once that ends. The predicate is checked first
      // (in-memory, cheap) so a live-session Ready move doesn't pay a git scan. The sweep predicate
      // is scoped to THIS ticket's worktree AND re-runs `isWorktreeReclaimable` so the branch-sibling
      // guard (+ the sweep's own TOCTOU re-check before removal) also apply on this eager path — not
      // just the one-time check below. Best-effort — a reclaim failure must never fail the status move.
      if (newStatus === readyStatus && task.branch && isWorktreeReclaimable(ticketId)) {
        await reclaimWorktrees(workspaceRoot!, (rid) => rid === ticketId && isWorktreeReclaimable(rid)).catch((err) =>
          console.error(`[mcp] Ready worktree reclaim for ${ticketId} failed:`, err),
        );
      }

      // FLUX-922: a concluded review (verdict recorded via reviewState) emits a first-class review
      // notification so the reviewer's verdict reaches the Updates panel, not just the card badge.
      // Gate on a *changed* verdict so a no-op re-affirm doesn't re-fire the notification (and
      // re-mark the card unread).
      if ((reviewState === 'approved' || reviewState === 'changes-requested') && reviewState !== priorReviewState) {
        generateReviewNotification(ticketId, task.title || ticketId, reviewState);
      }

      // FLUX-1071 (Temper): a ticket entering Ready with Temper on kicks off the auto-review loop.
      // maybeStartTemper is self-guarding (mode off / branchless / already looping / in a Furnace batch
      // all no-op), and only a genuine non-Ready → Ready move qualifies, so Temper's own re-implementation
      // returning to Ready never re-triggers it. Fire-and-forget — it must never fail the status move.
      void maybeStartTemper(ticketId, newStatus, prevStatus).catch((err) =>
        console.error(`[mcp] Temper start for ${ticketId} failed:`, err),
      );

      // FLUX-889: resolve the In-Progress / Todo target labels the Todo / Grooming hints
      // advance toward from the configured column order (the next forward column after the
      // canonical Todo / Grooming), so a renamed board never names a non-existent status.
      // FLUX-1263: reuses the shared `nextColumnAfter` (config.js) computed once above as
      // `todoStatusForGate` for the plan-gate guard — no more re-deriving this per call site.
      const inProgressStatus = nextColumnAfter('Todo') || 'In Progress';
      const hint = nextStepForStatus(newStatus, { readyStatus, requireInputStatus, inProgressStatus, todoStatus: todoStatusForGate });
      return textResult(`${ticketId} moved to ${newStatus}${hint ? `\n${hint}` : ''}`);
    },
  );

  server.tool(
    'start_plan_review',
    'FLUX-1263: manually trigger ONE plan-review pass on a Grooming ticket right now — the plan gate\'s explicit human-invoked entry point. Use this under the "you" gate value (which never auto-triggers) or any time you want an extra look before moving Grooming to Todo. Runs exactly one pass (never loops, regardless of gate value) and records its verdict to `planReviewState`; it does not move the ticket — a later `change_status` to Todo goes through once the verdict is recorded.',
    {
      ticketId: z.string().describe('Ticket ID (must currently be in Grooming).'),
    },
    async ({ ticketId }) => {
      if (!tasksCache[ticketId]) return errorResult(`Ticket ${ticketId} not found`, 'not_found');
      const result = await startPlanGateNow(ticketId, { mode: 'one-pass' });
      if (!result.ok) return errorResult(result.message, 'invalid_state');
      return textResult(result.message);
    },
  );

  server.tool(
    'archive',
    'Archive or unarchive a ticket. action: "archive" moves it to the Archived status (the reversible alternative to deletion — history is preserved; there is no hard-delete tool); "unarchive" brings it back to the active board (default Todo, or pass toStatus). comment applies to "archive"; toStatus applies to "unarchive".',
    {
      ticketId: z.string().describe('Ticket ID'),
      action: z.enum(['archive', 'unarchive']).describe('Whether to archive or unarchive the ticket.'),
      comment: z.string().optional().describe('archive only — optional reason for archiving (recorded in history).'),
      toStatus: z.string().optional().describe('unarchive only — status to restore the ticket to (default: "Todo").'),
    },
    { title: 'Archive / unarchive ticket', readOnlyHint: false, destructiveHint: true },
    async ({ ticketId, action, comment, toStatus }) => {
      const task = tasksCache[ticketId];
      if (!task) return errorResult(`Ticket ${ticketId} not found`, 'not_found');

      const archiveStatus = configCache.archiveStatus || 'Archived';

      if (action === 'archive') {
        if (task.status === archiveStatus) {
          return textResult(`${ticketId} is already ${archiveStatus}`);
        }

        const entries: Record<string, unknown>[] = [];
        if (comment) {
          entries.push({ type: 'comment', user: 'Agent', comment, date: new Date().toISOString() });
        }

        const extraFields: Record<string, unknown> = {};
        // Clear any swimlane so the archived ticket doesn't keep a stale blocked flag.
        if (task.swimlane) {
          extraFields.swimlane = null;
          entries.push({ type: 'swimlane_change', swimlane: task.swimlane, action: 'cleared', user: 'Agent', date: new Date().toISOString() });
          dismissNotificationsForTicket(ticketId);
        }

        const result = await updateTaskWithHistory(ticketId, {
          entries,
          updatedBy: 'Agent',
          nextStatus: archiveStatus,
          ...(Object.keys(extraFields).length > 0 ? { extraFields } : {}),
        });
        if (!result) return errorResult(`Failed to archive ${ticketId}`);

        // An archived ticket is off the active board — reap any sessions still parked on an
        // earlier phase so they don't linger as zombies. Preserves the persistent 'chat' session.
        reapStaleParkedSessions(ticketId, `ticket archived → ${archiveStatus}`);

        broadcastEvent('taskUpdated', { id: ticketId });
        return textResult(`${ticketId} archived (moved to ${archiveStatus})`);
      }

      // action === 'unarchive'
      if (task.status !== archiveStatus) {
        return errorResult(`${ticketId} is not archived (status is ${task.status}).`, 'invalid_state');
      }

      const target = toStatus || 'Todo';
      if (target === archiveStatus) {
        return errorResult(`Cannot unarchive ${ticketId} to ${archiveStatus} — choose a non-archive status.`, 'invalid_state');
      }

      const result = await updateTaskWithHistory(ticketId, {
        entries: [],
        updatedBy: 'Agent',
        nextStatus: target,
      });
      if (!result) return errorResult(`Failed to unarchive ${ticketId}`);

      broadcastEvent('taskUpdated', { id: ticketId });
      return textResult(`${ticketId} unarchived (moved to ${target})`);
    },
  );

  // ─── Swimlane Tools ──────────────────────────────────────────────────────────

  server.tool(
    'swimlane',
    'Set or clear a swimlane on a ticket (the ticket stays in its status column but is visually flagged). action: "set" applies a swimlane (needs swimlane id; a comment is required for swimlanes with commentRequired, e.g. "require-input"); "clear" removes the active swimlane.',
    {
      ticketId: z.string().describe('Ticket ID'),
      action: z.enum(['set', 'clear']).describe('Whether to set or clear a swimlane.'),
      swimlane: z.string().optional().describe('set only — swimlane ID (e.g. "require-input").'),
      comment: z.string().optional().describe('set: required for commentRequired swimlanes (the question to ask). clear: optional comment explaining the resolution.'),
    },
    async ({ ticketId, action, swimlane, comment }) => {
      const task = tasksCache[ticketId];
      if (!task) return errorResult(`Ticket ${ticketId} not found`, 'not_found');

      if (action === 'set') {
        if (!swimlane) return errorResult('swimlane is required for action "set".', 'validation_failed');

        const swimlanes: ConfigSwimlane[] = configCache.swimlanes || [];
        const swimlaneDef = swimlanes.find((s) => s.id === swimlane);
        if (!swimlaneDef) {
          return errorResult(`Unknown swimlane '${swimlane}'. Available: ${swimlanes.map((s) => s.id).join(', ')}`, 'validation_failed');
        }

        if (swimlaneDef.commentRequired && !comment) {
          return errorResult(`Swimlane '${swimlane}' requires a comment (the question to ask).`, 'validation_failed');
        }

        const entries: Record<string, unknown>[] = [];

        // If ticket already has a swimlane, emit a 'cleared' entry before setting the new one
        if (task.swimlane && task.swimlane !== swimlane) {
          entries.push({ type: 'swimlane_change', swimlane: task.swimlane, action: 'cleared', user: 'Agent', date: new Date().toISOString() });
        } else if (task.swimlane === swimlane) {
          return errorResult(`${ticketId} already has swimlane '${swimlane}'. Clear it first or use a different swimlane.`, 'invalid_state');
        }

        if (comment) {
          entries.push({ type: 'comment', user: 'Agent', comment, date: new Date().toISOString() });
        }
        entries.push({ type: 'swimlane_change', swimlane, action: 'set', user: 'Agent', date: new Date().toISOString(), comment: comment || undefined });

        const result = await updateTaskWithHistory(ticketId, {
          entries,
          updatedBy: 'Agent',
          extraFields: { swimlane },
        });
        if (!result) return errorResult(`Failed to update ${ticketId}`);

        // require-input parks active sessions (the same special-case change_status applies).
        if (swimlane === 'require-input') {
          const sessions = getActiveSessionsForTask(ticketId);
          for (const s of sessions) {
            s.status = 'waiting-input';
            s.pausedForInput = true;
          }
        }

        broadcastEvent('taskUpdated', { id: ticketId });
        generatePromptNotification(ticketId, task.title || ticketId, swimlaneDef.label);
        return textResult(`${ticketId} swimlane set to '${swimlane}'`);
      }

      // action === 'clear'
      if (!task.swimlane) return errorResult(`${ticketId} has no active swimlane to clear.`, 'invalid_state');

      const previousSwimlane = task.swimlane;
      const entries: Record<string, unknown>[] = [];
      if (comment) {
        entries.push({ type: 'comment', user: 'Agent', comment, date: new Date().toISOString() });
      }
      entries.push({ type: 'swimlane_change', swimlane: previousSwimlane, action: 'cleared', user: 'Agent', date: new Date().toISOString(), comment: comment || undefined });

      const result = await updateTaskWithHistory(ticketId, {
        entries,
        updatedBy: 'Agent',
        extraFields: { swimlane: null },
      });
      if (!result) return errorResult(`Failed to update ${ticketId}`);

      dismissNotificationsForTicket(ticketId);
      broadcastEvent('taskUpdated', { id: ticketId });
      return textResult(`${ticketId} swimlane '${previousSwimlane}' cleared`);
    },
  );

  server.tool(
    'add_note',
    'Append a note to a ticket\'s history. type "comment" records a decision/observation (a human-facing comment); type "activity" logs an agent progress update ("agent did X"). summary/pin/supersedes apply to both: write a faithful summary for substantial notes (shown in the agent digest once the note ages past the recent window), pin to never collapse it, and supersedes to retire an earlier now-wrong entry.',
    {
      ticketId: z.string().describe('Ticket ID'),
      type: z.enum(['comment', 'activity']).describe('"comment" = a human-facing comment; "activity" = an agent progress/activity update.'),
      message: z.string().describe('The note text (comment body or progress message).'),
      user: z.string().optional().describe('Author (default: Agent). Honored for type "comment"; activity is always attributed to Agent.'),
      summary: z.string().optional().describe('Faithful summary shown in the agent digest once this note ages past the recent window (full text fetchable on demand). Write it for a substantial/long note; concise but NOT lossy. Skip for short ones.'),
      pin: z.boolean().optional().describe('Pin so this note is NEVER collapsed in the agent digest (review handoffs / key decisions).'),
      supersedes: z.array(z.string()).optional().describe('History entry id(s) this note makes obsolete (it reverses/replaces an earlier decision). The superseded entries collapse to a one-line marker in the agent digest, still recoverable via get_ticket expand. Set ONLY when genuinely retiring a now-wrong entry; a pinned or user-authored target is advisory-only (kept full).'),
    },
    async ({ ticketId, type, message, user, summary, pin, supersedes }) => {
      const task = tasksCache[ticketId];
      if (!task) return errorResult(`Ticket ${ticketId} not found`, 'not_found');

      const ts = new Date().toISOString();
      const extra: Record<string, unknown> = {
        ...(summary && summary.trim() ? { summary: summary.trim() } : {}),
        ...(pin ? { pin: true } : {}),
        ...(Array.isArray(supersedes) && supersedes.length ? { supersedes } : {}),
      };

      let entries: Record<string, unknown>[];
      let actor: string;
      if (type === 'comment') {
        actor = user || 'Agent';
        // FLUX-1271: `user` here is a fully caller-controlled claim (this same MCP session can also
        // call `finish_ticket`) — mark it so the merge-lock (`hasHumanGateTouch`) never trusts it as
        // proof of a real human touch, no matter what name was passed.
        entries = [{ type: 'comment', user: actor, comment: message, date: ts, [SELF_ATTESTED_AUTHOR_FIELD]: true, ...extra }];
      } else {
        actor = 'Agent';
        entries = [buildActivityEntry(message, 'Agent', ts, extra)];
      }

      const result = await updateTaskWithHistory(ticketId, { entries, updatedBy: actor });
      if (!result) return errorResult(`Failed to update ${ticketId}`);
      broadcastEvent('taskUpdated', { id: ticketId });
      return textResult(type === 'comment' ? `Comment added to ${ticketId}` : `Progress logged on ${ticketId}`);
    },
  );

  // ─── Artifact Tools (FLUX-873, FLUX-976) ──────────────────────────────────────

  server.tool(
    'publish_artifact',
    'Publish a self-contained HTML artifact so the user can reason against a concrete rendering instead of imagining it from prose. Spans both lifecycle ends: a plan-time grooming mockup/diagram/prototype AND a Ready-time visual recap of an implementation diff (touched-file tree + key diff hunks + plain-language summary; tag the recap title/note with "recap"). Each call is a NEW REVISION (never an overwrite). The HTML must be a COMPLETE, self-contained document (inline <style>/<script>; default to hand-written inline CSS. Mermaid via cdn.jsdelivr.net is allowed for diagrams. The Tailwind Play CDN via cdn.tailwindcss.com is allowed but is a heavy last resort, not the default — it is a full in-browser compiler that can freeze the host UI for seconds per load) and renders in a sandboxed iframe with no network access. Judge per ticket: emit for UI/UX, architecture, or "shape of the thing" work; SKIP bug fixes, XS/S tickets, and backend plumbing; default OFF when unsure.',
    {
      ticketId: z.string().describe('Ticket ID, e.g. FLUX-42'),
      html: z.string().describe('Complete, self-contained HTML document (inline styles/scripts — default to hand-written inline CSS; Mermaid via CDN script tag is allowed for diagrams; the Tailwind Play CDN is allowed but a heavy last resort, not the default). Rendered in a sandboxed opaque-origin iframe — it cannot reach the portal, cookies, or storage, and cannot make network requests (connect-src is blocked), so everything it needs must be inlined or loaded from the allowed CDNs.'),
      title: z.string().optional().describe('Short label for this artifact/revision (shown above the viewer).'),
      note: z.string().optional().describe('Optional note about what changed in this revision or what to look at.'),
    },
    async ({ ticketId, html, title, note }) => {
      const task = tasksCache[ticketId];
      if (!task) return errorResult(`Ticket ${ticketId} not found`);
      if (!isSafeTicketId(ticketId)) return errorResult(`Invalid ticket id ${ticketId}`);
      if (!html || !html.trim()) return errorResult('html is required and must be a non-empty self-contained HTML document');

      try {
        const { rev, pointer, bytes } = await writeArtifactRevision(ticketId, html, { title, note }, task.artifacts);
        const result = await updateTaskWithHistory(ticketId, {
          updatedBy: 'Agent',
          extraFields: { artifacts: pointer },
          entries: [{
            type: 'activity',
            user: 'Agent',
            comment: `Published artifact revision ${rev}${title ? ` — ${title}` : ''} (${bytes.toLocaleString()} bytes).`,
            date: new Date().toISOString(),
          }],
        });
        if (!result) return errorResult(`Failed to record artifact revision on ${ticketId}`);
        // taskUpdated refreshes the card/sideview pointer; artifactReady tells an open viewer to
        // jump to the new revision (FLUX-873).
        broadcastEvent('taskUpdated', { id: ticketId });
        broadcastEvent('artifactReady', { ticketId, rev });
        return textResult(
          `Published artifact revision ${rev} for ${ticketId}. It appears in the ticket's artifact panel (served at /api/tasks/${ticketId}/artifact?rev=${rev}). ` +
          `Prior revisions are kept — re-publishing always creates a new revision, never overwrites.`,
        );
      } catch (err: unknown) {
        return errorResult(`Failed to publish artifact for ${ticketId}: ${errMessage(err)}`);
      }
    },
  );

  // ─── Lifecycle Tools ────────────────────────────────────────────────────────

  server.tool(
    'finish_ticket',
    'Atomically finish a ticket: set implementationLink, add completion comment, move status to Done',
    {
      ticketId: z.string().describe('Ticket ID'),
      implementationLink: z.string().describe('PR URL or commit hash'),
      completionComment: z.string().describe('Summary of what was implemented'),
      force: z.boolean().optional().describe('Override the shared-PR guard: merge even though the branch is shared by non-Done sibling tickets (their work merges + they advance to Done too).'),
      completion: completionInputSchema,
    },
    { title: 'Finish ticket (merge + Done)', readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    async ({ ticketId, implementationLink, completionComment, force, completion }) => {
      // FLUX-1147: best-effort, never blocks finish even on garbage input.
      const sanitizedCompletion = sanitizeCompletion(completion);
      const task = tasksCache[ticketId];
      if (!task) return errorResult(`Ticket ${ticketId} not found`, 'not_found');

      const readyStatus = configCache.readyForMergeStatus || 'Ready';
      if (task.status !== readyStatus) {
        return errorResult(
          `Cannot finish ${ticketId} — ticket must be in "${readyStatus}" status first (current: "${task.status}"). ` +
          `Move to "${readyStatus}" with change_status and wait for user confirmation before finishing.`,
          'invalid_state'
        );
      }

      // Finish-on-shared-PR guard (FLUX-569, from the FLUX-556/PR#6 incident): finishing one
      // member of a SHARED branch merges the whole PR — advancing every bundled sibling to Done
      // as a one-way door, even ones that aren't finished. Refuse when the branch is shared by
      // non-Done sibling tickets, unless `force`. Exempt PR tickets (kind:'pr'): merging a PR
      // ticket to advance its members IS the sanctioned shared-merge surface.
      if (task.branch && task.kind !== 'pr' && !force) {
        const nonDone = sharedNonDoneSiblings(Object.values(tasksCache), task.branch, ticketId);
        if (nonDone.length > 0) {
          return errorResult(
            `Cannot finish ${ticketId} — its branch \`${task.branch}\` is shared by ${nonDone.length} sibling ticket(s) that are NOT Done: ` +
            `${nonDone.map((t) => `${t.id} (${t.status})`).join(', ')}. Merging would advance them all to Done as a one-way door. ` +
            `Either finish/close those siblings first, merge via the PR ticket, or re-run finish with force:true if you intend to land the whole shared PR. ` +
            `(If this is a blocking call, raise it via Require Input — don't leave it only in chat — FLUX-570.)`,
            'invalid_state'
          );
        }
      }

      // Merge-lock runtime assertion (FLUX-1264, defense-in-depth on top of the schema-level
      // guarantee that `merge` isn't a configurable gate value — see `hasHumanGateTouch` in
      // `models/gate-policy.ts`). `finish_ticket` is the one merge path an agent session can reach
      // on its own initiative — without this, one session could implement, move to Ready with its
      // own completion comment, then immediately finish, merging with no human ever involved.
      // Deliberately runs for `kind:'pr'` tickets too (see `hasHumanGateTouch`'s doc comment) — a PR
      // deck card's own `finish_ticket` is itself a merge path and needs the same proof. FLUX-1271
      // hardened the signal itself: `add_note`'s freeform `user` can no longer satisfy this check
      // (see `SELF_ATTESTED_AUTHOR_FIELD`) — that residual gap is documented there, not here.
      // FLUX-1290: gated behind `blockAgentPrMerges` (default `false`) — a user who explicitly wants
      // agent-driven merges (e.g. a requested batch merge sweep) can leave the default alone and skip
      // this check entirely; flipping it `true` restores today's exact always-on refusal.
      if (configCache.blockAgentPrMerges && task.branch && !hasHumanGateTouch(task.history)) {
        return errorResult(
          `Cannot finish ${ticketId} — merge-lock: no human-authored comment or status change found in its history yet. ` +
          `A human must interact with this ticket (comment, review, or move its status) before its PR can be merged — this is a structural "merge is always human" guarantee, not a preference. ` +
          `Ask a human to review ${ticketId} (or leave a comment on it), then finish again.`,
          'invalid_state'
        );
      }

      let finalLink = implementationLink;

      // If ticket has a branch, merge the existing PR
      if (task.branch) {
        const ghAvailable = await checkGhAuth();
        if (!ghAvailable) {
          // Can't merge without gh — bounce back to In Progress
          const failEntries = [{ type: 'comment', user: 'Agent', comment: `⚠️ Finish aborted — gh not configured. Merge the PR manually, then finish again.`, date: new Date().toISOString() }];
          await updateTaskWithHistory(ticketId, { entries: failEntries, updatedBy: 'Agent', nextStatus: 'In Progress', extraFields: { reviewState: null } });
          broadcastEvent('taskUpdated', { id: ticketId });
          return errorResult(`Cannot finish ${ticketId} — gh not configured. Ticket moved back to In Progress.`, 'invalid_state');
        }

        // Ensure an OPEN PR exists before merging (FLUX-578 + FLUX-741). finish must be
        // self-sufficient: the PR is normally opened at the Ready transition, but if that didn't
        // happen (work committed only now) we open it here. CRITICALLY, a branch whose prior PR is
        // already MERGED/CLOSED (a commit pushed after that PR merged — FLUX-656) must NOT fall
        // through to `gh pr merge` on the dead PR (which throws "already merged" and strands the
        // commit) — planFinishPr opens a FRESH PR for it instead. A branch with 0 commits ahead
        // can't get a PR → route to Require Input (FLUX-570: don't leave a blocker only in chat) —
        // UNLESS it's a deliberately-folded ticket (FLUX-944): implementationLink already points
        // at a MERGED sibling PR, so there's genuinely nothing to open/merge on this branch.
        let folded = false;
        try {
          const prBody = `${task.body ? task.body.slice(0, 800) : ''}\n\n---\nTicket: ${ticketId}`;
          const plan = await planFinishPr(task.branch, task.title || ticketId, prBody, {}, implementationLink);
          if (plan.action === 'blocked') {
            const msg = `Cannot finish ${ticketId} — ${plan.reason} Commit your work, or if this ticket's deliverable was folded into another ticket's PR, pass that (merged) PR's URL as implementationLink so finish can auto-detect the fold.`;
            await updateTaskWithHistory(ticketId, {
              entries: [{ type: 'comment', user: 'Agent', comment: `⚠️ ${msg}`, date: new Date().toISOString() }],
              updatedBy: 'Agent',
              nextStatus: configCache.requireInputStatus || 'Require Input',
              extraFields: { swimlane: 'require-input' },
            });
            broadcastEvent('taskUpdated', { id: ticketId });
            return errorResult(`${msg} Ticket moved to Require Input.`, 'invalid_state');
          }
          if (plan.action === 'created' && plan.url) finalLink = plan.url;
          if (plan.action === 'folded') {
            folded = true;
            if (plan.url) finalLink = plan.url;
          }
        } catch (createErr: unknown) {
          await updateTaskWithHistory(ticketId, { entries: [{ type: 'comment', user: 'Agent', comment: `⚠️ Finish aborted — could not open a PR: ${errMessage(createErr)}.`, date: new Date().toISOString() }], updatedBy: 'Agent', nextStatus: 'In Progress', extraFields: { reviewState: null } });
          broadcastEvent('taskUpdated', { id: ticketId });
          return errorResult(`Cannot finish ${ticketId} — PR creation failed: ${errMessage(createErr)}. Ticket moved back to In Progress.`);
        }

        // Folded ticket: its branch is empty on purpose (work already landed via the sibling PR
        // in finalLink) — there's no PR of its own to merge. Skip straight to the Done write-up;
        // the branch/worktree still get torn down by the post-merge cleanup below.
        if (!folded) {
          try {
            await mergePullRequest(task.branch);
            if (!finalLink || !finalLink.startsWith('http')) {
              finalLink = task.implementationLink || implementationLink;
            }
          } catch (mergeErr: unknown) {
            // Merge failed — bounce back to In Progress with explanation. FLUX-986's guided-rebase CTA
            // lives on the kind:'pr' deck card (PrDeckCard.tsx) only — finish_ticket runs on a regular
            // ticket the agent itself is driving, so there's no portal CTA for it to surface here.
            const failEntries = [{ type: 'comment', user: 'Agent', comment: `⚠️ PR merge failed: ${errMessage(mergeErr)}. Fix the issue and try again.`, date: new Date().toISOString() }];
            await updateTaskWithHistory(ticketId, { entries: failEntries, updatedBy: 'Agent', nextStatus: 'In Progress', extraFields: { reviewState: null } });
            broadcastEvent('taskUpdated', { id: ticketId });
            return errorResult(`Cannot finish ${ticketId} — PR merge failed: ${errMessage(mergeErr)}. Ticket moved back to In Progress.`);
          }
        }
      }

      // FLUX-1147: attach the structured completion payload (if any) to the same completion comment
      // entry — covers the branchless-ticket case where Ready (and its own completion param) is
      // skipped entirely.
      // `completionComment: true` tags this as the canonical completion summary so release-index
      // gist derivation (deriveGist, release.ts) targets it instead of a later unrelated comment
      // that may land while the ticket sits in Done (FLUX-1205).
      const entries = [{ type: 'comment', user: 'Agent', comment: completionComment, completionComment: true, date: new Date().toISOString(), ...(sanitizedCompletion !== undefined ? { completion: sanitizedCompletion } : {}) }];
      // Clear any swimlane (e.g. open-pr) as we move to Done — finish used to leave it set,
      // so merged tickets kept glowing as open PRs forever (FLUX-574).
      const finishExtraFields: FinishExtraFields = { implementationLink: finalLink, swimlane: null };

      // Capture diff summary + sidecar file. Best-effort — failure here must not block finish.
      try {
        // Lazy repair: if baselineCommit is missing at finish (ticket never went through the
        // launch hook), anchor it at HEAD's parent. By finish time the ticket's commit is
        // already HEAD, so stamping HEAD would yield an empty HEAD..HEAD range — the parent
        // gives the plan's intended HEAD~1..HEAD fallback. If the parent is unavailable (root
        // commit) leave it null and let captureDiff handle it.
        if (!task.branch && !task.baselineCommit) {
          const parent = await resolveCommit('HEAD~1');
          if (parent) {
            await updateTaskWithHistory(ticketId, {
              updatedBy: 'Agent',
              extraFields: { baselineCommit: parent },
            });
            task.baselineCommit = parent;
          }
        }

        const diff = await captureDiff(task.branch ?? null, task.baselineCommit ?? null);
        if (diff && diff.summary.length > 0) {
          finishExtraFields.diffSummary = diff.summary;
          const diffPath = path.join(getActiveFluxDir(), `${ticketId}.diff`);
          await fs.writeFile(diffPath, diff.fullDiff, 'utf-8');
        }
      } catch (err: unknown) {
        console.error(`Diff capture failed for ${ticketId}:`, errMessage(err));
      }

      const result = await updateTaskWithHistory(ticketId, {
        entries,
        updatedBy: 'Agent',
        nextStatus: 'Done',
        extraFields: finishExtraFields,
      });

      if (!result) return errorResult(`Failed to finish ${ticketId}`);

      // FLUX-721: now that the ticket is Done, reap any sessions still parked on an earlier phase
      // so they don't linger as start-blocking zombies. Preserves the persistent 'chat' session.
      const reapedOnFinish = reapStaleParkedSessions(ticketId, 'ticket finished → Done');
      if (reapedOnFinish.length > 0) {
        await updateTaskWithHistory(ticketId, {
          updatedBy: 'Agent',
          entries: [{ type: 'activity', user: 'Agent', comment: `Reaped ${reapedOnFinish.length} stale parked session${reapedOnFinish.length > 1 ? 's' : ''} from an earlier phase on finish.`, date: new Date().toISOString() }],
        });
      }

      // Post-merge cleanup — the SAME unified path as POST /:id/pr/merge (FLUX-574): for a
      // branch ticket, `cleanupMergedBranch` tears down the worktree (by branch, so shared
      // worktrees resolve correctly), switches the main tree off the branch if needed, then
      // force-deletes the branch and fast-forwards master — in the correct order, so the
      // branch-delete no longer fails after the merge already landed. It skips re-advancing
      // this already-Done ticket. A dirty worktree is kept + flagged (never stashed to
      // master post-merge). Best-effort — a failure here must not undo the finish.
      if (task.branch) {
        try {
          await cleanupMergedBranch(workspaceRoot!, task.branch);
        } catch (cleanupErr: unknown) {
          console.error(`Post-merge cleanup failed for ${ticketId}:`, errMessage(cleanupErr));
        }
      }

      broadcastEvent('taskUpdated', { id: ticketId });
      return textResult(`${ticketId} finished → Done (link: ${finalLink})`);
    },
  );

  // ─── Branch Tools ──────────────────────────────────────────────────────────

  server.tool(
    'branch',
    'Manage the git branch for a ticket. action: "create" makes a feature branch (and a dedicated worktree by default) and stores it on the ticket; "status" reports name + existence + ahead/behind counts; "delete" removes the branch (refuses unmerged unless force=true). baseBranch/worktree apply only to "create"; force applies only to "delete".',
    {
      ticketId: z.string().describe('Ticket ID'),
      action: z.enum(['create', 'status', 'delete']).describe('Which branch operation to run.'),
      baseBranch: z.string().optional().describe('create only — base branch (default: master).'),
      worktree: z.boolean().optional().describe('create only — create a dedicated git worktree. Agent branch sessions are worktree-isolated BY DEFAULT so parallel ticket sessions never share a checkout; pass false to run in the shared main tree (single-checkout / human-manual escape). Implies a branch.'),
      force: z.boolean().optional().describe('delete only — force delete even if unmerged (default: false). Invalid for other actions.'),
    },
    async ({ ticketId, action, baseBranch, worktree, force }) => {
      const task = tasksCache[ticketId];
      if (!task) return errorResult(`Ticket ${ticketId} not found`, 'not_found');

      // `force` is only meaningful for delete — reject it on create/status so a misuse is loud.
      if (force !== undefined && action !== 'delete') {
        return errorResult(`force is only valid for action "delete" (got action "${action}").`, 'validation_failed');
      }

      if (action === 'create') {
        if (task.branch) return errorResult(`Ticket ${ticketId} already has branch: ${task.branch}`, 'invalid_state');
        try {
          // Optionally create a dedicated worktree (worktree ⇒ branch). Agent branch sessions are
          // worktree-isolated BY DEFAULT — two parallel ticket sessions must never share one
          // checkout. The explicit `worktree` param is the per-call escape (false → shared main
          // tree). The branch+worktree mechanism is centralized in ensureTicketIsolation; this tool
          // only resolves the agent POLICY (worktree-by-default) and delegates.
          const result = await ensureTicketIsolation(ticketId, { worktree: worktree ?? true, baseBranch });
          return jsonResult({
            ...result,
            nextSteps: `Branch ready. Next: implement on it and commit, then change_status to Ready to open the PR (finish_ticket merges it).`,
          });
        } catch (err: unknown) {
          return errorResult(`Failed to create branch: ${errMessage(err)}`);
        }
      }

      if (action === 'status') {
        const name: string | undefined = task.branch;
        if (!name) return jsonResult({ name: null, exists: false, aheadCount: 0, behindCount: 0 });
        try {
          const status = await getTicketBranchStatus(name);
          return jsonResult({ name, ...status });
        } catch (err: unknown) {
          return errorResult(`Failed to get branch status: ${errMessage(err)}`);
        }
      }

      // action === 'delete'
      const name: string | undefined = task.branch;
      if (!name) return errorResult(`Ticket ${ticketId} has no associated branch`, 'not_found');
      try {
        // A branch can't be deleted while a worktree holds it checked out — stop the session
        // (release the cwd lock) and detach. This is an ABANDON, so uncommitted work is preserved
        // as a stash ref but NOT applied onto master.
        const wtPath = taskWorktreeDir(workspaceRoot!, ticketId);
        if (existsSync(wtPath)) {
          stopAllSessionsForTask(ticketId, 'Deleting branch — detaching worktree');
          await detachTaskWorktree(workspaceRoot!, wtPath, { ticketId, applyToMain: false });
        }
        await deleteTicketBranch(name, force ?? false);
        await updateTaskWithHistory(ticketId, { updatedBy: 'Agent', extraFields: { branch: null } });
        broadcastEvent('taskUpdated', { id: ticketId });
        return textResult(`Branch ${name} deleted`);
      } catch (err: unknown) {
        return errorResult(`Failed to delete branch: ${errMessage(err)}`);
      }
    },
  );

  // ─── Delegation Tools (Supervisor Pattern) ──────────────────────────────────
  // These tools allow a supervisor lead agent to dynamically spawn child agents
  // and receive their results. The MCP server calls the engine's long-poll
  // delegation endpoint; the response blocks until the child finishes.

  const ENGINE_URL = process.env.EVENT_HORIZON_ENGINE_URL || 'http://localhost:3067';

  server.tool(
    'list_available_agents',
    'List available agent personas that can be delegated to. Returns id, label, description, role (lead/worker/flex), and phases for each.',
    {
      phase: z.string().optional().describe('Filter by phase (grooming, implementation, review, finalize). Omit to see all.'),
    },
    { title: 'List available agents', readOnlyHint: true, openWorldHint: false },
    async ({ phase }) => {
      try {
        const url = phase
          ? `${ENGINE_URL}/api/orchestration/personas?phase=${encodeURIComponent(phase)}`
          : `${ENGINE_URL}/api/orchestration/personas`;
        const res = await fetch(url);
        if (!res.ok) return errorResult('Failed to fetch agent roster', 'channel_unavailable');
        const data: unknown = await res.json();
        const personas = Array.isArray(data) ? data : (data as { personas?: unknown } | null)?.personas;
        const list: OrchestrationPersonaMeta[] = Array.isArray(personas) ? (personas as OrchestrationPersonaMeta[]) : [];
        const summary = list.map((p) => ({
          id: p.id,
          label: p.label,
          description: p.description,
          role: p.role,
          phases: p.phases,
        }));
        // AXI #5 definitive empty state (FLUX-878): distinguish "no personas for
        // this phase" from a roster fetch that returned nothing unexpectedly.
        if (summary.length === 0) {
          return jsonResult({
            agents: [],
            note: phase
              ? `No agent personas available for phase=${phase}.`
              : 'No agent personas are configured.',
          });
        }
        return jsonResult(summary);
      } catch (err: unknown) {
        return errorResult(`Failed to list agents: ${errMessage(err)}`, 'channel_unavailable');
      }
    },
  );

  server.tool(
    'delegate',
    'Delegate one or more tasks to specialist agents and wait for them to finish. One delegation runs serially; multiple run in parallel (Promise.allSettled). Always returns a JSON array, one entry per delegation: { persona, succeeded, status, output }. Use when specialist knowledge produces better results than doing the work yourself.',
    {
      ticketId: z.string().describe('Ticket ID the delegations are for'),
      delegations: z.array(z.object({
        personaId: z.string().describe('Agent persona ID (from list_available_agents)'),
        task: z.string().describe('What this delegate should do — be specific about files, scope, and expected output format.'),
        effort: z.string().optional().describe('Effort level: low, medium, high (default: medium).'),
        model: z.string().optional().describe('Optional model override for this delegate.'),
      })).min(1).describe('One or more delegation specs. Length 1 = serial; >1 = parallel.'),
      timeout: z.number().optional().describe('Timeout in seconds for ALL delegations (default: 300, max: 600).'),
    },
    async ({ ticketId, delegations, timeout }) => {
      const timeoutMs = timeout ? Math.min(timeout * 1000, 600_000) : 300_000;
      const results = await Promise.allSettled(
        delegations.map(async (d): Promise<DelegationResult> => {
          const framework = process.env.EVENT_HORIZON_FRAMEWORK || resolveDefaultFramework();
          const res = await fetch(`${ENGINE_URL}/api/tasks/${ticketId}/cli-session/delegate`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              framework,
              personaId: d.personaId,
              task: d.task,
              effortOverride: d.effort || '',
              // FLUX-482: per-call model override (highest precedence); route resolves the
              // persona/config/status-derived fallback when omitted.
              ...(d.model ? { model: d.model } : {}),
              skipPermissions: true,
              timeout: timeoutMs,
            }),
          });
          if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            throw new Error(err.error || res.statusText);
          }
          return res.json() as Promise<DelegationResult>;
        })
      );

      const output = results.map((r, i) => {
        const persona = delegations[i]!.personaId;
        if (r.status === 'fulfilled') {
          const v = r.value;
          return { persona, succeeded: v.succeeded, status: v.status, output: v.output || '(no output)' };
        }
        const reason = (r as PromiseRejectedResult).reason;
        return { persona, succeeded: false, status: 'error', output: reason?.message || 'unknown error' };
      });
      return jsonResult(output);
    },
  );

  server.tool(
    'start_session',
    'Start an agent work session ON a ticket and return IMMEDIATELY (fire-and-forget). Use this to DISPATCH work: when the user asks to groom/implement/review/finalize a ticket, start the phase session on that ticket instead of doing the work yourself. The session runs in the ticket\'s own scope; the user opens that ticket\'s chat to drive it. Unlike delegate, this does NOT wait for the session to finish.',
    {
      ticketId: z.string().describe('Ticket ID to start the session on'),
      phase: z.enum(['grooming', 'implementation', 'review', 'finalize']).optional().describe('Work phase — drives the session mission. If omitted, the engine derives it from the ticket status.'),
      personaId: z.string().optional().describe('Optional persona to lead the session (from list_available_agents). Default: the phase\'s solo lead.'),
      effort: z.string().optional().describe('Effort level: low, medium, high, xhigh.'),
      worktree: z.boolean().optional().describe('Isolate the session in a dedicated git worktree. Defaults to TRUE: agent dispatch is unattended and often concurrent, so it must never share a checkout with another session. NOTE (FLUX-1018): a branch-bearing agent session is ALWAYS worktree-isolated at spawn — `worktree:false` only skips creating the worktree up front; the spawn still creates one (a branch on the shared main checkout let a single-shot agent commit to master). To run in the shared main tree, start the session branchless instead of passing worktree:false. NOTE (FLUX-1214): ignored entirely for phase:"grooming" — grooming never writes code or opens a PR, so it always runs branchless in the shared checkout regardless of this flag.'),
    },
    async ({ ticketId, phase, personaId, effort, worktree }) => {
      try {
        const framework = process.env.EVENT_HORIZON_FRAMEWORK || resolveDefaultFramework();
        // FLUX-845: isolate by default — the engine creates the branch+worktree before spawning.
        const body: Record<string, unknown> = {
          framework,
          skipPermissions: true,
          patternPosition: 'standalone',
          isolation: worktree === false ? 'branch' : 'worktree',
        };
        if (phase) body.phase = phase;
        if (personaId) body.personaId = personaId;
        if (effort) body.effortOverride = effort;
        const res = await fetch(`${ENGINE_URL}/api/tasks/${ticketId}/cli-session/start`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          return errorResult(`Failed to start session on ${ticketId}: ${err.error || res.statusText}`, 'channel_unavailable');
        }
        const result = await res.json();
        const sid = result.session?.id || 'unknown';
        return textResult(`Started a ${phase || 'phase'} session on ${ticketId} (session ${sid}). It is running in the ticket's own scope — open ${ticketId}'s chat to drive it.`);
      } catch (err: unknown) {
        return errorResult(`Failed to start session: ${errMessage(err)}`, 'channel_unavailable');
      }
    },
  );

  // ── The Furnace (FLUX-1008 → FLUX-1053 batches) ─────────────────────────────
  // Read + live-mutate first-class Furnace batches. A batch burns its tickets (implement → review →
  // re-implement ≤ retryCap → leave the PR open at Ready) and NEVER merges. Two kinds:
  //   sequential — tickets share ONE branch + ONE PR on one worktree, burning in order (burnRate 1);
  //   parallel   — each ticket its own worktree + PR, at burnRate (1–4) concurrency.
  server.tool(
    'furnace_get',
    'Read Furnace batch(es). Pass `batchId` for one batch (its tickets + config + PRs + burn report); omit it to list every batch (optionally filter by `status`). A batch is a named bucket of tickets the Furnace burns unattended — implement → review → re-implement ≤ retryCap → leave the PR open at Ready — never merging. Also returns live worktree-slot usage.',
    {
      batchId: z.string().optional().describe('A specific batch id; omit to list all batches.'),
      status: z.enum(['draft', 'burning', 'done', 'parked']).optional().describe('When listing, only batches in this status.'),
    },
    async ({ batchId, status }) => {
      try {
        await ensureFurnaceLoaded();
        // FLUX-1066/1067: reconcile against ground truth on read so the orchestrator sees any ticket
        // completed / taken over outside the Furnace, and the slot count matches the real worktree pool.
        // FLUX-1145: TTL-gated + single-flighted, same as the GET /api/furnace route — a full per-batch
        // reconcile on every read measured 1.1s avg / 3.4s worst-case.
        await refreshWorktreePool();
        if (batchId) {
          if (!getFurnaceBatch(batchId)) return errorResult(`Furnace batch ${batchId} not found.`, 'not_found');
          await reconcileBatchCached(batchId);
          const batch = getFurnaceBatch(batchId);
          if (!batch) return errorResult(`Furnace batch ${batchId} not found.`, 'not_found');
          return jsonResult(batch);
        }
        await reconcileAllBatchesCached();
        let batches = getFurnaceBatchesCache();
        if (status) batches = batches.filter((b) => b.status === status);
        return jsonResult({ batches, slots: { used: globalSlotsInUse(), free: freeSlots(), max: FURNACE_SLOT_CAP } });
      } catch (err: unknown) {
        return errorResult(`Failed to read furnace batch(es): ${errMessage(err)}`);
      }
    },
  );

  server.tool(
    'furnace_update',
    'Live-adjust a Furnace batch — title, burn rate (parallel concurrency, 1–4), kind, retry cap, circuit breaker, auto-trigger. Changes are picked up on the next stoke tick. A title rename while burning updates the display name only — the branch is NOT renamed. `kind`/`branch` are only changeable while the batch is a draft. Does NOT ignite or stop — dedicated tools handle those.',
    {
      batchId: z.string().describe('The batch to update.'),
      title: z.string().optional().describe('Display name. Safe to change while burning (branch unchanged).'),
      kind: z.enum(['sequential', 'parallel']).optional().describe('sequential = shared branch/PR, ordered; parallel = per-ticket branch/PR. Only changeable while draft.'),
      burnRate: z.number().int().positive().optional().describe('Parallel concurrency, 1–4 (clamped). Ignored for sequential (forced to 1).'),
      retryCap: z.number().int().min(0).optional().describe('Re-implementation attempts before parking a ticket (default 2).'),
      maxConsecutiveFailures: z.number().int().positive().optional().describe('Circuit breaker: halt the batch after N consecutive parks/failures.'),
      rateLimitRetryIntervalMs: z.number().int().positive().optional().describe('FLUX-1063: how often (ms) a rate-limited (cooling-down) ticket auto-retries. Default 20m.'),
      rateLimitMaxWaitMs: z.number().int().positive().optional().describe('FLUX-1063: max time (ms) a ticket may cool down after a rate limit before failing outright. Default 5h.'),
      trigger: z.object({
        type: z.enum(['batch', 'pr']).describe('Auto-ignite after a batch or a PR is merged.'),
        ref: z.string().describe('A batch id (type "batch") or a PR url/#number (type "pr").'),
      }).nullable().optional().describe('Auto-ignite this batch once the referenced batch/PR is merged. Pass null to clear.'),
    },
    async ({ batchId, title, kind, burnRate, retryCap, maxConsecutiveFailures, rateLimitRetryIntervalMs, rateLimitMaxWaitMs, trigger }) => {
      try {
        await ensureFurnaceLoaded();
        const existing = getFurnaceBatch(batchId);
        if (!existing) return errorResult(`Furnace batch ${batchId} not found.`, 'not_found');
        if (trigger) {
          const err = validateBatchTrigger(batchId, trigger as BatchTrigger, getFurnaceBatchesCache());
          if (err) return errorResult(err, 'validation_failed');
        }
        const updated = await updateFurnaceBatch(batchId, {
          ...(title !== undefined ? { title } : {}),
          ...(kind !== undefined ? { kind: kind as BatchKind } : {}),
          ...(burnRate !== undefined ? { burnRate } : {}),
          ...(retryCap !== undefined ? { retryCap } : {}),
          ...(maxConsecutiveFailures !== undefined ? { maxConsecutiveFailures } : {}),
          ...(rateLimitRetryIntervalMs !== undefined ? { rateLimitRetryIntervalMs } : {}),
          ...(rateLimitMaxWaitMs !== undefined ? { rateLimitMaxWaitMs } : {}),
          ...(trigger !== undefined ? { trigger: (trigger as BatchTrigger | null) } : {}),
        });
        if (!updated) return errorResult(`Furnace batch ${batchId} not found.`, 'not_found');
        const warning = burnRateClampWarning(burnRate);
        return jsonResult(warning ? { batch: updated, warning } : updated);
      } catch (err: unknown) {
        return errorResult(`Failed to update furnace batch: ${errMessage(err)}`);
      }
    },
  );

  server.tool(
    'furnace_build',
    'Build a Furnace batch from the groomed backlog and create it as a `draft` you can edit and then ignite. Requires an explicit selector — `tag` (tickets carrying it, convention `burn-furnace`) or `tickets` (explicit ids) — a build with neither is refused; there is no way to pool the whole backlog. Deterministically reasons about independence (excludes parent/child pairs; flags — never blocks — likely file overlaps and orders them apart) and enforces the one-active-batch invariant (a ticket already queued in another non-terminal batch is excluded, not double-loaded). Returns the created batch plus what it excluded and why. Defaults to a `parallel` batch (each ticket its own worktree + PR); pass kind `sequential` for tickets that must stack onto one shared branch + PR in order. Edit with furnace_update / the Furnace drawer before igniting.',
    {
      tag: z.string().optional().describe('Only load tickets carrying this tag (a furnace opt-in hint). Required if `tickets` is omitted.'),
      tickets: z.array(z.string()).optional().describe('Explicit ticket ids to include — the other selector, usable instead of or alongside `tag`. Required if `tag` is omitted.'),
      statuses: z.array(z.string()).optional().describe('Statuses that count as groomed & ready (default ["Todo"]).'),
      limit: z.number().int().positive().optional().describe('Cap the batch to at most this many tickets.'),
      kind: z.enum(['sequential', 'parallel']).optional().describe('Batch kind (default parallel).'),
      burnRate: z.number().int().positive().optional().describe('Parallel concurrency, 1–4 (default 1). Ignored for sequential.'),
      title: z.string().optional().describe('Human label for the batch.'),
      adoptBranchFrom: z.string().optional().describe('FLUX-1270: reuse this ticket\'s existing branch as the new batch\'s shared branch instead of minting one — for pulling a same-branch-dependent follow-up + its parent out of a parallel batch into a standalone sequential batch. The named ticket must already have a `branch` with an OPEN PR on it (i.e. an existing `kind:"pr"` card for that branch with `prState:"OPEN"`); forces `kind` to `sequential` (refused if `kind:"parallel"` was explicitly passed).'),
      spawnedFrom: z.object({ batchId: z.string(), ticketId: z.string() }).optional().describe('Display-only provenance: stamp this batch as spun off from `batchId` (the origin batch) / `ticketId` (the parent ticket whose branch was adopted). Purely informational — rendered as a subtitle in the Furnace drawer; no lifecycle behavior reads it.'),
    },
    async ({ tag, tickets, statuses, limit, kind, burnRate, title, adoptBranchFrom, spawnedFrom }) => {
      try {
        if (!tag && !(tickets && tickets.length)) {
          return errorResult(
            'furnace_build requires an explicit selector — tag the tickets you want burnable (convention `burn-furnace`) or pass explicit ticket ids. There is no way to pool the entire backlog.',
            'validation_failed',
          );
        }
        // FLUX-1270: branch adoption — reuse an existing ticket's still-open-PR branch as the batch's
        // shared branch instead of minting a fresh one (see furnace.md's "spun off" section). Resolved
        // from already-loaded ticket cache data (no live `gh` call): a ticket's own branch + a sibling
        // `kind:'pr'` card on that branch with `prState:'OPEN'` is the same signal `prTicketsOnBranch`
        // already uses elsewhere (pr-tickets.ts).
        let resolvedKind = kind;
        let adoptedBranch: string | undefined;
        if (adoptBranchFrom) {
          if (kind && kind !== 'sequential') {
            return errorResult(
              `adoptBranchFrom requires a sequential batch (one shared branch/PR) — kind "${kind}" opens a separate branch per ticket, so there is nothing to adopt onto.`,
              'validation_failed',
            );
          }
          const anchor = tasksCache[adoptBranchFrom] as { branch?: string } | undefined;
          if (!anchor) return errorResult(`adoptBranchFrom ticket ${adoptBranchFrom} not found.`, 'not_found');
          const anchorBranch = anchor.branch;
          if (!anchorBranch) return errorResult(`adoptBranchFrom ticket ${adoptBranchFrom} has no branch to adopt.`, 'validation_failed');
          const hasOpenPr = prTicketsOnBranch(Object.values(tasksCache), anchorBranch).some((t) => t.prState === 'OPEN');
          if (!hasOpenPr) {
            return errorResult(
              `adoptBranchFrom ticket ${adoptBranchFrom}'s branch (${anchorBranch}) has no open PR to adopt — expected its PR to still be open.`,
              'invalid_state',
            );
          }
          resolvedKind = 'sequential';
          adoptedBranch = anchorBranch;
        }
        await ensureFurnaceLoaded();
        const candidates = Object.values(tasksCache).map(toBuildCandidate);
        // FLUX-1235: flag candidates with a live interactive session so the drawer surfaces them before
        // ignite (the Furnace can take over an idle session but 409s on a live one and parks mid-burn).
        const liveSessionTicketIds = new Set(
          candidates.map((c) => c.id).filter((id) => getLiveStandaloneSessionForTask(id)),
        );
        const proposal = buildBatchTickets(candidates, {
          ...(tag !== undefined ? { tag } : {}),
          ...(tickets !== undefined ? { tickets } : {}),
          ...(statuses !== undefined ? { statuses } : {}),
          ...(limit !== undefined ? { limit } : {}),
          activeBatches: getFurnaceBatchesCache(),
          liveSessionTicketIds,
        });
        if (proposal.tickets.length === 0) {
          return errorResult(
            proposal.notes[0] ?? `No eligible tickets found in ${(statuses ?? ['Todo']).join('/')}${tag ? ` tagged #${tag}` : ''}. Groom some tickets to Todo first.`,
            'invalid_state',
            { excluded: proposal.excluded, notes: proposal.notes },
          );
        }
        const batch = await createFurnaceBatch({
          title: title ?? 'Backlog batch',
          tickets: proposal.tickets,
          ...(resolvedKind !== undefined ? { kind: resolvedKind as BatchKind } : {}),
          ...(adoptedBranch ? { branch: adoptedBranch } : {}),
          ...(burnRate !== undefined ? { burnRate } : {}),
          ...(spawnedFrom ? { spawnedFrom } : {}),
          createdBy: 'furnace_build',
        });
        const notes = [...proposal.notes];
        if (adoptedBranch) notes.push(`Adopted ${adoptBranchFrom}'s existing branch \`${adoptedBranch}\` — no new branch/PR was created.`);
        const warn = burnRateClampWarning(burnRate);
        if (warn) notes.push(warn);
        return jsonResult({ batchId: batch.id, batch, excluded: proposal.excluded, notes });
      } catch (err: unknown) {
        return errorResult(`Failed to build furnace batch: ${errMessage(err)}`);
      }
    },
  );

  // FLUX-1085: `furnace_ignite`/`furnace_stop`/`furnace_resume`/`furnace_discard` folded into one
  // action-discriminated tool — same idiom as `branch` (create/status/delete). All four act on an
  // EXISTING batchId with near-identical signatures (`stop` alone takes reason/hard, mirroring
  // `branch`'s delete-only `force`), unlike `furnace_get`/`furnace_build`/`furnace_update` (read/create/
  // configure), whose per-action param sets are too heterogeneous to merge without hurting usability —
  // exactly the tradeoff the investigation ticket flagged, so those three stay separate tools.
  server.tool(
    'furnace_batch',
    'Transition an existing Furnace batch\'s lifecycle. action "ignite": draft→burning, claims a worktree slot (fails when the pool is full; a parallel batch clamps its burn rate to free slots), then the Stoker burns each ticket unattended (implement → review → re-implement ≤ retryCap → leave the PR open at Ready — NEVER merges). action "stop": halt it — graceful by default (stop feeding, let in-flight tickets finish, open PRs stay open), or pass `hard: true` for an immediate cutoff that kills in-flight sessions and parks them. action "resume": halted (`parked`) or finished (`done`) → `burning` — resets the circuit breaker, clears the stop request, re-queues tickets merely skipped by the halt, and claims a slot; parked/failed tickets are NOT auto-re-queued (retry those individually via furnace_ticket action:"retry"). action "discard": permanently delete a stale draft or old terminal batch — refuses a burning batch (stop it first). `reason`/`hard` apply only to "stop".',
    {
      action: z.enum(['ignite', 'stop', 'resume', 'discard']).describe('Which batch-lifecycle transition to apply.'),
      batchId: z.string().describe('The batch to transition.'),
      reason: z.string().optional().describe('stop only — why it is being stopped (recorded on the batch).'),
      hard: z.boolean().optional().describe('stop only — immediate cutoff: kill in-flight sessions instead of letting them drain.'),
    },
    async ({ action, batchId, reason, hard }) => {
      if ((reason !== undefined || hard !== undefined) && action !== 'stop') {
        return errorResult(`reason/hard are only valid for action "stop" (got action "${action}").`, 'validation_failed');
      }
      if (action === 'ignite') {
        try {
          const r = await igniteBatch(batchId);
          if (!r.ok) {
            if (r.error === 'no_slots') {
              return errorResult(
                `Cannot ignite ${batchId}: all ${r.max} worktree slots are in use (${r.used} used).${formatSlotHolders(r.holders)} Stop or wait for a batch to free a slot.`,
                'invalid_state',
                { holders: r.holders ?? [] },
              );
            }
            return errorResult(`Cannot ignite ${batchId}: ${r.error}`, 'invalid_state');
          }
          return jsonResult({ ignited: true, batch: r.batch });
        } catch (err: unknown) {
          return errorResult(`Failed to ignite furnace batch: ${errMessage(err)}`);
        }
      }
      if (action === 'stop') {
        try {
          const r = await stopBatch(batchId, reason || 'manual stop', hard ? { hard: true } : {});
          if (!r.ok) return errorResult(`Cannot stop ${batchId}: ${r.error}`, 'invalid_state');
          return jsonResult({ stopped: true, batch: r.batch });
        } catch (err: unknown) {
          return errorResult(`Failed to stop furnace batch: ${errMessage(err)}`);
        }
      }
      if (action === 'resume') {
        try {
          const r = await resumeBatch(batchId);
          if (!r.ok) {
            if (r.error === 'no_slots') {
              return errorResult(
                `Cannot resume ${batchId}: all ${r.max} worktree slots are in use (${r.used} used).${formatSlotHolders(r.holders)}`,
                'invalid_state',
                { holders: r.holders ?? [] },
              );
            }
            return errorResult(`Cannot resume ${batchId}: ${r.error}`, r.error === 'Furnace batch not found' ? 'not_found' : 'invalid_state');
          }
          return jsonResult({ resumed: true, batch: r.batch });
        } catch (err: unknown) {
          return errorResult(`Failed to resume furnace batch: ${errMessage(err)}`);
        }
      }
      // action === 'discard'
      try {
        await ensureFurnaceLoaded();
        const batch = getFurnaceBatch(batchId);
        if (!batch) return errorResult(`Furnace batch ${batchId} not found.`, 'not_found');
        if (isBatchActive(batch.status)) {
          return errorResult(`Cannot discard ${batchId}: batch is burning — stop it first (furnace_batch action:"stop").`, 'invalid_state');
        }
        const ok = await deleteFurnaceBatch(batchId);
        if (!ok) return errorResult(`Furnace batch ${batchId} not found.`, 'not_found');
        for (const t of batch.tickets) clearTakeoverTracking(t.ticketId); // FLUX-1094
        evictReconcileReadCache(batchId); // FLUX-1166
        return jsonResult({ discarded: true, batchId });
      } catch (err: unknown) {
        return errorResult(`Failed to discard furnace batch: ${errMessage(err)}`);
      }
    },
  );

  // FLUX-1085: `furnace_retry`/`furnace_dismiss`/`furnace_takeover`/`furnace_handback`/
  // `furnace_add_ticket`/`furnace_remove_ticket` folded into one action-discriminated tool. All six
  // share the exact same (batchId, ticketId) signature — the cleanest possible merge candidate, unlike
  // the batch-lifecycle group above (which still needed stop-only params).
  server.tool(
    'furnace_ticket',
    'Act on a single ticket inside a Furnace batch. action "retry": reset a parked/failed ticket to `queued` with a FRESH attempt budget and hand ownership back to the Furnace — re-burns next tick if the batch is burning (a halted/finished batch needs furnace_batch action:"resume" first). action "dismiss": clear the board Require-Input flag on a parked/failed ticket ("I\'ve got this") WITHOUT re-queuing — works on a done/terminal batch too. action "takeover": owner → human — the Furnace yields (stops the session it was driving, never reclaims the worktree); hand it back later with action "handback" (or "retry", which also re-queues it under the Furnace). action "handback": owner → furnace — re-queue a human-owned ticket with a fresh attempt budget, bypassing the pr-open/active-state guards; errors clearly if the ticket is not currently human-owned. action "add": append a ticket to a batch (draft or burning) without a full furnace_build rebuild — rejects a done batch, a ticket already in the batch or not in an allowed status, or one already queued in a different non-terminal batch. action "remove": remove a ticket from a batch — disallowed while it is actively burning (stop the batch first); a still-queued or terminal-state ticket can always be removed.',
    {
      action: z.enum(['retry', 'dismiss', 'takeover', 'handback', 'add', 'remove']).describe('Which per-ticket operation to run.'),
      batchId: z.string().describe('The batch containing the ticket.'),
      ticketId: z.string().describe('The ticket to act on.'),
      allowedStatuses: z.array(z.string()).optional().describe('action:"add" only (ignored otherwise): board statuses the ticket is allowed to be in (default ["Todo"]). FLUX-1270: pass e.g. ["In Progress"] to pull a follow-up ticket that is mid-implementation (branch-adopting a same-branch-dependent parent) into a batch — normally only groomed Todo tickets may be added.'),
    },
    async ({ action, batchId, ticketId, allowedStatuses }) => {
      if (action === 'retry') {
        try {
          const r = await retryTicket(batchId, ticketId);
          if (!r.ok) return errorResult(`Cannot retry ${ticketId}: ${r.error}`, r.error === 'Furnace batch not found' || r.error === 'Ticket not in batch' ? 'not_found' : 'invalid_state');
          return jsonResult({ retried: true, batch: r.batch });
        } catch (err: unknown) {
          return errorResult(`Failed to retry ticket: ${errMessage(err)}`);
        }
      }
      if (action === 'dismiss') {
        try {
          const r = await dismissTicketFlag(batchId, ticketId);
          if (!r.ok) return errorResult(`Cannot dismiss ${ticketId}: ${r.error}`, r.error === 'Furnace batch not found' || r.error === 'Ticket not in batch' ? 'not_found' : 'invalid_state');
          return jsonResult({ dismissed: true, batch: r.batch });
        } catch (err: unknown) {
          return errorResult(`Failed to dismiss ticket flag: ${errMessage(err)}`);
        }
      }
      if (action === 'takeover') {
        try {
          const r = await takeoverTicket(batchId, ticketId);
          if (!r.ok) return errorResult(`Cannot take over ${ticketId}: ${r.error}`, r.error === 'Furnace batch not found' || r.error === 'Ticket not in batch' ? 'not_found' : 'invalid_state');
          return jsonResult({ takenOver: true, batch: r.batch });
        } catch (err: unknown) {
          return errorResult(`Failed to take over ticket: ${errMessage(err)}`);
        }
      }
      if (action === 'handback') {
        try {
          const r = await handBackTicket(batchId, ticketId);
          if (!r.ok) return errorResult(`Cannot hand back ${ticketId}: ${r.error}`, r.error === 'Furnace batch not found' || r.error === 'Ticket not in batch' ? 'not_found' : 'invalid_state');
          return jsonResult({ handedBack: true, batch: r.batch });
        } catch (err: unknown) {
          return errorResult(`Failed to hand back ticket: ${errMessage(err)}`);
        }
      }
      if (action === 'add') {
        try {
          await ensureFurnaceLoaded();
          const batch = getFurnaceBatch(batchId);
          if (!batch) return errorResult(`Furnace batch ${batchId} not found.`, 'not_found');
          if (batch.status === 'done') {
            return errorResult(`Cannot append to ${batchId}: it is a completed batch — create a new one.`, 'invalid_state');
          }
          if (batch.tickets.some((t) => t.ticketId === ticketId)) {
            return errorResult(`${ticketId} is already in batch ${batchId}.`, 'invalid_state');
          }
          const { rejected } = validateBatchTickets([ticketId], tasksCache, {
            activeBatches: getFurnaceBatchesCache(),
            excludeBatchId: batchId,
            ...(allowedStatuses !== undefined ? { allowedStatuses } : {}),
          });
          if (rejected[0]) {
            const r = rejected[0];
            const why = r.reason === 'unknown' ? 'unknown ticket id' : r.reason === 'bad-status' ? 'not in an allowed status' : `already queued in batch ${r.batchId} — remove it there first`;
            return errorResult(`Cannot add ${ticketId}: ${why}.`, 'validation_failed');
          }
          const maxOrder = batch.tickets.reduce((m, t) => Math.max(m, t.order), -1);
          const entry = newBatchTicket(ticketId, maxOrder + 1, tasksCache[ticketId]?.title);
          const updated = await mutateFurnaceBatch(batchId, (draft) => { draft.tickets.push(entry); });
          if (!updated) return errorResult(`Furnace batch ${batchId} not found.`, 'not_found');
          return jsonResult({ added: true, batch: updated });
        } catch (err: unknown) {
          return errorResult(`Failed to add ticket to furnace batch: ${errMessage(err)}`);
        }
      }
      // action === 'remove'
      try {
        await ensureFurnaceLoaded();
        const batch = getFurnaceBatch(batchId);
        if (!batch) return errorResult(`Furnace batch ${batchId} not found.`, 'not_found');
        const t = batch.tickets.find((x) => x.ticketId === ticketId);
        if (!t) return errorResult(`${ticketId} is not in batch ${batchId}.`, 'not_found');
        if (isBatchActive(batch.status) && !isTerminalTicketState(t.state) && t.state !== 'queued') {
          return errorResult(`Cannot remove ${ticketId}: it is burning — stop the batch first (furnace_batch action:"stop").`, 'invalid_state');
        }
        // FLUX-1095: `t.state` stays `queued` until the freshly-dispatched session is recorded, so the
        // `queued` exemption above would otherwise let a removal race a spawn already in flight and orphan
        // the session (no batch left to own it). Reject and let the caller retry — the window is brief.
        if (isDispatching(ticketId)) {
          return errorResult(`Cannot remove ${ticketId}: a session spawn is in flight for it — try again in a moment.`, 'invalid_state');
        }
        const updated = await mutateFurnaceBatch(batchId, (draft) => {
          draft.tickets = draft.tickets.filter((x) => x.ticketId !== ticketId);
        });
        if (!updated) return errorResult(`Furnace batch ${batchId} not found.`, 'not_found');
        clearTakeoverTracking(ticketId); // FLUX-1094: don't leak debounce state past batch membership
        return jsonResult({ removed: true, batch: updated });
      } catch (err: unknown) {
        return errorResult(`Failed to remove ticket from furnace batch: ${errMessage(err)}`);
      }
    },
  );

  server.tool(
    'get_board_state',
    'Live snapshot of board activity: which tickets have ACTIVE agent sessions right now and what each is doing, plus ticket counts by status. Use this to see the field before dispatching work or to check on running sessions.',
    {},
    { title: 'Get board state', readOnlyHint: true, openWorldHint: false },
    async () => {
      try {
        const res = await fetch(`${ENGINE_URL}/api/board/state`);
        if (!res.ok) return errorResult(`Failed to get board state: ${res.statusText}`, 'channel_unavailable');
        return jsonResult(await res.json());
      } catch (err: unknown) {
        return errorResult(`Failed to get board state: ${errMessage(err)}`, 'channel_unavailable');
      }
    },
  );

  // ─── MCP Resources + Resource Templates (FLUX-949) ──────────────────────────
  // Read-only, @-mentionable context surfaces so a client (Claude Code, Cursor,
  // raw SDK) can pull EH content into context WITHOUT spending a tool call. Each
  // resource reuses the matching tool's projection verbatim — no new data shape.
  // `registerResource` auto-enables the server's `resources` capability (the same
  // way `tool()` enables `tools`); works unchanged over both the stdio and the
  // in-process streamable-HTTP transports — no transport changes needed.
  //
  // Surfaces:
  //   board://config   (fixed)    → buildBoardConfigProjection() (== get_board_config)
  //   board://state    (fixed)    → GET /api/board/state         (== get_board_state)
  //   ticket://{id}    (template) → serializeTaskForAgent, _path stripped (== get_ticket)
  //   docs://{+path}   (template) → docsCache[normalizeDocPathInput(path)].body
  //
  // {+path} (RFC 6570 reserved expansion) is REQUIRED for the docs template: a
  // plain {path} compiles to `([^/,]+)` and stops at the first '/', so a
  // multi-segment URI like docs://event-horizon/reference/mcp-tools would never
  // bind. {+path} compiles to `(.+)`, capturing the whole path; normalizeDocPathInput
  // then rejects any `..`/absolute segment, so traversal stays impossible.

  /** Translate a failed pure-resolver result into a thrown MCP resource error. */
  const failResource = (code: ResourceErrorCode, message: string): never => {
    const rpcCode = code === 'channel_unavailable' ? McpErrorCode.InternalError : McpErrorCode.InvalidParams;
    throw new McpError(rpcCode, message, { code });
  };

  const resourceTerminalStatuses = () => ['Done', 'Released', configCache.archiveStatus || 'Archived'];

  // board://config — fixed. Same projection as the get_board_config tool.
  server.registerResource(
    'board-config',
    'board://config',
    {
      title: 'Board configuration',
      description: 'Statuses, projects, tags, priorities, users — the agent-facing board config (same shape as the get_board_config tool).',
      mimeType: 'application/json',
    },
    async (uri) => ({
      contents: [{ uri: uri.toString(), mimeType: 'application/json', text: JSON.stringify(buildBoardConfigProjection()) }],
    }),
  );

  // board://state — fixed. Live board activity via the engine HTTP API. Mirrors
  // the get_board_state tool, including its channel_unavailable failure mode when
  // the engine HTTP server is unreachable.
  server.registerResource(
    'board-state',
    'board://state',
    {
      title: 'Board state',
      description: 'Live snapshot of active agent sessions and ticket counts by status (same shape as the get_board_state tool).',
      mimeType: 'application/json',
    },
    async (uri) => {
      let res: Response;
      try {
        res = await fetch(`${ENGINE_URL}/api/board/state`);
      } catch (err: unknown) {
        return failResource('channel_unavailable', `Failed to get board state: ${errMessage(err)}`);
      }
      if (!res.ok) return failResource('channel_unavailable', `Failed to get board state: ${res.statusText}`);
      const text = await res.text();
      return { contents: [{ uri: uri.toString(), mimeType: 'application/json', text }] };
    },
  );

  // ticket://{id} — template. JSON identical to the get_ticket tool (default
  // projection, _path stripped). list enumerates active (non-terminal) tickets only.
  server.registerResource(
    'ticket',
    new ResourceTemplate('ticket://{id}', {
      list: async () => ({ resources: listActiveTicketResources(tasksCache, resourceTerminalStatuses()) }),
    }),
    {
      title: 'Ticket',
      description: 'A ticket by canonical id, e.g. ticket://FLUX-42 — JSON identical to the get_ticket tool. resources/list enumerates active (non-terminal) tickets only; a bare number (ticket://42) is rejected, an unknown id is not-found.',
      mimeType: 'application/json',
    },
    async (uri, variables) => {
      const resolved = resolveTicketResource(decodeResourceVar(variables.id), tasksCache);
      if (!resolved.ok) return failResource(resolved.code, resolved.message);
      const { _path, ...output } = serializeTaskForAgent(resolved.task as TaskRecord, undefined, {});
      return { contents: [{ uri: uri.toString(), mimeType: 'application/json', text: JSON.stringify(output) }] };
    },
  );

  // docs://{+path} — template. Repo `.docs/` markdown by path (docs://INDEX,
  // docs://event-horizon/reference/mcp-tools). Group docs use the group_doc tool.
  server.registerResource(
    'docs',
    new ResourceTemplate('docs://{+path}', {
      list: async () => ({ resources: listDocResources(docsCache) }),
    }),
    {
      title: 'Project doc',
      description: 'A .docs/ markdown file by path, e.g. docs://INDEX or docs://event-horizon/reference/mcp-tools. Repo docs only (group docs are read via the group_doc tool); a path with .. or any traversal segment is rejected, an unknown path is not-found.',
      mimeType: 'text/markdown',
    },
    async (uri, variables) => {
      const resolved = resolveDocResource(decodeResourceVar(variables.path), docsCache);
      if (!resolved.ok) return failResource(resolved.code, resolved.message);
      return { contents: [{ uri: uri.toString(), mimeType: 'text/markdown', text: resolved.body }] };
    },
  );

  // FLUX-659: the board-rebase ritual. The orchestrator emits a BATCH of proposed restructurings
  // for the human to approve in one pass; this parks the batch (engine-side) and broadcasts it —
  // it does NOT mutate. Fire-then-resolve: the tool returns immediately (unlike permission_prompt,
  // which blocks). "Propose, never silently restructure."
  server.tool(
    'propose_board_rebase',
    'Propose a BATCH of board restructurings for the human to approve in one pass — the board-rebase ritual. Use this when asked to triage / "rebase the board" or at end-of-session, INSTEAD of mutating the board directly. Each item is a single action the user approves or rejects; nothing is applied until they click Apply approved. NEVER call the restructuring verbs (extract_ticket / merge_tickets / archive / change_status) directly to reorganize the board — emit them here as proposals. Returns immediately; the proposal is parked for approval.',
    {
      items: z.array(z.object({
        kind: z.enum(['promote', 'fold', 'archive', 'dispatch', 'status', 'leave']).describe('promote = extract a chat/turns into a new card; fold = merge one stream into another; archive = retire the ticket(s); dispatch = start a phase session; status = move a ticket to a new status; leave = keep it in the orchestrator thread (the safe default — never drop an item, leave it).'),
        targets: z.array(z.string()).describe('Ticket id(s) the item acts on, e.g. ["FLUX-123"]. For fold, the source stream(s) being merged.'),
        summary: z.string().describe('One-line human-readable description of the proposed action.'),
        rationale: z.string().optional().describe('Why you propose this — shown under the summary and recorded as a comment when applied.'),
        newStatus: z.string().optional().describe('For kind "status": the target status.'),
        phase: z.string().optional().describe('For kind "dispatch": the phase (grooming / implementation / review / finalize).'),
        into: z.string().optional().describe('For kind "fold": the destination ticket the sources merge into.'),
        fromSeq: z.number().int().optional().describe('For kind "promote": inclusive start seq of the topic-slice on the source stream (targets[0], default __board__).'),
        toSeq: z.number().int().optional().describe('For kind "promote": inclusive end seq of the topic-slice on the source stream.'),
        title: z.string().optional().describe('For kind "promote": title for the new card the slice seeds (falls back to the summary).'),
      })).min(1).describe('The batch of proposed restructurings.'),
    },
    async ({ items }) => {
      try {
        const res = await fetch(`${ENGINE_URL}/api/board/board-rebase`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ items, conversationId: getBoundConversation().id }),
        });
        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          return errorResult(`Failed to surface board-rebase proposal: ${err.error || res.statusText}`, 'channel_unavailable');
        }
        const result = await res.json();
        return textResult(`Surfaced a board-rebase proposal with ${result.count} item(s) for the user to approve (batch ${result.id}). The proposal is PARKED — nothing has been applied. The user reviews each item and clicks "Apply approved" (or "Dismiss"). Do not call the restructuring verbs directly.`);
      } catch (err: unknown) {
        return errorResult(`Board-rebase channel unavailable: ${errMessage(err)}`, 'channel_unavailable');
      }
    },
  );

  server.tool(
    'permission_prompt',
    'Internal — a gated agent CLI calls this via its permission-prompt hook (e.g. Claude Code\'s --permission-prompt-tool) to decide if a tool call is permitted. Returns {behavior:"allow",updatedInput} or {behavior:"deny",message}. Reads auto-allow; destructive ops (change_status, finish_ticket, archive, branch with action:"delete", furnace_batch with action:"discard", group_doc with action:"delete", Bash) require human approval via the EH portal.',
    { tool_name: z.string(), input: z.any().optional() },
    { title: 'Permission decision', readOnlyHint: true, openWorldHint: false },
    async ({ tool_name, input }) => {
      const decision = permissionDecisionFor(tool_name, input);
      if (decision === 'allow') return jsonResult({ behavior: 'allow', updatedInput: input ?? {} });
      if (decision === 'deny') return jsonResult({ behavior: 'deny', message: `${tool_name} is not permitted.` });
      try {
        const res = await fetch(`${ENGINE_URL}/api/board/permission-request`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ tool_name, input, conversationId: getBoundConversation().id, conversationToken: getBoundConversation().token }),
        });
        if (!res.ok) return jsonResult({ behavior: 'deny', message: 'Approval channel error — denied.' });
        // Normalize at the CLI-contract boundary (FLUX-1026): Claude Code's permission-prompt-tool
        // requires {behavior:'allow', updatedInput:<record>} or {behavior:'deny', message:<string>}.
        // A human ALLOW is POSTed without updatedInput; forwarding it verbatim crashes the CLI with a
        // Zod invalid_union. This layer has the original `input`, so echo it — the human approved
        // running the tool as proposed — mirroring the auto-allow branch above.
        const decided = await res.json().catch(() => null) as PermissionDecisionResponse | null;
        if (decided?.behavior === 'allow')
          return jsonResult({ behavior: 'allow', updatedInput: decided.updatedInput ?? input ?? {} });
        if (decided?.behavior === 'deny')
          return jsonResult({ behavior: 'deny', message: typeof decided.message === 'string' ? decided.message : `${tool_name} was denied.` });
        return jsonResult({ behavior: 'deny', message: 'Malformed approval decision — denied.' });
      } catch (err: unknown) {
        return jsonResult({ behavior: 'deny', message: `Approval channel unavailable — denied (${errMessage(err)}).` });
      }
    },
  );

  // FLUX-662: structured question → portal picker → answer-in-the-same-turn. The working
  // substitute for the native AskUserQuestion (which can't be fulfilled in `claude -p` print
  // mode). Schema mirrors the native tool so agents reach for it the same way; the handler
  // POSTs to the engine and BLOCKS on the response, which is held open until the user answers
  // (or a 4-minute timeout returns an `unanswered` sentinel — kept under undici's 300s
  // headersTimeout so the held-open fetch doesn't abort before the park resolves).
  server.tool(
    'ask_user_question',
    'Ask the user a structured multiple-choice question and BLOCK until they answer. Renders an interactive picker in the EH chat/board surface (single- or multi-select, with an "Other" free-text option) and returns the user\'s selection so you can continue the same turn. Use this whenever you need a decision or to resolve ambiguity instead of guessing — never assume; ask. Returns { answers: { [question]: chosenLabel | chosenLabel[] }, notes? }. If the user does not answer in time you get an unanswered result and should proceed with your best judgment.',
    {
      questions: z.array(z.object({
        question: z.string().describe('The full question to ask the user.'),
        header: z.string().describe('A very short label/category for the question (a few words).'),
        options: z.array(z.object({
          label: z.string().describe('The option text shown to (and returned for) the user.'),
          description: z.string().optional().describe('Optional longer explanation of what this option means.'),
        })).min(1).describe('The choices the user can pick from.'),
        multiSelect: z.boolean().optional().describe('Allow the user to select multiple options (default false).'),
      })).min(1).describe('One or more questions to ask (usually one).'),
    },
    async ({ questions }) => {
      try {
        const res = await fetch(`${ENGINE_URL}/api/board/ask-question`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ questions, conversationId: getBoundConversation().id, conversationToken: getBoundConversation().token }),
        });
        if (!res.ok) return errorResult('Ask-question channel error — no answer received. Proceed with your best judgment or ask again.', 'channel_unavailable');
        const result = await res.json();
        if (result?.unanswered) {
          return textResult('The user did not answer in time. Proceed using your best judgment, or ask again if the answer is essential.');
        }
        return jsonResult({ answers: result.answers ?? {}, ...(result.notes ? { notes: result.notes } : {}) });
      } catch (err: unknown) {
        return errorResult(`Ask-question channel unavailable: ${errMessage(err)}. Proceed with your best judgment.`, 'channel_unavailable');
      }
    },
  );

  // ─── Group Docs Tools (FLUX-421 / FLUX-420) ─────────────────────────────────

  server.tool(
    'group_doc',
    'Read or write the shared group docs (the cross-project knowledge base). Works from any workspace — parent or bound member. action: "list" returns all docs by path+title; "read" returns one doc body (needs path); "submit" creates/updates a doc and fans it out to all members (needs path+title+body); "delete" removes a doc and fans out (needs path). submit/delete return per-member fan-out results.',
    {
      action: z.enum(['list', 'read', 'submit', 'delete']).describe('Which group-doc operation to run.'),
      path: z.string().optional().describe('read/delete: full doc path as returned by list (e.g. "Product/features/payments"). submit: store-relative path WITHOUT the group prefix and WITHOUT .md (e.g. "features/payments-api"); single safe segment, no ".." or absolute paths.'),
      title: z.string().optional().describe('submit only — document title (written as the first H1 heading).'),
      body: z.string().optional().describe('submit only — full markdown body (title heading prepended automatically).'),
      message: z.string().optional().describe('submit only — optional git commit message. Defaults to an auto-generated message.'),
    },
    async ({ action, path: docPath, title, body, message }) => {
      if (action === 'list') {
        const label = activeGroupDocsLabel();
        const docs = Object.values(docsCache)
          .filter((d) => d.group === true)
          .sort((a, b) => a.path.localeCompare(b.path))
          .map((d) => ({ path: d.path, title: d.title, directory: d.directory }));
        if (docs.length === 0) {
          const inGroup = getGroupContext() != null || getMemberBinding() != null;
          return jsonResult({
            docs: [],
            message: inGroup
              ? 'No group docs found — the shared store may be empty.'
              : `No group configured. This is a single-repo workspace. Group docs appear under the '${label}/' prefix once a group is set up.`,
          });
        }
        return jsonResult({ docs, label });
      }

      if (action === 'read') {
        if (!docPath) return errorResult('path is required for action "read".', 'validation_failed');
        const doc = docsCache[docPath];
        if (!doc || !doc.group) {
          return errorResult(`Group doc '${docPath}' not found. Use group_doc action:"list" to see available paths.`, 'not_found');
        }
        return jsonResult({ path: doc.path, title: doc.title, body: doc.body, directory: doc.directory });
      }

      // submit / delete both need a group writer.
      const writer = getGroupContext() ?? getMemberBinding()?.parentGroup ?? null;
      if (!writer) {
        return errorResult(
          'No group writer is available. This workspace is not a group parent and is not bound to one. Set up a multi-repo group first (see get_project_group).',
          'invalid_state',
        );
      }

      if (action === 'submit') {
        if (!docPath) return errorResult('path is required for action "submit".', 'validation_failed');
        if (title === undefined) return errorResult('title is required for action "submit".', 'validation_failed');
        if (body === undefined) return errorResult('body is required for action "submit".', 'validation_failed');
        // Prepend the H1 title so the doc is self-contained.
        const content = `# ${title}\n\n${body.replace(/^\s+/, '')}`;
        try {
          const result = await submitGroupEdit(
            writer,
            [{ path: docPath.endsWith('.md') ? docPath : `${docPath}.md`, content }],
            { message: message ?? `group: agent doc update (${docPath})` },
          );
          const fanOut = result.sync.members.map((m) => ({
            name: m.name, ok: m.ok,
            ...(m.diverged ? { diverged: true } : {}),
            ...(m.error ? { error: m.error } : {}),
          }));
          return jsonResult({
            applied: result.applied,
            committed: result.sync.committed,
            pushed: result.sync.pushed,
            failed: result.sync.failed,
            members: fanOut,
          });
        } catch (err: unknown) {
          return errorResult(`Failed to submit group doc: ${errMessage(err)}`);
        }
      }

      // action === 'delete'
      if (!docPath) return errorResult('path is required for action "delete".', 'validation_failed');
      const storeRel = groupDocPathToStoreRelative(docPath);
      if (!storeRel) {
        return errorResult(`'${docPath}' is not a valid group doc path. It must start with the group docs prefix (e.g. 'Product/…').`, 'validation_failed');
      }
      try {
        const result = await submitGroupEdit(writer, [{ path: storeRel, delete: true }]);
        const fanOut = result.sync.members.map((m) => ({
          name: m.name, ok: m.ok,
          ...(m.diverged ? { diverged: true } : {}),
          ...(m.error ? { error: m.error } : {}),
        }));
        return jsonResult({
          deleted: storeRel,
          committed: result.sync.committed,
          pushed: result.sync.pushed,
          failed: result.sync.failed,
          members: fanOut,
        });
      } catch (err: unknown) {
        return errorResult(`Failed to delete group doc: ${errMessage(err)}`);
      }
    },
  );

  return server;
}

// ─── Streamable-HTTP mount (FLUX-645) ────────────────────────────────────────
//
// The engine process serves the MCP server in-process over loopback HTTP at
// POST/GET/DELETE /mcp, so every Claude Code session — main checkout or an
// `.eh-worktrees/*` worktree — points at one URL and shares the engine's single
// task-store cache + chokidar watchers, with no per-session stdio process. Per-session
// transports are keyed by the `Mcp-Session-Id` header so concurrent sessions stay
// isolated. index.ts registers the routes BEFORE express.json so the raw JSON-RPC request
// stream reaches the transport unparsed.
const httpTransports = new Map<string, StreamableHTTPServerTransport>();

interface BoundConversationContext {
  id: string | null;
  token: string | null;
}

/**
 * FLUX-1213: the shared HTTP mount means `process.env` is the ENGINE's own process-global env,
 * not any particular calling session's — so `propose_board_rebase`/`permission_prompt`/
 * `ask_user_question` can no longer read `EH_CONVERSATION_ID`/`EH_CONVERSATION_TOKEN` from
 * `process.env` and expect to see the calling session's binding (that only ever worked for the
 * old one-process-per-session stdio model). `handleMcpHttpRequest` extracts the caller's claimed
 * identity from that request's own headers/query (set per-session at spawn time, see
 * buildSpawnMcpConfigArgs) and runs the request inside this AsyncLocalStorage context so the tool
 * handlers below can read it back at call time. The stdio `--mcp` path never enters that context
 * (it's genuinely one process per session), so `getBoundConversation` falls back to `process.env`
 * there — unchanged behavior.
 */
const boundConversationALS = new AsyncLocalStorage<BoundConversationContext>();

function getBoundConversation(): BoundConversationContext {
  return boundConversationALS.getStore() ?? {
    id: process.env.EH_CONVERSATION_ID || null,
    token: process.env.EH_CONVERSATION_TOKEN || null,
  };
}

/** Reads `x-eh-conversation-id`/`x-eh-conversation-token` off the request — header first (the
 *  primary channel, set via the per-session `--mcp-config` `headers` override), falling back to
 *  `?conversationId=&conversationToken=` query params in case a client's HTTP MCP transport
 *  doesn't forward custom headers. Absent both, the caller is unbound (not an error — e.g. a
 *  manual/unrouted MCP client — and drops to the same "unrouted" handling as today). */
function extractBoundConversationFromRequest(req: IncomingMessage): BoundConversationContext {
  const headerId = req.headers['x-eh-conversation-id'];
  const headerToken = req.headers['x-eh-conversation-token'];
  let id = Array.isArray(headerId) ? headerId[0] : headerId;
  let token = Array.isArray(headerToken) ? headerToken[0] : headerToken;
  if (!id) {
    try {
      const url = new URL(req.url ?? '', 'http://localhost');
      id = url.searchParams.get('conversationId') ?? undefined;
      token = url.searchParams.get('conversationToken') ?? undefined;
    } catch {
      // Malformed request URL — leave unbound rather than throwing out of the HTTP handler.
    }
  }
  return { id: id || null, token: token || null };
}

export async function handleMcpHttpRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const headerId = req.headers['mcp-session-id'];
  const sessionId = Array.isArray(headerId) ? headerId[0] : headerId;
  let transport = sessionId ? httpTransports.get(sessionId) : undefined;

  if (!transport) {
    // Only a POST may open a session — it must carry the `initialize` request. A GET/DELETE
    // (or a POST with an unknown session id) has no live transport to attach to.
    if (req.method !== 'POST') {
      res.statusCode = 400;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message: 'Bad Request: no valid MCP session' }, id: null }));
      return;
    }
    // New session: fresh server + transport. The transport assigns the session id on
    // `initialize` (and rejects a non-initialize first message itself), so we never pre-parse
    // the body — pre-parsing would also let express.json consume the stream (see index.ts).
    const newTransport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (sid) => { httpTransports.set(sid, newTransport); },
    });
    newTransport.onclose = () => {
      const sid = newTransport.sessionId;
      if (sid) httpTransports.delete(sid);
    };
    // Cast: StreamableHTTPServerTransport `implements Transport`, but its getter/setter `onclose`
    // is `(() => void) | undefined` which trips exactOptionalPropertyTypes against Transport's
    // optional `onclose?`. The instance genuinely is a Transport.
    await buildMcpServer().connect(newTransport as Transport);
    transport = newTransport;
  }

  // FLUX-1213: this session's own claimed identity travels on EVERY request (not just
  // `initialize`) — the actual tool call that reads it happens on a later POST reusing this same
  // transport, keyed by Mcp-Session-Id.
  const bound = extractBoundConversationFromRequest(req);
  await boundConversationALS.run(bound, () => transport!.handleRequest(req, res));
}

// NOTE (FLUX-705): no self-start-on-direct-invocation block here. This module is now
// statically imported by index.ts so the in-process HTTP MCP mount shares the engine's
// live task-store (in SEA it was previously loaded as a SECOND bundle with its own,
// never-activated task-store → "Received null" on write + a cache blind to new tickets).
// A `process.argv[1] === import.meta.url` guard would misfire once bundled into index.js.
// (FLUX-646: the stdio `--mcp` entry point that once started here was removed — HTTP is
// the only transport now.)
