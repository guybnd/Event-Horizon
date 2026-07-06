import fs from 'fs/promises';
import path from 'path';
import { resolveSkillSourceRoot } from './workspace.js';
import { buildInitialPrompt } from './agents/shared.js';
import { getModulePromptFragments } from './modules.js';
import { computeAgentPayloadMetrics, type AgentPayloadMetrics } from './agent-payload-metrics.js';
import { getCliSessionSummaryForTask } from './session-store.js';

/**
 * Ticket/frontmatter-shaped input. There is no single canonical Task type in
 * this codebase (tickets are runtime-validated, loosely-typed records) — this
 * narrow interface covers only the fields these metrics functions read.
 */
interface MetricsTask {
  id: string;
  status?: string;
  tags?: string[];
  [key: string]: unknown;
}

function measure(value: string | undefined | null): { bytes: number; tokensEst: number } {
  if (!value) return { bytes: 0, tokensEst: 0 };
  return { bytes: Buffer.byteLength(value, 'utf8'), tokensEst: Math.ceil(value.length / 4) };
}

function pct(bytes: number, total: number): number {
  return total ? Math.round((bytes / total) * 1000) / 10 : 0;
}

const SKILL_MODULES = ['orchestrator', 'grooming', 'implementation', 'review', 'release', 'mapping'] as const;

function statusToPhase(status?: string): string | undefined {
  if (status === 'Grooming' || status === 'Require Input') return 'grooming';
  if (status === 'Todo' || status === 'In Progress') return 'implementation';
  return undefined;
}

export interface BudgetSection {
  name: string;
  bytes: number;
  tokensEst: number;
  pct: number;
}

export interface LaunchPromptMetrics {
  phase: string | null;
  totalBytes: number;
  totalTokensEst: number;
  sections: BudgetSection[];
  note: string;
}

/**
 * Measures the launch prompt EH constructs for a ticket (the message an agent is
 * spawned with). This is EH-owned context injected every session — far larger
 * than the get_ticket payload. Breaks the core prompt into the verbatim chunks
 * we can attribute (ticket body, module fragments) and the EH instruction
 * boilerplate (mission text, header, recent activity, mcp note). The persona
 * overlay (appendPrompt) is measured separately by the caller — here we pass ''.
 */
export function computeLaunchPromptMetrics(task: MetricsTask): LaunchPromptMetrics {
  const phase = statusToPhase(task.status);
  const corePrompt = buildInitialPrompt(task, '', phase ? { phase } : undefined);
  const total = measure(corePrompt);

  const moduleFragments = measure(getModulePromptFragments(phase, Array.isArray(task.tags) ? task.tags : undefined));
  // The body is NOT echoed in the launch prompt (FLUX-498) — agents read it via
  // get_ticket. moduleFragments appears verbatim; the remainder is the
  // EH-generated mission/header/recent-activity/get_ticket-pointer/mcp-note.
  const remainderBytes = Math.max(0, total.bytes - moduleFragments.bytes);
  const remainderTokens = Math.max(0, total.tokensEst - moduleFragments.tokensEst);

  const sections: BudgetSection[] = [
    { name: 'EH instructions/boilerplate', bytes: remainderBytes, tokensEst: remainderTokens, pct: pct(remainderBytes, total.bytes) },
    { name: 'module fragments', bytes: moduleFragments.bytes, tokensEst: moduleFragments.tokensEst, pct: pct(moduleFragments.bytes, total.bytes) },
  ].sort((a, b) => b.bytes - a.bytes);

  return {
    phase: phase ?? null,
    totalBytes: total.bytes,
    totalTokensEst: total.tokensEst,
    sections,
    note: 'Core EH launch prompt. The ticket body is NOT echoed here (FLUX-498) — agents read it via get_ticket. A persona overlay (appendPrompt) is appended at spawn and varies.',
  };
}

export interface SkillModuleMetrics {
  totalBytes: number;
  totalTokensEst: number;
  modules: Array<{ name: string; bytes: number; tokensEst: number; missing?: boolean }>;
  note: string;
}

/**
 * Measures the EH skill modules that load into every agent session (as
 * .claude/rules content, or concatenated into the prompt for non-modular
 * frameworks). This is fixed per-session overhead — all five load regardless of
 * the ticket's phase today (see FLUX-261/4c for phase-scoped loading).
 */
export async function computeSkillModuleMetrics(): Promise<SkillModuleMetrics> {
  const root = resolveSkillSourceRoot();
  const modules = await Promise.all(
    SKILL_MODULES.map(async (name) => {
      const file = path.join(root, '.docs', 'skills', `event-horizon-${name}.md`);
      try {
        const content = await fs.readFile(file, 'utf-8');
        return { name, ...measure(content) };
      } catch {
        return { name, bytes: 0, tokensEst: 0, missing: true };
      }
    }),
  );
  const totalBytes = modules.reduce((s, m) => s + m.bytes, 0);
  const totalTokensEst = modules.reduce((s, m) => s + m.tokensEst, 0);
  return {
    totalBytes,
    totalTokensEst,
    modules: modules.sort((a, b) => b.bytes - a.bytes),
    note: 'All modules load every session today; only the phase-relevant one is needed (FLUX-261/4c, FLUX-481).',
  };
}

export interface SessionTokenTotals {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
}

export interface ContextBudget {
  ticketId: string;
  agentPayload: AgentPayloadMetrics;
  launchPrompt: LaunchPromptMetrics;
  skillModules: SkillModuleMetrics;
  ehMeasurableTotalTokensEst: number;
  /** Actual token totals from this ticket's most recent agent session (from the
   * host, via the adapter) — the real number to compare the measured static
   * prelude against. The gap is conversation + tool-result accumulation. */
  session?: SessionTokenTotals;
  caveats: string[];
}

/**
 * Combined "where does an agent's context budget go" view for the parts EH owns
 * and can measure in-process. Deliberately honest about what it CANNOT see.
 */
export async function computeContextBudget(task: MetricsTask): Promise<ContextBudget> {
  const payload = computeAgentPayloadMetrics(task);
  const launchPrompt = computeLaunchPromptMetrics(task);
  const skillModules = await computeSkillModuleMetrics();

  const ehMeasurableTotalTokensEst =
    payload.totalTokensEst + launchPrompt.totalTokensEst + skillModules.totalTokensEst;

  const s = getCliSessionSummaryForTask(task.id);
  // Spread conditionally rather than assigning `undefined` fields directly —
  // exactOptionalPropertyTypes treats a present-but-undefined key differently
  // from an omitted one. JSON serialization of the response is unaffected
  // either way (JSON.stringify already drops undefined-valued keys).
  const session: SessionTokenTotals | undefined = s
    ? {
        ...(s.inputTokens !== undefined ? { inputTokens: s.inputTokens } : {}),
        ...(s.outputTokens !== undefined ? { outputTokens: s.outputTokens } : {}),
        ...(s.cacheReadTokens !== undefined ? { cacheReadTokens: s.cacheReadTokens } : {}),
        ...(s.cacheCreationTokens !== undefined ? { cacheCreationTokens: s.cacheCreationTokens } : {}),
      }
    : undefined;

  return {
    ticketId: task.id,
    agentPayload: payload,
    launchPrompt,
    skillModules,
    ehMeasurableTotalTokensEst,
    ...(session ? { session } : {}),
    caveats: [
      "Excludes Claude Code's own system prompt (not engine-controlled).",
      'Excludes external MCP server tool schemas (serena, context7, etc.) — measured by the host, not the engine.',
      'Excludes conversation + tool-result accumulation that grows during a session.',
      "EH's own MCP tool schemas are not measured here yet — pending the registerMcpTools extraction (FLUX-491/FLUX-481).",
      'Token counts are a chars/4 estimate for relative ranking, not an exact tokenizer count.',
    ],
  };
}
