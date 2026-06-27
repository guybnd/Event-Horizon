// FLUX-715: the single host hook behind the unified ticket-action registry. It owns every
// imperative concern the declarative `actionsForStatus` map closes over — status moves, agent
// dispatch / phase launches, PR merge, the Return-to-dev path — plus the launch-template catalog,
// the orchestration-launcher modal state, and the Todo "start prompt". Every inline surface
// (board card, chat mini-card, chat composer bar) drives its buttons from one of these, so the
// status→action logic lives in exactly one place (this hook + lib/ticketActions).
//
// This is the launch slice that used to live inline in useTaskCardController, lifted out so the
// card and the chat surfaces share it verbatim instead of re-implementing it.
import { useMemo, useRef, useState } from 'react';
import type { Task } from '../types';
import { useAppSelector, useAppActions } from '../store/useAppSelector';
import {
  mergePr, updateTask, fetchWorkflows, fetchPrStatus, sendTaskCliInput, raisePr, deleteTask,
  detachWorktree, joinWorktree, openWorktreeWindow, setTicketBranch, attachParent,
  MergeForceRequiredError, MergeParkedError,
  type WorkflowTemplate,
} from '../api';
import type { FinishMergeState, MergeConfirmOpts } from '../components/task-modal/FinishMergeConfirm';
import { resolveEffectiveAgent } from '../utils';
import { isActiveSession } from '../orchestration';
import { getArchiveStatus, getReadyForMergeStatus, getRequireInputStatus, isPromptableStatus } from '../workflow';
import {
  runAgentAction,
  launchOrchestration,
  launchPhaseDefault,
  getOrchestrationMode,
  phaseCombiner,
  phaseLaunchStatus,
  resolvePhaseDefaultId,
  statusToPhase,
  type LaunchPhase,
} from '../agentActions';
import { type OrchestrationLaunchPlan } from '../components/OrchestrationLauncher';
import {
  actionsForStatus,
  changeTaskStatus,
  type LaunchTemplateOption,
  type TicketAction,
  type TicketActionContext,
} from '../lib/ticketActions';

/**
 * Imperative ops the right-click ContextMenu binds to (FLUX-717). These are the menu's old
 * hand-rolled `handle*` functions, lifted here so the registry owns every transition / pr /
 * branch / lifecycle handler. Each throws on failure (the menu surfaces it inline) and refreshes
 * board + worktree state internally; presentation (confirm toggles, busy spinners) stays surface-local.
 */
export interface TicketActionOps {
  /** lifecycle — open the ticket's modal. */
  openTicket: () => void;
  /** transition — "Move to" flyout: promptable statuses open the modal for their comment; others move directly. */
  moveToStatus: (status: string) => Promise<void>;
  /** pr — a PR ticket's human-driven In Progress↔Ready move (no prompt; syncPrTickets preserves it). */
  setStatusRaw: (status: string) => Promise<void>;
  /** pr — raise a PR for the ticket's branch. */
  raisePr: () => Promise<void>;
  /** pr — merge the open PR now (the menu owns its own confirm). */
  mergePrNow: () => Promise<void>;
  /** branch — open the worktree in VS Code (copies the path if no window opened). */
  openInVSCode: () => Promise<void>;
  /** branch — close/detach the worktree, returning work to main. */
  detachWorktree: () => Promise<void>;
  /** branch — join an existing worktree by branch. */
  joinWorktree: (branch: string) => Promise<void>;
  /** branch — attach the ticket to a branch. */
  attachBranch: (branch: string) => Promise<void>;
  /** lifecycle — attach the ticket under a parent. */
  attachParent: (parentId: string) => Promise<void>;
  /** lifecycle — archive the ticket. */
  archive: () => Promise<void>;
  /** lifecycle — delete the ticket. */
  deleteTicket: () => Promise<void>;
  /** lifecycle — mark all of the ticket's comments read. */
  markCommentsRead: () => void;
  /** lifecycle — clear the ticket's swimlane. */
  clearSwimlane: () => Promise<void>;
}

export interface UseTicketActions {
  task: Task;
  /** The phase the ticket's status maps to (re-exposed for ContextMenu wiring). */
  cardPhase: LaunchPhase;
  /** The full computed action set (caller filters by surface). */
  actions: TicketAction[];
  /** The single/multi/other launch templates for the ticket's phase (drives the ContextMenu flyout). */
  launchTemplates: LaunchTemplateOption[];
  /** Imperative transition/pr/branch/lifecycle ops the right-click menu binds to (FLUX-717). */
  ops: TicketActionOps;
  /** Fire the phase default one-click; resolves true if it launched, false if a launcher is needed. */
  tryLaunchPhaseDefault: (phase: LaunchPhase) => Promise<boolean>;
  /** Single in-flight action key (drives the per-button spinner + double-fire guard). */
  busyKey: string | null;
  /** Run a registry action's handler, spinning just that button. */
  fire: (key: string, fn?: (() => void | Promise<void>)) => Promise<void>;
  /** Lazily fetch the workflow catalog (called when a launch ▾ menu first opens). */
  loadTemplates: () => void;
  // ── Orchestration launcher modal ──
  launcherOpen: boolean;
  launcherPhase: LaunchPhase;
  launcherTemplateId: string | undefined;
  launcherBusy: boolean;
  openLauncher: (phase: LaunchPhase, templateId?: string) => void;
  closeLauncher: () => void;
  onLaunch: (plan: OrchestrationLaunchPlan) => Promise<void>;
  // ── Todo "start" prompt (branch choice before first launch) ──
  startPromptOpen: boolean;
  confirmStartPrompt: (branch: string | null) => Promise<void>;
  cancelStartPrompt: () => void;
  // ── Finish-via-merge confirm/decision modal (FLUX-815) — replaces native confirm/alert ──
  finishMergeState: FinishMergeState | null;
  finishMergeBusy: boolean;
  confirmFinishMerge: (opts: MergeConfirmOpts) => Promise<void>;
  cancelFinishMerge: () => void;
  // ── For ContextMenu re-exposure (FLUX-717 will migrate it onto the registry) ──
  singleDefaultId: string;
}

export function useTicketActions(task: Task): UseTicketActions {
  const { triggerRefresh, refreshWorktrees, openTask, markAllCommentsRead } = useAppActions();
  const currentUser = useAppSelector((s) => s.currentUser);
  const config = useAppSelector((s) => s.config);

  const requireInputStatus = getRequireInputStatus(config);
  const readyStatus = getReadyForMergeStatus(config);
  const archiveStatus = getArchiveStatus(config);
  const framework = resolveEffectiveAgent(undefined, config?.defaultAgent);
  const cardPhase = statusToPhase(task.status, { readyStatus });

  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [phaseTemplates, setPhaseTemplates] = useState<WorkflowTemplate[] | null>(null);
  const [launcherOpen, setLauncherOpen] = useState(false);
  const [launcherPhase, setLauncherPhase] = useState<LaunchPhase>(cardPhase);
  const [launcherTemplateId, setLauncherTemplateId] = useState<string | undefined>(undefined);
  const [launcherBusy, setLauncherBusy] = useState(false);
  const [startPromptOpen, setStartPromptOpen] = useState(false);
  const [finishMergeState, setFinishMergeState] = useState<FinishMergeState | null>(null);
  const [finishMergeBusy, setFinishMergeBusy] = useState(false);
  // Merge options accumulate across escalations (confirm → shared force → parked stop&merge), so a
  // chain that picks up `force` then needs `stopParkedSessions` keeps both (the engine checks them
  // in sequence — see tasks.ts:1022-1024). Reset whenever the modal opens fresh or is cancelled.
  const finishMergeOptsRef = useRef<MergeConfirmOpts>({});

  // Lazily load the workflow catalog the first time a launch ▾ menu opens. Until then the menu
  // still shows Single/Multi (their ids resolve synchronously); names + extra templates fill in.
  const loadTemplates = () => {
    if (phaseTemplates === null) fetchWorkflows().then(setPhaseTemplates).catch(() => setPhaseTemplates([]));
  };

  // Build the single/multi/other template list for a phase (mirrors the old card menu logic).
  const buildTemplates = (phase: LaunchPhase): LaunchTemplateOption[] => {
    const list = (phaseTemplates ?? []).filter((w) => w.phases?.[phase as keyof typeof w.phases]);
    const singleId = resolvePhaseDefaultId(config?.phaseDefaults, phase, 'single');
    const multiId = resolvePhaseDefaultId(config?.phaseDefaults, phase, 'multi');
    const others = list.filter((w) => w.id !== singleId && w.id !== multiId);
    return [
      { id: singleId, name: list.find((w) => w.id === singleId)?.name, variant: 'single' },
      { id: multiId, name: list.find((w) => w.id === multiId)?.name, variant: 'multi' },
      ...others.map((w) => ({ id: w.id, name: w.name, variant: 'other' as const })),
    ];
  };

  const launchTemplates = useMemo(
    () => buildTemplates(cardPhase),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [phaseTemplates, cardPhase, config?.phaseDefaults],
  );
  const finalizeTemplates = useMemo(
    () => buildTemplates('finalize'),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [phaseTemplates, config?.phaseDefaults],
  );
  const singleDefaultId = resolvePhaseDefaultId(config?.phaseDefaults, cardPhase, 'single');

  // ── Engine: status move (prompts for the comment Ready/Require Input require) ──
  const changeStatus = async (newStatus: string, opts?: { needsComment?: boolean }) => {
    let comment: string | undefined;
    if (opts?.needsComment) {
      const label = newStatus === requireInputStatus ? 'question for the user' : 'completion summary';
      const entered = window.prompt(`Add a ${label} for moving ${task.id} to "${newStatus}":`);
      if (entered === null) return; // cancelled
      comment = entered.trim() || undefined;
    }
    try {
      await changeTaskStatus(task, newStatus, currentUser, { comment });
    } catch (err) {
      // Reactive: the engine rejects Ready/Require Input without a comment. Prompt + retry once.
      const msg = err instanceof Error ? err.message : String(err);
      if (/MISSING_COMMENT|comment is required/i.test(msg) && !comment) {
        const entered = window.prompt(`A comment is required to move ${task.id} to "${newStatus}":`);
        if (entered === null || !entered.trim()) return;
        await changeTaskStatus(task, newStatus, currentUser, { comment: entered.trim() });
      } else {
        alert(`Failed to move ${task.id}: ${msg}`);
        return;
      }
    }
    triggerRefresh();
  };

  // FLUX-719: a live CLI session on the ticket. When present, the agent `finish` is routed as
  // input into the running conversation rather than spawning a fresh finalize session.
  const hasActiveCliSession = Boolean(task.cliSession && isActiveSession(task.cliSession));

  // ── Engine: finish a branch ticket by merging its open PR (zero tokens) ──
  // A branch ticket can sit at Ready before any PR was raised; `mergePr` assumes an open PR
  // exists. Probe first (FLUX-719) and fall back to the agent finalize (commit → raise → merge)
  // when there's no open PR, so the primary Finish button works either way.
  const finishViaMerge = async () => {
    const pr = await fetchPrStatus(task.id).catch(() => null);
    if (!pr || pr.state !== 'OPEN') {
      await dispatchFinish();
      return;
    }
    // FLUX-815: no native confirm/alert. Open the styled modal in plain-confirm mode; the
    // shared-PR guard (FLUX-569) and parked-session block (FLUX-636) become in-modal decisions.
    finishMergeOptsRef.current = {};
    setFinishMergeState({ mode: 'confirm' });
  }

  // Run the merge with the accumulated options + this action's delta. Each engine guard maps to a
  // modal mode rather than a native dialog: shared-PR → decision list, parked → stop&merge, else
  // an inline error. On success: refresh the board and close.
  const confirmFinishMerge = async (delta: MergeConfirmOpts) => {
    const opts = { ...finishMergeOptsRef.current, ...delta };
    finishMergeOptsRef.current = opts;
    setFinishMergeBusy(true);
    try {
      await mergePr(task.id, opts);
      setFinishMergeState(null);
      triggerRefresh();
    } catch (err) {
      if (err instanceof MergeForceRequiredError) {
        setFinishMergeState({ mode: 'shared', sharedNonDone: err.sharedNonDone });
      } else if (err instanceof MergeParkedError) {
        setFinishMergeState({ mode: 'parked', message: err.message });
      } else {
        setFinishMergeState({ mode: 'error', message: err instanceof Error ? err.message : String(err) });
      }
    } finally {
      setFinishMergeBusy(false);
    }
  };
  const cancelFinishMerge = () => {
    finishMergeOptsRef.current = {};
    setFinishMergeState(null);
  };;

  // ── Agent: branchless (or no-open-PR) finish needs a curated commit → run the `finish` command.
  // FLUX-719: when a CLI session is live, continue it by sending `finish` as input rather than
  // spawning a new session, mirroring the pre-FLUX-715 card behavior. ──
  const dispatchFinish = async () => {
    if (hasActiveCliSession) {
      await sendTaskCliInput(task.id, `finish ${task.id}`, currentUser);
    } else {
      await runAgentAction({ taskId: task.id, framework, action: { kind: 'command', verb: 'finish' }, currentUser, phase: 'finalize' });
    }
    triggerRefresh();
  };

  // Launch the phase's single default; false ⇒ no persona resolved (caller opens the launcher UI).
  const launchPhaseSession = async (phase: LaunchPhase): Promise<boolean> => {
    const result = await launchPhaseDefault({ taskId: task.id, framework, phase, currentUser, phaseDefaults: config?.phaseDefaults });
    return result !== null;
  };

  const openLauncher = (phase: LaunchPhase, templateId?: string) => {
    setLauncherPhase(phase);
    setLauncherTemplateId(templateId);
    setLauncherOpen(true);
  };

  // ── One-click launch of the phase default. Todo without a branch defers to the start prompt;
  // a phase with no configured persona falls back to the full launcher (template pre-selected). ──
  const launchDefault = async (phase: LaunchPhase) => {
    if (task.status === 'Todo' && !task.branch) {
      setStartPromptOpen(true);
      return;
    }
    const launched = await launchPhaseSession(phase);
    if (!launched) {
      openLauncher(phase, resolvePhaseDefaultId(config?.phaseDefaults, phase, 'single'));
      return;
    }
    triggerRefresh();
  };

  const confirmStartPrompt = async (_branch: string | null) => {
    setStartPromptOpen(false);
    setBusyKey('implement');
    try {
      await launchPhaseSession('implementation');
      triggerRefresh();
    } finally {
      setBusyKey(null);
    }
  };
  const cancelStartPrompt = () => setStartPromptOpen(false);

  // ── Engine/agent: return a Ready ticket to In Progress carrying the reviewer's reason. ──
  const returnToDev = async (reason: string) => {
    const comment = reason.trim();
    if (!comment) return;
    const history = [...(task.history || []), { type: 'comment' as const, user: currentUser, date: new Date().toISOString(), comment }];
    await updateTask(task.id, { status: 'In Progress', history, updatedBy: currentUser } as Partial<Task>);
    triggerRefresh();
  };

  // ── The launcher modal's onLaunch: single agent runs standalone, multi via orchestration.
  // Lifted verbatim from useTaskCardController.handleCardReviewLaunch. ──
  const onLaunch = async (plan: OrchestrationLaunchPlan) => {
    setLauncherOpen(false);
    setLauncherBusy(true);
    try {
      if (plan.personas.length === 1) {
        await runAgentAction({
          taskId: task.id,
          framework,
          action: { kind: 'persona', personaId: plan.personas[0].id, focusComment: plan.comment || undefined },
          currentUser,
          effortOverride: plan.effort,
          preStatus: phaseLaunchStatus(launcherPhase),
          phase: launcherPhase,
        });
        triggerRefresh();
        return;
      }
      const def = getOrchestrationMode(plan.mode);
      const participants = plan.personas.map((p) => ({
        role: `${launcherPhase}:${p.id}`,
        label: p.label,
        personaId: p.id,
        focusComment: plan.comment || undefined,
      }));
      const combiner = plan.leadPersona
        ? { personaId: plan.leadPersona.id, label: plan.leadPersona.label }
        : phaseCombiner(launcherPhase, plan.mode);
      const lead = def.hasLead && combiner
        ? { role: combiner.personaId, label: combiner.label, personaId: combiner.personaId }
        : undefined;
      await launchOrchestration({
        taskId: task.id,
        framework,
        mode: plan.mode,
        participants,
        lead,
        currentUser,
        effortOverride: plan.effort,
        preStatus: phaseLaunchStatus(launcherPhase),
        phase: launcherPhase,
      });
      triggerRefresh();
    } finally {
      setLauncherBusy(false);
    }
  };

  // ── ContextMenu ops (FLUX-717): the right-click menu's transition/pr/branch/lifecycle handlers,
  // lifted here so the menu hand-rolls none of them. Each throws on failure (the menu surfaces it
  // inline) and refreshes board + worktree state internally. ──
  const refreshAll = () => { refreshWorktrees(); triggerRefresh(); };
  const ops: TicketActionOps = {
    openTicket: () => openTask(task),
    moveToStatus: async (status) => {
      // Promptable statuses (Ready / Require Input) open the modal so the comment is captured there.
      if (isPromptableStatus(status, config)) { openTask(task); return; }
      await updateTask(task.id, { status, updatedBy: currentUser });
      triggerRefresh();
    },
    setStatusRaw: async (status) => {
      await updateTask(task.id, { status, updatedBy: currentUser } as Partial<Task>);
      refreshAll();
    },
    raisePr: async () => { await raisePr(task.id); refreshAll(); },
    mergePrNow: async () => { await mergePr(task.id); refreshAll(); },
    openInVSCode: async () => {
      const r = await openWorktreeWindow(task.id);
      if (!r.opened) await navigator.clipboard.writeText(r.worktree).catch(() => {});
      refreshAll();
    },
    detachWorktree: async () => { await detachWorktree(task.id); refreshAll(); },
    joinWorktree: async (branch) => { await joinWorktree(task.id, branch); refreshAll(); },
    attachBranch: async (branch) => { await setTicketBranch(task.id, branch, currentUser); refreshAll(); },
    attachParent: async (parentId) => { await attachParent(task.id, parentId, currentUser); refreshAll(); },
    archive: async () => { await updateTask(task.id, { status: archiveStatus, updatedBy: currentUser }); triggerRefresh(); },
    deleteTicket: async () => { await deleteTask(task.id); triggerRefresh(); },
    markCommentsRead: () => {
      const ids = (task.history ?? []).filter((e) => e.type === 'comment' && e.id).map((e) => e.id!);
      markAllCommentsRead(task.id, ids);
    },
    clearSwimlane: async () => { await updateTask(task.id, { swimlane: null, updatedBy: currentUser } as Partial<Task>); triggerRefresh(); },
  };

  // One-click launch of a phase default, exposed for the ContextMenu primary action. Returns false
  // when no default persona resolves so the caller can fall back to the full launcher.
  const tryLaunchPhaseDefault = async (phase: LaunchPhase): Promise<boolean> => {
    const launched = await launchPhaseSession(phase);
    if (launched) triggerRefresh();
    return launched;
  };

  const ctx: TicketActionContext = {
    config,
    phase: cardPhase,
    launchTemplates,
    finalizeTemplates,
    changeStatus,
    finishViaMerge,
    dispatchFinish,
    launchDefault,
    openLauncher,
    returnToDev,
  };
  const actions = actionsForStatus(task, ctx);

  // Run a registry action, spinning only its button and blocking double-fire. Launch/picker
  // actions wire their own keys (the template menu / reason textarea), but they share busyKey.
  const fire = async (key: string, fn?: () => void | Promise<void>) => {
    if (busyKey || !fn) return;
    setBusyKey(key);
    try {
      await fn();
    } finally {
      setBusyKey(null);
    }
  };

  return {
    task,
    cardPhase,
    actions,
    launchTemplates,
    ops,
    tryLaunchPhaseDefault,
    busyKey,
    fire,
    loadTemplates,
    launcherOpen,
    launcherPhase,
    launcherTemplateId,
    launcherBusy,
    openLauncher,
    closeLauncher: () => setLauncherOpen(false),
    onLaunch,
    startPromptOpen,
    confirmStartPrompt,
    cancelStartPrompt,
    finishMergeState,
    finishMergeBusy,
    confirmFinishMerge,
    cancelFinishMerge,
    singleDefaultId,
  };
}
