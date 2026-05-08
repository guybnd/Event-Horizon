import type { Task, Config, Doc } from './types';

export const API_URL = '/api';

function encodeDocPath(docPath: string) {
  return docPath.split('/').map((segment) => encodeURIComponent(segment)).join('/');
}

export async function fetchTasks(): Promise<Task[]> {
  const res = await fetch(`${API_URL}/tasks`);
  if (!res.ok) throw new Error('Failed to fetch tasks');
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
  if (!res.ok) throw new Error('Failed to update task');
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

export async function fetchHealth(): Promise<{ status: string; workspace: string | null }> {
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
