import fs from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import { getActiveFluxDir } from '../workspace.js';

export type Phase = 'grooming' | 'implementation' | 'review' | 'release';
export type ExecutionPattern = 'relay' | 'scatter' | 'supervisor';
export type CliTarget = 'claude' | 'gemini' | 'copilot';

export interface WorkflowPhaseConfig {
  pattern: ExecutionPattern;
  steps?: string[];
  parallel?: string[];
  combiner?: string;
  lead?: string;
  assistants?: string[];
}

export interface WorkflowTemplate {
  id: string;
  name: string;
  cliTarget: CliTarget;
  phases: Partial<Record<Phase, WorkflowPhaseConfig>>;
  createdAt: string;
  updatedAt: string;
}

const CLI_PATTERN_SUPPORT: Record<CliTarget, ExecutionPattern[]> = {
  claude: ['relay', 'scatter', 'supervisor'],
  gemini: ['relay', 'scatter'],
  copilot: ['relay', 'scatter'],
};

export function getWorkflowsDir(): string {
  return path.join(getActiveFluxDir(), 'workflows');
}

export function validateWorkflow(template: Partial<WorkflowTemplate>): string | null {
  if (!template.name?.trim()) return 'Name is required';
  if (!template.cliTarget) return 'CLI target is required';
  if (!CLI_PATTERN_SUPPORT[template.cliTarget]) return `Invalid CLI target: ${template.cliTarget}`;

  const supported = CLI_PATTERN_SUPPORT[template.cliTarget];
  if (template.phases) {
    for (const [phase, config] of Object.entries(template.phases)) {
      if (!config) continue;
      if (!supported.includes(config.pattern)) {
        return `Pattern "${config.pattern}" is not supported by ${template.cliTarget} (phase: ${phase})`;
      }
    }
  }
  return null;
}

let workflowCache: WorkflowTemplate[] = [];

export async function loadWorkflows(): Promise<WorkflowTemplate[]> {
  const dir = getWorkflowsDir();
  if (!existsSync(dir)) {
    workflowCache = [];
    return [];
  }
  const files = await fs.readdir(dir);
  const workflows: WorkflowTemplate[] = [];
  for (const file of files) {
    if (!file.endsWith('.json')) continue;
    try {
      const raw = await fs.readFile(path.join(dir, file), 'utf-8');
      workflows.push(JSON.parse(raw));
    } catch {}
  }
  workflowCache = workflows;
  return workflows;
}

export function getWorkflowCache(): WorkflowTemplate[] {
  return workflowCache;
}

export async function saveWorkflow(workflow: WorkflowTemplate): Promise<void> {
  const dir = getWorkflowsDir();
  if (!existsSync(dir)) await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, `${workflow.id}.json`), JSON.stringify(workflow, null, 2), 'utf-8');
  const idx = workflowCache.findIndex(w => w.id === workflow.id);
  if (idx >= 0) workflowCache[idx] = workflow;
  else workflowCache.push(workflow);
}

export async function deleteWorkflow(id: string): Promise<boolean> {
  const dir = getWorkflowsDir();
  const filePath = path.join(dir, `${id}.json`);
  if (!existsSync(filePath)) return false;
  await fs.unlink(filePath);
  workflowCache = workflowCache.filter(w => w.id !== id);
  return true;
}

export function getCliPatternSupport(): Record<CliTarget, ExecutionPattern[]> {
  return CLI_PATTERN_SUPPORT;
}
