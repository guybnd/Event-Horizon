// FLUX-1390: the engine-owned wake timer for honored `ScheduleWakeup` calls. Consistent with EH's
// engine-side-loop stance (mirrors the Furnace stoker / Temper background ticks) — survives with no
// portal open, and picks a `scheduled` session that was rehydrated from a stub after an engine
// restart (session-store.ts's stubFor/rehydratedRecord already preserve `wakeAt` across that).
//
// Deliberately generic over CliFramework (reads `session.framework` and resolves via `getAdapter`)
// even though only the Claude adapter can currently produce a `scheduled` session — ScheduleWakeup is
// a Claude Code native tool with no gemini/copilot equivalent yet (see claude-code.ts's
// disallowedToolsArgs). A `scheduled` session should never appear for another framework, but this
// module doesn't need to assume that to stay correct.
import { log } from './log.js';
import { getWorkspaceRoot } from './workspace.js';
import { getAdapter } from './agents/index.js';
import { cliSessionsById } from './session-store.js';

const WAKE_TICK_INTERVAL_MS = 5_000;

// Reentrancy guard: a session id currently being resumed is excluded from the next tick's scan so a
// resume still in its pre-flight `await` (before the adapter flips status off 'scheduled') can't be
// picked up twice.
const waking = new Set<string>();

async function wakeDueSessions(): Promise<void> {
  const workspaceRoot = getWorkspaceRoot();
  if (!workspaceRoot) return;
  const now = Date.now();

  for (const session of cliSessionsById.values()) {
    if (session.status !== 'scheduled' || !session.wakeAt || waking.has(session.id)) continue;
    if (Date.parse(session.wakeAt) > now) continue;

    waking.add(session.id);
    const reasonNote = session.wakeReason ? ` (reason given: ${session.wakeReason})` : '';
    const message = `[Scheduled wakeup] The wait you requested has elapsed${reasonNote} — resuming automatically. Continue your work; call ScheduleWakeup again if you need to wait longer, or take the next board action when you're done.`;
    delete session.wakeAt;
    delete session.wakeReason;
    session.scheduledResumeCount = (session.scheduledResumeCount ?? 0) + 1;

    let adapter;
    try {
      adapter = getAdapter(session.framework);
    } catch (e: unknown) {
      log.warn(`[scheduled-wake] no adapter for session ${session.id} (${session.framework}): ${e instanceof Error ? e.message : String(e)}`);
      waking.delete(session.id);
      continue;
    }

    adapter.sendInput(session, message, 'Scheduler', workspaceRoot, { wakeResume: true })
      .catch((e: unknown) => {
        log.warn(`[scheduled-wake] resume failed for session ${session.id} (task ${session.taskId}): ${e instanceof Error ? e.message : String(e)}`);
      })
      .finally(() => {
        waking.delete(session.id);
      });
  }
}

let wakeTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Start the background scheduled-wake ticker (idempotent). Every tick, re-dispatches any `scheduled`
 * CLI session whose `wakeAt` has passed by resuming it via `--resume` (adapter.sendInput with
 * `wakeResume: true`) — the FLUX-1390 opt-in counterpart to FLUX-1389's unconditional ScheduleWakeup
 * block. A no-op tick when nothing is asleep (the common case, including when the feature flag is
 * off — no session can ever reach `scheduled` then), so always safe to start unconditionally.
 */
export function startScheduledWakeTicker(): void {
  if (wakeTimer) return;
  wakeTimer = setInterval(() => { void wakeDueSessions(); }, WAKE_TICK_INTERVAL_MS);
  wakeTimer.unref?.();
  log.info('[scheduled-wake] ticker started.');
}
