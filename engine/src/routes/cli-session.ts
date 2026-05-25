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
  checkPathConflicts,
  validatePatternSupport,
} from '../session-store.js';
import { getAdapter } from '../agents/index.js';
import { updateTaskWithHistory } from '../task-store.js';
import { buildActivityEntry } from '../history.js';
import type { CliSessionRecord, CliFramework, ExecutionPattern, PatternPosition } from '../agents/types.js';

const router = express.Router();

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
  const appendPrompt = typeof req.body?.appendPrompt === 'string' ? req.body.appendPrompt.trim() : '';
  const skipPermissions = req.body?.skipPermissions !== false;
  const effortOverrideRaw = typeof req.body?.effortOverride === 'string' ? req.body.effortOverride.trim() : '';

  // Multi-session fields
  const role = typeof req.body?.role === 'string' ? req.body.role.trim() : undefined;
  const pattern = typeof req.body?.pattern === 'string' ? req.body.pattern.trim() as ExecutionPattern : undefined;
  const patternPosition = typeof req.body?.patternPosition === 'string' ? req.body.patternPosition.trim() as PatternPosition : 'standalone';
  const lockedPaths: string[] = Array.isArray(req.body?.lockedPaths) ? req.body.lockedPaths : [];

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

  let adapter;
  try {
    adapter = getAdapter(framework);
  } catch {
    return res.status(400).json({ error: `Unsupported framework: ${framework}` });
  }

  const sessionId = randomUUID();
  const label = adapter.labelForFramework();
  const startedAt = new Date().toISOString();

  const session: CliSessionRecord = {
    id: sessionId,
    taskId: id,
    framework,
    status: 'pending',
    command: framework,
    args: [],
    startedAt,
    label,
    outputBuffer: '',
    liveOutputBuffer: '',
    pendingAssistantText: '',
    skipPermissions,
    requestedStop: false,
    writeQueue: Promise.resolve(),
    inputTokens: 0,
    outputTokens: 0,
    costUSD: 0,
  };
  if (role) session.role = role;
  if (pattern) session.pattern = pattern;
  if (patternPosition && patternPosition !== 'standalone') session.patternPosition = patternPosition;
  if (lockedPaths.length > 0) session.lockedPaths = lockedPaths;

  cliSessionsById.set(sessionId, session);
  registerSession(id, sessionId);

  try {
    await adapter.start(session, task, appendPrompt, effortOverrideRaw, workspaceRoot!);
    res.status(201).json({ session: getCliSessionSummaryForTask(id) });
  } catch (error: any) {
    unregisterSession(id, sessionId);
    cliSessionsById.delete(sessionId);
    res.status(500).json({ error: error.message || `Failed to launch ${label}` });
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
