import express from 'express';
import { randomUUID } from 'crypto';
import { workspaceRoot } from '../workspace.js';
import { tasksCache } from '../task-store.js';
import { cliSessionsById, cliSessionIdByTaskId, getCliSessionSummaryForTask } from '../session-store.js';
import { getAdapter } from '../agents/index.js';
import { updateTaskWithHistory } from '../task-store.js';
import { buildActivityEntry } from '../history.js';
import type { CliSessionRecord } from '../agents/types.js';

const router = express.Router();

router.get('/:id/cli-session', (req, res) => {
  const { id } = req.params;
  const task = tasksCache[id];
  if (!task) return res.status(404).json({ error: 'Task not found' });
  res.json({ session: getCliSessionSummaryForTask(id) || null });
});

router.post('/:id/cli-session/start', async (req, res) => {
  const { id } = req.params;
  const task = tasksCache[id];
  if (!task) return res.status(404).json({ error: 'Task not found' });

  const frameworkRaw = String(req.body?.framework || '').trim().toLowerCase();
  if (frameworkRaw !== 'claude' && frameworkRaw !== 'copilot') {
    return res.status(400).json({ error: 'framework must be claude or copilot' });
  }
  const framework = frameworkRaw as 'claude' | 'copilot';
  const appendPrompt = typeof req.body?.appendPrompt === 'string' ? req.body.appendPrompt.trim() : '';
  const skipPermissions = req.body?.skipPermissions !== false;
  const effortOverrideRaw = typeof req.body?.effortOverride === 'string' ? req.body.effortOverride.trim() : '';

  const existingSessionId = cliSessionIdByTaskId.get(id);
  if (existingSessionId) {
    const existingSession = cliSessionsById.get(existingSessionId);
    if (existingSession && ['pending', 'running', 'waiting-input'].includes(existingSession.status)) {
      return res.status(409).json({ error: 'Task already has an active CLI session', session: getCliSessionSummaryForTask(id) });
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

  cliSessionsById.set(sessionId, session);
  cliSessionIdByTaskId.set(id, sessionId);

  try {
    await adapter.start(session, task, appendPrompt, effortOverrideRaw, workspaceRoot!);
    res.status(201).json({ session: getCliSessionSummaryForTask(id) });
  } catch (error: any) {
    cliSessionIdByTaskId.delete(id);
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
  if (!message) return res.status(400).json({ error: 'message is required' });

  const sessionId = cliSessionIdByTaskId.get(id);
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

  const sessionId = cliSessionIdByTaskId.get(id);
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
