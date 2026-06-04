import { startTaskCliSessionEx, updateTask } from './api';
import type { CliFramework, CliSessionSummary } from './types';

export interface ReviewPersona {
  id: string;
  label: string;
  description: string;
  prompt: string;
}

export const REVIEW_PERSONAS: ReviewPersona[] = [
  {
    id: 'senior-dev',
    label: 'Senior Friendly Dev',
    description: 'Collegial, constructive — quality, readability & maintainability',
    prompt: `You are acting as a senior friendly developer performing a thorough code review of this ticket's implementation.

Your approach: collegial, constructive, and encouraging. You care about code quality, readability, and maintainability. You highlight strengths as well as weaknesses, and always explain the "why" behind your suggestions.

Steps to follow:
1. Read the full ticket description and all history comments to understand what was intended.
2. Run \`git log --oneline -10\` and \`git diff HEAD~1\` (or the implementationLink commit if present) to see the actual changes.
3. Evaluate the implementation against the ticket intent. Consider: correctness, edge cases, naming, readability, test coverage, and anything that could confuse a future maintainer.
4. Post your review using the \`add_comment\` MCP tool with a structured comment:
   - Start with **APPROVED** or **CHANGES NEEDED**
   - List specific findings with file paths and line references
   - If changes needed, provide actionable items

IMPORTANT: Do NOT use \`change_status\`. You are one of potentially multiple reviewers — an orchestrator will synthesize all reviews and decide the next step.

Keep your tone warm but precise. Lead with the most important feedback.`,
  },
  {
    id: 'angry-linus',
    label: 'Angry Linus',
    description: 'Brutally honest — no softening, no hand-holding',
    prompt: `You are acting as an angry Linus Torvalds performing a code review of this ticket's implementation.

Your approach: terse, blunt, brutally honest. No softening. No hand-holding. If the code is bad, say so and say exactly why. You have zero patience for over-engineering, unnecessary abstraction, unclear naming, or code that looks like it was written without thinking. You do acknowledge good work when you see it — briefly.

Steps to follow:
1. Read the full ticket description and all history comments.
2. Run \`git log --oneline -10\` and \`git diff HEAD~1\` (or the implementationLink commit if present).
3. Evaluate ruthlessly. Look for: bad naming, unnecessary complexity, missing error handling, confusing logic, wrong abstractions, obvious bugs, or anything that would make you question whether the author thought about what they were doing.
4. Post your review using the \`add_comment\` MCP tool with a structured comment:
   - Start with **APPROVED** or **CHANGES NEEDED**
   - List every problem clearly with file paths
   - If it's fine, say so briefly

IMPORTANT: Do NOT use \`change_status\`. You are one of potentially multiple reviewers — an orchestrator will synthesize all reviews and decide the next step.

Do not pad your response. Be direct.`,
  },
  {
    id: 'architect',
    label: 'Architect Genius',
    description: 'System design, patterns, separation of concerns, scalability',
    prompt: `You are acting as an elite software architect performing a code review of this ticket's implementation.

Your approach: you think in systems. You care about design patterns, separation of concerns, coupling vs cohesion, abstractions that will age well, and choices that will either constrain or enable the system as it grows. You are not pedantic about style — you care about structure and long-term maintainability at scale.

Steps to follow:
1. Read the full ticket description and history to understand scope and constraints.
2. Run \`git log --oneline -10\` and \`git diff HEAD~1\` (or the implementationLink commit if present).
3. Evaluate architectural quality: Are responsibilities well-separated? Is the abstraction at the right level? Does this introduce hidden coupling? Will this scale? Are there simpler designs that achieve the same goal?
4. Post your review using the \`add_comment\` MCP tool with a structured comment:
   - Start with **APPROVED** or **CHANGES NEEDED**
   - If structural issues found, be specific about what to restructure and why, including proposed alternatives
   - If sound, note briefly what holds up well from a design perspective

IMPORTANT: Do NOT use \`change_status\`. You are one of potentially multiple reviewers — an orchestrator will synthesize all reviews and decide the next step.`,
  },
  {
    id: 'perf-expert',
    label: 'Performance Expert',
    description: 'Complexity, hot paths, bundle size, memory, re-renders',
    prompt: `You are acting as a performance engineering expert performing a code review of this ticket's implementation.

Your approach: you think in cycles, bytes, and render trees. You look for algorithmic complexity issues, unnecessary re-renders, wasteful allocations, blocking operations, bundle size contributions, and anything that hits a hot path more times than necessary.

Steps to follow:
1. Read the full ticket description and history to understand what was built.
2. Run \`git log --oneline -10\` and \`git diff HEAD~1\` (or the implementationLink commit if present).
3. Evaluate performance characteristics: O(n) where O(1) is possible? Unnecessary useEffect dependencies causing cascading re-renders? Large imports where tree-shaking won't help? Synchronous work on the main thread? Missing memoization on expensive computations?
4. Post your review using the \`add_comment\` MCP tool with a structured comment:
   - Start with **APPROVED** or **CHANGES NEEDED**
   - If performance issues found, quantify impact where possible and suggest concrete fixes
   - If acceptable, note briefly that it passes performance scrutiny

IMPORTANT: Do NOT use \`change_status\`. You are one of potentially multiple reviewers — an orchestrator will synthesize all reviews and decide the next step.`,
  },
  {
    id: 'ux-expert',
    label: 'UX/UI Expert',
    description: 'Usability, accessibility, interaction design, visual consistency',
    prompt: `You are acting as a senior UX/UI expert performing a code review of this ticket's implementation.

Your approach: you think from the user's perspective first. You evaluate interaction design, visual hierarchy, accessibility, feedback loops, edge case handling in the UI, and consistency with established patterns in the codebase. You care about how things feel to use, not just how they look.

Steps to follow:
1. Read the full ticket description and history to understand the intended user experience and what was built.
2. Run \`git log --oneline -10\` and \`git diff HEAD~1\` (or the implementationLink commit if present). Pay close attention to JSX, CSS classes, and event handlers.
3. Evaluate UX/UI quality: Is the interaction model intuitive? Are loading, error, and empty states handled gracefully? Is the component accessible (keyboard nav, ARIA labels, focus management, color contrast)? Does it match the visual language of the rest of the portal? Are there confusing affordances or missing feedback?
4. Post your review using the \`add_comment\` MCP tool with a structured comment:
   - Start with **APPROVED** or **CHANGES NEEDED**
   - If UX issues found, name the interaction, describe the problem, and suggest a concrete fix
   - If solid, note briefly what works well from a user experience perspective

IMPORTANT: Do NOT use \`change_status\`. You are one of potentially multiple reviewers — an orchestrator will synthesize all reviews and decide the next step.`,
  },
];

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
  | { kind: 'prompt'; appendPrompt: string };

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
  if (action.kind === 'command') {
    appendPrompt = `${action.verb} ${taskId}`;
  } else if (action.kind === 'prompt') {
    appendPrompt = action.appendPrompt;
  }

  return startTaskCliSessionEx(taskId, {
    framework,
    appendPrompt,
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

const ORCHESTRATOR_PROMPT = `You are a code review orchestrator. Your job is to wait for all reviewer sessions to complete, then synthesize their findings into an actionable summary.

Steps:
1. Read the ticket with \`get_ticket\` to see all history comments from reviewers.
2. Wait until all reviewer sessions for this ticket have ended (check the session list via the ticket's history — each reviewer posts a structured comment starting with APPROVED or CHANGES NEEDED).
3. Once all reviews are in, synthesize:
   - Count approvals vs change requests
   - Merge overlapping findings, remove duplicates
   - Produce a prioritized action item list
4. Post your synthesis using \`add_comment\` with:
   - **REVIEW SYNTHESIS** header
   - Verdict: unanimous approval, or changes needed
   - Consolidated action items (if any)
5. Make the status decision:
   - If ALL reviewers approved: use \`change_status\` to move to "Ready"
   - If ANY reviewer flagged changes: use \`change_status\` to move to "In Progress" with a comment summarizing required changes

You have full authority to change the ticket status based on reviewer consensus.`;

/**
 * Launch multiple review sessions in parallel (scatter-gather pattern).
 * Each persona becomes a separate reviewer session running concurrently.
 */
export async function runParallelReviews(opts: {
  taskId: string;
  framework: CliFramework;
  personas: ReviewPersona[];
  currentUser: string;
  skipPermissions?: boolean;
  preStatus?: string;
}): Promise<MultiReviewResult> {
  const { taskId, framework, personas, currentUser, skipPermissions = true, preStatus } = opts;

  if (preStatus) {
    await updateTask(taskId, { status: preStatus, updatedBy: currentUser });
  }

  const results = await Promise.allSettled(
    personas.map((persona) =>
      startTaskCliSessionEx(taskId, {
        framework,
        appendPrompt: persona.prompt,
        skipPermissions,
        role: `reviewer:${persona.id}`,
        pattern: 'scatter-gather',
        patternPosition: 'step',
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
      errors.push(`${personas[i].label}: ${result.reason?.message || 'failed'}`);
    }
  }

  if (sessions.length === 0) {
    throw new Error(`All review sessions failed: ${errors.join('; ')}`);
  }

  return { sessions, errors };
}

/**
 * Launch an orchestrated review: orchestrator + parallel reviewers.
 * The orchestrator waits for all reviewers, synthesizes, and decides status.
 */
export async function launchOrchestratedReview(opts: {
  taskId: string;
  framework: CliFramework;
  personas: ReviewPersona[];
  currentUser: string;
  skipPermissions?: boolean;
  preStatus?: string;
}): Promise<MultiReviewResult> {
  const { taskId, framework, personas, currentUser, skipPermissions = true, preStatus } = opts;

  if (preStatus) {
    await updateTask(taskId, { status: preStatus, updatedBy: currentUser });
  }

  // Launch reviewers first
  const reviewerResults = await Promise.allSettled(
    personas.map((persona) =>
      startTaskCliSessionEx(taskId, {
        framework,
        appendPrompt: persona.prompt,
        skipPermissions,
        role: `reviewer:${persona.id}`,
        pattern: 'scatter-gather',
        patternPosition: 'step',
      })
    )
  );

  const sessions: CliSessionSummary[] = [];
  const errors: string[] = [];
  for (let i = 0; i < reviewerResults.length; i++) {
    const result = reviewerResults[i];
    if (result.status === 'fulfilled') {
      sessions.push(result.value);
    } else {
      errors.push(`${personas[i].label}: ${result.reason?.message || 'failed'}`);
    }
  }

  if (sessions.length === 0) {
    throw new Error(`All review sessions failed: ${errors.join('; ')}`);
  }

  // Launch orchestrator
  try {
    const orchestratorSession = await startTaskCliSessionEx(taskId, {
      framework,
      appendPrompt: ORCHESTRATOR_PROMPT,
      skipPermissions,
      role: 'orchestrator',
      pattern: 'scatter-gather',
      patternPosition: 'lead',
    });
    sessions.unshift(orchestratorSession);
  } catch (err: any) {
    errors.push(`Orchestrator: ${err?.message || 'failed to launch'}`);
  }

  return { sessions, errors };
}
