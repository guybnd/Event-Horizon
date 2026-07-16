// Phase-aware chat action bar — the single source of truth for "what can I do to a
// ticket from here" (FLUX-610). Splits ENGINE actions (direct REST, zero tokens,
// deterministic) from AGENT dispatch (deliberate, tokenized sessions) and LINK actions
// (open the PR). Both the chat bar and the board share `buildStatusChangeHistory` /
// `changeTaskStatus` so status moves are constructed in exactly one place.

import type { Config, HistoryDigest, HistoryEntry, Task } from '../types';
import { updateTask, type DiffOverview } from '../api';
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
 * FLUX-1303: the plan-approval target status — the VISIBLE column right after Grooming, falling
 * back to 'Todo'. One derivation shared by every "Approve plan" writer (`approvePlanToTodo` in
 * pendingInteractions.tsx, `PlanApprovalPanel.handleApprove`) so all surfaces route an approved
 * plan to the same column. Matches the engine gate's own approve move (`nextColumnAfter`,
 * engine/src/config.ts) exactly: visible columns only (never a hidden status), case-insensitive.
 */
export function statusAfterGrooming(visibleColumns: string[]): string {
  const i = visibleColumns.findIndex((c) => c.toLowerCase() === 'grooming');
  return (i >= 0 && i + 1 < visibleColumns.length ? visibleColumns[i + 1] : undefined) || 'Todo';
}

/**
 * Detect the engine's "comment required for this status transition" rejection (FLUX-847),
 * regardless of whether the caller has the structured `err.code` (api.ts attaches it from
 * `errorPayload.error`) or only the prose `message` (older call sites / generic Error).
 * Shared so Board's reactive re-prompt and the action bar's `changeStatus` agree on what
 * counts as "ask for a comment and retry" versus a genuine failure to `alert()`.
 */
export function isMissingCommentError(err: unknown): boolean {
  const code = (err as { code?: string } | null)?.code;
  if (typeof code === 'string' && /_MISSING_COMMENT$/.test(code)) return true;
  const msg = err instanceof Error ? err.message : String(err ?? '');
  return /MISSING_COMMENT|comment is required|requires a[^.]*comment/i.test(msg);
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
    isSpeedDemon: false, statusChanges24h: [], comments: [], requireInput: null, planReviewComment: null,
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
  });
}

// ── FLUX-1359: prompt/error seam ────────────────────────────────────────────
// `changeStatus` and `finishViaEngine` used to fire `window.prompt`/`alert` directly, which
// Electron's renderer doesn't implement (`prompt()` throws — no polyfill in `electron/`),
// silently no-oping Finish and every comment-gated status move there. These injected types let
// the host (useTicketActions) supply a styled modal instead, and let the logic below be
// unit-tested without a DOM `prompt`.

/** Requests a single value from the user. Resolves the entered string, or `null` on cancel. */
export type PromptResolver = (req: {
  title: string;
  message?: string;
  defaultValue?: string;
  submitLabel?: string;
  multiline?: boolean;
}) => Promise<string | null>;

/** Surfaces a non-actionable failure to the user (replaces `alert`). */
export type ErrorNotifier = (title: string, message: string) => void;

/**
 * Engine status move (moved out of `useTicketActions.changeStatus`, FLUX-1359): optionally prompt
 * for the Ready/Require-Input comment, persist the move, and reactively re-prompt once if the
 * engine rejects it for a missing comment. A genuine (non-missing-comment) failure notifies
 * instead of throwing — matching the old `alert` behavior — while a failed *retry* is left to
 * propagate so `fire()`'s catch (FLUX-1359) is the single backstop.
 */
export async function runChangeStatus(deps: {
  task: Task;
  newStatus: string;
  currentUser: string;
  needsComment?: boolean;
  requireInputStatus: string;
  prompt: PromptResolver;
  notifyError: ErrorNotifier;
  onDone: () => void;
}): Promise<void> {
  const { task, newStatus, currentUser, needsComment, requireInputStatus, prompt, notifyError, onDone } = deps;
  let comment: string | undefined;
  if (needsComment) {
    const label = newStatus === requireInputStatus ? 'question for the user' : 'completion summary';
    const entered = await prompt({
      title: `Move ${task.id} to "${newStatus}"`,
      message: `Add a ${label}:`,
      submitLabel: 'Continue',
      multiline: true,
    });
    if (entered === null) return; // cancelled
    comment = entered.trim() || undefined;
  }
  try {
    await changeTaskStatus(task, newStatus, currentUser, { comment });
  } catch (err) {
    // Reactive: the engine rejects Ready/Require Input without a comment. Prompt + retry once.
    if (isMissingCommentError(err) && !comment) {
      const entered = await prompt({
        title: `Move ${task.id} to "${newStatus}"`,
        message: 'A comment is required to move it here:',
        submitLabel: 'Continue',
        multiline: true,
      });
      if (entered === null || !entered.trim()) return;
      await changeTaskStatus(task, newStatus, currentUser, { comment: entered.trim() });
    } else {
      notifyError(`Failed to move ${task.id}`, err instanceof Error ? err.message : String(err));
      return;
    }
  }
  onDone();
}

/**
 * Branchless finish (moved out of `useTicketActions.finishViaEngine`, FLUX-618/FLUX-1359): gather
 * the main tree's uncommitted files, prompt for a curated commit message showing exactly what will
 * be committed, then commit + finish server-side. A clean tree (or an unavailable diff overview)
 * falls back to the agent finish rather than guessing.
 */
export async function runFinishBranchless(deps: {
  task: Task;
  prompt: PromptResolver;
  notifyError: ErrorNotifier;
  onDone: () => void;
  dispatchFinish: () => void | Promise<void>;
  fetchDiffOverview: (uncommittedOnly?: boolean) => Promise<DiffOverview>;
  finishBranchless: (taskId: string, body: { files: string[]; message: string }) => Promise<unknown>;
}): Promise<void> {
  const { task, prompt, notifyError, onDone, dispatchFinish, fetchDiffOverview, finishBranchless } = deps;
  let files: string[];
  try {
    const overview = await fetchDiffOverview(true);
    const mainGroup = overview.groups.find((g) => g.kind === 'main');
    files = (mainGroup?.files ?? []).map((f) => f.file);
  } catch {
    // Diff overview unavailable — fall back to the agent finish rather than guess.
    await dispatchFinish();
    return;
  }
  if (files.length === 0) {
    // Nothing uncommitted to curate — let the agent finish handle it (already-committed work, etc.).
    await dispatchFinish();
    return;
  }
  const fileList = files.map((f) => `  • ${f}`).join('\n');
  const entered = await prompt({
    title: `Finish ${task.id}`,
    message: `These ${files.length} file(s) will be committed:\n\n${fileList}\n\nCommit message (describe the shipped behavior):`,
    defaultValue: `${task.id}: ${task.title}`,
    submitLabel: 'Finish',
  });
  if (entered === null) return; // cancelled
  const message = entered.trim();
  if (!message) { notifyError('Cannot finish', 'A commit message is required to finish.'); return; }
  try {
    await finishBranchless(task.id, { files, message });
    onDone();
  } catch (err) {
    notifyError(`Failed to finish ${task.id}`, err instanceof Error ? err.message : String(err));
  }
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
  /** Agent fast-path (FLUX-1380) — one session grooms + implements a Grooming-column XS/S ticket. */
  dispatchFastPath: () => void | Promise<void>;
  /** One-click launch of the phase default (StartPrompt for Todo-no-branch; launcher fallback). */
  launchDefault: (phase: LaunchPhase) => void | Promise<void>;
  /** Open the orchestration launcher pinned to a phase + template. */
  openLauncher: (phase: LaunchPhase, templateId?: string) => void;
  /** Return a Ready ticket to In Progress with a reason. */
  returnToDev: (reason: string) => void | Promise<void>;
}

/** PR/commit url if it's an actual link (commit-hash implementationLinks aren't openable). */
export function prLink(task: Task): string | undefined {
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
    // FLUX-1380: fast-path is a Grooming-column-only opt-in (not offered from Require Input) —
    // eligibility (effort L/XL, subtasks) is enforced server-side; the button just offers the choice.
    if (/^groom/i.test(status)) {
      actions.push({
        key: 'fast-path',
        label: 'Fast-path',
        category: 'workflow',
        kind: 'agent',
        icon: 'sparkles',
        run: ctx.dispatchFastPath,
      });
    }
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
