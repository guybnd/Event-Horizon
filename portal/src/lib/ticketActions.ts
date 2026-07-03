// Phase-aware chat action bar — the single source of truth for "what can I do to a
// ticket from here" (FLUX-610). Splits ENGINE actions (direct REST, zero tokens,
// deterministic) from AGENT dispatch (deliberate, tokenized sessions) and LINK actions
// (open the PR). Both the chat bar and the board share `buildStatusChangeHistory` /
// `changeTaskStatus` so status moves are constructed in exactly one place.

import type { Config, HistoryDigest, HistoryEntry, Task } from '../types';
import { updateTask } from '../api';
import { getReadyForMergeStatus, getRequireInputStatus } from '../workflow';
import type { LaunchPhase } from '../agentActions';

// Standard board statuses these actions transition to. They mirror the engine defaults
// (see phaseLaunchStatus / config defaults); Ready / Require Input resolve from config.
const TODO_STATUS = 'Todo';
const IN_PROGRESS_STATUS = 'In Progress';

/**
 * Build the history DELTA for a status change: an optional comment entry (required by the
 * engine for Ready / Require Input) followed by the `status_change` entry. FLUX-725: this is
 * the *new* entries only — NOT spread onto `task.history` — sent to the engine via `appendHistory`
 * so the write path no longer depends on the client holding the full history (the list payload is
 * now history-digested). The engine appends these to the on-disk history and, seeing the
 * `status_change` in the delta, suppresses its own auto-add (no double-move). Shared by the board
 * (drag) and the chat action bar so the shape lives in one place.
 */
export function buildStatusChangeHistory(
  task: Task,
  newStatus: string,
  currentUser: string,
  comment?: string,
): HistoryEntry[] {
  const timestamp = new Date().toISOString();
  const delta: HistoryEntry[] = [];

  // A separate comment entry satisfies engine validation for Ready / Require Input.
  if (comment?.trim()) {
    delta.push({ type: 'comment', user: currentUser, date: timestamp, comment: comment.trim() });
  }

  delta.push({
    type: 'status_change',
    from: task.status,
    to: newStatus,
    user: currentUser,
    date: timestamp,
    comment: comment?.trim() ? 'Included with comment' : undefined,
  });

  return delta;
}

/**
 * Optimistically fold a status move into a list task's `historyDigest` (FLUX-725) so a dragged
 * card's history-derived signals (time-in-column, flow arrows) stay correct during the brief
 * window before the server confirms — the list payload carries only the digest, not full history,
 * so we can't rebuild it the old way. The next poll/SSE replaces this with the authoritative digest.
 */
export function applyOptimisticStatusChange(
  base: HistoryDigest | undefined,
  from: string,
  to: string,
  comment: string | undefined,
  _user: string,
): HistoryDigest {
  const now = new Date().toISOString();
  const prior: HistoryDigest = base ?? {
    length: 0, lastEntry: null, lastActivityAt: '', enteredCurrentStatusAt: null,
    isSpeedDemon: false, statusChanges24h: [], comments: [], requireInput: null,
  };
  return {
    ...prior,
    length: prior.length + (comment?.trim() ? 2 : 1),
    lastEntry: { date: now, type: 'status_change' },
    lastActivityAt: now,
    enteredCurrentStatusAt: now, // the card now displays `to`, entered just now (< 1min ⇒ chip hidden)
    statusChanges24h: [...prior.statusChanges24h, { from, to, date: now }],
  };
}

/**
 * Persist a status change (build the delta + PUT via `appendHistory`). The board keeps its own
 * optimistic wrapper around `buildStatusChangeHistory`; lightweight callers (the action bar) use
 * this directly.
 */
export async function changeTaskStatus(
  task: Task,
  newStatus: string,
  currentUser: string,
  opts?: { comment?: string; order?: number },
): Promise<void> {
  const appendHistory = buildStatusChangeHistory(task, newStatus, currentUser, opts?.comment);
  await updateTask(task.id, {
    status: newStatus,
    order: opts?.order ?? task.order ?? 0,
    appendHistory,
    updatedBy: currentUser,
  } as Partial<Task>);
}

// ── The unified ticket-action registry (FLUX-715) ───────────────────────────
// One declarative status→actions map shared by every inline surface (board card,
// chat mini-card, chat composer bar). Two orthogonal axes keep the model from
// exploding as new actions land:
//   • category (domain): WHAT the action touches.
//   • kind (execution + render): HOW it runs and HOW the renderer draws it.
// Adding an action ⇒ one entry here; adding a new `kind` ⇒ one extra arm in the
// <TicketActions> renderer's kind-switch. Nothing is re-plumbed per surface.

/** Domain an action operates on. Drives per-surface filtering, not rendering. */
export type TicketActionCategory = 'transition' | 'workflow' | 'pr' | 'branch' | 'lifecycle';

/**
 * Execution + render shape:
 *  • engine — direct REST (zero tokens, instant)
 *  • agent  — tokenized session dispatch
 *  • link   — open a url
 *  • launch — split control: one-click default + a ▾ menu of launch templates
 *  • picker — opens a small inline sub-UI (e.g. a reason textarea) before acting
 */
export type TicketActionKind = 'engine' | 'agent' | 'link' | 'launch' | 'picker';
export type TicketActionTone = 'default' | 'primary' | 'danger';

/** Which inline surfaces render an action. Defaults to both when omitted. */
export type TicketActionSurface = 'card' | 'compact';

/** Lucide glyph hint resolved by the renderer (keeps the registry import-free of icons). */
export type TicketActionIcon = 'bot' | 'layers' | 'file' | 'play' | 'send' | 'undo' | 'sparkles' | 'external';

/** A launch-template choice in a `kind:'launch'` action's ▾ menu. */
export interface LaunchTemplateOption {
  id: string;
  /** Display name once the workflow catalog has loaded (undefined before). */
  name?: string;
  variant: 'single' | 'multi' | 'other';
}

/** A `kind:'picker'` action's inline sub-UI contract (the Return-reason textarea today). */
export interface TicketActionPicker {
  title: string;
  placeholder: string;
  submitLabel: string;
  busyLabel: string;
  onSubmit: (value: string) => void | Promise<void>;
}

export interface TicketAction {
  key: string;
  label: string;
  /** Domain axis — surface filtering / future grouping. */
  category: TicketActionCategory;
  /** Execution + render axis — the renderer switches on this. */
  kind: TicketActionKind;
  tone?: TicketActionTone;
  icon?: TicketActionIcon;
  /** Surfaces that render this action (default: both). */
  surfaces?: TicketActionSurface[];
  /** `'confirm'` flags a destructive action (the runner self-guards today). */
  guard?: 'confirm';
  /** `link` actions. */
  href?: string;
  /** `engine` / `agent` / `launch` (one-click default) actions. */
  run?: () => void | Promise<void>;
  /** `launch`: template options for the ▾ menu (the one-click default is `run`). */
  templates?: LaunchTemplateOption[];
  /** `launch`: open the full launcher pinned to a chosen template. */
  onTemplate?: (templateId: string) => void;
  /** `picker`: the inline sub-UI. */
  picker?: TicketActionPicker;
}

/**
 * Imperative hooks the host (useTicketActions) provides; `actionsForStatus` closes over
 * these so it can stay a declarative status→actions map.
 */
export interface TicketActionContext {
  config?: Config | null;
  /** The launch phase the ticket's current status maps to. */
  phase: LaunchPhase;
  /** Resolved launch templates for the ticket's phase (single/multi/other). */
  launchTemplates: LaunchTemplateOption[];
  /** Resolved finalize templates for the Finish menu. */
  finalizeTemplates: LaunchTemplateOption[];
  /** Engine status move. `needsComment` prompts for the Ready/Require Input comment. */
  changeStatus: (newStatus: string, opts?: { needsComment?: boolean }) => void | Promise<void>;
  /** Engine finish for branch/PR tickets — merge the open PR and advance to Done. */
  finishViaMerge: () => void | Promise<void>;
  /** Engine finish for branchless tickets (FLUX-618) — curated commit + Done, zero tokens. */
  finishViaEngine: () => void | Promise<void>;
  /** Agent `finish` — fallback when there's nothing to curate (clean tree / no open PR), tokenized. */
  dispatchFinish: () => void | Promise<void>;
  /** One-click launch of the phase default (StartPrompt for Todo-no-branch; launcher fallback). */
  launchDefault: (phase: LaunchPhase) => void | Promise<void>;
  /** Open the orchestration launcher pinned to a phase + template. */
  openLauncher: (phase: LaunchPhase, templateId?: string) => void;
  /** Return a Ready ticket to In Progress with a reason. */
  returnToDev: (reason: string) => void | Promise<void>;
}

/** PR/commit url if it's an actual link (commit-hash implementationLinks aren't openable). */
function prLink(task: Task): string | undefined {
  const link = task.implementationLink;
  return link && /^https?:\/\//.test(link) ? link : undefined;
}

// ── Declarative action builders (one place per shape) ───────────────────────

function transition(
  key: string,
  label: string,
  toStatus: string,
  ctx: TicketActionContext,
  opts?: { tone?: TicketActionTone; needsComment?: boolean; surfaces?: TicketActionSurface[]; icon?: TicketActionIcon },
): TicketAction {
  return {
    key,
    label,
    category: 'transition',
    kind: 'engine',
    tone: opts?.tone,
    icon: opts?.icon,
    surfaces: opts?.surfaces,
    run: () => ctx.changeStatus(toStatus, { needsComment: opts?.needsComment }),
  };
}

function launchAction(
  key: string,
  label: string,
  phase: LaunchPhase,
  templates: LaunchTemplateOption[],
  ctx: TicketActionContext,
  opts?: { tone?: TicketActionTone; surfaces?: TicketActionSurface[]; icon?: TicketActionIcon },
): TicketAction {
  return {
    key,
    label,
    category: 'workflow',
    kind: 'launch',
    tone: opts?.tone ?? 'primary',
    icon: opts?.icon ?? 'bot',
    surfaces: opts?.surfaces,
    run: () => ctx.launchDefault(phase),
    templates,
    onTemplate: (id) => ctx.openLauncher(phase, id),
  };
}

function openPrAction(href: string): TicketAction {
  // The card never surfaced Open PR; it's a chat-bar affordance.
  return { key: 'open-pr', label: 'Open PR', category: 'pr', kind: 'link', icon: 'external', href, surfaces: ['compact'] };
}

/**
 * The phase-aware action set for a ticket's current status. Single source of truth for ALL
 * inline surfaces — the renderer filters by `surfaces`/`category` per variant, but the set is
 * computed only here. Ordering puts the primary launch first, then transitions, then links.
 */
export function actionsForStatus(task: Task, ctx: TicketActionContext): TicketAction[] {
  const status = (task.status || '').trim();
  const readyStatus = getReadyForMergeStatus(ctx.config);
  const requireInputStatus = getRequireInputStatus(ctx.config);
  const actions: TicketAction[] = [];
  const pr = prLink(task);
  const tpl = ctx.launchTemplates;

  // Grooming / Require Input → plan it forward or hand to the grooming agent.
  if (/^groom/i.test(status) || status === requireInputStatus) {
    actions.push(launchAction('groom', 'Start grooming', 'grooming', tpl, ctx));
    actions.push(transition('to-todo', 'Move to Todo', TODO_STATUS, ctx, { surfaces: ['compact'] }));
    return actions;
  }

  if (status === TODO_STATUS) {
    actions.push(launchAction('implement', 'Implement', 'implementation', tpl, ctx));
    actions.push(transition('to-in-progress', 'Move to In Progress', IN_PROGRESS_STATUS, ctx, { surfaces: ['compact'] }));
    return actions;
  }

  if (status === IN_PROGRESS_STATUS) {
    actions.push(launchAction('continue', 'Continue', 'implementation', tpl, ctx));
    actions.push(transition('to-ready', 'Move to Ready', readyStatus, ctx, { tone: 'primary', needsComment: true, surfaces: ['compact'] }));
    actions.push(transition('require-input', 'Require Input', requireInputStatus, ctx, { needsComment: true, surfaces: ['compact'] }));
    if (pr) actions.push(openPrAction(pr));
    return actions;
  }

  if (status === readyStatus) {
    actions.push(launchAction('review', 'Review', 'review', tpl, ctx, { tone: 'default' }));
    // Return: card captures a reason (picker); the chat bar keeps its instant transition.
    actions.push({
      key: 'return',
      label: 'Return',
      category: 'lifecycle',
      kind: 'picker',
      icon: 'undo',
      surfaces: ['card'],
      picker: {
        title: 'Return reason',
        placeholder: 'What needs fixing?',
        submitLabel: 'Return to dev',
        busyLabel: 'Returning…',
        onSubmit: ctx.returnToDev,
      },
    });
    actions.push(transition('back-to-in-progress', 'Back to In Progress', IN_PROGRESS_STATUS, ctx, { surfaces: ['compact'] }));
    // Finish: both branches are now zero-token engine actions (FLUX-618) — branch/PR ticket → merge
    // the open PR; branchless → curated commit + Done via the engine finish route. The ▾ menu carries
    // finalize templates either way.
    actions.push({
      key: 'finish',
      label: 'Finish',
      category: 'pr',
      kind: 'launch',
      tone: 'primary',
      icon: 'send',
      guard: task.branch ? 'confirm' : undefined,
      run: () => (task.branch ? ctx.finishViaMerge() : ctx.finishViaEngine()),
      templates: ctx.finalizeTemplates,
      onTemplate: (id) => ctx.openLauncher('finalize', id),
    });
    if (pr) actions.push(openPrAction(pr));
    return actions;
  }

  if (/^done$/i.test(status)) {
    // The card kept a launch affordance on Done (re-review); the chat bar offers Reopen.
    actions.push(launchAction('launch', 'Launch', 'review', tpl, ctx, { tone: 'default', surfaces: ['card'] }));
    actions.push(transition('reopen', 'Reopen', IN_PROGRESS_STATUS, ctx, { surfaces: ['compact'] }));
    if (pr) actions.push(openPrAction(pr));
    return actions;
  }

  // Custom statuses: the card keeps a generic Launch; the chat bar shows nothing.
  actions.push(launchAction('launch', 'Launch', ctx.phase, tpl, ctx, { tone: 'default', surfaces: ['card'] }));
  return actions;
}
