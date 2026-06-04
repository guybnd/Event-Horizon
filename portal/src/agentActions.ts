import { startTaskCliSessionEx, updateTask, registerDeferredCombiner, unregisterDeferredCombiner, type OrchestrationPersonaMeta } from './api';
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
    role,
    pattern,
    patternPosition,
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
export type LaunchPhase = 'grooming' | 'implementation' | 'review' | 'release';

/**
 * Map a board status to the launch phase whose personas apply. Uses the board's
 * configured review status; everything before review is implementation, the
 * grooming column maps to grooming, terminal columns fall back to review.
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
    launchable: false,
    minAgents: 2,
  },
  {
    id: 'handoff',
    label: 'Hand-off',
    blurb: 'A lead agent delegates to assistants and resumes once they report back.',
    pattern: 'supervisor',
    variant: 'combiner',
    topology: 'tree',
    hasLead: true,
    launchable: false,
    minAgents: 1,
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
}): Promise<MultiReviewResult> {
  const { taskId, framework, mode, participants, lead, currentUser, skipPermissions = true, preStatus } = opts;
  const def = getOrchestrationMode(mode);

  if (preStatus) {
    await updateTask(taskId, { status: preStatus, updatedBy: currentUser });
  }

  const groupId = crypto.randomUUID();
  const stepPosition: PatternPosition = def.pattern === 'supervisor' ? 'assistant' : 'step';

  // A combiner/lead only earns its keep when there are multiple workers to
  // synthesize. With a single participant, skip it entirely and just run that
  // one agent solo — no orchestrator overhead for the cheap single-reviewer path.
  const useLead = def.hasLead && !!lead && participants.length > 1;

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
        focusComment: p.focusComment,
        skipPermissions,
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
        role: lead.role,
        pattern: def.pattern,
        patternPosition: 'lead',
        groupId,
        groupType: def.pattern,
        groupVariant: def.variant,
      });
      sessions.unshift(leadSession);
    } catch (err: any) {
      errors.push(`${lead.label}: ${err?.message || 'failed to launch'}`);
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
  });
}
