import type { Task, Config, Doc, CliFramework, CliSessionSummary } from './types';

export const API_URL = '/api';

function encodeDocPath(docPath: string) {
  return docPath.split('/').map((segment) => encodeURIComponent(segment)).join('/');
}

export async function fetchTasks(): Promise<Task[]> {
  const res = await fetch(`${API_URL}/tasks`);
  if (!res.ok) throw new Error('Failed to fetch tasks');
  return res.json();
}

export interface ParseError {
  id: string;
  path: string;
  error: string;
}

export async function fetchParseErrors(): Promise<ParseError[]> {
  const res = await fetch(`${API_URL}/tasks/errors`);
  if (!res.ok) throw new Error('Failed to fetch parse errors');
  return res.json();
}

export async function fetchTask(id: string): Promise<Task> {
  const res = await fetch(`${API_URL}/tasks/${id}`);
  if (!res.ok) throw new Error('Failed to fetch task');
  return res.json();
}

export async function updateTask(id: string, updates: Partial<Task>): Promise<Task> {
  const res = await fetch(`${API_URL}/tasks/${id}`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(updates)
  });
  if (!res.ok) {
    let message = 'Failed to update task';
    try {
      const errorPayload = await res.json();
      if (errorPayload.message) message = errorPayload.message;
      else if (errorPayload.error) message = errorPayload.error;
    } catch {
      // ignore
    }
    throw new Error(message);
  }
  return res.json();
}

export interface TaskAssetUploadResult {
  path: string;
  fileName: string;
  url: string;
}

export async function uploadTaskAsset(id: string, payload: { fileName: string; mimeType: string; content: string }): Promise<TaskAssetUploadResult> {
  const res = await fetch(`${API_URL}/tasks/${id}/assets`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    let message = 'Failed to upload task asset';
    try {
      const errorPayload = await res.json();
      if (typeof errorPayload?.error === 'string' && errorPayload.error.trim()) {
        message = errorPayload.error.trim();
      }
    } catch {
      // Ignore JSON parse failures and fall back to the default message.
    }

    throw new Error(message);
  }

  return res.json();
}

export async function deleteTask(id: string): Promise<void> {
  const res = await fetch(`${API_URL}/tasks/${id}`, {
    method: 'DELETE'
  });
  if (!res.ok) throw new Error('Failed to delete task');
}

export async function fetchHealth(): Promise<{ status: string; workspace: string | null; ghAuthAvailable: boolean | null }> {
  const res = await fetch(`${API_URL}/health`);
  if (!res.ok) throw new Error('Failed to fetch health');
  return res.json();
}

export async function fetchWorkspace(): Promise<{ configured: boolean; path: string | null }> {
  const res = await fetch(`${API_URL}/workspace`);
  if (!res.ok) throw new Error('Failed to fetch workspace');
  return res.json();
}

export async function setWorkspace(folderPath: string): Promise<{ ok: boolean; path: string }> {
  const res = await fetch(`${API_URL}/workspace`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: folderPath }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Failed to set workspace');
  return data;
}

export async function pickWorkspaceFolder(): Promise<string | null> {
  const res = await fetch(`${API_URL}/workspace/pick`, { method: 'POST' });
  if (!res.ok) return null;
  const data = await res.json();
  return data.path ?? null;
}

// ─── Workspaces (multi-project) ─────────────────────────────────────────────

export interface WorkspaceInfo {
  path: string;
  label?: string;
  displayName: string;
  active: boolean;
  available: boolean;
}

export async function fetchWorkspaces(): Promise<WorkspaceInfo[]> {
  const res = await fetch(`${API_URL}/workspaces`);
  if (!res.ok) return [];
  return res.json();
}

export async function addWorkspace(wsPath: string, label?: string): Promise<WorkspaceInfo[]> {
  const res = await fetch(`${API_URL}/workspaces`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: wsPath, label }),
  });
  if (!res.ok) {
    const payload = await res.json().catch(() => ({}));
    throw new Error(payload.error || 'Failed to add workspace');
  }
  return res.json();
}

export async function removeWorkspace(index: number): Promise<WorkspaceInfo[]> {
  const res = await fetch(`${API_URL}/workspaces/${index}`, { method: 'DELETE' });
  if (!res.ok) throw new Error('Failed to remove workspace');
  return res.json();
}

export async function updateWorkspaceLabel(index: number, label: string): Promise<WorkspaceInfo[]> {
  const res = await fetch(`${API_URL}/workspaces/${index}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ label }),
  });
  if (!res.ok) throw new Error('Failed to update workspace label');
  return res.json();
}

export interface SwitchResult {
  ok: boolean;
  path: string;
}

export interface SwitchBlockedResult {
  blocked: true;
  activeSessions: number;
  message: string;
}

export async function switchWorkspace(wsPath: string, force?: boolean): Promise<SwitchResult | SwitchBlockedResult> {
  const res = await fetch(`${API_URL}/workspaces/switch`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: wsPath, force }),
  });
  if (res.status === 409) {
    const payload = await res.json();
    return { blocked: true, activeSessions: payload.activeSessions, message: payload.message };
  }
  if (!res.ok) {
    const payload = await res.json().catch(() => ({}));
    throw new Error(payload.error || 'Failed to switch workspace');
  }
  return res.json();
}

export async function fetchConfig(): Promise<Config> {
  const res = await fetch(`${API_URL}/config`);
  if (!res.ok) throw new Error('Failed to fetch config');
  return res.json();
}

export async function fetchDocs(): Promise<Doc[]> {
  const res = await fetch(`${API_URL}/docs`);
  if (!res.ok) throw new Error('Failed to fetch docs');
  return res.json();
}

export async function fetchDoc(docPath: string): Promise<Doc> {
  const res = await fetch(`${API_URL}/docs/${encodeDocPath(docPath)}`);
  if (!res.ok) throw new Error('Failed to fetch doc');
  return res.json();
}

export async function createDoc(payload: { path: string; title?: string; body?: string; order?: number }): Promise<Doc> {
  const res = await fetch(`${API_URL}/docs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error('Failed to create doc');
  return res.json();
}

export async function updateDoc(docPath: string, payload: { title?: string; body?: string; order?: number | null }): Promise<Doc> {
  const res = await fetch(`${API_URL}/docs/${encodeDocPath(docPath)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error('Failed to save doc');
  return res.json();
}

export async function deleteDoc(docPath: string): Promise<void> {
  const res = await fetch(`${API_URL}/docs/${encodeDocPath(docPath)}`, {
    method: 'DELETE',
  });
  if (!res.ok) throw new Error('Failed to delete doc');
}

export interface SkillStatus {
  framework: 'copilot' | 'antigravity' | 'gemini' | 'cursor' | 'cline' | 'windsurf' | 'claude' | 'generic';
  skillSourcePath: string;
  skillSourcePaths: string[];
  skillInstalledPath: string;
  skillSourceExists: boolean;
  skillInstalled: boolean;
  instructionsSourcePath?: string;
  instructionsInstalledPath?: string;
  instructionsSourceExists: boolean;
  instructionsInstalled: boolean;
  workflowInstalled: boolean;
}

export async function fetchSkillStatus(framework: string = 'auto'): Promise<SkillStatus> {
  const res = await fetch(`${API_URL}/skill/status?framework=${framework}`);
  if (!res.ok) throw new Error('Failed to fetch skill status');
  return res.json();
}

export async function installWorkspaceSkill(framework: string = 'auto'): Promise<{ success: boolean; skillInstalledPath: string; instructionsInstalledPath?: string }> {
  const res = await fetch(`${API_URL}/skill/install`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ framework }),
  });
  if (!res.ok) throw new Error('Failed to install skill');
  return res.json();
}

export const saveConfig = async (config: Config): Promise<Config> => {
  const response = await fetch(`${API_URL}/config`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(config),
  });
  if (!response.ok) throw new Error('Failed to save config');
  return response.json();
};

export type ReadState = Record<string, Record<string, string[]>>;

export async function fetchReadState(): Promise<ReadState> {
  const res = await fetch(`${API_URL}/read-state`);
  if (!res.ok) return {};
  return res.json();
}

export async function saveReadState(patch: ReadState): Promise<ReadState> {
  const res = await fetch(`${API_URL}/read-state`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });
  if (!res.ok) throw new Error('Failed to save read state');
  return res.json();
}

export const bulkRename = async (payload: { tags?: Record<string, string>, statuses?: Record<string, string>, users?: Record<string, string>, priorities?: Record<string, string> }): Promise<{success: boolean, modifiedCount: number}> => {
  const response = await fetch(`${API_URL}/bulk-rename`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!response.ok) throw new Error('Failed to bulk rename');
  return response.json();
};

export async function createTask(taskData: Partial<Task> & { projectKey: string, author: string }): Promise<Task> {
  const res = await fetch(`${API_URL}/tasks`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(taskData)
  });
  if (!res.ok) throw new Error('Failed to create task');
  return res.json();
}

export async function fetchTaskCliSession(taskId: string): Promise<CliSessionSummary | null> {
  const res = await fetch(`${API_URL}/tasks/${taskId}/cli-session`);
  if (!res.ok) throw new Error('Failed to fetch CLI session');
  const payload = await res.json();
  return payload.session || null;
}

export interface StartSessionOptions {
  framework: CliFramework;
  appendPrompt?: string;
  skipPermissions?: boolean;
  effortOverride?: string;
  role?: string;
  pattern?: string;
  patternPosition?: string;
  groupId?: string;
  groupSeq?: number;
  groupType?: string;
  groupVariant?: string;
  lockedPaths?: string[];
}

export async function startTaskCliSessionEx(taskId: string, opts: StartSessionOptions): Promise<CliSessionSummary> {
  const { framework, appendPrompt, skipPermissions = true, effortOverride, role, pattern, patternPosition, groupId, groupSeq, groupType, groupVariant, lockedPaths } = opts;
  const body: Record<string, unknown> = { framework, skipPermissions };
  if (appendPrompt) body.appendPrompt = appendPrompt;
  if (effortOverride) body.effortOverride = effortOverride;
  if (role) body.role = role;
  if (pattern) body.pattern = pattern;
  if (patternPosition) body.patternPosition = patternPosition;
  if (groupId) body.groupId = groupId;
  if (groupSeq != null) body.groupSeq = groupSeq;
  if (groupType) body.groupType = groupType;
  if (groupVariant) body.groupVariant = groupVariant;
  if (lockedPaths?.length) body.lockedPaths = lockedPaths;

  const res = await fetch(`${API_URL}/tasks/${taskId}/cli-session/start`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const payload = await res.json().catch(() => ({}));
    throw new Error(payload.error || 'Failed to start CLI session');
  }
  const payload = await res.json();
  return payload.session;
}

export async function fetchTaskCliSessions(taskId: string): Promise<CliSessionSummary[]> {
  const res = await fetch(`${API_URL}/tasks/${taskId}/cli-sessions`);
  if (!res.ok) throw new Error('Failed to fetch CLI sessions');
  const payload = await res.json();
  return payload.sessions || [];
}

export async function sendTaskCliInput(taskId: string, message: string, user: string): Promise<CliSessionSummary> {
  const res = await fetch(`${API_URL}/tasks/${taskId}/cli-session/input`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message, user }),
  });
  if (!res.ok) {
    const payload = await res.json().catch(() => ({}));
    throw new Error(payload.error || 'Failed to send CLI input');
  }
  const payload = await res.json();
  return payload.session;
}

export async function fetchPathInfo(): Promise<{ binaryDir: string | null; isPkg: boolean; platform: string }> {
  const res = await fetch(`${API_URL}/path-info`);
  if (!res.ok) throw new Error('Failed to fetch path info');
  return res.json();
}

export async function setupPath(mode: 'auto' | 'instructional'): Promise<{ ok: boolean; snippet: string | null; note?: string }> {
  const res = await fetch(`${API_URL}/path-setup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mode }),
  });
  if (!res.ok) {
    const payload = await res.json().catch(() => ({}));
    throw new Error(payload.error || 'Failed to set up PATH');
  }
  return res.json();
}

export async function stopTaskCliSession(taskId: string, sessionId?: string): Promise<CliSessionSummary> {
  const res = await fetch(`${API_URL}/tasks/${taskId}/cli-session/stop`, {
    method: 'POST',
    headers: sessionId ? { 'Content-Type': 'application/json' } : undefined,
    body: sessionId ? JSON.stringify({ sessionId }) : undefined,
  });
  if (!res.ok) {
    const payload = await res.json().catch(() => ({}));
    throw new Error(payload.error || 'Failed to stop CLI session');
  }
  const payload = await res.json();
  return payload.session;
}

export async function fetchStorageMode(): Promise<{ mode: 'in-repo' | 'orphan' }> {
  const res = await fetch(`${API_URL}/storage/mode`);
  if (!res.ok) throw new Error('Failed to fetch storage mode');
  return res.json();
}

export async function migrateStorage(): Promise<{ ok: boolean; mode: string }> {
  const res = await fetch(`${API_URL}/storage/migrate`, { method: 'POST' });
  if (!res.ok) {
    const payload = await res.json().catch(() => ({}));
    throw new Error(payload.error || 'Migration failed');
  }
  return res.json();
}

export async function restoreStorage(): Promise<{ ok: boolean; mode: string }> {
  const res = await fetch(`${API_URL}/storage/restore`, { method: 'POST' });
  if (!res.ok) {
    const payload = await res.json().catch(() => ({}));
    throw new Error(payload.error || 'Restore failed');
  }
  return res.json();
}

export interface ConflictInfo {
  ticketId: string;
  localContent: string;
  remoteContent: string;
}

export interface SyncStatus {
  state: 'idle' | 'syncing' | 'synced' | 'conflict' | 'error';
  lastSyncTime?: string;
  conflicts?: ConflictInfo[];
  error?: string;
  errorType?: 'network' | 'auth' | 'conflict' | 'unknown';
}

export async function fetchSyncStatus(): Promise<SyncStatus> {
  const res = await fetch(`${API_URL}/sync-status`);
  if (!res.ok) throw new Error('Failed to fetch sync status');
  return res.json();
}

export function subscribeSyncStatus(callback: (status: SyncStatus) => void): () => void {
  const eventSource = new EventSource(`${API_URL}/sync-status/stream`);

  eventSource.onmessage = (event) => {
    try {
      const status = JSON.parse(event.data);
      callback(status);
    } catch (err) {
      console.error('Failed to parse sync status:', err);
    }
  };

  eventSource.onerror = (err) => {
    console.error('Sync status stream error:', err);
  };

  return () => {
    eventSource.close();
  };
}

export async function triggerSync(): Promise<void> {
  await fetch(`${API_URL}/sync-status/sync`, { method: 'POST' });
}

export async function resolveConflicts(
  resolutions: Array<{ ticketId: string; strategy: 'use-remote' | 'rename-local' | 'manual'; newContent?: string }>
): Promise<{ ok: boolean }> {
  const res = await fetch(`${API_URL}/storage/resolve-conflicts`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ resolutions }),
  });
  if (!res.ok) {
    const payload = await res.json().catch(() => ({}));
    throw new Error(payload.error || 'Failed to resolve conflicts');
  }
  return res.json();
}

// ─── Notifications ───────────────────────────────────────────────────────────

export interface NotificationAction {
  label: string;
  actionId: string;
}

export interface Notification {
  id: string;
  type: 'error' | 'prompt' | 'completion' | 'info';
  title: string;
  message: string;
  ticketId?: string;
  framework?: string;
  actions: NotificationAction[];
  createdAt: string;
  read: boolean;
  dismissed: boolean;
}

export interface NotificationsResponse {
  notifications: Notification[];
  unreadCount: number;
}

export async function fetchNotifications(): Promise<NotificationsResponse> {
  const res = await fetch(`${API_URL}/notifications`);
  if (!res.ok) return { notifications: [], unreadCount: 0 };
  return res.json();
}

export async function markNotificationRead(id: string): Promise<void> {
  await fetch(`${API_URL}/notifications/${id}/read`, { method: 'POST' });
}

export async function markAllNotificationsRead(): Promise<void> {
  await fetch(`${API_URL}/notifications/read-all`, { method: 'POST' });
}

export async function dismissNotification(id: string): Promise<void> {
  await fetch(`${API_URL}/notifications/${id}/dismiss`, { method: 'POST' });
}

export async function executeNotificationAction(id: string, actionId: string): Promise<any> {
  const res = await fetch(`${API_URL}/notifications/${id}/action`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ actionId }),
  });
  if (!res.ok) throw new Error('Action failed');
  return res.json();
}

// ─── Global Settings / Boot ──────────────────────────────────────────────────

export interface BootStatus {
  firstBoot: boolean;
  legacyFound: boolean;
  dataDir: string;
  migrated: boolean;
}

export interface GlobalSettings {
  workspaces: { path: string; label?: string }[];
  lastWorkspace?: string;
  theme?: 'light' | 'dark' | 'system';
  defaultUser?: string;
  preferredFramework?: string;
  defaultAgent?: string;
  port?: number;
  dataDir?: string;
  boardClickBehavior?: 'modal' | 'expand';
  animations?: boolean;
  timeouts?: {
    syncDebounceMs?: number;
    syncMaxWaitMs?: number;
  };
  firstBootCompleted?: boolean;
  migratedFrom?: string;
}

export async function fetchBootStatus(): Promise<BootStatus> {
  const res = await fetch(`${API_URL}/settings/boot-status`);
  if (!res.ok) throw new Error('Failed to fetch boot status');
  return res.json();
}

export async function confirmBoot(migrate?: boolean): Promise<{ ok: boolean; settings: GlobalSettings }> {
  const res = await fetch(`${API_URL}/settings/confirm-boot`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ migrate }),
  });
  if (!res.ok) throw new Error('Boot confirmation failed');
  return res.json();
}

export async function fetchGlobalSettings(): Promise<GlobalSettings> {
  const res = await fetch(`${API_URL}/settings/global`);
  if (!res.ok) throw new Error('Failed to fetch global settings');
  return res.json();
}

export async function updateGlobalSettings(updates: Partial<GlobalSettings>): Promise<GlobalSettings> {
  const res = await fetch(`${API_URL}/settings/global`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(updates),
  });
  if (!res.ok) throw new Error('Failed to update global settings');
  return res.json();
}

export interface BranchStatus {
  name: string | null;
  exists: boolean;
  aheadCount: number;
  behindCount: number;
}

export async function fetchBranchStatus(taskId: string): Promise<BranchStatus> {
  const res = await fetch(`${API_URL}/tasks/${taskId}/branch`);
  if (!res.ok) throw new Error('Failed to fetch branch status');
  return res.json();
}

export async function createBranch(taskId: string, baseBranch?: string): Promise<{ branch: string }> {
  const res = await fetch(`${API_URL}/tasks/${taskId}/branch`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(baseBranch ? { baseBranch } : {}),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error((err as any).error || 'Failed to create branch');
  }
  return res.json();
}

export async function fetchTaskDiff(taskId: string, file?: string): Promise<string | null> {
  const url = file
    ? `${API_URL}/tasks/${taskId}/diff?file=${encodeURIComponent(file)}`
    : `${API_URL}/tasks/${taskId}/diff`;
  const res = await fetch(url);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error('Failed to fetch diff');
  return res.text();
}
