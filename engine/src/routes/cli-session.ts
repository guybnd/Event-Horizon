import express from 'express';
import { randomUUID } from 'crypto';
import { workspaceRoot } from '../workspace.js';
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
  type PendingCombinerSpec,
  type PendingRelaySpec,
} from '../session-store.js';
import { getAdapter } from '../agents/index.js';
import { updateTaskWithHistory } from '../task-store.js';
import { resolvePersonaPrompt } from '../orchestration-personas.js';
import { buildActivityEntry } from '../history.js';
import { captureDiffForPrompt, type PromptDiffCapture } from '../branch-manager.js';
import type { CliSessionRecord, CliFramework, ExecutionPattern, PatternPosition, GroupVariant } from '../agents/types.js';

const router = express.Router();

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
  skipPermissions: boolean;
  role?: string;
  pattern?: ExecutionPattern;
  patternPosition?: PatternPosition;
  groupId?: string;
  groupSeq?: number;
  groupTotal?: number;
  groupType?: ExecutionPattern;
  groupVariant?: GroupVariant;
  lockedPaths?: string[];
  diffBlock?: string;
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
  if (opts.pattern) session.pattern = opts.pattern;
  if (opts.patternPosition && opts.patternPosition !== 'standalone') session.patternPosition = opts.patternPosition;
  if (opts.groupId) session.groupId = opts.groupId;
  if (opts.groupSeq != null) session.groupSeq = opts.groupSeq;
  if (opts.groupTotal != null) session.groupTotal = opts.groupTotal;
  if (opts.groupType) session.groupType = opts.groupType;
  if (opts.groupVariant) session.groupVariant = opts.groupVariant;
  if (opts.lockedPaths && opts.lockedPaths.length > 0) session.lockedPaths = opts.lockedPaths;
  if (opts.diffBlock) session.diffBlock = opts.diffBlock;

  cliSessionsById.set(sessionId, session);
  registerSession(task.id, sessionId);

  try {
    await adapter.start(session, task, opts.appendPrompt, opts.effortOverride, workspaceRoot!);
  } catch (error) {
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
  const task = tasksCache[id];
  if (!task) return res.status(404).json({ error: 'Task not found' });
  res.json({ session: getCliSessionSummaryForTask(id) || null });
});

// GET all sessions for a task
router.get('/:id/cli-sessions', (req, res) => {
  const { id } = req.params;
  const task = tasksCache[id];
  if (!task) return res.status(404).json({ error: 'Task not found' });
  res.json({ sessions: getAllSessionSummariesForTask(id) });
});

router.post('/:id/cli-session/start', async (req, res) => {
  const { id } = req.params;
  const task = tasksCache[id];
  if (!task) return res.status(404).json({ error: 'Task not found' });

  const frameworkRaw = String(req.body?.framework || 'claude').trim().toLowerCase();
  if (frameworkRaw !== 'claude' && frameworkRaw !== 'copilot' && frameworkRaw !== 'gemini') {
    return res.status(400).json({ error: 'framework must be claude, copilot or gemini' });
  }
  const framework = frameworkRaw as CliFramework;
  const skipPermissions = req.body?.skipPermissions !== false;
  const effortOverrideRaw = typeof req.body?.effortOverride === 'string' ? req.body.effortOverride.trim() : '';

  // Persona resolution: when a personaId is supplied the engine owns the prompt
  // text (it never ships to the client). A raw appendPrompt is still accepted
  // for ad-hoc, non-persona launches.
  const personaId = typeof req.body?.personaId === 'string' ? req.body.personaId.trim() : '';
  const focusComment = typeof req.body?.focusComment === 'string' ? req.body.focusComment.trim() : '';
  let appendPrompt = typeof req.body?.appendPrompt === 'string' ? req.body.appendPrompt.trim() : '';
  if (personaId) {
    const resolved = resolvePersonaPrompt(personaId, focusComment);
    if (!resolved) return res.status(400).json({ error: `Unknown personaId: ${personaId}` });
    appendPrompt = resolved;
  }

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
      return res.status(409).json({
        error: 'Task already has an active CLI session. Use role/pattern params for multi-session.',
        session: getCliSessionSummaryForTask(id),
      });
    }
  }

  try {
    getAdapter(framework);
  } catch {
    return res.status(400).json({ error: `Unsupported framework: ${framework}` });
  }

  try {
    // Inject pre-computed diff for scatter-gather review workers
    let diffBlock: string | undefined;
    if (groupType === 'scatter-gather' && patternPosition !== 'lead') {
      diffBlock = await computeDiffBlockForTask(task);
    }

    await spawnSession(task, {
      framework,
      appendPrompt,
      effortOverride: effortOverrideRaw,
      skipPermissions,
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

  const frameworkRaw = String(req.body?.framework || 'claude').trim().toLowerCase();
  if (frameworkRaw !== 'claude' && frameworkRaw !== 'copilot' && frameworkRaw !== 'gemini') {
    return res.status(400).json({ error: 'framework must be claude, copilot or gemini' });
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

  const frameworkRaw = String(req.body?.framework || 'claude').trim().toLowerCase();
  if (frameworkRaw !== 'claude' && frameworkRaw !== 'copilot' && frameworkRaw !== 'gemini') {
    return res.status(400).json({ error: 'framework must be claude, copilot or gemini' });
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

  const frameworkRaw = String(req.body?.framework || 'claude').trim().toLowerCase();
  if (frameworkRaw !== 'claude' && frameworkRaw !== 'copilot' && frameworkRaw !== 'gemini') {
    return res.status(400).json({ error: 'framework must be claude, copilot or gemini' });
  }
  const framework = frameworkRaw as CliFramework;
  const personaId = typeof req.body?.personaId === 'string' ? req.body.personaId.trim() : '';
  const taskPrompt = typeof req.body?.task === 'string' ? req.body.task.trim() : '';
  const focusComment = typeof req.body?.focusComment === 'string' ? req.body.focusComment.trim() : '';
  const effortOverride = typeof req.body?.effortOverride === 'string' ? req.body.effortOverride.trim() : '';
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

  let session: CliSessionRecord;
  try {
    session = await spawnSession(task, {
      framework,
      appendPrompt,
      effortOverride,
      skipPermissions,
      role: personaId ? `assistant:${personaId}` : 'assistant',
      pattern: 'supervisor',
      patternPosition: 'assistant',
      groupId,
      groupType: 'supervisor',
      groupVariant: 'combiner',
    });
  } catch (error: any) {
    return res.status(500).json({ error: error.message || 'Failed to spawn delegate' });
  }

  // Set up a race between delegation completion and timeout.
  const delegationPromise = awaitDelegation(session.id);
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
  const task = tasksCache[id];
  if (!task) return res.status(404).json({ error: 'Task not found' });

  const message = typeof req.body?.message === 'string' ? req.body.message.trim() : '';
  const user = typeof req.body?.user === 'string' && req.body.user.trim() ? req.body.user.trim() : 'Guy';
  const targetSessionId = typeof req.body?.sessionId === 'string' ? req.body.sessionId.trim() : undefined;
  if (!message) return res.status(400).json({ error: 'message is required' });

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

  if (!session.claudeSessionId) {
    return res.status(409).json({ error: 'Session ID not yet available — wait for the initial response to complete' });
  }

  try {
    await adapter.sendInput(session, message, user, workspaceRoot!);
    res.json({ session: getCliSessionSummaryForTask(id) });
  } catch (error: any) {
    res.status(500).json({ error: error.message || 'Failed to send message to CLI session' });
  }
});

router.post('/:id/cli-session/stop', async (req, res) => {
  const { id } = req.params;
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
