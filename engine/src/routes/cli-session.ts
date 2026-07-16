import { getWorkspace } from '../workspace-context.js';
import express from 'express';
import { randomUUID } from 'crypto';
import { getWorkspaceRoot } from '../workspace.js';
import { getConfig } from '../config.js';

import {
  cliSessionsById,
  cliSessionIdByTaskId,
  registerSession,
  unregisterSession,
  getCliSessionSummaryForTask,
  getAllSessionSummariesForTask,
  getActiveSessionsForTask,
  getPreferredInputSessionId,
  getSessionGroup,
  checkPathConflicts,
  validatePatternSupport,
  registerPendingCombiner,
  unregisterPendingCombiner,
  setCombinerLauncher,
  registerPendingRelay,
  unregisterPendingRelay,
  setRelayStepLauncher,
  notifyGroupSessionTerminal,
  awaitDelegation,
  cancelDelegation,
  dispatchKey,
  findDispatch,
  reserveDispatch,
  type PendingCombinerSpec,
  type PendingRelaySpec,
} from '../session-store.js';
import { getAdapter, getBoardAdapter, resolveDefaultFramework, isKnownFramework, getRuntimeFrameworks } from '../agents/index.js';
import { BOARD_CONVERSATION_ID, FURNACE_CONVERSATION_ID, isVirtualConversationId } from '../agents/board.js';
import { resolveAttachmentAbsPaths, attachmentReadInstruction, appendErrorToSession, resolveModel } from '../agents/shared.js';
import type { ChatAttachment } from '../projection.js';
import { updateTaskWithHistory, subtaskIds } from '../task-store.js';
import { broadcastEvent } from '../events.js';
import { killProcessTree } from '../kill-process-tree.js';
import { appendTranscriptEvent, readTranscriptMessages, clearTranscript } from '../transcript.js';
import { resetBoardDigest } from '../board-digest.js';
import { dismissNotificationsForTicket } from '../notifications.js';
import { resolvePersonaPrompt, getPersonaById } from '../orchestration-personas.js';
import { ensureTicketIsolation } from '../ticket-isolation.js';
import { raiseNeedsAction, isDelegatedMember } from '../parked-ticket.js';
import { buildActivityEntry, buildAgentSessionEntry } from '../history.js';
import {
  captureDiffForPrompt,
  getMergeBase,
  isAncestor,
  resolveBaselineCommit,
  type PromptDiffCapture,
} from '../branch-manager.js';
import { TASK_KEYS, type CliSessionRecord, type CliFramework, type ExecutionPattern, type PatternPosition, type GroupVariant, type LaunchPhase, type TaskKey } from '../agents/types.js';

// ─── Local types (lint burndown, FLUX-1073) ──────────────────────────────────
// Ticket frontmatter has no canonical compile-time type in this codebase — it's validated at
// RUNTIME by schema.ts, and `tasksCache` itself is declared `Record<string, any>` in
// task-store.ts. This interface names only the fields THIS route file actually reads/writes off
// a task record; every other field still flows through via the index signature. Mirrors the
// TaskRecord pattern already established in routes/tasks.ts for the same ticket.
interface TaskRecord {
  id: string;
  branch?: string | null;
  baselineCommit?: string | null;
  [key: string]: unknown;
}

function errorMessage(err: unknown, fallback: string): string {
  return err instanceof Error && err.message ? err.message : fallback;
}

const router = express.Router();

// Launch phase / intent (portal tells engine why a session exists). Validated
// against this set wherever a caller supplies a raw `phase` string so an
// arbitrary value never lands on a session record or a persona-prompt lookup.
const VALID_LAUNCH_PHASES: LaunchPhase[] = ['grooming', 'implementation', 'review', 'finalize', 'chat', 'fast-path'];

/**
 * Resolve the default permission mode for a session surface (FLUX-605). The per-chat
 * Perms picker overrides this (`requested`); when it's absent ("Default") the session
 * inherits the workspace risk-tolerance setting (`config.permissions`). Falls back to
 * the built-in defaults — orchestrator gated, per-ticket skip — if unconfigured.
 */
function resolvePermissionMode(
  requested: 'gated' | 'skip' | undefined,
  surface: 'board' | 'ticket',
): 'gated' | 'skip' {
  if (requested === 'gated' || requested === 'skip') return requested;
  const configured = surface === 'board'
    ? getConfig()?.permissions?.boardDefault
    : getConfig()?.permissions?.ticketDefault;
  if (configured === 'gated' || configured === 'skip') return configured;
  return surface === 'board' ? 'gated' : 'skip';
}

/**
 * FLUX-1236: apply a mid-chat permission-chip change to a live session record so it takes
 * effect on the NEXT resumed turn (the flag is re-emitted per spawn via permissionArgs()).
 * - 'gated'/'skip' set the mode explicitly (and clear the legacy skipPermissions flag so the
 *   explicit mode is authoritative — permissionArgs() already prefers permissionMode, but a stale
 *   skipPermissions:true would otherwise linger on the record).
 * - 'default' (or '') RE-INHERITS the surface/workspace default via resolvePermissionMode
 *   (gated for board, skip for ticket, or the configured override) — it does NOT clear the mode.
 *   A cleared mode yields permissionArgs()===[], and in `claude -p` print mode there is no
 *   interactive approval path, so [] silently denies autonomous tool use — the very failure the
 *   chip is meant to let you escape. Resolving keeps "Default" predictable and identical to the
 *   mode a fresh session on this surface would get.
 * - Any absent/unknown value leaves the mode UNCHANGED, so an ordinary send never wipes it. The
 *   portal only transmits permissionMode when the user actually touches the Perms chip (FLUX-1236,
 *   ChatView Composer) — an untouched follow-up omits it entirely and lands here as undefined.
 */
function applyPermissionModeChange(
  session: CliSessionRecord,
  raw: unknown,
  surface: 'board' | 'ticket',
): void {
  if (raw === 'gated' || raw === 'skip') {
    session.permissionMode = raw;
    session.skipPermissions = false;
  } else if (raw === 'default' || raw === '') {
    session.permissionMode = resolvePermissionMode(undefined, surface);
    session.skipPermissions = false;
  }
}

/**
 * FLUX-674: parse the `attachments` field off a chat request into well-formed ChatAttachment
 * records (pasted-image refs from the composer). Only entries with string `url` + `path` are
 * kept; the absolute-path resolution + assets-root guard happen later in the claude adapter.
 */
function parseChatAttachments(raw: unknown): ChatAttachment[] {
  if (!Array.isArray(raw)) return [];
  const out: ChatAttachment[] = [];
  for (const a of raw) {
    const url = typeof a?.url === 'string' ? a.url : '';
    const p = typeof a?.path === 'string' ? a.path : '';
    if (!url || !p) continue;
    out.push({ url, path: p, fileName: typeof a?.fileName === 'string' ? a.fileName : 'image' });
  }
  return out;
}

/** FLUX-1434: parse an optional `enableTools` body param (dispatch.enableTools in the deny-list
 *  model) into a clean string array, or `undefined` if absent/empty. Best-effort — an unknown
 *  tool name is simply never matched by the deny-list filter (a no-op grant), so this never
 *  rejects the request; it only narrows the shape. */
function parseEnableTools(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const names = raw.filter((t): t is string => typeof t === 'string' && t.trim().length > 0).map((t) => t.trim());
  return names.length > 0 ? names : undefined;
}

function formatDiffBlock(capture: PromptDiffCapture): string {
  const lines = [
    '## Scoped Diff (auto-injected)',
    '',
    `The following diff represents the changes under review (${capture.range}):`,
    '',
    '```diff',
    capture.diff,
    '```',
  ];
  if (capture.truncated) {
    lines.push('', `Note: Diff truncated at 80KB. Run \`git diff ${capture.range}\` for the full output.`);
  }
  return lines.join('\n');
}

async function computeDiffBlockForTask(task: TaskRecord): Promise<string | undefined> {
  const branch = task.branch || null;
  const baseline = task.baselineCommit || null;
  const capture = await captureDiffForPrompt(branch, baseline);
  if (!capture || !capture.diff.trim()) return undefined;
  return formatDiffBlock(capture);
}

interface SpawnOptions {
  framework: CliFramework;
  appendPrompt: string;
  effortOverride: string;
  model?: string;
  permissionMode?: 'gated' | 'skip' | undefined;
  skipPermissions: boolean;
  role?: string | undefined;
  phase?: LaunchPhase | undefined;
  /** FLUX-1373: explicit task-tier policy key override — bypasses deriveTaskKey's phase+position
   *  rule for dispatch sites where that generic derivation would guess wrong (the plan-gate review
   *  pass, the scatter-gather combiner). Most callers omit this and let createPendingSession derive it. */
  taskKey?: TaskKey | undefined;
  pattern?: ExecutionPattern | undefined;
  patternPosition?: PatternPosition | undefined;
  groupId?: string | undefined;
  groupSeq?: number | undefined;
  groupTotal?: number | undefined;
  groupType?: ExecutionPattern | undefined;
  groupVariant?: GroupVariant | undefined;
  lockedPaths?: string[] | undefined;
  diffBlock?: string | undefined;
  /** FLUX-1385: launched persona id — scopes this session's `event-horizon` MCP toolset by
   *  role (see disallowedEhToolsForPersona in orchestration-personas.ts). */
  personaId?: string | undefined;
  /** FLUX-1385: this launch's focus text — carries the sole-reviewer-of-record override signal
   *  through to the same tool-scoping check. */
  focusComment?: string | undefined;
  /** FLUX-1434: explicit per-launch `event-horizon` MCP tool grant (dispatch.enableTools in the
   *  deny-list model) — re-enabled regardless of pattern position, same as persona.enableTools.
   *  Forwarded from the `/start` and `/delegate` route bodies and the `delegate` MCP tool. */
  enableTools?: string[] | undefined;
}

// FLUX-1373: derive session.taskKey from what a dispatch site knows at spawn time — phase +
// pattern position (assistant/step -> workers, else lead); finalize/chat are single keys with no
// position suffix. No phase (ad-hoc/legacy launch) falls back to the status-based rule that
// predates taskKey (grooming statuses -> grooming.lead, else implementation.lead) so an unstamped
// launch resolves the same model it always did. Callers that know better (the /start route's
// explicit body param, the plan-gate review pass, the scatter-gather combiner) pass `opts.taskKey`
// to createPendingSession instead, which short-circuits this.
function deriveTaskKey(phase: LaunchPhase | undefined, patternPosition: PatternPosition | undefined, taskStatus: unknown): TaskKey {
  if (phase === 'finalize') return 'finalize';
  if (phase === 'chat') return 'chat';
  if (phase) {
    const position = patternPosition === 'assistant' || patternPosition === 'step' ? 'workers' : 'lead';
    return `${phase}.${position}` as TaskKey;
  }
  const groomingStatuses = [getConfig().requireInputStatus || 'Require Input', 'Grooming'];
  return groomingStatuses.includes(taskStatus) ? 'grooming.lead' : 'implementation.lead';
}

// Stamp baselineCommit at first session launch if missing. This is the review-diff anchor.
// For a branch/PR ticket the anchor must be the branch's fork point from the default branch
// (merge-base), NOT the engine's HEAD at launch — HEAD can sit on an unrelated sibling commit,
// which made baseline..HEAD diffs surface phantom reversions (FLUX-585). resolveBaselineCommit
// returns the merge-base for branch tickets and current HEAD for branch-less ones.
async function stampBaselineCommit(task: TaskRecord): Promise<void> {
  if (!task.baselineCommit) {
    const baseline = await resolveBaselineCommit(task.branch ?? null);
    if (baseline) {
      await updateTaskWithHistory(task.id, {
        updatedBy: 'Agent',
        extraFields: { baselineCommit: baseline },
      });
      task.baselineCommit = baseline;
    }
  } else if (task.branch) {
    // Self-heal a baseline recorded before the FLUX-585 fix: a PR ticket stamped at the engine's
    // sibling-branch HEAD. If the stored baseline isn't an ancestor of the branch tip it can only
    // ever produce phantom-revert diffs — re-anchor it to the merge-base. Targeted: a baseline
    // already on the branch is left untouched.
    // Captured into locals (rather than repeated `task.` property reads) so TS's narrowing —
    // both baselineCommit's truthiness above and branch's below — survives the `await`s.
    const currentBaseline = task.baselineCommit;
    const branch = task.branch;
    const onBranch =
      (await isAncestor(currentBaseline, branch)) ||
      (await isAncestor(currentBaseline, `origin/${branch}`));
    if (!onBranch) {
      const mb = await getMergeBase(branch);
      if (mb && mb !== currentBaseline) {
        await updateTaskWithHistory(task.id, {
          updatedBy: 'Agent',
          extraFields: { baselineCommit: mb },
        });
        task.baselineCommit = mb;
      }
    }
  }
}

// FLUX-1002: the fast, synchronous half of launching a session — build the record and register
// it so callers (and the client, for the route below) have a session id to track immediately.
// No network/git ops here; those live in the caller (spawnSession) or prepareAndLaunchSession.
function createPendingSession(task: TaskRecord, opts: SpawnOptions): CliSessionRecord {
  const adapter = getAdapter(opts.framework);
  const sessionId = randomUUID();
  const label = adapter.labelForFramework();
  const startedAt = new Date().toISOString();

  const session: CliSessionRecord = {
    id: sessionId,
    taskId: task.id,
    framework: opts.framework,
    status: 'pending',
    command: opts.framework,
    args: [],
    startedAt,
    label,
    outputBuffer: '',
    liveOutputBuffer: '',
    pendingAssistantText: '',
    cumulativeOutput: '',
    skipPermissions: opts.skipPermissions,
    requestedStop: false,
    writeQueue: Promise.resolve(),
    inputTokens: 0,
    outputTokens: 0,
    costUSD: 0,
  };
  if (opts.role) session.role = opts.role;
  if (opts.phase) session.phase = opts.phase;
  session.taskKey = opts.taskKey ?? deriveTaskKey(opts.phase, opts.patternPosition, task.status);
  if (opts.pattern) session.pattern = opts.pattern;
  if (opts.patternPosition && opts.patternPosition !== 'standalone') session.patternPosition = opts.patternPosition;
  if (opts.groupId) session.groupId = opts.groupId;
  if (opts.groupSeq != null) session.groupSeq = opts.groupSeq;
  if (opts.groupTotal != null) session.groupTotal = opts.groupTotal;
  if (opts.groupType) session.groupType = opts.groupType;
  if (opts.groupVariant) session.groupVariant = opts.groupVariant;
  if (opts.lockedPaths && opts.lockedPaths.length > 0) session.lockedPaths = opts.lockedPaths;
  if (opts.diffBlock) session.diffBlock = opts.diffBlock;
  if (opts.personaId) session.personaId = opts.personaId;
  if (opts.focusComment) session.focusComment = opts.focusComment;
  if (opts.enableTools && opts.enableTools.length > 0) session.enableTools = opts.enableTools;
  if (opts.model) session.model = opts.model;
  if (opts.effortOverride) session.effortOverride = opts.effortOverride;
  if (opts.permissionMode) session.permissionMode = opts.permissionMode;

  cliSessionsById.set(sessionId, session);
  registerSession(task.id, sessionId);
  return session;
}

// FLUX-1156: a pre-spawn failure (worktree pool full, isolation error, binary missing, etc.) throws
// BEFORE the adapter ever creates its `agent_session` history entry (that happens post-spawn — see
// claude-code.ts/gemini.ts/copilot.ts's `buildAgentSessionEntry` call right before `proc.on(...)` is
// wired up). Without a durable entry, the chat timeline (built from `agent_session` entries — FLUX-507)
// shows nothing, and `get_session_log` can never resolve the id the caller (e.g. the Furnace) already
// has. Build one here using the session id/startedAt already allocated by createPendingSession, marked
// terminal from birth, so every pre-spawn failure path renders exactly like a post-spawn one.
function buildFailedPreSpawnSessionEntry(session: CliSessionRecord, message: string, endedAt: string = new Date().toISOString()) {
  const entry = buildAgentSessionEntry(session.id, session.startedAt, session.label, {
    groupId: session.groupId,
    role: session.role,
    pattern: session.groupType,
  });
  entry.status = 'failed';
  entry.endedAt = endedAt;
  entry.outcome = `${session.label} session failed to start: ${message}`;
  return entry;
}

/**
 * Build, register and launch one CLI session, awaiting the full launch before returning —
 * used by callers that don't need the response-time treatment below (the deferred-combiner
 * and relay-step launchers run off session-store callbacks, not an HTTP handler; /delegate
 * already holds its response open for the whole child lifecycle).
 */
async function spawnSession(task: TaskRecord, opts: SpawnOptions): Promise<CliSessionRecord> {
  const session = createPendingSession(task, opts);
  await stampBaselineCommit(task);

  try {
    await getAdapter(opts.framework).start(session, task, opts.appendPrompt, opts.effortOverride, getWorkspaceRoot()!);
  } catch (error) {
    // FLUX-981: a pre-spawn failure (binary missing, worktree/isolation resolution error, etc.) throws
    // BEFORE any child process spawns, so the adapter's own proc.on('error') handler never runs — the
    // failure would otherwise be a portal-toast-only HTTP 500 with nothing in the chat. Surface it
    // inline (live `progress` SSE via appendErrorToSession) AND record a durable ticket activity entry.
    // Best-effort: never let the surfacing mask the original throw the caller must still see.
    const message = error instanceof Error ? error.message : String(error);
    try {
      appendErrorToSession(session, `Failed to start agent: ${message}`);
      // FLUX-1156: a durable agent_session entry (not just an activity line) so the chat timeline
      // and get_session_log both resolve this session id even though it never actually spawned.
      await updateTaskWithHistory(task.id, {
        updatedBy: 'Agent',
        entries: [buildFailedPreSpawnSessionEntry(session, message)],
      });
    } catch {
      /* surfacing is best-effort */
    }
    unregisterSession(task.id, session.id);
    cliSessionsById.delete(session.id);
    throw error;
  }
  return session;
}

/**
 * FLUX-1002: background counterpart to spawnSession for the per-ticket start route. Runs
 * ensureTicketIsolation (branch push + worktree add) and the adapter spawn (itself gated on the
 * MCP/Serena handshake, FLUX-1004) OFF the HTTP response path — the route below already returned
 * 201 with the pending session created via createPendingSession. Failures here surface as the
 * session going 'failed' with an inline chat error + ticket history entry (mirroring the
 * proc.on('error') pattern in the adapters), never as a hung or dropped request.
 */
async function prepareAndLaunchSession(
  session: CliSessionRecord,
  task: TaskRecord,
  opts: SpawnOptions,
  isolation: 'worktree' | 'branch' | undefined,
): Promise<void> {
  const id = task.id;
  try {
    // FLUX-845: isolate BEFORE spawning so resolveTaskExecutionRoot lands the session in the
    // dedicated worktree (the canonical mechanism, shared with create_branch + the /branch route).
    // Idempotent: a ticket that already has a branch is reused, never re-created.
    if (isolation) {
      session.currentActivity = 'Preparing workspace…';
      broadcastEvent('activity', { taskId: id, activity: session.currentActivity });
      await ensureTicketIsolation(id, { worktree: isolation === 'worktree' });
    }

    // FLUX-1002: the pending window this backgrounding creates is now long enough (a real
    // `git push` + worktree add) for the client to see the session and hit stop before prep
    // finishes. The stop route sets status:'cancelled'+requestedStop on a 'pending' session but
    // has no live proc to kill yet — without this check we'd spawn the child anyway right after,
    // silently reviving a session the user already cancelled.
    if (session.requestedStop) return;

    await stampBaselineCommit(task);

    // Inject pre-computed diff for scatter-gather review workers.
    if (opts.groupType === 'scatter-gather' && opts.patternPosition !== 'lead') {
      const diffBlock = await computeDiffBlockForTask(task);
      if (diffBlock) session.diffBlock = diffBlock;
    }

    if (session.requestedStop) return;

    session.currentActivity = undefined;
    await getAdapter(opts.framework).start(session, task, opts.appendPrompt, opts.effortOverride, getWorkspaceRoot()!);
  } catch (error: unknown) {
    // FLUX-1002 review: a stop requested while isolation/spawn prep was in flight already set
    // status:'cancelled' (see the requestedStop checks above) — this backgrounded rejection lands
    // AFTER that, so without this guard it would clobber the user's cancellation back to 'failed'
    // and append a spurious "failed to start" ticket-history entry for a session they already
    // stopped. Leave the cancelled session exactly as the stop route left it.
    if (session.requestedStop) return;
    // Unlike spawnSession's catch, the client already has this session id (the route responded
    // 201 before this ran) — mark it failed and surface it instead of deleting/rethrowing.
    const message = error instanceof Error ? error.message : String(error);
    session.status = 'failed';
    session.endedAt = new Date().toISOString();
    session.currentActivity = undefined;
    try {
      appendErrorToSession(session, `Failed to start agent: ${message}`);
      // FLUX-1156: durable agent_session entry (status:'failed' + outcome), not just an activity
      // line — the chat timeline is built from agent_session entries, and the Furnace/get_session_log
      // both need this session id to resolve to something once the in-memory record is evicted.
      // Set on the in-memory record too so an immediate reconcile pass (furnace-stoker) can read the
      // failure reason straight off the live session, no re-read needed.
      const entry = buildFailedPreSpawnSessionEntry(session, message, session.endedAt);
      session.sessionHistoryEntry = entry;
      await updateTaskWithHistory(id, {
        updatedBy: 'Agent',
        entries: [entry],
      });
    } catch {
      /* surfacing is best-effort */
    }
    // A fresh-spawn pre-spawn failure previously surfaced only as the inline chat ⚠️ + history
    // entry above — no board flag, unlike a RESUME-time pre-spawn failure (surfaceResumeFailure,
    // FLUX-1120), which raises needsAction. Dispatched launches (start_session, board-rebase,
    // fast-path) are fire-and-forget: nobody is watching the ticket chat, so e.g. a worktree-pool-
    // full refusal (FLUX-1018 fail-closed) died quietly. Raise the persistent flag so the ticket
    // lands in the board's "Needs Action" group; it self-clears when a fresh turn starts
    // (clearNeedsActionIfSet). Best-effort by design (raiseNeedsAction catches internally).
    // Mirrors flagIfParked's isDelegatedMember guard: a scatter-gather worker or supervisor
    // delegate shares the ticket with an actively-running orchestrator that owns the transition,
    // so flagging the ticket here on a delegate's failure would be a false positive. A group LEAD
    // (supervisor orchestrator / combiner) is NOT exempt — it IS the orchestrator, so its failure
    // to spawn means nobody is driving the ticket and must surface.
    if (!isDelegatedMember(session)) {
      void raiseNeedsAction(id, `${session.label} session failed to start: ${message}`);
    }
    broadcastEvent('taskUpdated', { id });
  }
}

// Wire the deferred-combiner launcher: when a scatter-gather group's workers
// all finish, session-store calls this to spawn the combiner.
setCombinerLauncher(async (spec: PendingCombinerSpec, anyWorkerSucceeded: boolean) => {
  const task = getWorkspace().tasks[spec.taskId];
  if (!task) {
    console.warn(`Deferred combiner for ${spec.groupId}: task ${spec.taskId} not found.`);
    return;
  }
  let prompt = spec.appendPrompt;
  if (!anyWorkerSucceeded) {
    prompt = `NOTE: No worker sessions completed successfully — all failed or were cancelled. There may be nothing to synthesize. Check the ticket history and summarize whatever is available, or report that no reviews were produced.\n\n${prompt}`;
  }
  await spawnSession(task, {
    framework: spec.framework,
    appendPrompt: prompt,
    effortOverride: '',
    skipPermissions: spec.skipPermissions,
    role: spec.role,
    pattern: spec.groupType,
    patternPosition: 'lead',
    groupId: spec.groupId,
    groupType: spec.groupType,
    groupVariant: spec.groupVariant,
    // FLUX-1373: PendingCombinerSpec carries no `phase`, so deriveTaskKey's generic rule would fall
    // through to the status-based no-phase fallback and guess wrong. Every scatter-gather combiner
    // today is a review synthesis step — pin it explicitly.
    taskKey: 'review.lead',
  });
});

// Wire the relay step launcher: when a relay step finishes, session-store
// calls this to spawn the next step in the pipeline with the previous output.
setRelayStepLauncher(async (spec: PendingRelaySpec, previousOutput: string, previousSucceeded: boolean) => {
  const task = getWorkspace().tasks[spec.taskId];
  if (!task) {
    console.warn(`Relay step for ${spec.groupId}: task ${spec.taskId} not found.`);
    return;
  }
  const step = spec.steps[spec.currentStep];
  if (!step) return;

  const resolved = resolvePersonaPrompt(step.personaId, step.focusComment, spec.phase);
  let prompt = resolved || '';

  // Prepend previous step's output so this step has context of what came before.
  const handoffHeader = previousSucceeded
    ? `## Output from previous pipeline step\n\nThe previous agent in the pipeline completed successfully. Here is their output — continue from where they left off:\n\n---\n${previousOutput}\n---\n\n`
    : `## Output from previous pipeline step\n\nNOTE: The previous agent FAILED or was cancelled. Their partial output is below — you may need to start fresh or recover from their state:\n\n---\n${previousOutput}\n---\n\n`;
  if (previousOutput) {
    prompt = handoffHeader + prompt;
  }

  await spawnSession(task, {
    framework: spec.framework,
    appendPrompt: prompt,
    effortOverride: spec.effortOverride,
    ...(spec.phase ? { phase: spec.phase } : {}),
    skipPermissions: spec.skipPermissions,
    role: step.role,
    personaId: step.personaId || undefined,
    focusComment: step.focusComment || undefined,
    pattern: 'relay',
    patternPosition: 'step',
    groupId: spec.groupId,
    groupSeq: spec.currentStep,
    groupTotal: spec.steps.length,
    groupType: spec.groupType,
  });
});

// GET single session (backwards compat — returns most recent active)
router.get('/:id/cli-session', (req, res) => {
  const { id } = req.params;
  if (!isVirtualConversationId(id) && !getWorkspace().tasks[id]) return res.status(404).json({ error: 'Task not found' });
  res.json({ session: getCliSessionSummaryForTask(id) || null });
});

// GET all sessions for a task
router.get('/:id/cli-sessions', (req, res) => {
  const { id } = req.params;
  const task = getWorkspace().tasks[id];
  if (!task) return res.status(404).json({ error: 'Task not found' });
  res.json({ sessions: getAllSessionSummariesForTask(id) });
});

// FLUX-602: durable conversation transcript (raw tier) for the chat pane.
// Source of truth for rendering — persists across reopen/restart, unlike the
// in-memory live progress stream.
router.get('/:id/transcript', async (req, res) => {
  const { id } = req.params;
  if (!isVirtualConversationId(id) && !getWorkspace().tasks[id]) return res.status(404).json({ error: 'Task not found' });
  try {
    const messages = await readTranscriptMessages(id);
    res.json({ messages });
  } catch (err: unknown) {
    res.status(500).json({ error: errorMessage(err, 'Failed to read transcript') });
  }
});

// FLUX-867: durable board Activity/History feed. The `📡 <ticket> <STAGE>` dispatch-lifecycle
// rows teed to the board orchestrator thread (FLUX-849) are durably persisted in the same
// `__board__` transcript; this replays them, filtered down to `kind:'dispatch'` rows only, so the
// other board chat (user/assistant/tool/permission notes) never leaks into the Activity view.
// Read-only, newest-first, with optional server-side filters (`ticket`/`phase`/`lifecycle`/`from`/
// `to`/`limit`) so the unbounded `__board__.jsonl` is never shipped whole to the client. Backs the
// portal Activity screen. (No new store — same source of truth as `/transcript`.)
router.get('/:id/activity', async (req, res) => {
  const { id } = req.params;
  if (!isVirtualConversationId(id) && !getWorkspace().tasks[id]) return res.status(404).json({ error: 'Task not found' });
  try {
    const ticket = typeof req.query.ticket === 'string' ? req.query.ticket : '';
    const phase = typeof req.query.phase === 'string' ? req.query.phase : '';
    const lifecycle = typeof req.query.lifecycle === 'string' ? req.query.lifecycle : '';
    const from = typeof req.query.from === 'string' ? Date.parse(req.query.from) : NaN;
    const to = typeof req.query.to === 'string' ? Date.parse(req.query.to) : NaN;
    const limitRaw = typeof req.query.limit === 'string' ? parseInt(req.query.limit, 10) : NaN;
    const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 2000) : 500;

    let rows = (await readTranscriptMessages(id)).filter((m) => m.kind === 'dispatch');
    if (ticket) rows = rows.filter((m) => m.sourceTask === ticket);
    if (phase) rows = rows.filter((m) => m.phase === phase);
    if (lifecycle) rows = rows.filter((m) => m.lifecycle === lifecycle);
    if (Number.isFinite(from)) rows = rows.filter((m) => { const t = Date.parse(m.ts); return !Number.isNaN(t) && t >= from; });
    if (Number.isFinite(to)) rows = rows.filter((m) => { const t = Date.parse(m.ts); return !Number.isNaN(t) && t <= to; });

    // readTranscriptMessages returns chronological (oldest-first); reverse for newest-first, then cap.
    res.json({ messages: rows.reverse().slice(0, limit) });
  } catch (err: unknown) {
    res.status(500).json({ error: errorMessage(err, 'Failed to read activity') });
  }
});

// Clear a conversation's transcript — the orchestrator "reset". The caller stops any live
// session first; this just wipes the durable record. Broadcasting `taskUpdated` makes any
// open chat window refetch (and come back empty) without a reload.
router.delete('/:id/transcript', async (req, res) => {
  const { id } = req.params;
  if (!isVirtualConversationId(id) && !getWorkspace().tasks[id]) return res.status(404).json({ error: 'Task not found' });
  try {
    await clearTranscript(id);
    // FLUX-659: resetting the orchestrator conversation drops the digest delta baseline too, so the
    // next turn's "since last turn" starts clean rather than diffing against a wiped conversation.
    if (id === BOARD_CONVERSATION_ID) resetBoardDigest();
    broadcastEvent('taskUpdated', { id });
    res.json({ ok: true });
  } catch (err: unknown) {
    res.status(500).json({ error: errorMessage(err, 'Failed to clear transcript') });
  }
});

router.post('/:id/cli-session/start', async (req, res) => {
  const { id } = req.params;

  // FLUX-604 / FLUX-1209: a virtual, non-ticket-scoped conversation session — the board
  // orchestrator (`__board__`) or the Furnace Operator ("Smelter") chat (`__furnace__`).
  if (isVirtualConversationId(id)) {
    const isBoard = id === BOARD_CONVERSATION_ID;
    const conversationLabel = isBoard ? 'Orchestrator' : 'Furnace';
    const firstMessage = typeof req.body?.appendPrompt === 'string' ? req.body.appendPrompt.trim() : '';
    // FLUX-676: the opening turn may carry pasted images; allow an image-only turn (empty text).
    const chatAttachments = parseChatAttachments(req.body?.attachments);
    // FLUX-1175 / FLUX-1209: an optional personaId (e.g. the Smelter, launched from the Furnace
    // drawer) swaps this turn's identity block for that persona's resolved prompt — these are the
    // only non-ticket-scoped conversations, so a persona chat not bound to a real ticket rides on
    // one of them rather than a whole new sentinel/adapter per persona. Only meaningful on the
    // opening turn: a persona's identity is established once, same as a per-ticket chat launch.
    // FLUX-1209: the Furnace conversation IS the Smelter's chat, structurally — default to the
    // 'smelter' persona whenever the caller doesn't explicitly pass one (e.g. the generic composer
    // starting a fresh turn after a prior Smelter turn went terminal), so it's never possible to
    // accidentally cold-start a generic, unpersona'd turn on this conversation id.
    const explicitPersonaId = typeof req.body?.personaId === 'string' ? req.body.personaId.trim() : '';
    const boardPersonaId = explicitPersonaId || (id === FURNACE_CONVERSATION_ID ? 'smelter' : '');
    const boardFocusComment = typeof req.body?.focusComment === 'string' ? req.body.focusComment.trim() : '';
    // FLUX-1211: a personaId-only launch (no user-typed appendPrompt) is a valid silent boot —
    // the persona resolves identity server-side and no fake `user` transcript turn gets recorded
    // (see startBoardSession). Only error when there's neither text, an attachment, nor a persona.
    if (!firstMessage && chatAttachments.length === 0 && !boardPersonaId) return res.status(400).json({ error: `appendPrompt (first message) is required for the ${conversationLabel.toLowerCase()} chat` });
    let boardPersonaPrompt: string | undefined;
    let boardPersonaLabel: string | undefined;
    if (boardPersonaId) {
      const persona = getPersonaById(boardPersonaId);
      if (!persona) return res.status(400).json({ error: `Unknown personaId: ${boardPersonaId}` });
      boardPersonaPrompt = resolvePersonaPrompt(boardPersonaId, boardFocusComment, 'chat');
      boardPersonaLabel = persona.label;
    }
    const existingId = cliSessionIdByTaskId.get(id);
    const existing = existingId ? cliSessionsById.get(existingId) : undefined;
    // Block only while a turn is genuinely IN FLIGHT (a live proc is running). A session parked
    // at 'waiting-input' is idle — claude -p already exited — so a fresh start should supersede
    // it rather than 409. The frontend prefers resume for a resumable parked session; when it
    // falls back to start (e.g. the parked turn never captured a resumeSessionId and so isn't
    // resumable), this lets a fresh turn through instead of wedging forever (FLUX-667).
    if (existing && (existing.status === 'running' || existing.status === 'pending')) {
      return res.status(409).json({ error: `${conversationLabel} session already active`, session: getCliSessionSummaryForTask(id) });
    }
    if (existing && existing.status === 'waiting-input') {
      existing.status = 'cancelled';
      existing.endedAt = new Date().toISOString();
    }
    // FLUX-959: the board picker can request any registered runtime framework — same
    // validation as the per-ticket start route below. Unknown/absent resolves to the default.
    // FLUX-984: registry-backed (isKnownFramework), not a hardcoded literal list — an
    // adapter-boundary leak fixed alongside the same guard failure the Copilot MCP fix surfaced.
    const boardFrameworkRaw = String(req.body?.framework || resolveDefaultFramework()).trim().toLowerCase();
    if (!isKnownFramework(boardFrameworkRaw)) {
      return res.status(400).json({ error: `framework must be one of: ${getRuntimeFrameworks().join(', ')}` });
    }
    const fw = boardFrameworkRaw as CliFramework;
    const boardSession: CliSessionRecord = {
      id: randomUUID(),
      taskId: id,
      framework: fw,
      status: 'pending',
      command: fw,
      args: [],
      startedAt: new Date().toISOString(),
      label: boardPersonaLabel ?? conversationLabel,
      outputBuffer: '',
      liveOutputBuffer: '',
      pendingAssistantText: '',
      cumulativeOutput: '',
      // Permission policy is governed by permissionMode below (defaults to 'gated'),
      // NOT this legacy flag — permissionArgs() checks permissionMode first. Kept false
      // so the record doesn't misread as an ungated skip-permissions session.
      skipPermissions: false,
      requestedStop: false,
      writeQueue: Promise.resolve(),
      inputTokens: 0,
      outputTokens: 0,
      costUSD: 0,
      // FLUX-1373: virtual board/Smelter conversations are always the `chat` task key — they never
      // flow through createPendingSession's deriveTaskKey (this session record is built by hand).
      taskKey: 'chat',
      ...(boardPersonaId ? { personaId: boardPersonaId } : {}),
      ...(boardFocusComment ? { focusComment: boardFocusComment } : {}),
    };
    cliSessionsById.set(boardSession.id, boardSession);
    registerSession(id, boardSession.id);
    if (typeof req.body?.model === 'string' && req.body.model.trim()) boardSession.model = req.body.model.trim();
    if (typeof req.body?.effortOverride === 'string' && req.body.effortOverride.trim()) boardSession.effortOverride = req.body.effortOverride.trim();
    // Orchestrator/Furnace default comes from the workspace risk-tolerance setting (board default
    // gated); an explicit per-chat Perms choice overrides it. (FLUX-605)
    boardSession.permissionMode = resolvePermissionMode(
      req.body?.permissionMode === 'gated' || req.body?.permissionMode === 'skip' ? req.body.permissionMode : undefined,
      'board',
    );
    try {
      await getBoardAdapter(fw).startBoardSession(boardSession, firstMessage, getWorkspaceRoot()!, {
        attachments: chatAttachments,
        ...(boardPersonaPrompt ? { personaPrompt: boardPersonaPrompt } : {}),
      });
      return res.status(201).json({ session: getCliSessionSummaryForTask(id) });
    } catch (error: unknown) {
      unregisterSession(id, boardSession.id);
      cliSessionsById.delete(boardSession.id);
      return res.status(500).json({ error: errorMessage(error, `Failed to start ${conversationLabel.toLowerCase()} session`) });
    }
  }

  const task = getWorkspace().tasks[id];
  if (!task) return res.status(404).json({ error: 'Task not found' });

  const frameworkRaw = String(req.body?.framework || resolveDefaultFramework()).trim().toLowerCase();
  // FLUX-984: registry-backed (isKnownFramework), not a hardcoded literal list.
  if (!isKnownFramework(frameworkRaw)) {
    return res.status(400).json({ error: `framework must be one of: ${getRuntimeFrameworks().join(', ')}` });
  }
  const framework = frameworkRaw as CliFramework;
  const skipPermissions = req.body?.skipPermissions !== false;
  const effortOverrideRaw = typeof req.body?.effortOverride === 'string' ? req.body.effortOverride.trim() : '';
  const modelRaw = typeof req.body?.model === 'string' ? req.body.model.trim() : '';
  const permissionModeRaw: 'gated' | 'skip' | undefined =
    req.body?.permissionMode === 'gated' || req.body?.permissionMode === 'skip' ? req.body.permissionMode : undefined;

  // Launch phase / intent (portal tells engine why this session exists).
  // An unrecognized phase is ignored (buildInitialPrompt falls back to status-based logic).
  const phaseRaw = typeof req.body?.phase === 'string' ? req.body.phase.trim() : '';
  const phase: LaunchPhase | undefined = (VALID_LAUNCH_PHASES as string[]).includes(phaseRaw)
    ? (phaseRaw as LaunchPhase)
    : undefined;

  // FLUX-1373: explicit task-tier policy key override (validated against the 9-key set) — needed
  // because a caller like the plan gate dispatches phase 'review' but wants the distinct
  // `planReview` tier, which deriveTaskKey's generic phase+position rule can't produce on its own.
  // An unrecognized/absent value is ignored (createPendingSession derives it as normal).
  const taskKeyRaw = typeof req.body?.taskKey === 'string' ? req.body.taskKey.trim() : '';
  const taskKey: TaskKey | undefined = (TASK_KEYS as readonly string[]).includes(taskKeyRaw)
    ? (taskKeyRaw as TaskKey)
    : undefined;

  // FLUX-1380: fast-path lets one session groom AND implement an XS/S ticket, structurally
  // bypassing the plan gate (which only fires on Grooming→Todo). Refuse it deterministically
  // for work that's too big for a single unattended pass: L/XL effort, or a ticket that is
  // itself an epic (has its own subtasks). A ticket that merely HAS a parentId (is a subtask of
  // some other epic) but carries no subtasks of its own remains eligible. Unset/None effort is
  // allowed through — the session sets effort during its inline grooming step and is expected to
  // bail via change_status→Todo (firing the plan gate normally) if it turns out to be M+.
  if (phase === 'fast-path') {
    const taskEffort = typeof task.effort === 'string' ? task.effort : undefined;
    if (taskEffort === 'L' || taskEffort === 'XL') {
      return res.status(400).json({ error: `fast-path is not available for ${taskEffort}-effort tickets — use implementation instead` });
    }
    if (subtaskIds(task.subtasks).length > 0) {
      return res.status(400).json({ error: 'fast-path is not available for tickets with their own subtasks (epic parents) — use implementation instead' });
    }
  }

  // Persona resolution: when a personaId is supplied the engine owns the prompt
  // text (it never ships to the client). A raw appendPrompt is still accepted
  // for ad-hoc, non-persona launches. FLUX-1170: the launch phase (above) picks
  // the shared phase contract composed onto the persona's lens.
  const personaId = typeof req.body?.personaId === 'string' ? req.body.personaId.trim() : '';
  const focusComment = typeof req.body?.focusComment === 'string' ? req.body.focusComment.trim() : '';
  const enableTools = parseEnableTools(req.body?.enableTools);
  const launchedBy = typeof req.body?.user === 'string' && req.body.user.trim() ? req.body.user.trim() : 'User';
  let appendPrompt = typeof req.body?.appendPrompt === 'string' ? req.body.appendPrompt.trim() : '';
  if (personaId) {
    const resolved = resolvePersonaPrompt(personaId, focusComment, phase);
    if (!resolved) return res.status(400).json({ error: `Unknown personaId: ${personaId}` });
    appendPrompt = resolved;
  }

  // FLUX-845: server-side isolation policy. Agent-driven dispatch (start_session / board-rebase)
  // has no human to choose a branch, so it requests isolation here and the engine creates the
  // branch (+worktree) BEFORE spawning — otherwise the session runs branchless in the shared
  // checkout (the FLUX-840/841/844 tangle). 'worktree' → dedicated worktree (the default for
  // agent callers); 'branch' → branch only; omitted → no server-side isolation (the portal
  // pre-creates its own branch client-side and omits this).
  // FLUX-1214: grooming never writes code or opens a PR — it only reads/writes ticket metadata
  // via MCP tools — so it has no use for a branch or worktree. Force isolation off here,
  // regardless of what the caller requested, so a ticket that grooms straight back to Todo
  // (never reaching Ready/a terminal status) never leaves an orphaned worktree that
  // `worktreeUnreclaimableReason` (status-gated) can't ever reclaim.
  // FLUX-1215 follow-up: this is a deny-list (block only 'grooming'), not an allow-list (permit
  // only 'implementation'), because 'review'/'finalize' dispatch onto a ticket that ALREADY
  // carries a branch (idempotent reuse of the existing worktree, no fresh isolation-creation) —
  // so 'grooming' is genuinely the only phase that both lacks a branch and doesn't need one
  // today. If a future phase is added that, like grooming, can run branchless without ever
  // needing isolation, re-check this condition rather than assuming the deny-list still covers it.
  // FLUX-1380 follow-up: 'fast-path' isolation is forced ON server-side (grooming's mirror
  // image). Unlike grooming, fast-path writes code and commits (groom inline, then implement,
  // then Ready) — it needs the same branch/worktree isolation as 'implementation'. The original
  // FLUX-1380 wiring relied on the CALLER to request it: the MCP start_session dispatcher does
  // (it always sends `isolation`), but the portal's fast-path launch (dispatchFastPath →
  // runAgentAction) sends no isolation at all — and, launching from the Grooming column, it also
  // never routes through the Todo Start-Task prompt that pre-creates a branch client-side for
  // normal implementation launches. Net effect: a portal fast-path spawned BRANCHLESS in the
  // shared main checkout, with its commits landing on master (the exact FLUX-972 mode the
  // FLUX-1018 branch⇒worktree invariant exists to forbid — that invariant never engaged because
  // the ticket had no branch). Defaulting here, in the route, closes the gap for every caller
  // instead of trusting each one to know. An explicit 'branch' request (MCP worktree:false) is
  // still honored — FLUX-1018 worktree-isolates that spawn anyway. Only 'grooming' ever runs
  // branchless.
  const isolationRaw = typeof req.body?.isolation === 'string' ? req.body.isolation.trim() : '';
  const requestedIsolation: 'worktree' | 'branch' | undefined =
    isolationRaw === 'worktree' || isolationRaw === 'branch' ? isolationRaw : undefined;
  const isolation: 'worktree' | 'branch' | undefined =
    phase === 'grooming'
      ? undefined
      : phase === 'fast-path'
        ? requestedIsolation ?? 'worktree'
        : requestedIsolation;

  // Multi-session fields
  const role = typeof req.body?.role === 'string' ? req.body.role.trim() : undefined;
  const pattern = typeof req.body?.pattern === 'string' ? req.body.pattern.trim() as ExecutionPattern : undefined;
  const patternPosition = typeof req.body?.patternPosition === 'string' ? req.body.patternPosition.trim() as PatternPosition : 'standalone';
  const lockedPaths: string[] = Array.isArray(req.body?.lockedPaths) ? req.body.lockedPaths : [];

  // Run-group fields: shared identity + topology classification for one orchestration run
  const groupId = typeof req.body?.groupId === 'string' ? req.body.groupId.trim() : undefined;
  const groupSeq = typeof req.body?.groupSeq === 'number' ? req.body.groupSeq : undefined;
  const groupTotal = typeof req.body?.groupTotal === 'number' ? req.body.groupTotal : undefined;
  const groupType = typeof req.body?.groupType === 'string' ? req.body.groupType.trim() as ExecutionPattern : undefined;
  const groupVariant = typeof req.body?.groupVariant === 'string' ? req.body.groupVariant.trim() as GroupVariant : undefined;

  // Validate pattern support for the chosen CLI
  if (pattern && patternPosition) {
    const patternError = validatePatternSupport(framework, pattern, patternPosition);
    if (patternError) {
      return res.status(400).json({ error: patternError });
    }
  }

  // Check file-lock conflicts
  if (lockedPaths.length > 0) {
    const conflict = checkPathConflicts(id, lockedPaths);
    if (conflict.conflict) {
      return res.status(409).json({
        error: 'Path conflict with active session',
        conflictingSession: conflict.holder,
        conflictingPaths: conflict.paths,
      });
    }
  }

  // FLUX-1235: an authoritative programmatic driver (the Furnace) opts in via `supersedeParked` to take
  // over an IDLE (waiting-input) session — even a genuinely resumable one — because it is the sanctioned
  // grooming→implementation handoff and the idle session's proc has already exited (nothing is killed).
  // Without the flag the portal's interactive single-session/resume UX (FLUX-915/667) is byte-for-byte
  // unchanged. A LIVE (running/pending) session is NEVER superseded, flag or not — a real turn is in
  // flight and must not be clobbered; the caller gets a 409 and (for the Furnace) parks the ticket.
  const supersedeParked = req.body?.supersedeParked === true;

  // Only block if there's already an active standalone (legacy single-session) session without a role
  const activeSessions = getActiveSessionsForTask(id);
  if (!role && activeSessions.length > 0) {
    const blockingSession = activeSessions.find(s => !s.role);
    if (blockingSession) {
      // FLUX-915: a session parked at waiting-input with NO resumeSessionId can never resume (the
      // input route 409s on a missing session id) yet counts as active and reconcileDeadSessions
      // skips waiting-input — a permanent wedge (the per-ticket twin of the board's FLUX-667
      // self-heal). Terminalize it so a fresh start supersedes it instead of 409-ing forever. A
      // genuinely resumable parked session (has resumeSessionId) still blocks the interactive user —
      // they should send input to it, not spawn a duplicate — UNLESS `supersedeParked` is set
      // (FLUX-1235), where the authoritative driver reclaims an idle session regardless of resumability.
      const idle = blockingSession.status === 'waiting-input';
      if (idle && (!blockingSession.resumeSessionId || supersedeParked)) {
        blockingSession.status = 'cancelled';
        blockingSession.endedAt = new Date().toISOString();
      } else {
        return res.status(409).json({
          error: idle
            ? 'Task already has a resumable parked CLI session. Send input to it, or supersede it.'
            : 'Task already has a live CLI session. Use role/pattern params for multi-session.',
          session: getCliSessionSummaryForTask(id),
        });
      }
    }
  }

  try {
    getAdapter(framework);
  } catch {
    return res.status(400).json({ error: `Unsupported framework: ${framework}` });
  }

  // FLUX-674: pasted-image attachments on the opening chat turn. Reference their absolute
  // sidecar paths in the spawn prompt (the agent Reads them); keep the clean text + refs for
  // the transcript so the bubble re-renders the thumbnail.
  const chatAttachments = phase === 'chat' ? parseChatAttachments(req.body?.attachments) : [];
  const attachmentAbs = resolveAttachmentAbsPaths(chatAttachments);
  const spawnAppendPrompt = attachmentAbs.length
    ? `${appendPrompt}${attachmentReadInstruction(attachmentAbs)}`
    : appendPrompt;

  try {
    // FLUX-1002: build + register the pending session synchronously (no network/git ops) so the
    // response below can return immediately. ensureTicketIsolation (branch push + worktree add)
    // and the adapter spawn (which itself waits on the MCP/Serena handshake, FLUX-1004) run in
    // the background via prepareAndLaunchSession — the session's status/currentActivity and the
    // taskUpdated/activity broadcasts it already emits carry the outcome to the client instead of
    // the request hanging on either op.
    const spawnOpts: SpawnOptions = {
      framework,
      appendPrompt: spawnAppendPrompt,
      effortOverride: effortOverrideRaw,
      model: modelRaw,
      // Per-chat Perms choice wins; otherwise inherit the workspace ticket default
      // (risk-tolerance setting, default skip). (FLUX-605)
      permissionMode: resolvePermissionMode(permissionModeRaw, 'ticket'),
      skipPermissions,
      phase,
      taskKey,
      role,
      pattern,
      patternPosition,
      groupId,
      groupSeq,
      groupTotal,
      groupType,
      groupVariant,
      lockedPaths,
      personaId: personaId || undefined,
      focusComment: focusComment || undefined,
      enableTools,
    };
    const session = createPendingSession(task, spawnOpts);

    // FLUX-602: record the user's opening turn for chat sessions in the transcript.
    // FLUX-674: include attachments; allow an image-only opening turn (empty text).
    if (phase === 'chat' && (appendPrompt || chatAttachments.length)) {
      appendTranscriptEvent(id, { type: 'user', text: appendPrompt, attachments: chatAttachments, timestamp: new Date().toISOString() });
    }
    // FLUX-794: for a non-chat phase launch (Groom / Implement / Review / Finalize) the chat pops
    // in but nothing records WHICH action the user pressed. Append a synthetic `action` turn so the
    // pressed action surfaces as a durable, quiet system chip (projected to a `note`, not a bubble)
    // in chronological order before the agent's first response. The `phase !== 'chat'` guard avoids
    // doubling up with the chat user-turn above; ad-hoc launches (no phase) get no chip — no clean
    // label. Best-effort like the launch-focus block: `appendTranscriptEvent` is fire-and-forget, so
    // a transcript-append failure can never turn a successful launch into a 500.
    if (phase && phase !== 'chat') {
      appendTranscriptEvent(id, { type: 'action', phase, focus: focusComment || undefined, timestamp: new Date().toISOString() });
    }
    // FLUX-480: persist the launch focus as a small, clean history entry so it
    // survives across sessions and is visible to any agent re-reading the
    // ticket. Only the focus text is stored — never the full launch prompt
    // (FLUX-473 deliberately keeps that blob out of the agent digest).
    // Best-effort: the session already launched, so a failure to record the
    // focus must NOT turn a successful launch into a 500 (FLUX-480 review).
    if (focusComment) {
      try {
        await updateTaskWithHistory(id, {
          updatedBy: 'Agent',
          entries: [buildActivityEntry(`🎯 Launch focus: ${focusComment}`, launchedBy, new Date().toISOString(), { launchFocus: focusComment })],
        });
      } catch (focusErr: unknown) {
        console.warn(`[cli-session] Failed to persist launch focus for ${id}: ${focusErr instanceof Error ? focusErr.message : focusErr}`);
      }
    }

    void prepareAndLaunchSession(session, task, spawnOpts, isolation);

    res.status(201).json({ session: getCliSessionSummaryForTask(id) });
  } catch (error: unknown) {
    res.status(500).json({ error: errorMessage(error, `Failed to launch ${framework}`) });
  }
});

// Register a deferred combiner: stored against a run group's groupId and spawned
// only once every worker ("step") session in that group reaches a terminal state.
router.post('/:id/cli-session/register-combiner', (req, res) => {
  const { id } = req.params;
  const task = getWorkspace().tasks[id];
  if (!task) return res.status(404).json({ error: 'Task not found' });

  const frameworkRaw = String(req.body?.framework || resolveDefaultFramework()).trim().toLowerCase();
  // FLUX-984: registry-backed (isKnownFramework), not a hardcoded literal list.
  if (!isKnownFramework(frameworkRaw)) {
    return res.status(400).json({ error: `framework must be one of: ${getRuntimeFrameworks().join(', ')}` });
  }
  const groupId = typeof req.body?.groupId === 'string' ? req.body.groupId.trim() : '';
  const role = typeof req.body?.role === 'string' ? req.body.role.trim() : '';
  const phaseRaw = typeof req.body?.phase === 'string' ? req.body.phase.trim() : '';
  const phase: LaunchPhase | undefined = (VALID_LAUNCH_PHASES as string[]).includes(phaseRaw)
    ? (phaseRaw as LaunchPhase)
    : undefined;
  // Persona resolution mirrors the start route: a personaId resolves the prompt
  // server-side (composed with the launch phase's contract); a raw appendPrompt
  // is the fallback for ad-hoc combiners.
  const personaId = typeof req.body?.personaId === 'string' ? req.body.personaId.trim() : '';
  const focusComment = typeof req.body?.focusComment === 'string' ? req.body.focusComment.trim() : '';
  let appendPrompt = typeof req.body?.appendPrompt === 'string' ? req.body.appendPrompt.trim() : '';
  if (personaId) {
    const resolved = resolvePersonaPrompt(personaId, focusComment, phase);
    if (!resolved) return res.status(400).json({ error: `Unknown personaId: ${personaId}` });
    appendPrompt = resolved;
  }
  if (!groupId) return res.status(400).json({ error: 'groupId is required' });
  if (!role) return res.status(400).json({ error: 'role is required' });
  if (!appendPrompt) return res.status(400).json({ error: 'appendPrompt or personaId is required' });

  const groupType = typeof req.body?.groupType === 'string' ? req.body.groupType.trim() as ExecutionPattern : undefined;
  const groupVariant = typeof req.body?.groupVariant === 'string' ? req.body.groupVariant.trim() as GroupVariant : undefined;
  const expectedWorkers = typeof req.body?.expectedWorkers === 'number' && req.body.expectedWorkers > 0
    ? Math.floor(req.body.expectedWorkers)
    : 1;

  const spec: PendingCombinerSpec = {
    taskId: id,
    groupId,
    framework: frameworkRaw as CliFramework,
    role,
    appendPrompt,
    skipPermissions: req.body?.skipPermissions !== false,
    groupType,
    groupVariant,
    expectedWorkers,
  };
  registerPendingCombiner(spec);
  // Workers may already have finished between launch and registration — check now.
  notifyGroupSessionTerminal(id, groupId).catch(() => {});
  res.status(201).json({ registered: true, groupId });
});

// Cancel a deferred combiner (e.g. when all workers failed to launch).
router.post('/:id/cli-session/unregister-combiner', (req, res) => {
  const { id } = req.params;
  const task = getWorkspace().tasks[id];
  if (!task) return res.status(404).json({ error: 'Task not found' });
  const groupId = typeof req.body?.groupId === 'string' ? req.body.groupId.trim() : '';
  if (!groupId) return res.status(400).json({ error: 'groupId is required' });
  const removed = unregisterPendingCombiner(groupId);
  res.json({ removed, groupId });
});

// Register a relay pipeline: stores the full step chain and launches only step 0.
// Subsequent steps spawn automatically via the relay barrier as each finishes.
router.post('/:id/cli-session/register-relay', (req, res) => {
  const { id } = req.params;
  const task = getWorkspace().tasks[id];
  if (!task) return res.status(404).json({ error: 'Task not found' });

  const frameworkRaw = String(req.body?.framework || resolveDefaultFramework()).trim().toLowerCase();
  // FLUX-984: registry-backed (isKnownFramework), not a hardcoded literal list.
  if (!isKnownFramework(frameworkRaw)) {
    return res.status(400).json({ error: `framework must be one of: ${getRuntimeFrameworks().join(', ')}` });
  }
  const groupId = typeof req.body?.groupId === 'string' ? req.body.groupId.trim() : '';
  if (!groupId) return res.status(400).json({ error: 'groupId is required' });

  const steps = Array.isArray(req.body?.steps) ? req.body.steps : [];
  if (steps.length < 2) return res.status(400).json({ error: 'relay requires at least 2 steps' });
  for (let i = 0; i < steps.length; i++) {
    if (!steps[i]?.personaId || !steps[i]?.role) {
      return res.status(400).json({ error: `step[${i}] must have personaId and role` });
    }
  }

  const effortOverride = typeof req.body?.effortOverride === 'string' ? req.body.effortOverride.trim() : '';
  const skipPermissions = req.body?.skipPermissions !== false;
  const phaseRaw = typeof req.body?.phase === 'string' ? req.body.phase.trim() : '';
  const phase: LaunchPhase | undefined = (VALID_LAUNCH_PHASES as string[]).includes(phaseRaw)
    ? (phaseRaw as LaunchPhase)
    : undefined;

  const spec: PendingRelaySpec = {
    taskId: id,
    groupId,
    framework: frameworkRaw as CliFramework,
    skipPermissions,
    effortOverride,
    groupType: 'relay',
    steps,
    currentStep: 0,
    ...(phase ? { phase } : {}),
  };
  registerPendingRelay(spec);
  res.status(201).json({ registered: true, groupId, totalSteps: steps.length });
});

// Cancel a pending relay pipeline (e.g. when step 0 fails to launch).
router.post('/:id/cli-session/unregister-relay', (req, res) => {
  const { id } = req.params;
  const task = getWorkspace().tasks[id];
  if (!task) return res.status(404).json({ error: 'Task not found' });
  const groupId = typeof req.body?.groupId === 'string' ? req.body.groupId.trim() : '';
  if (!groupId) return res.status(400).json({ error: 'groupId is required' });
  const removed = unregisterPendingRelay(groupId);
  res.json({ removed, groupId });
});

// ── Supervisor delegation endpoint ───────────────────────────────────────────
// Spawns a child session and holds the HTTP response open until the child
// reaches a terminal state. The MCP delegation tool calls this single endpoint
// and awaits the response — no polling needed.
router.post('/:id/cli-session/delegate', async (req, res) => {
  const { id } = req.params;
  const task = getWorkspace().tasks[id];
  if (!task) return res.status(404).json({ error: 'Task not found' });

  const frameworkRaw = String(req.body?.framework || resolveDefaultFramework()).trim().toLowerCase();
  // FLUX-984: registry-backed (isKnownFramework), not a hardcoded literal list.
  if (!isKnownFramework(frameworkRaw)) {
    return res.status(400).json({ error: `framework must be one of: ${getRuntimeFrameworks().join(', ')}` });
  }
  const framework = frameworkRaw as CliFramework;
  const personaId = typeof req.body?.personaId === 'string' ? req.body.personaId.trim() : '';
  const taskPrompt = typeof req.body?.task === 'string' ? req.body.task.trim() : '';
  const focusComment = typeof req.body?.focusComment === 'string' ? req.body.focusComment.trim() : '';
  const enableTools = parseEnableTools(req.body?.enableTools);
  const effortOverride = typeof req.body?.effortOverride === 'string' ? req.body.effortOverride.trim() : '';
  // FLUX-482: per-call model override from the delegate MCP tool (highest precedence).
  const modelOverride = typeof req.body?.model === 'string' ? req.body.model.trim() : '';
  const skipPermissions = req.body?.skipPermissions !== false;
  const timeoutMs = typeof req.body?.timeout === 'number' && req.body.timeout > 0
    ? Math.min(req.body.timeout, 600_000)
    : 300_000; // Default 5 minutes

  // Parent session context (for grouping and topology rendering).
  // Auto-discover: if not explicitly passed, find the active supervisor lead for this task.
  let groupId = typeof req.body?.groupId === 'string' ? req.body.groupId.trim() : undefined;
  if (!groupId) {
    const activeLead = getActiveSessionsForTask(id).find(
      s => s.patternPosition === 'lead' && s.pattern === 'supervisor'
    );
    if (activeLead?.groupId) groupId = activeLead.groupId;
  }

  if (!personaId && !taskPrompt) {
    return res.status(400).json({ error: 'personaId or task is required' });
  }

  // Build the child's prompt: persona prompt (if any) + delegation task.
  // FLUX-482/1170: a delegate call has no portal-supplied launch phase, so the
  // persona's own declared phase is the only signal — used both for prompt
  // contract composition here and for MCP-server scoping at spawn below.
  // Persona.phases are workflow Phases, a strict subset of LaunchPhase (which
  // adds 'chat'), so the first one is already a valid LaunchPhase.
  let appendPrompt = '';
  const persona = personaId ? getPersonaById(personaId) : undefined;
  const delegatePhase: LaunchPhase | undefined = persona?.phases?.[0];
  if (personaId) {
    const resolved = resolvePersonaPrompt(personaId, focusComment, delegatePhase);
    if (!resolved) return res.status(400).json({ error: `Unknown personaId: ${personaId}` });
    appendPrompt = resolved;
  }
  if (taskPrompt) {
    appendPrompt = appendPrompt
      ? `${appendPrompt}\n\n## Delegation Task\n\n${taskPrompt}`
      : taskPrompt;
  }

  // FLUX-842: idempotency. If the MCP transport dropped a prior response after
  // the child spawned, the orchestrator retries the identical delegation. Attach
  // to the in-flight (or freshly-settled) dispatch instead of spawning a second
  // child — this is what kept the review fleet running ~3× over.
  // FLUX-482: fold the per-call model into the effort component so two otherwise
  // identical delegations that differ only by model don't dedupe onto each other.
  const idempotencyKey = dispatchKey(id, personaId, taskPrompt, modelOverride ? `${effortOverride}::model=${modelOverride}` : effortOverride);
  const existing = findDispatch(idempotencyKey);
  if (existing) {
    try {
      const result = await existing.promise;
      return res.json({
        sessionId: result.sessionId,
        status: result.status,
        output: result.output,
        succeeded: result.succeeded,
        deduped: true,
      });
    } catch (error: unknown) {
      return res.status(500).json({ error: errorMessage(error, 'Delegation failed') });
    }
  }

  // FLUX-844: reserve the idempotency key BEFORE spawn so a retry that lands
  // *during* spawnSession() attaches to this reservation instead of launching a
  // second child. The reservation holds a deferred promise; we fill in the real
  // sessionId and settle it once the delegation resolves, or fail it (releasing
  // the key) if spawn itself errors so a genuine later retry can start fresh.
  const reservation = reserveDispatch(idempotencyKey);

  // FLUX-1373: resolve the delegate's model with precedence:
  //   per-call `model` param  >  resolveModel(taskKey, framework, config).
  // A delegate dispatch is always `patternPosition: 'assistant'`, so its taskKey is
  // `<delegatePhase>.workers` — or, when the persona declares no phase, the same no-phase
  // status-based fallback every other dispatch site uses (deriveTaskKey). Computed explicitly here
  // (rather than left to createPendingSession's own derivation) so `resolvedModel` below resolves
  // against the exact key that gets stamped. Supersedes the old per-call model > persona.modelTier
  // (TIER_MODELS) > config.delegateModel chain — modelTier/TIER_MODELS are retired (FLUX-1373).
  const taskKey = deriveTaskKey(delegatePhase, 'assistant', task.status);
  const resolvedModel = modelOverride || resolveModel(taskKey, framework, getConfig());

  let session: CliSessionRecord;
  try {
    session = await spawnSession(task, {
      framework,
      appendPrompt,
      effortOverride,
      ...(resolvedModel ? { model: resolvedModel } : {}),
      ...(delegatePhase ? { phase: delegatePhase } : {}),
      taskKey,
      skipPermissions,
      role: personaId ? `assistant:${personaId}` : 'assistant',
      personaId: personaId || undefined,
      focusComment: focusComment || undefined,
      enableTools,
      pattern: 'supervisor',
      patternPosition: 'assistant',
      groupId,
      groupType: 'supervisor',
      groupVariant: 'combiner',
    });
  } catch (error: unknown) {
    reservation.fail(error);
    return res.status(500).json({ error: errorMessage(error, 'Failed to spawn delegate') });
  }

  // Set up a race between delegation completion and timeout.
  reservation.setSessionId(session.id);
  const delegationPromise = awaitDelegation(session.id);
  // Pump the delegation outcome into the reservation so retries attached during
  // spawn settle with the real result (held for a short TTL after it settles).
  void delegationPromise.then(
    (result) => reservation.settle(result),
    (error) => reservation.fail(error),
  );
  const timeoutId = setTimeout(() => {
    cancelDelegation(session.id, `Delegation timed out after ${timeoutMs / 1000}s`);
    // Also kill the child process if still running.
    const childSession = cliSessionsById.get(session.id);
    if (childSession && ['pending', 'running', 'waiting-input', 'scheduled'].includes(childSession.status)) {
      childSession.requestedStop = true;
      childSession.status = 'cancelled';
      childSession.endedAt = new Date().toISOString();
      try { getAdapter(childSession.framework).stop(childSession); } catch {}
    }
  }, timeoutMs);

  try {
    const result = await delegationPromise;
    clearTimeout(timeoutId);
    res.json({
      sessionId: result.sessionId,
      status: result.status,
      output: result.output,
      succeeded: result.succeeded,
    });
  } catch (error: unknown) {
    clearTimeout(timeoutId);
    res.status(500).json({ error: errorMessage(error, 'Delegation failed') });
  }
});

router.post('/:id/cli-session/input', async (req, res) => {
  const { id } = req.params;

  // FLUX-604 / FLUX-1209: follow-up turn on a virtual (non-ticket) conversation — the board
  // orchestrator or the Furnace-chat.
  if (isVirtualConversationId(id)) {
    const conversationLabel = id === BOARD_CONVERSATION_ID ? 'Orchestrator' : 'Furnace';
    const boardMessage = typeof req.body?.message === 'string' ? req.body.message.trim() : '';
    // FLUX-676: a turn may carry pasted images; allow an image-only turn (empty text).
    const boardAttachments = parseChatAttachments(req.body?.attachments);
    if (!boardMessage && boardAttachments.length === 0) return res.status(400).json({ error: 'message is required' });
    const sid = cliSessionIdByTaskId.get(id);
    const boardSession = sid ? cliSessionsById.get(sid) : undefined;
    if (!boardSession) return res.status(409).json({ error: `No ${conversationLabel.toLowerCase()} session — start one first` });
    // FLUX-714: a turn already in flight must not be double-sent. A second resume against the same
    // resumeSessionId spawns a concurrent `claude --resume` that races the first on the session
    // JSONL and loses turns. Mirror the start-path guard (line ~347): 409 while genuinely running.
    if (boardSession.status === 'running' || boardSession.status === 'pending') {
      return res.status(409).json({ error: `${conversationLabel} is mid-turn — wait for the current turn to finish.`, session: getCliSessionSummaryForTask(id) });
    }
    if (!boardSession.resumeSessionId) {
      return res.status(409).json({ error: 'Session ID not yet available — wait for the initial response to complete' });
    }
    if (typeof req.body?.model === 'string') boardSession.model = req.body.model.trim() || undefined;
    if (typeof req.body?.effortOverride === 'string') boardSession.effortOverride = req.body.effortOverride.trim() || undefined;
    applyPermissionModeChange(boardSession, req.body?.permissionMode, 'board');
    try {
      // FLUX-959: framework is fixed for a board session's life — resolve via the session
      // record, not the request (resumeSessionId is CLI-specific; switching = a new session).
      await getBoardAdapter(boardSession.framework).sendBoardInput(boardSession, boardMessage, getWorkspaceRoot()!, { attachments: boardAttachments });
      return res.json({ session: getCliSessionSummaryForTask(id) });
    } catch (error: unknown) {
      return res.status(500).json({ error: errorMessage(error, `Failed to send message to ${conversationLabel.toLowerCase()}`) });
    }
  }

  const task = getWorkspace().tasks[id];
  if (!task) return res.status(404).json({ error: 'Task not found' });

  const message = typeof req.body?.message === 'string' ? req.body.message.trim() : '';
  const user = typeof req.body?.user === 'string' && req.body.user.trim() ? req.body.user.trim() : 'Guy';
  const targetSessionId = typeof req.body?.sessionId === 'string' ? req.body.sessionId.trim() : undefined;
  // FLUX-674: a turn may carry pasted images; allow an image-only turn (empty text).
  const attachments = parseChatAttachments(req.body?.attachments);
  if (!message && attachments.length === 0) return res.status(400).json({ error: 'message is required' });

  // Allow targeting a specific session, or fall back role-aware: prefer the session the user is
  // actually addressing (supervisor lead / combiner / solo) over the most recently registered one —
  // in a scatter-gather run the delegates register AFTER the lead, so raw registration order would
  // resume a narrow-scope (possibly completed) worker instead of the lead.
  const sessionId = targetSessionId || getPreferredInputSessionId(id);
  if (!sessionId) return res.status(409).json({ error: 'No active CLI session for this ticket' });

  const session = cliSessionsById.get(sessionId);
  if (!session || !['running', 'waiting-input', 'scheduled', 'completed'].includes(session.status)) {
    return res.status(409).json({ error: 'CLI session is not resumable', session: getCliSessionSummaryForTask(id) || null });
  }
  // FLUX-1392: mirror the board branch's FLUX-714 guard (line ~1257) onto this ticket-session
  // branch, which had no equivalent. sendCliSessionInput sets status='running' before several
  // later awaited steps that can still throw (e.g. ensureSharedServersForRoot under resource
  // contention); if one does, the route's catch below returns 500 but status is left stuck at
  // 'running'. A caller that blindly retries on failure (furnace-stoker's postResumeInput) would
  // then re-POST into a session already 'running', spawning a second concurrent `claude --resume`
  // that races the first on the session JSONL and loses turns — the exact failure FLUX-714
  // prevented on the board branch. Reject here too instead of double-dispatching.
  if (session.status === 'running') {
    return res.status(409).json({ error: 'CLI session is mid-turn — wait for the current turn to finish.', session: getCliSessionSummaryForTask(id) || null });
  }

  let adapter;
  try {
    adapter = getAdapter(session.framework);
  } catch {
    return res.status(400).json({ error: `Unsupported framework: ${session.framework}` });
  }

  if (!session.resumeSessionId) {
    return res.status(409).json({ error: 'Session ID not yet available — wait for the initial response to complete' });
  }

  if (typeof req.body?.model === 'string') session.model = req.body.model.trim() || undefined;
  if (typeof req.body?.effortOverride === 'string') session.effortOverride = req.body.effortOverride.trim() || undefined;
  applyPermissionModeChange(session, req.body?.permissionMode, 'ticket');
  try {
    await adapter.sendInput(session, message, user, getWorkspaceRoot()!, { attachments });

    // Clear swimlane when user sends input (they answered the question)
    if (task.swimlane === 'require-input') {
      await updateTaskWithHistory(id, {
        entries: [
          { type: 'comment', user, comment: message, date: new Date().toISOString() },
          { type: 'swimlane_change', swimlane: 'require-input', action: 'cleared', user, date: new Date().toISOString() },
        ],
        updatedBy: user,
        extraFields: { swimlane: null },
      });
      broadcastEvent('taskUpdated', { id });
      dismissNotificationsForTicket(id);
    }

    res.json({ session: getCliSessionSummaryForTask(id) });
  } catch (error: unknown) {
    res.status(500).json({ error: errorMessage(error, 'Failed to send message to CLI session') });
  }
});

router.post('/:id/cli-session/stop', async (req, res) => {
  const { id } = req.params;

  // FLUX-604 / FLUX-1209: stop a virtual (non-ticket) conversation's session — the board
  // orchestrator or the Furnace-chat.
  if (isVirtualConversationId(id)) {
    const sid = cliSessionIdByTaskId.get(id);
    const boardSession = sid ? cliSessionsById.get(sid) : undefined;
    if (boardSession) {
      boardSession.requestedStop = true;
      // FLUX-910: tree-kill so the orchestrator's MCP child servers (serena, context7, the EH MCP
      // server) are reaped too — the board spawns the FULL toolset, so a raw proc.kill orphaned the
      // heaviest child tree (the stale-node-process leak). Mirrors the adapter stop() paths.
      killProcessTree(boardSession.proc);
      // A live turn's exit handler will terminalize a 'running' session; one parked at
      // 'waiting-input'/'pending' has no live proc, so terminalize it here (FLUX-667).
      if (boardSession.status === 'waiting-input' || boardSession.status === 'pending') {
        boardSession.status = 'cancelled';
        boardSession.endedAt = new Date().toISOString();
      } else if (boardSession.status === 'running') {
        // FLUX-915 (Finding 4): if the kill produces no exit (proc wedged / ignoring the signal on
        // POSIX), the exit handler never fires and the board would stay 'running' forever, 409-ing
        // every future start. Force-terminalize after a short grace if still running + stop-requested.
        const stalled = boardSession;
        const t = setTimeout(() => {
          if (stalled.requestedStop && stalled.status === 'running') {
            stalled.status = 'cancelled';
            stalled.endedAt = new Date().toISOString();
            broadcastEvent('taskUpdated', { id });
          }
        }, 5000);
        t.unref?.();
      }
    }
    // FLUX-910: broadcast synchronously so the UI reflects the stop immediately. The board path
    // previously broadcast nothing — the only signal was the proc exit handler, invisible if the
    // SSE stream stalled or the proc lingered.
    broadcastEvent('taskUpdated', { id });
    return res.json({ session: getCliSessionSummaryForTask(id) || null });
  }

  const task = getWorkspace().tasks[id];
  if (!task) return res.status(404).json({ error: 'Task not found' });

  const targetSessionId = typeof req.body?.sessionId === 'string' ? req.body.sessionId.trim() : undefined;
  const groupId = typeof req.body?.groupId === 'string' ? req.body.groupId.trim() : undefined;
  const stopAll = req.body?.stopAll === true;

  // ── Group / all stop: cancel every active session in scope in one request ──
  if (groupId || stopAll) {
    const candidates = groupId ? getSessionGroup(id, groupId) : getActiveSessionsForTask(id);
    const active = candidates.filter(s => ['pending', 'running', 'waiting-input', 'scheduled'].includes(s.status));
    if (active.length === 0) {
      return res.status(409).json({ error: 'No active sessions to stop', session: getCliSessionSummaryForTask(id) || null });
    }
    const now = new Date().toISOString();
    const stoppedLabels: string[] = [];
    for (const session of active) {
      session.requestedStop = true;
      session.status = 'cancelled';
      session.endedAt = now;
      stoppedLabels.push(session.label);
      try {
        getAdapter(session.framework).stop(session);
      } catch (error: unknown) {
        console.warn(`Failed to stop session ${session.id} for task ${id}:`, error instanceof Error ? error.message : error);
      }
    }
    await updateTaskWithHistory(id, {
      updatedBy: 'Agent',
      entries: [buildActivityEntry(
        active.length === 1
          ? `${stoppedLabels[0]} session stopped.`
          : `Stopped ${active.length} agent sessions (${stoppedLabels.join(', ')}).`,
        'Agent',
        now,
      )],
    });
    return res.json({ session: getCliSessionSummaryForTask(id) });
  }

  // Allow targeting a specific session, or fall back to most recent
  const sessionId = targetSessionId || cliSessionIdByTaskId.get(id);
  if (!sessionId) return res.status(404).json({ error: 'No CLI session found for this ticket' });

  const session = cliSessionsById.get(sessionId);
  if (!session) return res.status(404).json({ error: 'CLI session not available' });

  if (!['pending', 'running', 'waiting-input', 'scheduled'].includes(session.status)) {
    return res.status(409).json({ error: 'CLI session is already finished', session: getCliSessionSummaryForTask(id) || null });
  }

  let adapter;
  try {
    adapter = getAdapter(session.framework);
  } catch {
    return res.status(400).json({ error: `Unsupported framework: ${session.framework}` });
  }

  session.requestedStop = true;
  session.status = 'cancelled';
  session.endedAt = new Date().toISOString();
  await updateTaskWithHistory(id, {
    updatedBy: 'Agent',
    entries: [buildActivityEntry(`${session.label} session stopped.`, 'Agent', session.endedAt)],
  });
  try {
    adapter.stop(session);
    res.json({ session: getCliSessionSummaryForTask(id) });
  } catch (error: unknown) {
    res.status(500).json({ error: errorMessage(error, 'Failed to stop CLI session') });
  }
});

export default router;
