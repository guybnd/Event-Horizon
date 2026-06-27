import { randomUUID } from 'crypto';
import { getWorkflowInstallStatus, checkSkillVersionStaleness, type Framework } from './workflow-installer.js';
import { workspaceRoot, resolveSkillSourceRoot } from './workspace.js';
import { broadcastEvent } from './events.js';
import { configCache } from './config.js';

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

export function markUnread(id: string): boolean {
  const n = notifications.find(n => n.id === id);
  if (!n) return false;
  n.read = false;
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
  // FLUX-777: pertinence by status. Require Input genuinely BLOCKS the agent on you → Action-needed
  // ('prompt'). "Ready" is a review hand-off, not a blocking question → lower-priority Update
  // ('info'), so it doesn't nag the bell the way a real "needs your input" does. (A real escaped
  // agent question is surfaced separately by the FLUX-570 safety-net in task-store, also as Action.)
  const readyStatus = configCache.readyForMergeStatus || 'Ready';
  const isReady = status.trim() === readyStatus;
  const type: NotificationType = isReady ? 'info' : 'prompt';
  const message = isReady ? 'Ready for your review.' : 'The agent needs your input to continue.';
  const title = ticketTitle || ticketId;

  // Title-scoped dedup so this never clobbers the distinct needs-action / escaped-question
  // notifications that share type 'prompt' + ticketId.
  const existing = notifications.find(
    n => n.type === type && n.ticketId === ticketId && n.title === title && !n.dismissed
  );
  if (existing) {
    existing.message = message;
    existing.read = false;
    existing.createdAt = new Date().toISOString();
    broadcastEvent('notification', { notification: existing, unreadCount: getUnreadCount() });
    return;
  }

  addNotification({ type, title, message, ticketId, actions: [{ label: 'View', actionId: 'view' }] });
}

/**
 * FLUX-651 — an agent ended its turn leaving the ticket parked in a working status without
 * taking a board action. Deduped per ticket (like the prompt notification) so repeated parked
 * turns refresh the existing entry instead of stacking.
 *
 * FLUX-827 — `message` lets the caller pass the same reason string already written to the
 * `needsAction` flag, so the toast matches the board reason (the soft resting-status backstop
 * and the `ask_user_question` timeout reuse this path, where the default hard-park wording reads
 * oddly). Falls back to the generic hard-park text when omitted.
 */
export function generateNeedsActionNotification(ticketId: string, ticketTitle: string, status: string, message?: string): void {
  message ??= `Agent stopped in "${status}" without moving the ticket forward — review and move it on (or resume).`;
  const existing = notifications.find(
    n => n.type === 'prompt' && n.ticketId === ticketId && n.title?.startsWith('Needs action') && !n.dismissed
  );
  if (existing) {
    existing.message = message;
    existing.read = false;
    existing.createdAt = new Date().toISOString();
    broadcastEvent('notification', { notification: existing, unreadCount: getUnreadCount() });
    return;
  }
  addNotification({
    type: 'prompt',
    title: `Needs action — ${ticketTitle || ticketId}`,
    message,
    ticketId,
    actions: [{ label: 'Open ticket', actionId: 'view' }],
  });
}

/**
 * FLUX-810 — the board orchestrator finished a clean assistant turn on the `__board__` chat
 * (i.e. answered the user). Unlike ticket sessions, the persistent orchestrator thread has no
 * cross-cutting signal pulling the user back. Emit a low-pertinence 'info' entry (a reply is an
 * update, not a blocking action — FLUX-777) deduped to ONE refreshing entry so repeated replies
 * don't stack. `'__board__'` is inlined (not imported from claude-code.ts) to avoid an import
 * cycle — that module already imports from here.
 */
export function generateOrchestratorReplyNotification(): void {
  const ticketId = '__board__';
  const message = 'The board orchestrator answered in the chat.';
  const existing = notifications.find(
    n => n.type === 'info' && n.ticketId === ticketId && !n.dismissed
  );
  if (existing) {
    existing.message = message;
    existing.read = false;
    existing.createdAt = new Date().toISOString();
    broadcastEvent('notification', { notification: existing, unreadCount: getUnreadCount() });
    return;
  }
  addNotification({
    type: 'info',
    title: 'Orchestrator replied',
    message,
    ticketId,
    actions: [{ label: 'Open chat', actionId: 'view' }],
  });
}

export function generateCompletionNotification(ticketId: string, ticketTitle: string): void {
  addNotification({
    type: 'completion',
    title: ticketTitle || ticketId,
    message: 'The agent finished this ticket — moved to Done.',
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
