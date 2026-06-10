import { randomUUID } from 'crypto';
import { getWorkflowInstallStatus, checkSkillVersionStaleness, type Framework } from './workflow-installer.js';
import { workspaceRoot, resolveSkillSourceRoot } from './workspace.js';
import { broadcastEvent } from './events.js';

export type NotificationType = 'error' | 'prompt' | 'completion' | 'info';

export interface NotificationAction {
  label: string;
  actionId: string;
}

export interface Notification {
  id: string;
  type: NotificationType;
  title: string;
  message: string;
  ticketId?: string;
  framework?: string;
  actions: NotificationAction[];
  createdAt: string;
  read: boolean;
  dismissed: boolean;
}

const notifications: Notification[] = [];
const MAX_NOTIFICATIONS = 100;

export function clearNotifications(): void {
  notifications.length = 0;
}

export function getNotifications(): Notification[] {
  return notifications
    .filter(n => !n.dismissed)
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
    .slice(0, 50);
}

export function getUnreadCount(): number {
  return notifications.filter(n => !n.read && !n.dismissed).length;
}

export function markRead(id: string): boolean {
  const n = notifications.find(n => n.id === id);
  if (!n) return false;
  n.read = true;
  return true;
}

export function markAllRead(): void {
  for (const n of notifications) {
    n.read = true;
  }
}

export function dismissNotification(id: string): boolean {
  const n = notifications.find(n => n.id === id);
  if (!n) return false;
  n.dismissed = true;
  return true;
}

export function dismissNotificationsForTicket(ticketId: string): void {
  for (const n of notifications) {
    if (n.ticketId === ticketId && !n.dismissed) {
      n.dismissed = true;
    }
  }
}

export function addNotification(notification: Omit<Notification, 'id' | 'createdAt' | 'read' | 'dismissed'>): Notification {
  const entry: Notification = {
    ...notification,
    id: randomUUID(),
    createdAt: new Date().toISOString(),
    read: false,
    dismissed: false,
  };

  notifications.unshift(entry);

  if (notifications.length > MAX_NOTIFICATIONS) {
    notifications.splice(MAX_NOTIFICATIONS);
  }

  broadcastEvent('notification', { notification: entry, unreadCount: getUnreadCount() });
  return entry;
}

export function generatePromptNotification(ticketId: string, ticketTitle: string, status: string): void {
  const existing = notifications.find(
    n => n.type === 'prompt' && n.ticketId === ticketId && !n.dismissed
  );
  if (existing) {
    existing.message = `Status: ${status}`;
    existing.read = false;
    existing.createdAt = new Date().toISOString();
    broadcastEvent('notification', { notification: existing, unreadCount: getUnreadCount() });
    return;
  }

  addNotification({
    type: 'prompt',
    title: ticketTitle || ticketId,
    message: `Status: ${status}`,
    ticketId,
    actions: [{ label: 'View', actionId: 'view' }],
  });
}

export function generateCompletionNotification(ticketId: string, ticketTitle: string): void {
  addNotification({
    type: 'completion',
    title: ticketTitle || ticketId,
    message: 'Ticket completed',
    ticketId,
    actions: [{ label: 'View', actionId: 'view' }],
  });
}

export async function checkFrameworkHealth(framework: Framework): Promise<void> {
  if (!workspaceRoot) return;

  try {
    const status = await getWorkflowInstallStatus({
      sourceRoot: workspaceRoot,
      targetDir: workspaceRoot,
      framework,
    });

    if (status.workflowInstalled) return;

    const missing: string[] = [];
    if (!status.skillInstalled) missing.push('skills');
    if (status.instructionsInstalledPath && !status.instructionsInstalled) missing.push('instructions');

    if (missing.length === 0) return;

    const existing = notifications.find(
      n => n.type === 'error' && n.framework === status.framework && !n.dismissed
    );
    if (existing) return;

    addNotification({
      type: 'error',
      title: `${status.framework} integration incomplete`,
      message: `Missing: ${missing.join(', ')}. Agent may not function correctly.`,
      framework: status.framework,
      actions: [
        { label: 'Reinstall', actionId: 'reinstall' },
        { label: 'Dismiss', actionId: 'dismiss' },
      ],
    });
  } catch (err) {
    console.error(`[notifications] Health check failed for ${framework}:`, err);
  }
}

export async function checkSkillStaleness(framework: Framework): Promise<void> {
  if (!workspaceRoot) return;

  try {
    const sourceRoot = resolveSkillSourceRoot();
    const result = await checkSkillVersionStaleness({
      sourceRoot,
      targetDir: workspaceRoot,
      framework,
    });

    if (!result || !result.isStale) return;

    // Don't duplicate existing staleness notifications
    const existing = notifications.find(
      n => n.type === 'error' && n.title.includes('outdated') && !n.dismissed
    );
    if (existing) return;

    const installedLabel = result.installedVersion || 'unknown';
    const resolvedFramework = result.resolvedFramework;
    addNotification({
      type: 'error',
      title: 'Agent skills outdated',
      message: `Installed skills are v${installedLabel} but source is v${result.sourceVersion}. Agent may not follow current rules. Reinstall to update.`,
      framework: resolvedFramework,
      actions: [
        { label: 'Reinstall', actionId: 'reinstall' },
        { label: 'Dismiss', actionId: 'dismiss' },
      ],
    });

    console.warn(`[skills] Installed skills (v${installedLabel}) are outdated — source is v${result.sourceVersion}. Reinstall recommended.`);
  } catch (err) {
    console.error('[notifications] Skill staleness check failed:', err);
  }
}

export function getNotificationById(id: string): Notification | undefined {
  return notifications.find(n => n.id === id);
}
