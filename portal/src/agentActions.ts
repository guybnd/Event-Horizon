import { startTaskCliSessionEx, updateTask, registerDeferredCombiner, unregisterDeferredCombiner, registerRelayChain, unregisterRelayChain, fetchWorkflows, workflowPhaseMembers, type OrchestrationPersonaMeta } from './api';
import type { CliFramework, CliSessionSummary, ExecutionPattern, GroupVariant, PatternPosition } from './types';
import type { TopologyShape } from './orchestration';

/**
 * Persona metadata only. Prompt text lives engine-side (orchestration-personas.ts)
 * and is resolved server-side from a `personaId` at launch — it never ships in the
 * client bundle. Fetch the catalog via `fetchOrchestrationPersonas()`.
 */
export type ReviewPersona = OrchestrationPersonaMeta;

export const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type EffortLevel = typeof EFFORT_LEVELS[number];

const EFFORT_DISPLAY: Record<EffortLevel, string> = {
  low: 'Low', medium: 'Medium', high: 'High', xhigh: 'X-High', max: 'Max',
};
export function effortDisplayLabel(level: EffortLevel): string {
  return EFFORT_DISPLAY[level];
}

export type AgentCommandVerb = 'implement' | 'groom' | 'finish';

export interface AgentCommandDef {
  label: string;
  verb: AgentCommandVerb;
}

export const AGENT_COMMANDS: AgentCommandDef[] = [
  { label: 'Implement', verb: 'implement' },
  { label: 'Groom', verb: 'groom' },
  { label: 'Finish', verb: 'finish' },
];

export type AgentAction =
  | { kind: 'launch' }
  | { kind: 'command'; verb: AgentCommandVerb }
  | { kind: 'prompt'; appendPrompt: string }
  | { kind: 'persona'; personaId: string; focusComment?: string };

export interface RunAgentActionOptions {
  taskId: string;
  framework: CliFramework;
  action: AgentAction;
  currentUser: string;
  skipPermissions?: boolean;
  effortOverride?: string;
  /** Status to move the ticket to before launching the agent. */
  preStatus?: string;
  /** Launch phase / intent — threaded to engine for phase-aware prompts. */
  phase?: LaunchPhase;
  /** Multi-session role tag (e.g. 'reviewer', 'implementer'). */
  role?: string;
  /** Orchestration pattern for multi-session coordination. */
  pattern?: 'relay' | 'scatter-gather' | 'supervisor';
  /** Position within the pattern. */
  patternPosition?: 'lead' | 'assistant' | 'combiner' | 'step' | 'standalone';
}

/**
 * Single entry point for starting an agent session. Every launch button in the
 * portal (card context menu, modal CLI panel, code-review picker, finish button,
 * save-and-launch) must route through here so behavior stays consistent.
 */
export async function runAgentAction(opts: RunAgentActionOptions): Promise<CliSessionSummary> {
  const {
    taskId,
    framework,
    action,
    currentUser,
    skipPermissions = true,
    effortOverride,
    preStatus,
    phase,
    role,
    pattern,
    patternPosition,
  } = opts;

  if (preStatus) {
    await updateTask(taskId, { status: preStatus, updatedBy: currentUser });
  }

  let appendPrompt: string | undefined;
  let personaId: string | undefined;
  let focusComment: string | undefined;
  if (action.kind === 'command') {
    appendPrompt = `${action.verb} ${taskId}`;
  } else if (action.kind === 'prompt') {
    appendPrompt = action.appendPrompt;
  } else if (action.kind === 'persona') {
    personaId = action.personaId;
    focusComment = action.focusComment;
  }

  return startTaskCliSessionEx(taskId, {
    framework,
    appendPrompt,
    personaId,
    focusComment,
    skipPermissions,
    effortOverride,
    phase,
    role,
    pattern,
    patternPosition,
  });
}

/**
 * Launch the phase's single-default template with correct orchestration routing.
 * When the template uses supervisor pattern, launches via launchOrchestration so
 * the session gets proper groupType/patternPosition metadata. Otherwise launches
 * standalone via runAgentAction. Returns null if no persona could be resolved.
 */
export async function launchPhaseDefault(opts: {
  taskId: string;
  framework: CliFramework;
  phase: LaunchPhase;
  currentUser: string;
  phaseDefaults?: Partial<Record<LaunchPhase, { single?: string; multi?: string }>>;
  skipPermissions?: boolean;
  /** FLUX-906 (audit E.6): whether `framework` supports the supervisor pattern, per the
   *  /api/config capability table — pass `frameworkSupports(config, framework, 'supervisor')`.
   *  Replaces the old `framework === 'claude' || framework === 'gemini'` hardcode. Defaults to
   *  false (fail closed → standalone launch) if the caller hasn't loaded capabilities yet. */
  supervisorCapable?: boolean;
}): Promise<CliSessionSummary | null> {
  const { taskId, framework, phase, currentUser, phaseDefaults, skipPermissions, supervisorCapable } = opts;
  const defaultId = resolvePhaseDefaultId(phaseDefaults, phase, 'single');
  const list = await fetchWorkflows();
  const wf = list.find((w) => w.id === defaultId);
  const cfg = wf?.phases?.[phase];
  const members = workflowPhaseMembers(cfg);
  const personaId = members[0];
  if (!personaId) return null;

  if (cfg?.pattern === 'supervisor' && supervisorCapable) {
    const combiner = phaseCombiner(phase);
    const lead = { role: personaId, label: combiner?.label || personaId, personaId };
    const result = await launchOrchestration({
      taskId,
      framework,
      mode: 'handoff',
      participants: [],
      lead,
      currentUser,
      skipPermissions,
      preStatus: phaseLaunchStatus(phase),
      phase,
    });
    return result.sessions[0] ?? null;
  }

  return runAgentAction({
    taskId,
    framework,
    action: { kind: 'persona', personaId },
    currentUser,
    skipPermissions,
    preStatus: phaseLaunchStatus(phase),
    phase,
  });
}

export interface MultiReviewResult {
  sessions: CliSessionSummary[];
  errors: string[];
}

// ── Generic orchestration model ─────────────────────────────────────────────
// A single, framework-agnostic launch primitive. The code-review use case is
// just one configuration of it (a scatter-gather of reviewer roles, optionally
// with a combiner). Focused on Claude Code for now: no per-row framework
// picking / cross-framework capability gating — the caller passes the framework.

export type OrchestrationMode = 'scatter-gather' | 'parallel' | 'serialized' | 'handoff';

/** Ticket lifecycle phase a launch belongs to. Drives which personas are offered. */
export type LaunchPhase = 'grooming' | 'implementation' | 'review' | 'finalize';

/**
 * Map a board status to the launch phase whose personas apply. Uses the board's
 * configured review status; everything before review is implementation, the
 * grooming column maps to grooming, terminal columns fall back to review.
 *
 * Note: never returns 'finalize' — that phase is action-triggered (user clicks
 * Finish), not status-driven. The LaunchPhase union includes it for template
 * resolution and persona filtering, but status mapping skips it intentionally.
 */
export function statusToPhase(
  status: string | undefined,
  opts?: { readyStatus?: string; groomingStatus?: string },
): LaunchPhase {
  const s = (status || '').trim();
  const readyStatus = (opts?.readyStatus || 'Ready').trim();
  const groomingStatus = (opts?.groomingStatus || 'Grooming').trim();
  if (!s) return 'implementation';
  if (s === groomingStatus || /^groom/i.test(s)) return 'grooming';
  if (s === readyStatus || /^review/i.test(s)) return 'review';
  if (/^(done|archived|released)$/i.test(s)) return 'review';
  return 'implementation';
}

/** Default board status to move a ticket to when launching agents for a phase. */
export function phaseLaunchStatus(phase: LaunchPhase): string | undefined {
  switch (phase) {
    case 'grooming': return 'Grooming';
    case 'implementation': return 'In Progress';
    case 'review': return 'In Progress';
    default: return undefined;
  }
}

/**
 * Resolve the default template id for a phase + variant. Falls back to the
 * built-in id convention: single → `builtin-<phase>-single` (supervisor, no pre-selected assistants),
 * multi → `builtin-<phase>-supervisor` (dynamic delegation).
 */
export function resolvePhaseDefaultId(
  phaseDefaults: Partial<Record<LaunchPhase, { single?: string; multi?: string }>> | undefined,
  phase: LaunchPhase,
  variant: 'single' | 'multi',
): string {
  const configured = phaseDefaults?.[phase]?.[variant];
  if (configured) return configured;
  return variant === 'multi' ? `builtin-${phase}-supervisor` : `builtin-${phase}-single`;
}

/**
 * Combiner/lead persona for a phase. If a workflow template configures an explicit
 * lead, that takes priority. Otherwise falls back to built-in defaults.
 */
export function phaseCombiner(phase: LaunchPhase, mode?: OrchestrationMode, configuredLead?: { personaId: string; label: string }): { personaId: string; label: string } | undefined {
  if (configuredLead) return configuredLead;
  if (mode === 'handoff') {
    return { personaId: 'supervisor', label: 'Supervisor' };
  }
  switch (phase) {
    case 'grooming': return { personaId: 'planner', label: 'Planner' };
    case 'implementation': return { personaId: 'dev-lead', label: 'Dev Lead' };
    case 'review': return { personaId: 'orchestrator', label: 'Review Lead' };
    default: return { personaId: 'coordinator', label: 'Coordinator' };
  }
}

export interface OrchestrationModeDef {
  id: OrchestrationMode;
  label: string;
  blurb: string;
  /** Engine execution pattern this mode maps to. */
  pattern: ExecutionPattern;
  /** Scatter-gather variant (combiner = synthesis node, headless = peer swarm). */
  variant?: GroupVariant;
  topology: TopologyShape;
  /** A coordinating lead/combiner agent participates in this mode. */
  hasLead: boolean;
  /** The engine can run this mode end-to-end today. */
  launchable: boolean;
  minAgents: number;
}

export const ORCHESTRATION_MODES: OrchestrationModeDef[] = [
  {
    id: 'scatter-gather',
    label: 'Scatter-gather',
    blurb: 'Fan out to N agents in parallel, then a combiner synthesizes their findings and decides the next step.',
    pattern: 'scatter-gather',
    variant: 'combiner',
    topology: 'fan',
    hasLead: true,
    launchable: true,
    minAgents: 1,
  },
  {
    id: 'parallel',
    label: 'Parallel',
    blurb: 'Run N independent agents at once. No combiner — you review the results and decide.',
    pattern: 'scatter-gather',
    variant: 'headless',
    topology: 'swarm',
    hasLead: false,
    launchable: true,
    minAgents: 1,
  },
  {
    id: 'serialized',
    label: 'Serialized',
    blurb: 'Pipeline A → B → C, one agent at a time, each handing off to the next.',
    pattern: 'relay',
    topology: 'pipeline',
    hasLead: false,
    launchable: true,
    minAgents: 2,
  },
  {
    id: 'handoff',
    label: 'Supervisor',
    blurb: 'A single lead agent dynamically discovers and delegates to specialists via MCP tools. No pre-selection needed.',
    pattern: 'supervisor',
    variant: 'combiner',
    topology: 'tree',
    hasLead: true,
    launchable: true,
    minAgents: 0,
  },
];

export function getOrchestrationMode(mode: OrchestrationMode): OrchestrationModeDef {
  const def = ORCHESTRATION_MODES.find(m => m.id === mode);
  if (!def) throw new Error(`Unknown orchestration mode: ${mode}`);
  return def;
}

export interface OrchestrationParticipant {
  /** Multi-session role tag (e.g. 'reviewer:architect'). */
  role: string;
  /** Human label used for error messages. */
  label: string;
  /** Persona whose prompt the engine resolves server-side at launch. */
  personaId: string;
  /** Optional reviewer focus note appended to the resolved prompt. */
  focusComment?: string;
}

/**
 * Generic orchestration launcher. Stamps every session in one run with a shared
 * groupId and the correct pattern metadata so all portal surfaces (card cluster,
 * Run View, popover, grouped history) render the same topology. Returns started
 * sessions plus any per-participant launch errors (partial-failure aware).
 */
export async function launchOrchestration(opts: {
  taskId: string;
  framework: CliFramework;
  mode: OrchestrationMode;
  participants: OrchestrationParticipant[];
  /** Combiner (scatter-gather) / lead (supervisor) agent, when the mode has one. */
  lead?: OrchestrationParticipant;
  currentUser: string;
  skipPermissions?: boolean;
  preStatus?: string;
  effortOverride?: string;
  /** Launch phase / intent — threaded to engine for phase-aware prompts. */
  phase?: LaunchPhase;
}): Promise<MultiReviewResult> {
  const { taskId, framework, mode, participants, lead, currentUser, skipPermissions = true, preStatus, effortOverride, phase } = opts;
  const def = getOrchestrationMode(mode);

  if (preStatus) {
    await updateTask(taskId, { status: preStatus, updatedBy: currentUser });
  }

  const groupId = crypto.randomUUID();
  const stepPosition: PatternPosition = def.pattern === 'supervisor' ? 'assistant' : 'step';

  // ── Relay pipeline: register step chain, launch only step 0 ──────────────
  if (def.pattern === 'relay') {
    const steps = participants.map(p => ({
      personaId: p.personaId,
      role: p.role,
      focusComment: p.focusComment,
    }));

    try {
      await registerRelayChain(taskId, {
        framework,
        groupId,
        steps,
        skipPermissions,
        effortOverride,
      });
    } catch (err) {
      throw new Error(`Failed to register relay chain: ${err instanceof Error ? err.message : 'unknown'}`, { cause: err });
    }

    // Launch only the first step; the engine barrier handles the rest.
    const first = participants[0];
    try {
      const session = await startTaskCliSessionEx(taskId, {
        framework,
        personaId: first.personaId,
        focusComment: first.focusComment,
        skipPermissions,
        effortOverride,
        phase,
        role: first.role,
        pattern: 'relay',
        patternPosition: 'step',
        groupId,
        groupSeq: 0,
        groupTotal: participants.length,
        groupType: 'relay',
      });
      return { sessions: [session], errors: [] };
    } catch (err) {
      await unregisterRelayChain(taskId, groupId).catch(() => {});
      throw new Error(`${first.label}: ${err instanceof Error ? err.message : 'failed to launch step 0'}`, { cause: err });
    }
  }

  // ── Supervisor: launch only the lead with delegation context ─────────────
  if (def.pattern === 'supervisor' && lead) {
    // When participants are pre-selected, show them as a curated shortlist.
    // When empty (pure supervisor mode), just tell the lead to discover dynamically.
    const rosterContext = participants.length > 0
      ? [
        `## Pre-selected Specialists (use only those relevant to THIS task)`,
        ``,
        `Below are specialists pre-configured for this workflow. You do NOT need to use all — delegate only when specialist knowledge adds clear value over doing it yourself.`,
        ``,
        participants.map(p => `- **${p.label}** (id: \`${p.personaId}\`): ${p.focusComment || 'general specialist'}`).join('\n'),
        ``,
        `Call \`list_available_agents\` if you need a specialist not listed above.`,
      ].join('\n')
      : `## Dynamic Delegation\n\nUse \`list_available_agents\` to discover specialists, then delegate as needed. Only delegate when specialist knowledge adds clear value over doing it yourself.`;

    // Inject effort-based delegation budget when available.
    const effortCaps = effortOverride ? [
      ``,
      `## Delegation Budget (ticket effort: ${effortOverride})`,
      `- XS: max 1 delegation. Prefer doing it yourself.`,
      `- S: max 2 delegations.`,
      `- M: max 3 delegations.`,
      `- L: max 5 delegations.`,
      `- XL: unlimited, but still skip irrelevant specialists.`,
    ].join('\n') : '';

    try {
      const leadFocus = rosterContext + effortCaps + (lead.focusComment ? `\n\n${lead.focusComment}` : '');
      const leadSession = await startTaskCliSessionEx(taskId, {
        framework,
        personaId: lead.personaId,
        focusComment: leadFocus,
        skipPermissions,
        effortOverride,
        phase,
        role: lead.role,
        pattern: 'supervisor',
        patternPosition: 'lead',
        groupId,
        groupType: 'supervisor',
        groupVariant: def.variant,
      });
      return { sessions: [leadSession], errors: [] };
    } catch (err) {
      throw new Error(`${lead.label}: ${err instanceof Error ? err.message : 'failed to launch supervisor lead'}`, { cause: err });
    }
  }

  // ── Scatter-gather / parallel ──────────────────────────────────────────────

  // A combiner/lead only earns its keep when there are multiple workers to
  // synthesize. With a single participant, skip it entirely and just run that
  // one agent solo — no orchestrator overhead for the cheap single-reviewer path.
  const useLead = def.hasLead && !!lead && participants.length > 1;

  // FLUX-754: a lead-capable review mode launched with exactly ONE participant collapses to a lone
  // reviewer (useLead is false — it requires >1). Without an orchestrator to synthesize, that
  // reviewer posts its review and defers to nobody, leaving the ticket dangling in In Progress
  // (the PR-62 bug). Option A: grant the sole reviewer authority to finalize itself via an appended
  // focusComment — resolvePersonaPrompt appends focus AFTER the persona prompt, so it supersedes the
  // persona's blanket "defer" line (which we also carve out for the sole-reviewer case). The combiner
  // path (useLead, ≥2 workers) is untouched.
  const soloReviewer = def.hasLead && participants.length === 1;
  const soloAuthority =
    '\n\n---\n**You are the SOLE reviewer for this ticket — there is no orchestrator and no other reviewer to synthesize your verdict.** You OWN the final decision. After posting your structured review you MUST call `change_status`: APPROVED → "Ready" with a summary; CHANGES NEEDED → "In Progress" with the required changes (Blockers first); if you need a user decision → "Require Input". Do not end your turn without a status move.';

  // Scatter-gather combiners must run AFTER their workers finish. Register the
  // combiner as deferred BEFORE launching workers so the engine's fan-in barrier
  // owns the sequencing — a Claude CLI session can't poll/block to wait itself.
  const deferCombiner = useLead && def.pattern === 'scatter-gather';
  let combinerDeferred = false;
  if (deferCombiner && lead) {
    try {
      await registerDeferredCombiner(taskId, {
        framework,
        groupId,
        role: lead.role,
        personaId: lead.personaId,
        expectedWorkers: participants.length,
        skipPermissions,
        groupType: def.pattern,
        groupVariant: def.variant,
      });
      combinerDeferred = true;
    } catch {
      // Non-fatal: fall back to inline launch below if registration fails.
    }
  }

  const results = await Promise.allSettled(
    participants.map((p, i) =>
      startTaskCliSessionEx(taskId, {
        framework,
        personaId: p.personaId,
        // FLUX-754: the lone reviewer gets decision authority appended; multi-reviewer focus is untouched.
        focusComment: soloReviewer ? (p.focusComment ?? '') + soloAuthority : p.focusComment,
        skipPermissions,
        effortOverride,
        phase,
        role: p.role,
        pattern: def.pattern,
        patternPosition: stepPosition,
        groupId,
        groupSeq: i,
        groupType: def.pattern,
        groupVariant: def.variant,
      })
    )
  );

  const sessions: CliSessionSummary[] = [];
  const errors: string[] = [];
  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    if (result.status === 'fulfilled') {
      sessions.push(result.value);
    } else {
      errors.push(`${participants[i].label}: ${result.reason?.message || 'failed'}`);
    }
  }

  if (sessions.length === 0 && participants.length > 0) {
    if (combinerDeferred) {
      // No workers started — cancel the deferred combiner so it never fires.
      await unregisterDeferredCombiner(taskId, groupId).catch(() => {});
    }
    throw new Error(`All sessions failed: ${errors.join('; ')}`);
  }

  // Lead / combiner agent. Scatter-gather combiners are deferred to the engine
  // barrier (registered above); only supervisor-style leads launch inline here.
  if (useLead && lead && !combinerDeferred) {
    try {
      const leadSession = await startTaskCliSessionEx(taskId, {
        framework,
        personaId: lead.personaId,
        focusComment: lead.focusComment,
        skipPermissions,
        effortOverride,
        phase,
        role: lead.role,
        pattern: def.pattern,
        patternPosition: 'lead',
        groupId,
        groupType: def.pattern,
        groupVariant: def.variant,
      });
      sessions.unshift(leadSession);
    } catch (err) {
      errors.push(`${lead.label}: ${err instanceof Error ? err.message : 'failed to launch'}`);
    }
  }

  return { sessions, errors };
}

const personaToParticipant = (p: ReviewPersona): OrchestrationParticipant => ({
  role: `reviewer:${p.id}`,
  label: p.label,
  personaId: p.id,
});

/**
 * Launch multiple review sessions in parallel (headless scatter-gather / swarm).
 * Thin preset over {@link launchOrchestration} for the code-review use case.
 */
export async function runParallelReviews(opts: {
  taskId: string;
  framework: CliFramework;
  personas: ReviewPersona[];
  currentUser: string;
  skipPermissions?: boolean;
  preStatus?: string;
}): Promise<MultiReviewResult> {
  return launchOrchestration({
    taskId: opts.taskId,
    framework: opts.framework,
    mode: 'parallel',
    participants: opts.personas.map(personaToParticipant),
    currentUser: opts.currentUser,
    skipPermissions: opts.skipPermissions,
    preStatus: opts.preStatus,
    phase: 'review',
  });
}

/**
 * Launch an orchestrated review: parallel reviewers + a combiner that synthesizes
 * and decides status. Thin preset over {@link launchOrchestration}.
 */
export async function launchOrchestratedReview(opts: {
  taskId: string;
  framework: CliFramework;
  personas: ReviewPersona[];
  currentUser: string;
  skipPermissions?: boolean;
  preStatus?: string;
}): Promise<MultiReviewResult> {
  return launchOrchestration({
    taskId: opts.taskId,
    framework: opts.framework,
    mode: 'scatter-gather',
    participants: opts.personas.map(personaToParticipant),
    lead: { role: 'orchestrator', label: 'Orchestrator', personaId: 'orchestrator' },
    currentUser: opts.currentUser,
    skipPermissions: opts.skipPermissions,
    preStatus: opts.preStatus,
    phase: 'review',
  });
}
