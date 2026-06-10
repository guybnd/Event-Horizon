import fs from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import { getActiveFluxDir } from '../workspace.js';

export type Phase = 'grooming' | 'implementation' | 'review' | 'finalize';
export type ExecutionPattern = 'relay' | 'scatter' | 'supervisor';
export type CliTarget = 'claude' | 'gemini' | 'copilot';

export interface WorkflowPhaseConfig {
  pattern: ExecutionPattern;
  steps?: string[];
  parallel?: string[];
  combiner?: string;
  lead?: string;
  assistants?: string[];
  /** Override the built-in combiner persona for multi-agent launches in this phase. */
  combinerPersonaId?: string;
}

export type PersonaRole = 'lead' | 'worker' | 'flex';

/**
 * Validate that a persona's role is compatible with a workflow slot.
 * Lead/combiner slots accept 'lead' or 'flex'. Worker slots accept 'worker' or 'flex'.
 */
export function isRoleValidForSlot(role: PersonaRole, slot: 'lead' | 'worker'): boolean {
  if (slot === 'lead') return role === 'lead' || role === 'flex';
  return role === 'worker' || role === 'flex';
}

export interface WorkflowTemplate {
  id: string;
  name: string;
  cliTarget: CliTarget;
  phases: Partial<Record<Phase, WorkflowPhaseConfig>>;
  createdAt: string;
  updatedAt: string;
  /** True for code-defined templates (cannot be edited or deleted). */
  builtIn?: boolean;
}

const CLI_PATTERN_SUPPORT: Record<CliTarget, ExecutionPattern[]> = {
  claude: ['relay', 'scatter', 'supervisor'],
  gemini: ['relay', 'scatter'],
  copilot: ['relay', 'scatter'],
};

// ── Built-in templates ───────────────────────────────────────────────────────
// Per-phase Single/Multi pairs shipped in code (read-only, forkable), mirroring
// the built-in persona pattern. Stable ids so `config.defaultWorkflowId` and the
// card launch controls can reference them. Merged with custom templates at read
// time; never written to disk. Multi templates that rely on the `relay` pattern
// (TDD implementation, release pipeline) are defined but auto-run is gated in the
// UI until the engine can sequence relays.
const BUILTIN_TS = '2026-01-01T00:00:00.000Z';

export const BUILTIN_WORKFLOWS: WorkflowTemplate[] = [
  // ── Grooming ────────────────────────────────────────────────────────────────
  {
    id: 'builtin-grooming-single', name: 'Grooming · Solo', cliTarget: 'claude',
    phases: { grooming: { pattern: 'supervisor', lead: 'planner', assistants: [] } },
    createdAt: BUILTIN_TS, updatedAt: BUILTIN_TS, builtIn: true,
  },
  {
    id: 'builtin-grooming-multi', name: 'Grooming · Sequential', cliTarget: 'claude',
    phases: { grooming: { pattern: 'relay', steps: ['context-scout', 'requirements-interrogator', 'planner'] } },
    createdAt: BUILTIN_TS, updatedAt: BUILTIN_TS, builtIn: true,
  },
  {
    id: 'builtin-grooming-supervisor', name: 'Grooming · Supervisor', cliTarget: 'claude',
    phases: { grooming: { pattern: 'supervisor', lead: 'planner', assistants: ['context-scout', 'requirements-interrogator'] } },
    createdAt: BUILTIN_TS, updatedAt: BUILTIN_TS, builtIn: true,
  },
  // ── Implementation ──────────────────────────────────────────────────────────
  {
    id: 'builtin-implementation-single', name: 'Implementation · Solo', cliTarget: 'claude',
    phases: { implementation: { pattern: 'supervisor', lead: 'dev-lead', assistants: [] } },
    createdAt: BUILTIN_TS, updatedAt: BUILTIN_TS, builtIn: true,
  },
  {
    id: 'builtin-implementation-multi', name: 'Implementation · TDD', cliTarget: 'claude',
    phases: { implementation: { pattern: 'relay', steps: ['test-engineer', 'implementer'] } },
    createdAt: BUILTIN_TS, updatedAt: BUILTIN_TS, builtIn: true,
  },
  {
    id: 'builtin-implementation-supervisor', name: 'Implementation · Supervisor', cliTarget: 'claude',
    phases: { implementation: { pattern: 'supervisor', lead: 'dev-lead', assistants: ['implementer', 'test-engineer'] } },
    createdAt: BUILTIN_TS, updatedAt: BUILTIN_TS, builtIn: true,
  },
  // ── Review ──────────────────────────────────────────────────────────────────
  {
    id: 'builtin-review-single', name: 'Review · Solo', cliTarget: 'claude',
    phases: { review: { pattern: 'supervisor', lead: 'orchestrator', assistants: [] } },
    createdAt: BUILTIN_TS, updatedAt: BUILTIN_TS, builtIn: true,
  },
  {
    id: 'builtin-review-multi', name: 'Review · Panel', cliTarget: 'claude',
    phases: { review: { pattern: 'scatter', parallel: ['qa-correctness', 'architect', 'security-auditor'], combiner: 'orchestrator' } },
    createdAt: BUILTIN_TS, updatedAt: BUILTIN_TS, builtIn: true,
  },
  {
    id: 'builtin-review-supervisor', name: 'Review · Supervisor', cliTarget: 'claude',
    phases: { review: { pattern: 'supervisor', lead: 'orchestrator', assistants: ['qa-correctness', 'architect', 'security-auditor', 'perf-expert', 'ux-expert'] } },
    createdAt: BUILTIN_TS, updatedAt: BUILTIN_TS, builtIn: true,
  },
  // ── Finalize ────────────────────────────────────────────────────────────────
  {
    id: 'builtin-finalize-single', name: 'Finalize · Solo', cliTarget: 'claude',
    phases: { finalize: { pattern: 'supervisor', lead: 'finalizer', assistants: [] } },
    createdAt: BUILTIN_TS, updatedAt: BUILTIN_TS, builtIn: true,
  },
  {
    id: 'builtin-finalize-multi', name: 'Finalize · Pipeline', cliTarget: 'claude',
    phases: { finalize: { pattern: 'relay', steps: ['docs-auditor', 'committer', 'ticket-curator', 'pr-merger'] } },
    createdAt: BUILTIN_TS, updatedAt: BUILTIN_TS, builtIn: true,
  },
  {
    id: 'builtin-finalize-supervisor', name: 'Finalize · Supervisor', cliTarget: 'claude',
    phases: { finalize: { pattern: 'supervisor', lead: 'finalizer', assistants: ['docs-auditor', 'committer'] } },
    createdAt: BUILTIN_TS, updatedAt: BUILTIN_TS, builtIn: true,
  },
];

export function isBuiltInWorkflow(id: string): boolean {
  return BUILTIN_WORKFLOWS.some(w => w.id === id);
}

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
    workflowCache = [...BUILTIN_WORKFLOWS];
    return workflowCache;
  }
  const files = await fs.readdir(dir);
  const custom: WorkflowTemplate[] = [];
  for (const file of files) {
    if (!file.endsWith('.json')) continue;
    try {
      const raw = await fs.readFile(path.join(dir, file), 'utf-8');
      const parsed = JSON.parse(raw) as WorkflowTemplate;
      // Never let a stale on-disk copy shadow a built-in id.
      if (!isBuiltInWorkflow(parsed.id)) {
        parsed.builtIn = false;
        custom.push(parsed);
      }
    } catch {}
  }
  workflowCache = [...BUILTIN_WORKFLOWS, ...custom];
  return workflowCache;
}

export function getWorkflowCache(): WorkflowTemplate[] {
  return workflowCache;
}

export async function saveWorkflow(workflow: WorkflowTemplate): Promise<void> {
  if (isBuiltInWorkflow(workflow.id)) {
    throw new Error(`"${workflow.id}" is a built-in template and cannot be modified`);
  }
  const dir = getWorkflowsDir();
  if (!existsSync(dir)) await fs.mkdir(dir, { recursive: true });
  workflow.builtIn = false;
  await fs.writeFile(path.join(dir, `${workflow.id}.json`), JSON.stringify(workflow, null, 2), 'utf-8');
  const idx = workflowCache.findIndex(w => w.id === workflow.id);
  if (idx >= 0) workflowCache[idx] = workflow;
  else workflowCache.push(workflow);
}

export async function deleteWorkflow(id: string): Promise<boolean> {
  if (isBuiltInWorkflow(id)) {
    throw new Error(`"${id}" is a built-in template and cannot be deleted`);
  }
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
