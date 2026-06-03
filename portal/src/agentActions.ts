import { startTaskCliSession, updateTask } from './api';
import type { CliFramework, CliSessionSummary } from './types';
import { REVIEW_PERSONAS, type ReviewPersona } from './components/CodeReviewButton';

export { REVIEW_PERSONAS };
export type { ReviewPersona };

export const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type EffortLevel = typeof EFFORT_LEVELS[number];

export type AgentCommandVerb = 'implement' | 'groom' | 'finish' | 'review';

export interface AgentCommandDef {
  label: string;
  verb: AgentCommandVerb;
  /** If set, ticket is moved to this status before launching. */
  preStatus?: string;
}

export const AGENT_COMMANDS: AgentCommandDef[] = [
  { label: 'Implement', verb: 'implement' },
  { label: 'Groom', verb: 'groom' },
  { label: 'Finish', verb: 'finish' },
  { label: 'Review', verb: 'review' },
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

  return startTaskCliSession(taskId, framework, appendPrompt, skipPermissions, effortOverride);
}
