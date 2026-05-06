import type { Task, Config } from './types';

const API_URL = 'http://localhost:3001/api';

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

export async function fetchConfig(): Promise<Config> {
  const res = await fetch(`${API_URL}/config`);
  if (!res.ok) throw new Error('Failed to fetch config');
  return res.json();
}

export async function updateConfig(updates: Partial<Config>): Promise<Config> {
  const res = await fetch(`${API_URL}/config`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(updates)
  });
  if (!res.ok) throw new Error('Failed to update config');
  return res.json();
}
