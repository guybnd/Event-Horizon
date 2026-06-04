import type { ExecutionPattern, CliCapabilities } from './agents/types.js';
import type { Phase } from './models/workflow.js';
import fs from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import { getActiveFluxDir } from './workspace.js';

/**
 * Server-side orchestration persona catalog.
 *
 * Prompts live here (not in the portal bundle) so the client only ever sends a
 * `personaId` at launch and the engine resolves the full prompt text. This keeps
 * ~10KB of prompt literals out of the client bundle and makes personas the
 * single authoritative source for orchestration roles.
 *
 * Built-in personas are defined in code (read-only). User-authored personas are
 * persisted under `<fluxDir>/personas/*.json` and merged in at read time.
 */
export interface OrchestrationPersona {
  id: string;
  label: string;
  description: string;
  /** Ticket phase this persona belongs to (drives phase-aware launch filtering). */
  phase: Phase;
  /** Orchestration modes this persona can participate in. Empty = any mode. */
  compatiblePatterns: ExecutionPattern[];
  /** CLI capabilities the persona needs. Empty = runnable on any framework. */
  requiredCapabilities: (keyof CliCapabilities)[];
  /** Full prompt the agent session launches with. Never sent to the client for built-ins. */
  prompt: string;
  /** True for code-defined personas (cannot be edited or deleted). */
  builtIn?: boolean;
}

/** Persona metadata with the prompt stripped — the shape exposed over the API. */
export type OrchestrationPersonaMeta = Omit<OrchestrationPersona, 'prompt'>;

export const ORCHESTRATION_PERSONAS: OrchestrationPersona[] = [
  {
    id: 'senior-dev',
    label: 'Senior Friendly Dev',
    description: 'Collegial, constructive — quality, readability & maintainability',
    phase: 'review',
    compatiblePatterns: [],
    requiredCapabilities: [],
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
    phase: 'review',
    compatiblePatterns: [],
    requiredCapabilities: [],
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
    phase: 'review',
    compatiblePatterns: [],
    requiredCapabilities: [],
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
    phase: 'review',
    compatiblePatterns: [],
    requiredCapabilities: [],
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
    phase: 'review',
    compatiblePatterns: [],
    requiredCapabilities: [],
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
  {
    id: 'planner',
    label: 'Planner',
    description: 'Turns requirements into a concrete, sequenced implementation plan',
    phase: 'grooming',
    compatiblePatterns: [],
    requiredCapabilities: [],
    prompt: `You are acting as a planning agent grooming this ticket. Your job is to turn the requirements into a concrete, actionable implementation plan — not to write code.

Steps to follow:
1. Read the full ticket description and all history comments to understand the intent, constraints, and any prior decisions.
2. Explore the relevant parts of the codebase to ground the plan in how things actually work today. Identify the smallest surface that owns the change.
3. If an implementation-critical decision is genuinely ambiguous, post ONE clear question with a proposed default using the \`change_status\` MCP tool to move the ticket to "Require Input"; otherwise continue.
4. Rewrite the ticket body via \`update_ticket\` with:
   - **Problem / Motivation** (1-3 sentences)
   - **Implementation plan**: concrete, sequenced steps another agent could pick up without re-discovery, naming the key files.
   - Filled metadata (priority, effort, tags) where inferable.
5. When the plan is solid and no input is pending, use \`change_status\` to move the ticket to "Todo". Do not start coding.

Keep the plan tight and specific. Prefer the smallest change that satisfies the intent.`,
  },
  {
    id: 'implementer',
    label: 'Implementer',
    description: 'Implements the ticket plan in the smallest correct change',
    phase: 'implementation',
    compatiblePatterns: [],
    requiredCapabilities: [],
    prompt: `You are acting as an implementation agent building this ticket. Your job is to implement the planned change correctly in the smallest reasonable surface.

Steps to follow:
1. Read the full ticket description and all history comments to understand the plan and any review feedback.
2. Use \`change_status\` to move the ticket to "In Progress" before the first substantive code change (if it isn't already).
3. Implement the change in the smallest owning surface. Read nearby files first; match existing conventions. Validate as you go (build/tests) after the first edit.
4. Use \`log_progress\` to record meaningful progress, scope changes, or validation failures. If you hit a genuine blocker needing a decision, use \`change_status\` to "Require Input" with a concrete question + proposed default.
5. When the work is implemented and validated, use \`change_status\` to move the ticket to "Ready" with a comment summarizing what was implemented, what you validated, and any caveats. Do not commit — the user finalizes via the finish handoff.

Prefer correctness and minimal footprint over cleverness. Do not add features, refactors, or abstractions beyond what the ticket asks.`,
  },
];

/**
 * The combiner/lead persona for scatter-gather and supervisor runs. It is not a
 * user-selectable reviewer (it's implied by a mode's `hasLead`), so it lives
 * outside the selectable catalog but is still resolvable by id.
 */
export const ORCHESTRATOR_PERSONA: OrchestrationPersona = {
  id: 'orchestrator',
  label: 'Orchestrator',
  description: 'Synthesizes reviewer findings and decides the next status',
  phase: 'review',
  compatiblePatterns: ['scatter-gather', 'supervisor'],
  requiredCapabilities: [],
  prompt: `You are a code review orchestrator. Your job is to wait for all reviewer sessions to complete, then synthesize their findings into an actionable summary.

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

You have full authority to change the ticket status based on reviewer consensus.`,
};

// Stamp built-in personas so the client can tell them apart from custom ones.
for (const p of ORCHESTRATION_PERSONAS) p.builtIn = true;
ORCHESTRATOR_PERSONA.builtIn = true;

const ALL_BUILT_IN: OrchestrationPersona[] = [...ORCHESTRATION_PERSONAS, ORCHESTRATOR_PERSONA];

// ── Custom persona persistence ───────────────────────────────────────────────
// User-authored personas live as JSON files under <fluxDir>/personas/ and are
// merged with the built-ins at read time. Built-ins are never written to disk.

const VALID_PHASES: Phase[] = ['grooming', 'implementation', 'review', 'release'];

let customPersonaCache: OrchestrationPersona[] = [];

export function getPersonasDir(): string {
  return path.join(getActiveFluxDir(), 'personas');
}

/** Load all custom personas from disk into the cache. Safe to call repeatedly. */
export async function loadCustomPersonas(): Promise<OrchestrationPersona[]> {
  const dir = getPersonasDir();
  if (!existsSync(dir)) {
    customPersonaCache = [];
    return [];
  }
  const files = await fs.readdir(dir);
  const personas: OrchestrationPersona[] = [];
  for (const file of files) {
    if (!file.endsWith('.json')) continue;
    try {
      const raw = await fs.readFile(path.join(dir, file), 'utf-8');
      const parsed = JSON.parse(raw) as OrchestrationPersona;
      parsed.builtIn = false;
      personas.push(parsed);
    } catch {
      // Skip malformed persona files rather than failing the whole load.
    }
  }
  customPersonaCache = personas;
  return personas;
}

/** All personas (built-in + custom), excluding the non-selectable orchestrator. */
function getSelectablePersonas(): OrchestrationPersona[] {
  return [...ORCHESTRATION_PERSONAS, ...customPersonaCache];
}

/** Validate a custom persona payload. Returns an error string or null if valid. */
export function validatePersona(p: Partial<OrchestrationPersona>): string | null {
  if (!p.id?.trim() || !/^[a-z0-9][a-z0-9-]*$/.test(p.id.trim())) {
    return 'id is required and must be a slug (lowercase letters, numbers, hyphens)';
  }
  if (!p.label?.trim()) return 'label is required';
  if (!p.phase || !VALID_PHASES.includes(p.phase)) {
    return `phase must be one of: ${VALID_PHASES.join(', ')}`;
  }
  if (!p.prompt?.trim()) return 'prompt is required';
  return null;
}

/**
 * Create or update a custom persona. Refuses ids that collide with a built-in.
 * Returns the persisted persona (with builtIn=false).
 */
export async function saveCustomPersona(input: Partial<OrchestrationPersona>): Promise<OrchestrationPersona> {
  const err = validatePersona(input);
  if (err) throw new Error(err);
  const id = input.id!.trim();
  if (ALL_BUILT_IN.some((p) => p.id === id)) {
    throw new Error(`"${id}" is a built-in persona and cannot be overwritten`);
  }
  const persona: OrchestrationPersona = {
    id,
    label: input.label!.trim(),
    description: input.description?.trim() ?? '',
    phase: input.phase!,
    compatiblePatterns: Array.isArray(input.compatiblePatterns) ? input.compatiblePatterns : [],
    requiredCapabilities: Array.isArray(input.requiredCapabilities) ? input.requiredCapabilities : [],
    prompt: input.prompt!,
    builtIn: false,
  };
  const dir = getPersonasDir();
  if (!existsSync(dir)) await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, `${id}.json`), JSON.stringify(persona, null, 2), 'utf-8');
  const idx = customPersonaCache.findIndex((p) => p.id === id);
  if (idx >= 0) customPersonaCache[idx] = persona;
  else customPersonaCache.push(persona);
  return persona;
}

/** Delete a custom persona by id. Refuses built-ins. Returns false if not found. */
export async function deleteCustomPersona(id: string): Promise<boolean> {
  if (ALL_BUILT_IN.some((p) => p.id === id)) {
    throw new Error(`"${id}" is a built-in persona and cannot be deleted`);
  }
  const filePath = path.join(getPersonasDir(), `${id}.json`);
  if (!existsSync(filePath)) return false;
  await fs.unlink(filePath);
  customPersonaCache = customPersonaCache.filter((p) => p.id !== id);
  return true;
}

/** Resolve a persona (built-in, orchestrator, or custom) by id. */
export function getPersonaById(id: string): OrchestrationPersona | undefined {
  return ALL_BUILT_IN.find((p) => p.id === id) ?? customPersonaCache.find((p) => p.id === id);
}

/**
 * Full persona for editing — includes prompt. Only custom personas expose their
 * prompt; built-ins return undefined so their prompt text never reaches the client.
 */
export function getEditablePersona(id: string): OrchestrationPersona | undefined {
  const custom = customPersonaCache.find((p) => p.id === id);
  return custom ? { ...custom } : undefined;
}

/** Strip the prompt — the only shape that should ever reach the client. */
export function toPersonaMeta(p: OrchestrationPersona): OrchestrationPersonaMeta {
  const { prompt: _prompt, ...meta } = p;
  return meta;
}

/**
 * Metadata for user-selectable personas (no prompts, no orchestrator). Pass a
 * `phase` to return only the personas configured for that ticket phase. Includes
 * both built-in and custom personas.
 */
export function listSelectablePersonaMeta(phase?: Phase): OrchestrationPersonaMeta[] {
  const all = getSelectablePersonas();
  const personas = phase ? all.filter((p) => p.phase === phase) : all;
  return personas.map(toPersonaMeta);
}

/**
 * Resolve a persona's full prompt server-side, optionally appending a user focus
 * note. Returns undefined for unknown ids so callers can 400.
 */
export function resolvePersonaPrompt(id: string, focusComment?: string): string | undefined {
  const persona = getPersonaById(id);
  if (!persona) return undefined;
  const focus = focusComment?.trim();
  if (!focus) return persona.prompt;
  return `${persona.prompt}\n\nThe user specifically asked you to focus on:\n${focus}`;
}
