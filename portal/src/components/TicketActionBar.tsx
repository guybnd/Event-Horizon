// Phase-aware chat action bar (FLUX-610). Renders the actions `actionsForStatus` declares
// for the ticket's current status, splitting ENGINE moves (free, instant, deterministic
// REST) from AGENT dispatch (deliberate, tokenized — flagged with a spark) and LINK
// (open PR). Dropped into the dumb `ChatView` via its `actions` slot, so ChatView stays
// transport-free.

import { useState } from 'react';
import { Sparkles, ExternalLink, Loader2 } from 'lucide-react';
import type { Task } from '../types';
import { useAppSelector, useAppActions } from '../store/useAppSelector';
import { mergePr } from '../api';
import { resolveEffectiveAgent } from '../utils';
import { getRequireInputStatus } from '../workflow';
import { launchPhaseDefault, runAgentAction, phaseLaunchStatus, type LaunchPhase } from '../agentActions';
import {
  actionsForStatus,
  changeTaskStatus,
  type TicketAction,
  type TicketActionContext,
} from '../lib/ticketActions';

export function TicketActionBar({ task }: { task: Task }) {
  const { triggerRefresh } = useAppActions();
  const currentUser = useAppSelector((s) => s.currentUser);
  const config = useAppSelector((s) => s.config);
  // Track the in-flight action by key so we can spin just that button and block double-fire.
  const [running, setRunning] = useState<string | null>(null);

  const requireInputStatus = getRequireInputStatus(config);
  const framework = resolveEffectiveAgent(undefined, config?.defaultAgent);

  // --- engine: status move (prompts for the comment Ready/Require Input require) ----------
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

  // --- engine: finish a branch/PR ticket by merging the open PR (zero tokens) --------------
  const finishViaMerge = async () => {
    if (!window.confirm(`Merge ${task.id}'s PR and mark it Done? This can't be undone.`)) return;
    try {
      await mergePr(task.id);
    } catch (err) {
      alert(`Failed to finish ${task.id}: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    triggerRefresh();
  };

  // --- agent: dispatch a session in the right phase (tokenized) ----------------------------
  const dispatchAgent = async (phase: LaunchPhase) => {
    const launched = await launchPhaseDefault({
      taskId: task.id,
      framework,
      phase,
      currentUser,
      phaseDefaults: config?.phaseDefaults,
    });
    // No configured phase default → fall back to a plain command/prompt dispatch.
    if (!launched) {
      const action =
        phase === 'grooming'
          ? ({ kind: 'command', verb: 'groom' } as const)
          : phase === 'review'
            ? ({ kind: 'prompt', appendPrompt: `review ${task.id}` } as const)
            : ({ kind: 'command', verb: 'implement' } as const);
      await runAgentAction({ taskId: task.id, framework, action, currentUser, preStatus: phaseLaunchStatus(phase), phase });
    }
    triggerRefresh();
  };

  // --- agent: branchless finish needs a curated commit → run the `finish` command ----------
  const dispatchFinish = async () => {
    await runAgentAction({ taskId: task.id, framework, action: { kind: 'command', verb: 'finish' }, currentUser });
    triggerRefresh();
  };

  const ctx: TicketActionContext = { config, changeStatus, finishViaMerge, dispatchAgent, dispatchFinish };
  const actions = actionsForStatus(task, ctx);
  if (actions.length === 0) return null;

  const hasEngine = actions.some((a) => a.kind === 'engine');
  const hasNonEngine = actions.some((a) => a.kind !== 'engine');

  const fire = async (action: TicketAction) => {
    if (running || !action.run) return;
    setRunning(action.key);
    try {
      await action.run();
    } finally {
      setRunning(null);
    }
  };

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {actions.map((action, i) => {
        // Subtle divider between the engine (free) cluster and the tokenized/link cluster.
        const prevEngine = i > 0 && actions[i - 1].kind === 'engine';
        const showDivider = hasEngine && hasNonEngine && action.kind !== 'engine' && prevEngine;
        return (
          <div key={action.key} className="contents">
            {showDivider && <span className="mx-0.5 h-4 w-px self-center bg-[var(--eh-border)]" aria-hidden="true" />}
            <ActionButton action={action} busy={running === action.key} disabled={!!running} onRun={() => fire(action)} />
          </div>
        );
      })}
    </div>
  );
}

function ActionButton({
  action,
  busy,
  disabled,
  onRun,
}: {
  action: TicketAction;
  busy: boolean;
  disabled: boolean;
  onRun: () => void;
}) {
  const tone = action.tone ?? 'default';
  // Engine = solid-ish & free; agent = bordered with a spark (tokenized); link = ghost.
  const base =
    'inline-flex items-center gap-1 rounded-md px-2.5 py-1 text-[11px] font-semibold transition-colors disabled:opacity-50 disabled:cursor-not-allowed';
  const toneClass =
    tone === 'primary'
      ? 'bg-primary text-white hover:bg-primary/90'
      : tone === 'danger'
        ? 'text-red-500 hover:bg-red-500/10'
        : 'eh-border border bg-[var(--eh-input-bg)] text-[var(--eh-text-primary)] hover:bg-black/5 dark:hover:bg-white/5';

  if (action.kind === 'link') {
    return (
      <a
        href={action.href}
        target="_blank"
        rel="noreferrer"
        className={`${base} eh-border border bg-transparent text-[var(--eh-text-muted)] hover:text-[var(--eh-text-primary)] hover:bg-black/5 dark:hover:bg-white/5`}
      >
        <ExternalLink className="h-3 w-3" /> {action.label}
      </a>
    );
  }

  return (
    <button
      type="button"
      onClick={onRun}
      disabled={disabled}
      title={action.kind === 'agent' ? 'Starts a tokenized agent session' : 'Instant — no agent, no tokens'}
      className={`${base} ${toneClass}`}
    >
      {busy ? (
        <Loader2 className="h-3 w-3 animate-spin" />
      ) : action.kind === 'agent' ? (
        <Sparkles className="h-3 w-3" />
      ) : null}
      {action.label}
    </button>
  );
}
