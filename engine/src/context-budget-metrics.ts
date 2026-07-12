import { buildInitialPrompt } from './agents/shared.js';
import { getModulePromptFragments } from './modules.js';
import { computeAgentPayloadMetrics, type AgentPayloadMetrics } from './agent-payload-metrics.js';
import { getCliSessionSummaryForTask } from './session-store.js';
import { buildCoreSkillDocument } from './skill-core.js';
import { isInjectablePhaseModule, loadSkillModuleBodySync, skillModuleFallback } from './skill-modules.js';

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
  // FLUX-1377: buildInitialPrompt (default framework 'claude', no patternPosition — i.e. a real
  // phase dispatch, not a delegate) now appends the phase's skill module body for
  // grooming/implementation/review. Measure it separately so it doesn't get lumped into the
  // boilerplate remainder below — this is the "phase guidance on demand" delta this ticket adds.
  const injectedModule = measure(
    isInjectablePhaseModule(phase) ? (loadSkillModuleBodySync(phase) ?? skillModuleFallback(phase)) : undefined,
  );
  // The body is NOT echoed in the launch prompt (FLUX-498) — agents read it via
  // get_ticket. moduleFragments/injectedModule appear verbatim; the remainder is the
  // EH-generated mission/header/recent-activity/get_ticket-pointer/mcp-note.
  const remainderBytes = Math.max(0, total.bytes - moduleFragments.bytes - injectedModule.bytes);
  const remainderTokens = Math.max(0, total.tokensEst - moduleFragments.tokensEst - injectedModule.tokensEst);

  const sections: BudgetSection[] = [
    { name: 'EH instructions/boilerplate', bytes: remainderBytes, tokensEst: remainderTokens, pct: pct(remainderBytes, total.bytes) },
    { name: 'injected phase skill module', bytes: injectedModule.bytes, tokensEst: injectedModule.tokensEst, pct: pct(injectedModule.bytes, total.bytes) },
    { name: 'config module fragments', bytes: moduleFragments.bytes, tokensEst: moduleFragments.tokensEst, pct: pct(moduleFragments.bytes, total.bytes) },
  ].sort((a, b) => b.bytes - a.bytes);

  return {
    phase: phase ?? null,
    totalBytes: total.bytes,
    totalTokensEst: total.tokensEst,
    sections,
    note: 'Core EH launch prompt — FLUX-1377: includes the injected phase skill module (grooming/implementation/review) since buildInitialPrompt now appends it for Claude spawns. The ticket body is NOT echoed here (FLUX-498) — agents read it via get_ticket. A persona overlay (appendPrompt) is appended at spawn and varies.',
  };
}

export interface SkillModuleMetrics {
  /** Bytes/tokens of JUST the installed core (.claude/rules/event-horizon.md for Claude) —
   * the static, always-loaded portion. Separate from totalBytes/totalTokensEst so callers that
   * already counted an injected module elsewhere (computeLaunchPromptMetrics) can add this
   * without double-counting. */
  coreBytes: number;
  coreTokensEst: number;
  /** core + injected phase module (informational — the full "skill" cost this session pays). */
  totalBytes: number;
  totalTokensEst: number;
  modules: Array<{ name: string; bytes: number; tokensEst: number; missing?: boolean }>;
  note: string;
}

/**
 * FLUX-1377: measures the REAL skill-module prelude — the trimmed always-on core
 * (`.claude/rules/event-horizon.md` for Claude, see skill-core.ts) plus, when `phase` is
 * grooming/implementation/review, the ONE module `buildInitialPrompt` injects for agent
 * spawns. Replaces the old assertion that all six modules load every session (never actually
 * measured per session kind, and stale — it claimed "all five" when there were six).
 *
 * Both agent main-checkout AND agent worktree spawns get the same injected module (worktrees
 * never had the rules file installed at all — task-worktree.ts — so this is a net improvement
 * there). Human sessions get the core only and Read the phase module on demand.
 */
export async function computeSkillModuleMetrics(phase?: string): Promise<SkillModuleMetrics> {
  const core = measure(buildCoreSkillDocument());
  const modulePhase = isInjectablePhaseModule(phase) ? phase : undefined;
  const moduleMeasured = measure(
    modulePhase ? (loadSkillModuleBodySync(modulePhase) ?? skillModuleFallback(modulePhase)) : undefined,
  );

  const modules: SkillModuleMetrics['modules'] = [
    { name: 'core (installed .claude/rules, every Claude session)', bytes: core.bytes, tokensEst: core.tokensEst },
  ];
  if (modulePhase) {
    modules.push({ name: `${modulePhase} module (injected, agent spawns only)`, bytes: moduleMeasured.bytes, tokensEst: moduleMeasured.tokensEst });
  }

  return {
    coreBytes: core.bytes,
    coreTokensEst: core.tokensEst,
    totalBytes: core.bytes + moduleMeasured.bytes,
    totalTokensEst: core.tokensEst + moduleMeasured.tokensEst,
    modules,
    note: modulePhase
      ? `FLUX-1377: Claude installs get the ~${core.tokensEst}-tok core always; only the ${modulePhase} module is injected for agent spawns (main-checkout or worktree) — the other modules never load this session.`
      : 'FLUX-1377: Claude installs get the core always; no phase module applies to this ticket status (release/mapping are Read-on-demand, not phase-spawned).',
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
  const skillModules = await computeSkillModuleMetrics(launchPrompt.phase ?? undefined);

  // FLUX-1377: launchPrompt already includes the injected phase skill module (buildInitialPrompt
  // appends it for Claude spawns) — add only skillModules.coreTokensEst (the static installed
  // rules file) here, not skillModules.totalTokensEst (core + module), or the module would be
  // double-counted.
  const ehMeasurableTotalTokensEst =
    payload.totalTokensEst + launchPrompt.totalTokensEst + skillModules.coreTokensEst;

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
