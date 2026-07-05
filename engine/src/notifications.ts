import { randomUUID } from 'crypto';
import { getWorkflowInstallStatus, checkSkillVersionStaleness, detectWorkspaceFrameworks, type Framework, type ResolvedFramework } from './workflow-installer.js';
import { workspaceRoot, resolveSkillSourceRoot } from './workspace.js';
import { broadcastEvent } from './events.js';
import { configCache } from './config.js';

export type NotificationType = 'error' | 'prompt' | 'completion' | 'review' | 'info';

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

/**
 * FLUX-922 — a code review concluded with a recorded verdict (the reviewer handoff passes
 * `reviewState` to `change_status`: `approved` → Ready, `changes-requested` → In Progress). Emits a
 * first-class `review` notification so the verdict surfaces in the Updates panel, not only on the
 * card. Title-scoped dedup per ticket (like the prompt notification) so a re-review refreshes the
 * existing entry instead of stacking. The portal renders the verdict chip from the linked task's
 * `reviewState` (portal-derived, no payload field) — the title carries the verdict for text-only
 * surfaces (Electron toast).
 */
export function generateReviewNotification(ticketId: string, ticketTitle: string, verdict: 'approved' | 'changes-requested'): void {
  const approved = verdict === 'approved';
  const title = `Review ${approved ? 'approved' : 'changes requested'} — ${ticketTitle || ticketId}`;
  const message = approved
    ? 'The reviewer approved this ticket — ready to merge.'
    : 'The reviewer requested changes — open the review to see what to fix.';

  const existing = notifications.find(
    n => n.type === 'review' && n.ticketId === ticketId && !n.dismissed
  );
  if (existing) {
    existing.title = title;
    existing.message = message;
    existing.read = false;
    existing.createdAt = new Date().toISOString();
    broadcastEvent('notification', { notification: existing, unreadCount: getUnreadCount() });
    return;
  }

  addNotification({
    type: 'review',
    title,
    message,
    ticketId,
    actions: [{ label: 'View review', actionId: 'view' }],
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

/**
 * FLUX-895 — background sync can't authenticate to GitHub (git push/fetch credential
 * missing/expired). The login popup is suppressed (non-interactive git env), so this is
 * the channel that tells the user re-auth is needed and how — even when the sync indicator
 * isn't in view. Title-scoped dedup (it isn't ticket-bound) so repeated failures refresh
 * ONE entry instead of stacking; cleared automatically on the next successful sync via
 * {@link clearSyncAuthNotification}.
 */
const SYNC_AUTH_NOTIFICATION_TITLE = 'GitHub sign-in needed';

export function generateSyncAuthNotification(): void {
  const message =
    'Sync is paused — git push/fetch can’t authenticate to GitHub. Fix: run `gh auth login` then `gh auth setup-git`, then retry sync.';
  const existing = notifications.find(
    n => n.type === 'error' && n.title === SYNC_AUTH_NOTIFICATION_TITLE && !n.dismissed
  );
  if (existing) {
    existing.message = message;
    existing.read = false;
    existing.createdAt = new Date().toISOString();
    broadcastEvent('notification', { notification: existing, unreadCount: getUnreadCount() });
    return;
  }
  addNotification({
    type: 'error',
    title: SYNC_AUTH_NOTIFICATION_TITLE,
    message,
    actions: [
      { label: 'Retry sync', actionId: 'retry-sync' },
      { label: 'Dismiss', actionId: 'dismiss' },
    ],
  });
}

/** Dismiss the standing sync-auth notification (called on a successful sync — FLUX-895). */
export function clearSyncAuthNotification(): void {
  let changed = false;
  for (const n of notifications) {
    if (n.type === 'error' && n.title === SYNC_AUTH_NOTIFICATION_TITLE && !n.dismissed) {
      n.dismissed = true;
      changed = true;
    }
  }
  // Engine-internal clear (not a portal action) — broadcast so the bell/toast update.
  if (changed) broadcastEvent('notification', { notification: null, unreadCount: getUnreadCount() });
}

/**
 * FLUX-1076 — a flux-data merge conflict parks sync indefinitely until a human resolves it
 * (SyncStatusIndicator's little toolbar pill is the only other signal, and it's invisible
 * unless the portal happens to be open on that screen). A 2026-07-03 incident chain showed
 * this reads as "silent": the sync-status SSE state flipped to 'conflict' correctly, but
 * nothing persisted the fact anywhere a distracted/away user would see it, so the store sat
 * unmerged and fell 315+ commits behind before anyone noticed. Mirrors the auth notification
 * (FLUX-895) — same title-scoped dedup so a repeated detection refreshes ONE entry instead of
 * stacking; cleared on the next successful sync via {@link clearSyncConflictNotification}.
 */
const SYNC_CONFLICT_NOTIFICATION_TITLE = 'Sync conflict needs resolution';

export function generateSyncConflictNotification(conflictCount: number): void {
  const message =
    `Sync is paused — ${conflictCount} ticket file${conflictCount === 1 ? '' : 's'} have a merge ` +
    'conflict that needs resolution before sync can continue. Click the sync indicator to resolve.';
  const existing = notifications.find(
    n => n.type === 'error' && n.title === SYNC_CONFLICT_NOTIFICATION_TITLE && !n.dismissed
  );
  if (existing) {
    existing.message = message;
    existing.read = false;
    existing.createdAt = new Date().toISOString();
    broadcastEvent('notification', { notification: existing, unreadCount: getUnreadCount() });
    return;
  }
  addNotification({
    type: 'error',
    title: SYNC_CONFLICT_NOTIFICATION_TITLE,
    message,
    actions: [{ label: 'Dismiss', actionId: 'dismiss' }],
  });
}

/** Dismiss the standing sync-conflict notification (called once sync recovers — FLUX-1076). */
export function clearSyncConflictNotification(): void {
  let changed = false;
  for (const n of notifications) {
    if (n.type === 'error' && n.title === SYNC_CONFLICT_NOTIFICATION_TITLE && !n.dismissed) {
      n.dismissed = true;
      changed = true;
    }
  }
  if (changed) broadcastEvent('notification', { notification: null, unreadCount: getUnreadCount() });
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
    // Check EVERY framework the workspace uses (configured/primary + already-installed), not just the
    // single auto-resolved one. Otherwise a multi-framework workspace false-warns about whichever
    // framework auto-resolution happens to pick (e.g. `.github` → Copilot) while the framework the
    // user actually runs is current (FLUX-942). After the multi-framework reinstall on activation
    // none should be stale; this is the safety net that reports any that genuinely are.
    const frameworks = detectWorkspaceFrameworks(workspaceRoot, framework);
    const stale: { framework: ResolvedFramework; installed: string; source: string }[] = [];
    for (const fw of frameworks) {
      const result = await checkSkillVersionStaleness({ sourceRoot, targetDir: workspaceRoot, framework: fw });
      if (result?.isStale) {
        stale.push({
          framework: result.resolvedFramework,
          installed: result.installedVersion || 'unknown',
          source: result.sourceVersion,
        });
      }
    }

    if (stale.length === 0) return;

    // Don't duplicate existing staleness notifications
    const existing = notifications.find(
      n => n.type === 'error' && n.title.includes('outdated') && !n.dismissed
    );
    if (existing) return;

    const first = stale[0]!;
    const detail = stale.map(s => `${s.framework} v${s.installed}`).join(', ');
    const sourceVersion = first.source;
    addNotification({
      type: 'error',
      title: 'Agent skills outdated',
      message: `Outdated installed skills — ${detail} (source v${sourceVersion}). Reinstall to update.`,
      framework: first.framework,
      actions: [
        { label: 'Reinstall', actionId: 'reinstall' },
        { label: 'Dismiss', actionId: 'dismiss' },
      ],
    });

    console.warn(`[skills] Outdated installed skills — ${detail} (source v${sourceVersion}). Reinstall recommended.`);
  } catch (err) {
    console.error('[notifications] Skill staleness check failed:', err);
  }
}

export function getNotificationById(id: string): Notification | undefined {
  return notifications.find(n => n.id === id);
}
