import { useCallback, useState } from 'react';
import { Bot } from 'lucide-react';
import { AnimatePresence } from 'framer-motion';
import { useAppSelector } from '../store/useAppSelector';
import { ActiveSessionsPopover } from './ActiveSessionsPopover';
import { LifetimeTokenStats } from './LifetimeTokenStats';

const ACTIVE_SESSION_STATUSES = new Set(['pending', 'running', 'waiting-input']);

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

  const activeSessionCount = tasks.filter(
    (task) => task.cliSession && ACTIVE_SESSION_STATUSES.has(task.cliSession.status)
  ).length;

  const handleCloseSessionsPopover = useCallback(() => setIsSessionsPopoverOpen(false), []);
  const toggleSessionsPopover = useCallback(() => setIsSessionsPopoverOpen((prev) => !prev), []);

  return (
    <div className="flex flex-none items-center gap-2">
      {/* Agent sessions — compact stat card */}
      <div className="relative">
        <button
          onClick={toggleSessionsPopover}
          className={`group flex shrink-0 cursor-pointer items-center gap-1.5 rounded-xl border px-2.5 py-2 text-left transition-all duration-200 overflow-hidden ${activeSessionCount > 0 ? 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-300 agent-session-active' : 'border-gray-200 bg-white/60 text-gray-500 dark:border-white/10 dark:bg-white/5 dark:text-gray-400'} ${isSessionsPopoverOpen ? 'ring-2 ring-primary/30' : ''}`}
          title="Active agent sessions running on tickets"
        >
          <div className="relative shrink-0">
            <Bot className="h-3.5 w-3.5" />
            {activeSessionCount > 0 && <span className="absolute -right-0.5 -top-0.5 h-1.5 w-1.5 rounded-full bg-emerald-500 animate-pulse" />}
          </div>
          <span className="text-sm font-semibold leading-none">{activeSessionCount}</span>
          <span className="text-[10px] font-bold uppercase tracking-wider opacity-70">Agents</span>
        </button>
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
