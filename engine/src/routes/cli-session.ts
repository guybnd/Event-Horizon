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
  notifyGroupSessionTerminal,
  type PendingCombinerSpec,
} from '../session-store.js';
import { getAdapter } from '../agents/index.js';
import { updateTaskWithHistory } from '../task-store.js';
import { resolvePersonaPrompt } from '../orchestration-personas.js';
import { buildActivityEntry } from '../history.js';
import type { CliSessionRecord, CliFramework, ExecutionPattern, PatternPosition, GroupVariant } from '../agents/types.js';

const router = express.Router();

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
  groupType?: ExecutionPattern;
  groupVariant?: GroupVariant;
  lockedPaths?: string[];
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
  if (opts.groupType) session.groupType = opts.groupType;
  if (opts.groupVariant) session.groupVariant = opts.groupVariant;
  if (opts.lockedPaths && opts.lockedPaths.length > 0) session.lockedPaths = opts.lockedPaths;

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
      groupType,
      groupVariant,
      lockedPaths,
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
