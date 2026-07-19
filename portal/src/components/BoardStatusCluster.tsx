import { useCallback, useMemo, useState } from 'react';
import { Bot } from 'lucide-react';
import { AnimatePresence } from 'framer-motion';
import { useAppSelector } from '../store/useAppSelector';
import { isActiveSession, isSessionStale } from '../orchestration';
import { ActiveSessionsPopover } from './ActiveSessionsPopover';
import { LifetimeTokenStats } from './LifetimeTokenStats';

/**
 * Board-context status cluster — the live "working state" of the board:
 * active agent sessions and lifetime token/cost. Lives on the board/backlog
 * control bar rather than the global header, since these signals are only
 * meaningful where tickets are shown. (Sync status moved to the top Header;
 * the uncommitted-changes control sits next to the Worktrees chip.)
 */
export function BoardStatusCluster() {
  const tasks = useAppSelector((s) => s.tasks);
  const [isSessionsPopoverOpen, setIsSessionsPopoverOpen] = useState(false);

  // FLUX-1532: shared `isActiveSession` (not a locally-duplicated status set) picks up the FLUX-846
  // `endedAt`-is-terminal guard and the FLUX-1390 `'scheduled'` status. A stalled session (gone quiet
  // past `SESSION_STALE_MS`) still counts as "active" per that shared helper, but is split OUT of the
  // headline count here and surfaced as its own "· N stalled" indicator instead — so a hung agent no
  // longer silently inflates the pill.
  const { activeSessionCount, stalledSessionCount } = useMemo(() => {
    let active = 0;
    let stalled = 0;
    for (const task of tasks) {
      if (!task.cliSession || !isActiveSession(task.cliSession)) continue;
      if (isSessionStale(task.cliSession)) stalled++;
      else active++;
    }
    return { activeSessionCount: active, stalledSessionCount: stalled };
  }, [tasks]);

  const handleCloseSessionsPopover = useCallback(() => setIsSessionsPopoverOpen(false), []);
  const toggleSessionsPopover = useCallback(() => setIsSessionsPopoverOpen((prev) => !prev), []);

  const hasActive = activeSessionCount > 0;
  const hasStalledOnly = !hasActive && stalledSessionCount > 0;
  const pillTitle = stalledSessionCount > 0
    ? `${activeSessionCount} active, ${stalledSessionCount} stalled agent session${stalledSessionCount === 1 ? '' : 's'}`
    : 'Active agent sessions running on tickets';

  return (
    <div className="flex flex-none items-center gap-2">
      {/* Agent sessions — compact stat card */}
      <div className="relative">
        <button
          onClick={toggleSessionsPopover}
          className={`group flex shrink-0 cursor-pointer items-center gap-1.5 rounded-xl border px-2.5 py-2 text-left transition-all duration-200 overflow-hidden ${hasActive ? 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-300' : hasStalledOnly ? 'border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-300' : 'border-gray-200 bg-white/60 text-gray-500 dark:border-white/10 dark:bg-white/5 dark:text-gray-400'} ${isSessionsPopoverOpen ? 'ring-2 ring-primary/30' : ''}`}
          title={pillTitle}
        >
          <div className="relative shrink-0">
            <Bot className="h-3.5 w-3.5" />
            {hasActive && <span className="absolute -right-0.5 -top-0.5 h-1.5 w-1.5 rounded-full bg-emerald-500 animate-pulse" />}
            {hasStalledOnly && <span className="absolute -right-0.5 -top-0.5 h-1.5 w-1.5 rounded-full bg-amber-500" />}
          </div>
          <span className="text-sm font-semibold leading-none">{activeSessionCount}</span>
          <span className="text-[10px] font-bold uppercase tracking-wider opacity-70">Agents</span>
          {stalledSessionCount > 0 && (
            <span className="text-[10px] font-semibold text-amber-600 dark:text-amber-400">· {stalledSessionCount} stalled</span>
          )}
        </button>
        {/* FLUX-1552: the pulse used to be a box-shadow keyframe animation on the button itself
            (main-thread paint every frame, continuously whenever any session is active). It's now a
            sibling overlay carrying a static box-shadow that only fades opacity (compositor-only,
            FLUX-1266 recipe) — a sibling rather than the button's own ::after because the button is
            overflow-hidden, which would clip a descendant's shadow. */}
        {hasActive && <span className="agent-session-glow" />}
        <AnimatePresence>
          {isSessionsPopoverOpen && (
            <ActiveSessionsPopover
              tasks={tasks}
              onClose={handleCloseSessionsPopover}
            />
          )}
        </AnimatePresence>
      </div>

      {/* Token/cost is informational only — pinned to the far edge where it won't
          get in the way of the controls you actually click. */}
      <LifetimeTokenStats />
    </div>
  );
}
