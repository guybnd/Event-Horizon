// Phase-aware chat action bar — the single source of truth for "what can I do to a
// ticket from here" (FLUX-610). Splits ENGINE actions (direct REST, zero tokens,
// deterministic) from AGENT dispatch (deliberate, tokenized sessions) and LINK actions
// (open the PR). Both the chat bar and the board share `buildStatusChangeHistory` /
// `changeTaskStatus` so status moves are constructed in exactly one place.

import type { Config, HistoryEntry, Task } from '../types';
import { updateTask } from '../api';
import { getReadyForMergeStatus, getRequireInputStatus } from '../workflow';
import type { LaunchPhase } from '../agentActions';

// Standard board statuses these actions transition to. They mirror the engine defaults
// (see phaseLaunchStatus / config defaults); Ready / Require Input resolve from config.
const TODO_STATUS = 'Todo';
const IN_PROGRESS_STATUS = 'In Progress';

/**
 * Build the history array for a status change: an optional comment entry (required by the
 * engine for Ready / Require Input) followed by the `status_change` entry. Extracted from
 * Board.tsx so the board and the chat action bar don't duplicate the shape.
 */
export function buildStatusChangeHistory(
  task: Task,
  newStatus: string,
  currentUser: string,
  comment?: string,
): HistoryEntry[] {
  const timestamp = new Date().toISOString();
  const history: HistoryEntry[] = [...(task.history || [])];

  // A separate comment entry satisfies engine validation for Ready / Require Input.
  if (comment?.trim()) {
    history.push({ type: 'comment', user: currentUser, date: timestamp, comment: comment.trim() });
  }

  history.push({
    type: 'status_change',
    from: task.status,
    to: newStatus,
    user: currentUser,
    date: timestamp,
    comment: comment?.trim() ? 'Included with comment' : undefined,
  });

  return history;
}

/**
 * Persist a status change (build history + PUT). The board keeps its own optimistic
 * wrapper around `buildStatusChangeHistory`; lightweight callers (the action bar) use
 * this directly.
 */
export async function changeTaskStatus(
  task: Task,
  newStatus: string,
  currentUser: string,
  opts?: { comment?: string; order?: number },
): Promise<void> {
  const history = buildStatusChangeHistory(task, newStatus, currentUser, opts?.comment);
  await updateTask(task.id, {
    status: newStatus,
    order: opts?.order ?? task.order ?? 0,
    history,
    updatedBy: currentUser,
  });
}

export type TicketActionKind = 'engine' | 'agent' | 'link';
export type TicketActionTone = 'default' | 'primary' | 'danger';

export interface TicketAction {
  key: string;
  label: string;
  /** engine = direct REST (zero tokens) · agent = tokenized session · link = open a url */
  kind: TicketActionKind;
  tone?: TicketActionTone;
  /** For `link` actions. */
  href?: string;
  /** For `engine` / `agent` actions. */
  run?: () => void | Promise<void>;
}

/**
 * Imperative hooks the action bar provides; `actionsForStatus` closes over these so it can
 * stay a declarative status→actions map.
 */
export interface TicketActionContext {
  config?: Config | null;
  /** Engine status move. `needsComment` prompts for the Ready/Require Input comment. */
  changeStatus: (newStatus: string, opts?: { needsComment?: boolean }) => void | Promise<void>;
  /** Engine finish for branch/PR tickets — merge the open PR and advance to Done. */
  finishViaMerge: () => void | Promise<void>;
  /** Agent dispatch in a phase (groom / implement / review). Tokenized. */
  dispatchAgent: (phase: LaunchPhase) => void | Promise<void>;
  /** Agent `finish` — branchless tickets need a curated commit, so this is tokenized. */
  dispatchFinish: () => void | Promise<void>;
}

/** PR/commit url if it's an actual link (commit-hash implementationLinks aren't openable). */
function prLink(task: Task): string | undefined {
  const link = task.implementationLink;
  return link && /^https?:\/\//.test(link) ? link : undefined;
}

/**
 * The phase-aware action set for a ticket's current status. Single source of truth for the
 * chat action bar. Ordering is engine-first (free) then agent (tokenized) then link.
 */
export function actionsForStatus(task: Task, ctx: TicketActionContext): TicketAction[] {
  const status = (task.status || '').trim();
  const readyStatus = getReadyForMergeStatus(ctx.config);
  const requireInputStatus = getRequireInputStatus(ctx.config);
  const actions: TicketAction[] = [];
  const pr = prLink(task);

  // Grooming / Require Input → plan it forward or hand to the grooming agent.
  if (/^groom/i.test(status) || status === requireInputStatus) {
    actions.push({ key: 'to-todo', label: 'Move to Todo', kind: 'engine', run: () => ctx.changeStatus(TODO_STATUS) });
    actions.push({ key: 'groom', label: 'Groom', kind: 'agent', run: () => ctx.dispatchAgent('grooming') });
    return actions;
  }

  if (status === TODO_STATUS) {
    actions.push({ key: 'to-in-progress', label: 'Move to In Progress', kind: 'engine', run: () => ctx.changeStatus(IN_PROGRESS_STATUS) });
    actions.push({ key: 'implement', label: 'Start', kind: 'agent', tone: 'primary', run: () => ctx.dispatchAgent('implementation') });
    return actions;
  }

  if (status === IN_PROGRESS_STATUS) {
    actions.push({ key: 'to-ready', label: 'Move to Ready', kind: 'engine', tone: 'primary', run: () => ctx.changeStatus(readyStatus, { needsComment: true }) });
    actions.push({ key: 'require-input', label: 'Require Input', kind: 'engine', run: () => ctx.changeStatus(requireInputStatus, { needsComment: true }) });
    if (pr) actions.push({ key: 'open-pr', label: 'Open PR', kind: 'link', href: pr });
    return actions;
  }

  if (status === readyStatus) {
    // Finish: branch/PR ticket → engine merge (zero tokens). Branchless → the commit needs
    // curation, so dispatch the agent `finish` command (honestly tokenized).
    if (task.branch) {
      actions.push({ key: 'finish', label: 'Finish', kind: 'engine', tone: 'primary', run: () => ctx.finishViaMerge() });
    } else {
      actions.push({ key: 'finish', label: 'Finish', kind: 'agent', tone: 'primary', run: () => ctx.dispatchFinish() });
    }
    actions.push({ key: 'back-to-in-progress', label: 'Back to In Progress', kind: 'engine', run: () => ctx.changeStatus(IN_PROGRESS_STATUS) });
    actions.push({ key: 'review', label: 'Review', kind: 'agent', run: () => ctx.dispatchAgent('review') });
    if (pr) actions.push({ key: 'open-pr', label: 'Open PR', kind: 'link', href: pr });
    return actions;
  }

  if (/^done$/i.test(status)) {
    actions.push({ key: 'reopen', label: 'Reopen', kind: 'engine', run: () => ctx.changeStatus(IN_PROGRESS_STATUS) });
    if (pr) actions.push({ key: 'open-pr', label: 'Open PR', kind: 'link', href: pr });
    return actions;
  }

  return actions;
}
