import express from 'express';
import {
  getNotifications,
  getUnreadCount,
  markRead,
  markAllRead,
  dismissNotification,
  getNotificationById,
  checkFrameworkHealth,
} from '../notifications.js';
import { installWorkspaceWorkflow, type Framework } from '../workflow-installer.js';
import { workspaceRoot } from '../workspace.js';

const router = express.Router();

router.get('/', (_req, res) => {
  res.json({
    notifications: getNotifications(),
    unreadCount: getUnreadCount(),
  });
});

router.post('/read-all', (_req, res) => {
  markAllRead();
  res.json({ ok: true });
});

router.post('/check-health', async (req, res) => {
  const { framework = 'auto' } = req.body || {};
  await checkFrameworkHealth(framework as Framework);
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
      const result = await installWorkspaceWorkflow({
        sourceRoot: workspaceRoot,
        targetDir: workspaceRoot,
        framework: notification.framework as Framework,
      });
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

  res.status(400).json({ error: `Unknown action: ${actionId}` });
});

export default router;
