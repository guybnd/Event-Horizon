import { AlertTriangle, Bot, CheckCircle2, MessageCircleQuestion, RotateCw } from 'lucide-react';
import type { ComponentType } from 'react';
import type { Task } from '../../types';
import type { TaskCardController } from '../../hooks/useTaskCardController';
import type { CardSessionState } from '../../workflow';

/**
 * Dedicated full-width lane for a single live agent session (FLUX-652). The live progress /
 * activity text is variable-length and effectively unbounded; hosting it inline in the footer let
 * it push the card wider (the "npm run check 2>…" pill spilling past the rounded border). As a
 * block-level `w-full` row with `min-w-0` + `truncate` it is structurally incapable of widening
 * the card — it clips to the available width instead. Mirrors the CardBranchRow / CardClusterPanel
 * stacked-row pattern, sitting above the footer.
 *
 * Multi-session / orchestration runs render through CardClusterPanel instead, so the caller gates
 * this on `!clusterGroup`; this row only covers the single-session case.
 *
 * FLUX-909: the row no longer reads as a flat emerald "Running" for every active state. The engine's
 * `waiting-input` is overloaded (blocked-on-user vs clean idle turn-end), so the controller derives
 * a `sessionState` we branch on here — emerald+pulse running, amber attention "Needs your input",
 * calm blue "Idle · done for now", faint "Starting…". Reuses the amber convention from
 * ActiveSessionsPopover / CardClusterPanel so dark mode + the board color language stay consistent.
 */

interface StatePresentation {
  /** Wrapper classes for the pill (border/bg/text + dark variants). */
  wrapper: string;
  /** Class for the trailing detail span (the dimmer same-hue text). */
  detailClass: string;
  icon: ComponentType<{ className?: string }>;
  /** Whether the icon pulses (only the actively-working `running` state). */
  pulse: boolean;
}

const PRESENTATION: Record<Exclude<CardSessionState, 'none'>, StatePresentation> = {
  // S10 (epic FLUX-996): a spawn/resume that crashed — distinct rose "alarm" tone from
  // `needs-input`'s amber so a dead session doesn't read as merely "waiting on you".
  failed: {
    wrapper:
      'border-rose-200 bg-rose-50 text-rose-700 dark:border-rose-500/30 dark:bg-rose-500/10 dark:text-rose-300',
    detailClass: 'text-rose-600/90 dark:text-rose-300/80',
    icon: AlertTriangle,
    pulse: false,
  },
  running: {
    wrapper:
      'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-300',
    detailClass: 'text-emerald-600/90 dark:text-emerald-300/80',
    icon: Bot,
    pulse: true,
  },
  starting: {
    wrapper:
      'border-emerald-200/60 bg-emerald-50/60 text-emerald-600 dark:border-emerald-500/20 dark:bg-emerald-500/5 dark:text-emerald-300/80',
    detailClass: 'text-emerald-600/80 dark:text-emerald-300/70',
    icon: Bot,
    pulse: false,
  },
  'needs-input': {
    wrapper:
      'border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-300',
    detailClass: 'text-amber-600/90 dark:text-amber-300/80',
    icon: MessageCircleQuestion,
    pulse: false,
  },
  idle: {
    wrapper:
      'border-blue-200 bg-blue-50 text-blue-700 dark:border-blue-500/30 dark:bg-blue-500/10 dark:text-blue-300',
    detailClass: 'text-blue-600/90 dark:text-blue-300/80',
    icon: CheckCircle2,
    pulse: false,
  },
};

export function CardSessionRow({ task, c }: { task: Task; c: TaskCardController }) {
  const label = task.cliSession?.label ?? 'Agent';
  // `sessionState` is 'none' only when there is no active session and we render purely for a recent
  // progress note (shouldShowProgress); fall back to the running presentation so that case is
  // unchanged from before FLUX-909.
  const state = c.sessionState === 'none' ? 'running' : c.sessionState;
  const p = PRESENTATION[state];
  const Icon = p.icon;

  // The trailing detail text per state: the live activity / progress note while running or starting,
  // and a settled one-liner for the parked states. `needs-input` prefers the session's blockedReason
  // (the concrete denial/permission text) and falls back to the generic prompt; `idle` is the calm
  // "nothing pending" line. `failed` prefers the S9/S10 operation-telemetry reason (the actual
  // "why" — e.g. "ENOENT", "signal SIGKILL") over a generic line. Both are bounded by the
  // truncate cell below.
  const detail =
    state === 'failed'
      ? c.operationFailure?.reason ?? 'Agent failed to start'
      : state === 'needs-input'
        ? task.cliSession?.blockedReason ?? 'Needs your input'
        : state === 'idle'
          ? 'Idle · done for now'
          : state === 'starting'
            ? 'Starting…'
            : c.shouldShowProgress && c.latestProgress
              ? c.latestProgress.message
              : c.currentActivity ?? 'Running';

  // S10 (epic FLUX-996): Retry re-fires the same one-click phase launch the card's primary action
  // button already uses (`tryLaunchPhaseDefault`) — no bespoke "resume a crashed spawn" endpoint,
  // just the existing dispatch path a user would otherwise reach for manually. Mirrors
  // useTicketActions' `launchDefault` fallback: if no phase-default persona resolves (e.g. it was
  // unconfigured/removed since the original launch), fall back to the full launcher instead of
  // silently no-oping.
  const retrying = c.ticketActions.busyKey === 'retry-operation';
  const handleRetry = (e: React.MouseEvent) => {
    e.stopPropagation();
    void c.ticketActions.fire('retry-operation', async () => {
      const launched = await c.ticketActions.tryLaunchPhaseDefault(c.ticketActions.cardPhase);
      if (!launched) c.ticketActions.openLauncher(c.ticketActions.cardPhase, c.ticketActions.singleDefaultId);
    });
  };

  return (
    <div
      // The emerald pulsing glow is a "live / working" signal — keep it only for the running state
      // so the calm parked states (idle / needs-input / starting / failed) don't read as still-running.
      className={`${state === 'running' ? 'bot-assignee-glow ' : ''}mb-2 flex min-w-0 max-w-full items-center gap-1.5 overflow-hidden rounded-md border px-2 py-1 text-[11px] ${p.wrapper}`}
      title={`${label}: ${detail}`}
    >
      <Icon className={`h-3 w-3 shrink-0 ${p.pulse ? 'animate-pulse' : ''}`} />
      <span className="max-w-[40%] shrink-0 truncate font-semibold">{label}</span>
      <span aria-hidden className="shrink-0 opacity-40">·</span>
      <span className={`min-w-0 flex-1 truncate ${p.detailClass}`}>{detail}</span>
      {state === 'failed' && (
        <button
          type="button"
          onClick={handleRetry}
          disabled={retrying}
          title="Retry — launch a fresh session"
          className="flex shrink-0 items-center gap-1 rounded border border-rose-300 px-1.5 py-0.5 font-semibold text-rose-700 hover:bg-rose-100 disabled:opacity-50 dark:border-rose-500/40 dark:text-rose-300 dark:hover:bg-rose-800/30"
        >
          <RotateCw className={`h-3 w-3 ${retrying ? 'animate-spin' : ''}`} />
          Retry
        </button>
      )}
    </div>
  );
}
