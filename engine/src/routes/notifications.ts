import express from 'express';
import {
  getNotifications,
  getUnreadCount,
  markRead,
  markAllRead,
  dismissNotification,
  getNotificationById,
  checkFrameworkHealth,
  checkSkillStaleness,
} from '../notifications.js';
import { installWorkspaceWorkflow, checkSkillVersionStaleness, type Framework } from '../workflow-installer.js';
import { workspaceRoot, resolveSkillSourceRoot } from '../workspace.js';
import { broadcastEvent } from '../events.js';
import { tasksCache } from '../task-store.js';
import { findWorktreeForBranch } from '../task-worktree.js';
import { isEditorAvailable, openEditorWindow } from '../editor-launcher.js';
import { cleanupMergedBranch } from '../pr-cleanup.js';

const router = express.Router();

router.get('/', (_req, res) => {
  res.json({
    notifications: getNotifications(),
    unreadCount: getUnreadCount(),
  });
});

router.post('/read-all', (_req, res) => {
  markAllRead();
  broadcastEvent('notification', { notification: null, unreadCount: 0 });
  res.json({ ok: true });
});

router.post('/check-health', async (req, res) => {
  const { framework = 'auto' } = req.body || {};
  await checkFrameworkHealth(framework as Framework);
  await checkSkillStaleness(framework as Framework);
  res.json({ ok: true });
});

router.post('/:id/read', (req, res) => {
  const success = markRead(req.params.id);
  if (!success) return res.status(404).json({ error: 'Notification not found' });
  res.json({ ok: true });
});

router.post('/:id/dismiss', (req, res) => {
  const success = dismissNotification(req.params.id);
  if (!success) return res.status(404).json({ error: 'Notification not found' });
  res.json({ ok: true });
});

router.post('/:id/action', async (req, res) => {
  const { actionId } = req.body || {};
  const notification = getNotificationById(req.params.id);

  if (!notification) return res.status(404).json({ error: 'Notification not found' });
  if (!actionId) return res.status(400).json({ error: 'actionId required' });

  if (actionId === 'dismiss') {
    dismissNotification(notification.id);
    return res.json({ ok: true, action: 'dismissed' });
  }

  if (actionId === 'reinstall' && notification.framework && workspaceRoot) {
    try {
      const sourceRoot = resolveSkillSourceRoot();
      const result = await installWorkspaceWorkflow({
        sourceRoot,
        targetDir: workspaceRoot,
        framework: notification.framework as Framework,
      });
      const verify = await checkSkillVersionStaleness({ sourceRoot, targetDir: workspaceRoot, framework: notification.framework as Framework });
      if (verify?.isStale) {
        return res.status(500).json({ error: `Reinstall wrote files but skills are still stale (installed: v${verify.installedVersion}, source: v${verify.sourceVersion}). Check path resolution.` });
      }
      dismissNotification(notification.id);
      return res.json({ ok: true, action: 'reinstalled', result });
    } catch (err: any) {
      return res.status(500).json({ error: err.message || 'Reinstall failed' });
    }
  }

  if (actionId === 'view') {
    markRead(notification.id);
    return res.json({ ok: true, action: 'viewed', ticketId: notification.ticketId });
  }

  // Post-merge worktree cleanup notifications (FLUX-557). Both resolve the branch via the
  // notification's ticket, since the cleanup is branch-scoped.
  if ((actionId === 'cleanup-worktree' || actionId === 'open-worktree') && notification.ticketId && workspaceRoot) {
    const task = tasksCache[notification.ticketId] as any;
    const branch: string | undefined = task?.branch;
    if (!branch) return res.status(409).json({ error: 'Ticket no longer has a branch to clean up.' });

    if (actionId === 'open-worktree') {
      const worktree = await findWorktreeForBranch(workspaceRoot, branch).catch(() => null);
      if (!worktree) return res.status(404).json({ error: 'Worktree no longer exists.' });
      const opened = await isEditorAvailable();
      if (opened) openEditorWindow(worktree);
      return res.json({ ok: true, action: 'opened-worktree', worktree, opened });
    }

    // cleanup-worktree: re-run the safe teardown now that the user has resolved the tree.
    // Still dirty → cleanupMergedBranch re-raises its own notification; dismiss this stale one.
    const result = await cleanupMergedBranch(workspaceRoot, branch);
    dismissNotification(notification.id);
    return res.json({ ok: true, action: 'cleaned-worktree', result });
  }

  res.status(400).json({ error: `Unknown action: ${actionId}` });
});

export default router;
