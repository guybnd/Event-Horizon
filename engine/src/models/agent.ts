import fs from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import { getActiveFluxDir } from '../workspace.js';

export interface AgentDefinition {
  id: string;
  name: string;
  systemPrompt: string;
  skills: string[];
  phase: 'grooming' | 'implementation' | 'review' | 'finalize';
  toolRestrictions: string[];
  outputSchema?: object;
  createdAt: string;
  updatedAt: string;
}

export function getAgentsDir(): string {
  return path.join(getActiveFluxDir(), 'agents');
}

let agentCache: AgentDefinition[] = [];

export async function loadAgents(): Promise<AgentDefinition[]> {
  const dir = getAgentsDir();
  if (!existsSync(dir)) {
    agentCache = [];
    return [];
  }
  const files = await fs.readdir(dir);
  const agents: AgentDefinition[] = [];
  for (const file of files) {
    if (!file.endsWith('.json')) continue;
    try {
      const raw = await fs.readFile(path.join(dir, file), 'utf-8');
      agents.push(JSON.parse(raw));
    } catch {}
  }
  agentCache = agents;
  return agents;
}

export function getAgentCache(): AgentDefinition[] {
  return agentCache;
}

export async function saveAgent(agent: AgentDefinition): Promise<void> {
  const dir = getAgentsDir();
  if (!existsSync(dir)) await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, `${agent.id}.json`), JSON.stringify(agent, null, 2), 'utf-8');
  const idx = agentCache.findIndex(a => a.id === agent.id);
  if (idx >= 0) agentCache[idx] = agent;
  else agentCache.push(agent);
}

export async function deleteAgent(id: string): Promise<boolean> {
  const dir = getAgentsDir();
  const filePath = path.join(dir, `${id}.json`);
  if (!existsSync(filePath)) return false;
  await fs.unlink(filePath);
  agentCache = agentCache.filter(a => a.id !== id);
  return true;
}

export function validateAgent(agent: Partial<AgentDefinition>): string | null {
  if (!agent.name?.trim()) return 'Name is required';
  if (!agent.phase) return 'Phase is required';
  const validPhases = ['grooming', 'implementation', 'review', 'finalize'];
  if (!validPhases.includes(agent.phase)) return `Invalid phase: ${agent.phase}`;
  return null;
}
