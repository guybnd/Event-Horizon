import express from 'express';
import { randomUUID } from 'crypto';
import { workspaceRoot } from '../workspace.js';
import { configCache } from '../config.js';
import { tasksCache } from '../task-store.js';
import {
  cliSessionsById,
  cliSessionIdByTaskId,
  registerSession,
  unregisterSession,
  getCliSessionSummaryForTask,
  getAllSessionSummariesForTask,
  getActiveSessionsForTask,
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
import { BOARD_CONVERSATION_ID } from '../agents/board.js';
import { resolveAttachmentAbsPaths, attachmentReadInstruction, appendErrorToSession } from '../agents/shared.js';
import type { ChatAttachment } from '../projection.js';
import { updateTaskWithHistory } from '../task-store.js';
import { broadcastEvent } from '../events.js';
import { killProcessTree } from '../kill-process-tree.js';
import { appendTranscriptEvent, readTranscriptMessages, clearTranscript } from '../transcript.js';
import { resetBoardDigest } from '../board-digest.js';
import { dismissNotificationsForTicket } from '../notifications.js';
import { resolvePersonaPrompt, getPersonaById } from '../orchestration-personas.js';
import { ensureTicketIsolation } from '../ticket-isolation.js';
import { buildActivityEntry } from '../history.js';
import {
  captureDiffForPrompt,
  getMergeBase,
  isAncestor,
  resolveBaselineCommit,
  type PromptDiffCapture,
} from '../branch-manager.js';
import type { CliSessionRecord, CliFramework, ExecutionPattern, PatternPosition, GroupVariant, LaunchPhase } from '../agents/types.js';

const router = express.Router();

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
    ? configCache?.permissions?.boardDefault
    : configCache?.permissions?.ticketDefault;
  if (configured === 'gated' || configured === 'skip') return configured;
  return surface === 'board' ? 'gated' : 'skip';
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

async function computeDiffBlockForTask(task: any): Promise<string | undefined> {
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
  pattern?: ExecutionPattern | undefined;
  patternPosition?: PatternPosition | undefined;
  groupId?: string | undefined;
  groupSeq?: number | undefined;
  groupTotal?: number | undefined;
  groupType?: ExecutionPattern | undefined;
  groupVariant?: GroupVariant | undefined;
  lockedPaths?: string[] | undefined;
  diffBlock?: string | undefined;
}

/**
 * Build, register and launch one CLI session for a task. Shared by the start
 * route and the deferred-combiner launcher so both paths stay identical.
 */
async function spawnSession(task: any, opts: SpawnOptions): Promise<CliSessionRecord> {
  const adapter = getAdapter(opts.framework);
  const sessionId = randomUUID();
  const label = adapter.labelForFramework();
  const startedAt = new Date().toISOString();

  // Stamp baselineCommit at first session launch if missing. This is the review-diff anchor.
  // For a branch/PR ticket the anchor must be the branch's fork point from the default branch
  // (merge-base), NOT the engine's HEAD at launch — HEAD can sit on an unrelated sibling commit,
  // which made baseline..HEAD diffs surface phantom reversions (FLUX-585). resolveBaselineCommit
  // returns the merge-base for branch tickets and current HEAD for branch-less ones.
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
    const onBranch =
      (await isAncestor(task.baselineCommit, task.branch)) ||
      (await isAncestor(task.baselineCommit, `origin/${task.branch}`));
    if (!onBranch) {
      const mb = await getMergeBase(task.branch);
      if (mb && mb !== task.baselineCommit) {
        await updateTaskWithHistory(task.id, {
          updatedBy: 'Agent',
          extraFields: { baselineCommit: mb },
        });
        task.baselineCommit = mb;
      }
    }
  }

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
  if (opts.pattern) session.pattern = opts.pattern;
  if (opts.patternPosition && opts.patternPosition !== 'standalone') session.patternPosition = opts.patternPosition;
  if (opts.groupId) session.groupId = opts.groupId;
  if (opts.groupSeq != null) session.groupSeq = opts.groupSeq;
  if (opts.groupTotal != null) session.groupTotal = opts.groupTotal;
  if (opts.groupType) session.groupType = opts.groupType;
  if (opts.groupVariant) session.groupVariant = opts.groupVariant;
  if (opts.lockedPaths && opts.lockedPaths.length > 0) session.lockedPaths = opts.lockedPaths;
  if (opts.diffBlock) session.diffBlock = opts.diffBlock;
  if (opts.model) session.model = opts.model;
  if (opts.effortOverride) session.effortOverride = opts.effortOverride;
  if (opts.permissionMode) session.permissionMode = opts.permissionMode;

  cliSessionsById.set(sessionId, session);
  registerSession(task.id, sessionId);

  try {
    await adapter.start(session, task, opts.appendPrompt, opts.effortOverride, workspaceRoot!);
  } catch (error) {
    // FLUX-981: a pre-spawn failure (binary missing, worktree/isolation resolution error, etc.) throws
    // BEFORE any child process spawns, so the adapter's own proc.on('error') handler never runs — the
    // failure would otherwise be a portal-toast-only HTTP 500 with nothing in the chat. Surface it
    // inline (live `progress` SSE via appendErrorToSession) AND record a durable ticket activity entry.
    // Best-effort: never let the surfacing mask the original throw the caller must still see.
    const message = error instanceof Error ? error.message : String(error);
    try {
      appendErrorToSession(session, `Failed to start agent: ${message}`);
      await updateTaskWithHistory(task.id, {
        updatedBy: 'Agent',
        entries: [buildActivityEntry(`${label} session failed to start: ${message}`, 'Agent', new Date().toISOString())],
      });
    } catch {
      /* surfacing is best-effort */
    }
    unregisterSession(task.id, sessionId);
    cliSessionsById.delete(sessionId);
    throw error;
  }
  return session;
}

// Wire the deferred-combiner launcher: when a scatter-gather group's workers
// all finish, session-store calls this to spawn the combiner.
setCombinerLauncher(async (spec: PendingCombinerSpec, anyWorkerSucceeded: boolean) => {
  const task = tasksCache[spec.taskId];
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
  });
});

// Wire the relay step launcher: when a relay step finishes, session-store
// calls this to spawn the next step in the pipeline with the previous output.
setRelayStepLauncher(async (spec: PendingRelaySpec, previousOutput: string, previousSucceeded: boolean) => {
  const task = tasksCache[spec.taskId];
  if (!task) {
    console.warn(`Relay step for ${spec.groupId}: task ${spec.taskId} not found.`);
    return;
  }
  const step = spec.steps[spec.currentStep];
  if (!step) return;

  const resolved = resolvePersonaPrompt(step.personaId, step.focusComment);
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
    skipPermissions: spec.skipPermissions,
    role: step.role,
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
  if (id !== BOARD_CONVERSATION_ID && !tasksCache[id]) return res.status(404).json({ error: 'Task not found' });
  res.json({ session: getCliSessionSummaryForTask(id) || null });
});

// GET all sessions for a task
router.get('/:id/cli-sessions', (req, res) => {
  const { id } = req.params;
  const task = tasksCache[id];
  if (!task) return res.status(404).json({ error: 'Task not found' });
  res.json({ sessions: getAllSessionSummariesForTask(id) });
});

// FLUX-602: durable conversation transcript (raw tier) for the chat pane.
// Source of truth for rendering — persists across reopen/restart, unlike the
// in-memory live progress stream.
router.get('/:id/transcript', async (req, res) => {
  const { id } = req.params;
  if (id !== BOARD_CONVERSATION_ID && !tasksCache[id]) return res.status(404).json({ error: 'Task not found' });
  try {
    const messages = await readTranscriptMessages(id);
    res.json({ messages });
  } catch (err: any) {
    res.status(500).json({ error: err?.message || 'Failed to read transcript' });
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
  if (id !== BOARD_CONVERSATION_ID && !tasksCache[id]) return res.status(404).json({ error: 'Task not found' });
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
  } catch (err: any) {
    res.status(500).json({ error: err?.message || 'Failed to read activity' });
  }
});

// Clear a conversation's transcript — the orchestrator "reset". The caller stops any live
// session first; this just wipes the durable record. Broadcasting `taskUpdated` makes any
// open chat window refetch (and come back empty) without a reload.
router.delete('/:id/transcript', async (req, res) => {
  const { id } = req.params;
  if (id !== BOARD_CONVERSATION_ID && !tasksCache[id]) return res.status(404).json({ error: 'Task not found' });
  try {
    await clearTranscript(id);
    // FLUX-659: resetting the orchestrator conversation drops the digest delta baseline too, so the
    // next turn's "since last turn" starts clean rather than diffing against a wiped conversation.
    if (id === BOARD_CONVERSATION_ID) resetBoardDigest();
    broadcastEvent('taskUpdated', { id });
    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ error: err?.message || 'Failed to clear transcript' });
  }
});

router.post('/:id/cli-session/start', async (req, res) => {
  const { id } = req.params;

  // FLUX-604: board-level orchestrator session — not bound to any ticket.
  if (id === BOARD_CONVERSATION_ID) {
    const firstMessage = typeof req.body?.appendPrompt === 'string' ? req.body.appendPrompt.trim() : '';
    // FLUX-676: the opening turn may carry pasted images; allow an image-only turn (empty text).
    const chatAttachments = parseChatAttachments(req.body?.attachments);
    if (!firstMessage && chatAttachments.length === 0) return res.status(400).json({ error: 'appendPrompt (first message) is required for the orchestrator chat' });
    const existingId = cliSessionIdByTaskId.get(BOARD_CONVERSATION_ID);
    const existing = existingId ? cliSessionsById.get(existingId) : undefined;
    // Block only while a turn is genuinely IN FLIGHT (a live proc is running). A session parked
    // at 'waiting-input' is idle — claude -p already exited — so a fresh start should supersede
    // it rather than 409. The frontend prefers resume for a resumable parked session; when it
    // falls back to start (e.g. the parked turn never captured a resumeSessionId and so isn't
    // resumable), this lets a fresh orchestrator turn through instead of wedging forever (FLUX-667).
    if (existing && (existing.status === 'running' || existing.status === 'pending')) {
      return res.status(409).json({ error: 'Orchestrator session already active', session: getCliSessionSummaryForTask(BOARD_CONVERSATION_ID) });
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
      taskId: BOARD_CONVERSATION_ID,
      framework: fw,
      status: 'pending',
      command: fw,
      args: [],
      startedAt: new Date().toISOString(),
      label: 'Orchestrator',
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
    };
    cliSessionsById.set(boardSession.id, boardSession);
    registerSession(BOARD_CONVERSATION_ID, boardSession.id);
    if (typeof req.body?.model === 'string' && req.body.model.trim()) boardSession.model = req.body.model.trim();
    if (typeof req.body?.effortOverride === 'string' && req.body.effortOverride.trim()) boardSession.effortOverride = req.body.effortOverride.trim();
    // Orchestrator default comes from the workspace risk-tolerance setting (board default
    // gated); an explicit per-chat Perms choice overrides it. (FLUX-605)
    boardSession.permissionMode = resolvePermissionMode(
      req.body?.permissionMode === 'gated' || req.body?.permissionMode === 'skip' ? req.body.permissionMode : undefined,
      'board',
    );
    try {
      await getBoardAdapter(fw).startBoardSession(boardSession, firstMessage, workspaceRoot!, { attachments: chatAttachments });
      return res.status(201).json({ session: getCliSessionSummaryForTask(BOARD_CONVERSATION_ID) });
    } catch (error: any) {
      unregisterSession(BOARD_CONVERSATION_ID, boardSession.id);
      cliSessionsById.delete(boardSession.id);
      return res.status(500).json({ error: error.message || 'Failed to start orchestrator session' });
    }
  }

  const task = tasksCache[id];
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

  // Persona resolution: when a personaId is supplied the engine owns the prompt
  // text (it never ships to the client). A raw appendPrompt is still accepted
  // for ad-hoc, non-persona launches.
  const personaId = typeof req.body?.personaId === 'string' ? req.body.personaId.trim() : '';
  const focusComment = typeof req.body?.focusComment === 'string' ? req.body.focusComment.trim() : '';
  const launchedBy = typeof req.body?.user === 'string' && req.body.user.trim() ? req.body.user.trim() : 'User';
  let appendPrompt = typeof req.body?.appendPrompt === 'string' ? req.body.appendPrompt.trim() : '';
  if (personaId) {
    const resolved = resolvePersonaPrompt(personaId, focusComment);
    if (!resolved) return res.status(400).json({ error: `Unknown personaId: ${personaId}` });
    appendPrompt = resolved;
  }

  // Launch phase / intent (portal tells engine why this session exists).
  // Validate against the known set so an arbitrary value never lands on the session record;
  // an unrecognized phase is ignored (buildInitialPrompt falls back to status-based logic).
  const VALID_PHASES: LaunchPhase[] = ['grooming', 'implementation', 'review', 'finalize', 'chat'];
  const phaseRaw = typeof req.body?.phase === 'string' ? req.body.phase.trim() : '';
  const phase: LaunchPhase | undefined = (VALID_PHASES as string[]).includes(phaseRaw)
    ? (phaseRaw as LaunchPhase)
    : undefined;

  // FLUX-845: server-side isolation policy. Agent-driven dispatch (start_session / board-rebase)
  // has no human to choose a branch, so it requests isolation here and the engine creates the
  // branch (+worktree) BEFORE spawning — otherwise the session runs branchless in the shared
  // checkout (the FLUX-840/841/844 tangle). 'worktree' → dedicated worktree (the default for
  // agent callers); 'branch' → branch only; omitted → no server-side isolation (the portal
  // pre-creates its own branch client-side and omits this).
  const isolationRaw = typeof req.body?.isolation === 'string' ? req.body.isolation.trim() : '';
  const isolation: 'worktree' | 'branch' | undefined =
    isolationRaw === 'worktree' || isolationRaw === 'branch' ? isolationRaw : undefined;

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

  // Only block if there's already an active standalone (legacy single-session) session without a role
  const activeSessions = getActiveSessionsForTask(id);
  if (!role && activeSessions.length > 0) {
    const blockingSession = activeSessions.find(s => !s.role);
    if (blockingSession) {
      // FLUX-915: a session parked at waiting-input with NO resumeSessionId can never resume (the
      // input route 409s on a missing session id) yet counts as active and reconcileDeadSessions
      // skips waiting-input — a permanent wedge (the per-ticket twin of the board's FLUX-667
      // self-heal). Terminalize it so a fresh start supersedes it instead of 409-ing forever. A
      // genuinely resumable parked session (has resumeSessionId) still blocks — the user should
      // send input to it, not spawn a duplicate.
      if (blockingSession.status === 'waiting-input' && !blockingSession.resumeSessionId) {
        blockingSession.status = 'cancelled';
        blockingSession.endedAt = new Date().toISOString();
      } else {
        return res.status(409).json({
          error: 'Task already has an active CLI session. Use role/pattern params for multi-session.',
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
    // FLUX-845: isolate BEFORE spawning so resolveTaskExecutionRoot lands the session in the
    // dedicated worktree (the canonical mechanism, shared with create_branch + the /branch route).
    // Idempotent: a ticket that already has a branch is reused, never re-created.
    if (isolation) {
      await ensureTicketIsolation(id, { worktree: isolation === 'worktree' });
    }

    // Inject pre-computed diff for scatter-gather review workers
    let diffBlock: string | undefined;
    if (groupType === 'scatter-gather' && patternPosition !== 'lead') {
      diffBlock = await computeDiffBlockForTask(task);
    }

    await spawnSession(task, {
      framework,
      appendPrompt: spawnAppendPrompt,
      effortOverride: effortOverrideRaw,
      model: modelRaw,
      // Per-chat Perms choice wins; otherwise inherit the workspace ticket default
      // (risk-tolerance setting, default skip). (FLUX-605)
      permissionMode: resolvePermissionMode(permissionModeRaw, 'ticket'),
      skipPermissions,
      phase,
      role,
      pattern,
      patternPosition,
      groupId,
      groupSeq,
      groupTotal,
      groupType,
      groupVariant,
      lockedPaths,
      diffBlock,
    });
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
      } catch (focusErr: any) {
        console.warn(`[cli-session] Failed to persist launch focus for ${id}: ${focusErr?.message || focusErr}`);
      }
    }
    res.status(201).json({ session: getCliSessionSummaryForTask(id) });
  } catch (error: any) {
    res.status(500).json({ error: error.message || `Failed to launch ${framework}` });
  }
});

// Register a deferred combiner: stored against a run group's groupId and spawned
// only once every worker ("step") session in that group reaches a terminal state.
router.post('/:id/cli-session/register-combiner', (req, res) => {
  const { id } = req.params;
  const task = tasksCache[id];
  if (!task) return res.status(404).json({ error: 'Task not found' });

  const frameworkRaw = String(req.body?.framework || resolveDefaultFramework()).trim().toLowerCase();
  // FLUX-984: registry-backed (isKnownFramework), not a hardcoded literal list.
  if (!isKnownFramework(frameworkRaw)) {
    return res.status(400).json({ error: `framework must be one of: ${getRuntimeFrameworks().join(', ')}` });
  }
  const groupId = typeof req.body?.groupId === 'string' ? req.body.groupId.trim() : '';
  const role = typeof req.body?.role === 'string' ? req.body.role.trim() : '';
  // Persona resolution mirrors the start route: a personaId resolves the prompt
  // server-side; a raw appendPrompt is the fallback for ad-hoc combiners.
  const personaId = typeof req.body?.personaId === 'string' ? req.body.personaId.trim() : '';
  const focusComment = typeof req.body?.focusComment === 'string' ? req.body.focusComment.trim() : '';
  let appendPrompt = typeof req.body?.appendPrompt === 'string' ? req.body.appendPrompt.trim() : '';
  if (personaId) {
    const resolved = resolvePersonaPrompt(personaId, focusComment);
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
  const task = tasksCache[id];
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
  const task = tasksCache[id];
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

  const spec: PendingRelaySpec = {
    taskId: id,
    groupId,
    framework: frameworkRaw as CliFramework,
    skipPermissions,
    effortOverride,
    groupType: 'relay',
    steps,
    currentStep: 0,
  };
  registerPendingRelay(spec);
  res.status(201).json({ registered: true, groupId, totalSteps: steps.length });
});

// Cancel a pending relay pipeline (e.g. when step 0 fails to launch).
router.post('/:id/cli-session/unregister-relay', (req, res) => {
  const { id } = req.params;
  const task = tasksCache[id];
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
  const task = tasksCache[id];
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

  // Build the child's prompt: persona prompt (if any) + delegation task
  let appendPrompt = '';
  const persona = personaId ? getPersonaById(personaId) : undefined;
  if (personaId) {
    const resolved = resolvePersonaPrompt(personaId, focusComment);
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
    } catch (error: any) {
      return res.status(500).json({ error: error.message || 'Delegation failed' });
    }
  }

  // FLUX-844: reserve the idempotency key BEFORE spawn so a retry that lands
  // *during* spawnSession() attaches to this reservation instead of launching a
  // second child. The reservation holds a deferred promise; we fill in the real
  // sessionId and settle it once the delegation resolves, or fail it (releasing
  // the key) if spawn itself errors so a genuine later retry can start fresh.
  const reservation = reserveDispatch(idempotencyKey);

  // FLUX-482: resolve the delegate's model with precedence:
  //   per-call `model` param  >  persona.model  >  config.delegateModel  >  undefined.
  // Leaving it undefined makes the adapter fall back to its status-derived
  // grooming/implementation model (unchanged default behavior). Cheap personas
  // (search/grooming/doc/review-reading) carry persona.model='sonnet'; code-writing
  // personas carry none, so they keep the strong implementation model.
  //
  // Claude-only for now: the resolved model is threaded onto session.model, which
  // is currently honored ONLY by the Claude adapter (claude-code.ts: `session.model
  // || selectedModel`). The Gemini and Copilot adapters read their own configured
  // grooming/implementation model and ignore session.model, and persona.model='sonnet'
  // is a Claude alias meaningless to them. So we gate the override to framework
  // 'claude' — on Gemini/Copilot it stays undefined (no behavior change, and no risk
  // of pushing a Claude alias onto a --model arg). Generalizing the adapters to honor
  // session.model with a cheap/strong tier abstraction is tracked in FLUX-931.
  const configDelegateModel = typeof (configCache as any)?.integrations?.claudeCode?.delegateModel === 'string'
    ? (configCache as any).integrations.claudeCode.delegateModel.trim()
    : '';
  const resolvedModel = framework === 'claude'
    ? (modelOverride || persona?.model || configDelegateModel || undefined)
    : undefined;

  // FLUX-482: thread the persona's phase so the child's prompt/MCP-server scoping
  // matches the delegated role (e.g. a grooming scout gets the grooming server set).
  // Persona.phases are workflow Phases, a strict subset of LaunchPhase (which adds
  // 'chat'), so the first one is already a valid LaunchPhase.
  const delegatePhase: LaunchPhase | undefined = persona?.phases?.[0];

  let session: CliSessionRecord;
  try {
    session = await spawnSession(task, {
      framework,
      appendPrompt,
      effortOverride,
      ...(resolvedModel ? { model: resolvedModel } : {}),
      ...(delegatePhase ? { phase: delegatePhase } : {}),
      skipPermissions,
      role: personaId ? `assistant:${personaId}` : 'assistant',
      pattern: 'supervisor',
      patternPosition: 'assistant',
      groupId,
      groupType: 'supervisor',
      groupVariant: 'combiner',
    });
  } catch (error: any) {
    reservation.fail(error);
    return res.status(500).json({ error: error.message || 'Failed to spawn delegate' });
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
    if (childSession && ['pending', 'running', 'waiting-input'].includes(childSession.status)) {
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
  } catch (error: any) {
    clearTimeout(timeoutId);
    res.status(500).json({ error: error.message || 'Delegation failed' });
  }
});

router.post('/:id/cli-session/input', async (req, res) => {
  const { id } = req.params;

  // FLUX-604: orchestrator follow-up turn.
  if (id === BOARD_CONVERSATION_ID) {
    const boardMessage = typeof req.body?.message === 'string' ? req.body.message.trim() : '';
    // FLUX-676: a turn may carry pasted images; allow an image-only turn (empty text).
    const boardAttachments = parseChatAttachments(req.body?.attachments);
    if (!boardMessage && boardAttachments.length === 0) return res.status(400).json({ error: 'message is required' });
    const sid = cliSessionIdByTaskId.get(BOARD_CONVERSATION_ID);
    const boardSession = sid ? cliSessionsById.get(sid) : undefined;
    if (!boardSession) return res.status(409).json({ error: 'No orchestrator session — start one first' });
    // FLUX-714: a turn already in flight must not be double-sent. A second resume against the same
    // resumeSessionId spawns a concurrent `claude --resume` that races the first on the session
    // JSONL and loses turns. Mirror the start-path guard (line ~347): 409 while genuinely running.
    if (boardSession.status === 'running' || boardSession.status === 'pending') {
      return res.status(409).json({ error: 'Orchestrator is mid-turn — wait for the current turn to finish.', session: getCliSessionSummaryForTask(BOARD_CONVERSATION_ID) });
    }
    if (!boardSession.resumeSessionId) {
      return res.status(409).json({ error: 'Session ID not yet available — wait for the initial response to complete' });
    }
    if (typeof req.body?.model === 'string') boardSession.model = req.body.model.trim() || undefined;
    if (typeof req.body?.effortOverride === 'string') boardSession.effortOverride = req.body.effortOverride.trim() || undefined;
    if (req.body?.permissionMode === 'gated' || req.body?.permissionMode === 'skip') boardSession.permissionMode = req.body.permissionMode;
    try {
      // FLUX-959: framework is fixed for a board session's life — resolve via the session
      // record, not the request (resumeSessionId is CLI-specific; switching = a new session).
      await getBoardAdapter(boardSession.framework).sendBoardInput(boardSession, boardMessage, workspaceRoot!, { attachments: boardAttachments });
      return res.json({ session: getCliSessionSummaryForTask(BOARD_CONVERSATION_ID) });
    } catch (error: any) {
      return res.status(500).json({ error: error.message || 'Failed to send message to orchestrator' });
    }
  }

  const task = tasksCache[id];
  if (!task) return res.status(404).json({ error: 'Task not found' });

  const message = typeof req.body?.message === 'string' ? req.body.message.trim() : '';
  const user = typeof req.body?.user === 'string' && req.body.user.trim() ? req.body.user.trim() : 'Guy';
  const targetSessionId = typeof req.body?.sessionId === 'string' ? req.body.sessionId.trim() : undefined;
  // FLUX-674: a turn may carry pasted images; allow an image-only turn (empty text).
  const attachments = parseChatAttachments(req.body?.attachments);
  if (!message && attachments.length === 0) return res.status(400).json({ error: 'message is required' });

  // Allow targeting a specific session, or fall back to most recent active
  const sessionId = targetSessionId || cliSessionIdByTaskId.get(id);
  if (!sessionId) return res.status(409).json({ error: 'No active CLI session for this ticket' });

  const session = cliSessionsById.get(sessionId);
  if (!session || !['running', 'waiting-input', 'completed'].includes(session.status)) {
    return res.status(409).json({ error: 'CLI session is not resumable', session: getCliSessionSummaryForTask(id) || null });
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
  if (req.body?.permissionMode === 'gated' || req.body?.permissionMode === 'skip') session.permissionMode = req.body.permissionMode;
  try {
    await adapter.sendInput(session, message, user, workspaceRoot!, { attachments });

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
  } catch (error: any) {
    res.status(500).json({ error: error.message || 'Failed to send message to CLI session' });
  }
});

router.post('/:id/cli-session/stop', async (req, res) => {
  const { id } = req.params;

  // FLUX-604: stop the orchestrator session.
  if (id === BOARD_CONVERSATION_ID) {
    const sid = cliSessionIdByTaskId.get(BOARD_CONVERSATION_ID);
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
            broadcastEvent('taskUpdated', { id: BOARD_CONVERSATION_ID });
          }
        }, 5000);
        t.unref?.();
      }
    }
    // FLUX-910: broadcast synchronously so the UI reflects the stop immediately. The board path
    // previously broadcast nothing — the only signal was the proc exit handler, invisible if the
    // SSE stream stalled or the proc lingered.
    broadcastEvent('taskUpdated', { id: BOARD_CONVERSATION_ID });
    return res.json({ session: getCliSessionSummaryForTask(BOARD_CONVERSATION_ID) || null });
  }

  const task = tasksCache[id];
  if (!task) return res.status(404).json({ error: 'Task not found' });

  const targetSessionId = typeof req.body?.sessionId === 'string' ? req.body.sessionId.trim() : undefined;
  const groupId = typeof req.body?.groupId === 'string' ? req.body.groupId.trim() : undefined;
  const stopAll = req.body?.stopAll === true;

  // ── Group / all stop: cancel every active session in scope in one request ──
  if (groupId || stopAll) {
    const candidates = groupId ? getSessionGroup(id, groupId) : getActiveSessionsForTask(id);
    const active = candidates.filter(s => ['pending', 'running', 'waiting-input'].includes(s.status));
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
      } catch (error: any) {
        console.warn(`Failed to stop session ${session.id} for task ${id}:`, error?.message || error);
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

  if (!['pending', 'running', 'waiting-input'].includes(session.status)) {
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
  } catch (error: any) {
    res.status(500).json({ error: error.message || 'Failed to stop CLI session' });
  }
});

export default router;
