import { memo, useRef, useEffect, useMemo, useCallback, useState } from 'react';
import { Bot, Square, ExternalLink, CircleDot, X, Settings2, Clock } from 'lucide-react';
import type { Task, CliFramework } from '../types';
import { stopTaskCliSession } from '../api';
import { useAppSelector, useAppActions } from '../store/useAppSelector';
import { FRAMEWORK_ICONS } from '../constants';
import { FrameworkSelector } from './FrameworkSelector';

/** Compact running-duration label, e.g. "4s", "3m 12s", "1h 04m". FLUX-846: a terminal session
 *  freezes its duration at `endedAt` instead of counting from `startedAt` against `now` forever. */
function formatElapsed(startedAt: string | undefined, now: number, endedAt?: string): string {
  if (!startedAt) return '';
  const end = endedAt ? new Date(endedAt).getTime() : now;
  const ms = end - new Date(startedAt).getTime();
  if (!Number.isFinite(ms) || ms < 0) return '';
  const totalSecs = Math.floor(ms / 1000);
  const secs = totalSecs % 60;
  const mins = Math.floor(totalSecs / 60) % 60;
  const hours = Math.floor(totalSecs / 3600);
  if (hours > 0) return `${hours}h ${String(mins).padStart(2, '0')}m`;
  if (mins > 0) return `${mins}m ${String(secs).padStart(2, '0')}s`;
  return `${secs}s`;
}
import {
  groupSessions,
  aggregateGroup,
  groupAggregateLine,
  patternLabel,
  normalizeRoleLabel,
  isActiveSession,
  statusDotColor,
} from '../orchestration';
import { OrchestrationTopology } from './OrchestrationTopology';

interface Props {
  tasks: Task[];
  onClose: () => void;
  openTask: (task: Task) => void;
}

interface SessionItemProps {
  task: Task;
  now: number;
  onClose: () => void;
  openTask: (task: Task) => void;
  handleStop: (e: React.MouseEvent, taskId: string) => void;
}

const SessionItem = memo(function SessionItem({ task, now, onClose, openTask, handleStop }: SessionItemProps) {
  const session = task.cliSession!;
  const Icon = FRAMEWORK_ICONS[session.framework] || Bot;
  const statusColor = session.status === 'running' ? 'text-emerald-500' : session.status === 'waiting-input' ? 'text-amber-500' : 'text-gray-400';
  const elapsed = formatElapsed(session.startedAt, now, session.endedAt);
  const isWaiting = session.status === 'waiting-input';

  // Performance: Only compute last line when we actually have output
  const lastLine = useMemo(() => {
    if (!session.liveOutput) return '';
    const lines = session.liveOutput.trim().split('\n');
    return lines[lines.length - 1] || '';
  }, [session.liveOutput]);

  return (
    <div
      onClick={() => { onClose(); openTask(task); }}
      className="group relative flex flex-col gap-2 rounded-xl border border-gray-100 bg-white p-3 transition-all hover:border-primary/30 hover:bg-primary/5 cursor-pointer dark:border-white/5 dark:bg-white/3 dark:hover:bg-white/5"
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <div className={`p-1.5 rounded-lg bg-gray-100 dark:bg-white/10 ${statusColor}`}>
            <Icon className="h-4 w-4" />
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-1.5">
              <span className="text-[10px] font-bold uppercase tracking-wider text-gray-400">{task.id}</span>
              {session.role && (
                <span className="rounded-full bg-violet-100 px-1.5 py-0.5 text-[9px] font-semibold text-violet-700 dark:bg-violet-500/10 dark:text-violet-300">
                  {normalizeRoleLabel(session.role)}
                </span>
              )}
              {elapsed && (
                <span
                  className={`flex items-center gap-0.5 text-[9px] font-semibold tabular-nums ${isWaiting ? 'text-amber-500 dark:text-amber-400' : 'text-gray-400 dark:text-gray-500'}`}
                  title={isWaiting ? 'Waiting for input' : 'Running for'}
                >
                  <Clock className="h-2.5 w-2.5" />
                  {elapsed}
                </span>
              )}
            </div>
            <div className="truncate text-xs font-semibold text-gray-900 dark:text-gray-100">{task.title}</div>
          </div>
        </div>
        <button
          onClick={(e) => handleStop(e, task.id)}
          className="rounded-lg p-1.5 text-gray-400 hover:bg-red-50 hover:text-red-500 dark:hover:bg-red-500/10 transition-colors"
          title="Stop session"
        >
          <Square className="h-3.5 w-3.5" />
        </button>
      </div>

      {session.currentActivity && (
        <div className={`flex items-center gap-1.5 px-1.5 py-1 rounded text-[10px] font-medium ${isWaiting ? 'bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-300' : 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300'}`}>
          <CircleDot className={`h-2.5 w-2.5 shrink-0 ${isWaiting ? '' : 'animate-pulse'}`} />
          <span className="truncate">{session.currentActivity}</span>
        </div>
      )}

      {lastLine && (
        <div className="rounded-lg bg-gray-900 p-2 text-[9px] leading-relaxed text-gray-300 dark:bg-black/40 font-mono line-clamp-2">
          {lastLine}
        </div>
      )}

      <div className="absolute right-2 bottom-2 opacity-0 group-hover:opacity-100 transition-opacity">
         <ExternalLink className="h-3 w-3 text-primary" />
      </div>
    </div>
  );
});

interface GroupItemProps {
  task: Task;
  group: ReturnType<typeof groupSessions>[number];
  now: number;
  onClose: () => void;
  openTask: (task: Task) => void;
  handleStop: (e: React.MouseEvent, taskId: string) => void;
}

const GroupItem = memo(function GroupItem({ task, group, now, onClose, openTask, handleStop }: GroupItemProps) {
  const agg = aggregateGroup(group);
  // Earliest start across the group's sessions = how long the run has been going.
  const groupStartedAt = group.sessions.reduce<string | undefined>((earliest, s) => {
    if (!s.startedAt) return earliest;
    if (!earliest || new Date(s.startedAt).getTime() < new Date(earliest).getTime()) return s.startedAt;
    return earliest;
  }, undefined);
  const elapsed = formatElapsed(groupStartedAt, now);
  return (
    <div
      onClick={() => { onClose(); openTask(task); }}
      className="group relative flex flex-col gap-2 rounded-xl border border-emerald-200/70 bg-emerald-50/40 p-3 transition-all hover:border-primary/30 hover:bg-primary/5 cursor-pointer dark:border-emerald-500/20 dark:bg-emerald-500/5 dark:hover:bg-white/5"
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <OrchestrationTopology group={group} variant="glyph" />
          <div className="min-w-0">
            <div className="flex items-center gap-1.5">
              <span className="text-[10px] font-bold uppercase tracking-wider text-gray-400">{task.id}</span>
              <span className="rounded-full bg-violet-100 px-1.5 py-0.5 text-[9px] font-semibold text-violet-700 dark:bg-violet-500/10 dark:text-violet-300">
                {patternLabel(group.groupType, group.groupVariant)}
              </span>
              {elapsed && (
                <span className="flex items-center gap-0.5 text-[9px] font-semibold tabular-nums text-gray-400 dark:text-gray-500" title="Run elapsed">
                  <Clock className="h-2.5 w-2.5" />
                  {elapsed}
                </span>
              )}
            </div>
            <div className="truncate text-xs font-semibold text-gray-900 dark:text-gray-100">{task.title}</div>
          </div>
        </div>
        <button
          onClick={(e) => handleStop(e, task.id)}
          className="rounded-lg p-1.5 text-gray-400 hover:bg-red-50 hover:text-red-500 dark:hover:bg-red-500/10 transition-colors"
          title="Stop all sessions"
        >
          <Square className="h-3.5 w-3.5" />
        </button>
      </div>

      <div className="flex items-center gap-1.5 px-1 py-0.5 rounded bg-emerald-50 text-[10px] font-medium text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300">
        <CircleDot className="h-2.5 w-2.5 animate-pulse" />
        <span className="truncate">{groupAggregateLine(group, agg)}</span>
      </div>

      <div className="flex flex-wrap gap-1">
        {group.sessions.map(s => {
          const Icon = FRAMEWORK_ICONS[s.framework] || Bot;
          return (
            <span
              key={s.id}
              title={`${normalizeRoleLabel(s.role) ?? s.framework} — ${s.status}`}
              className="flex items-center gap-1 rounded-md border border-gray-200 bg-white px-1.5 py-0.5 text-[10px] font-medium text-gray-700 dark:border-white/10 dark:bg-white/5 dark:text-gray-200"
            >
              <span className={`inline-block h-1.5 w-1.5 rounded-full bg-current ${statusDotColor(s.status)} ${isActiveSession(s) && s.status !== 'waiting-input' ? 'animate-pulse' : ''}`} />
              <Icon className="h-2.5 w-2.5 text-gray-400" />
              <span className="max-w-[80px] truncate">{normalizeRoleLabel(s.role) ?? s.framework}</span>
            </span>
          );
        })}
      </div>

      <div className="absolute right-2 bottom-2 opacity-0 group-hover:opacity-100 transition-opacity">
         <ExternalLink className="h-3 w-3 text-primary" />
      </div>
    </div>
  );
});

export const ActiveSessionsPopover = memo(function ActiveSessionsPopover({ tasks, onClose, openTask }: Props) {
  const { triggerRefresh, saveConfig } = useAppActions();
  const config = useAppSelector((s) => s.config);
  const popoverRef = useRef<HTMLDivElement>(null);
  // Tick once a second so elapsed-time labels stay live while the popover is open.
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);

  useEffect(() => {
    const handleDown = (e: MouseEvent) => {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    document.addEventListener('mousedown', handleDown);
    return () => document.removeEventListener('mousedown', handleDown);
  }, [onClose]);

  const handleStop = useCallback(async (e: React.MouseEvent, taskId: string) => {
    e.stopPropagation();
    try {
      await stopTaskCliSession(taskId, { stopAll: true });
      triggerRefresh();
    } catch (err) {
      console.error('Failed to stop session:', err);
    }
  }, [triggerRefresh]);

  const handleAgentChange = useCallback((v: string) => {
    if (config) {
      saveConfig({ ...config, defaultAgent: v as CliFramework | 'auto' });
    }
  }, [config, saveConfig]);

  const activeTasks = useMemo(() =>
    // FLUX-846: `isActiveSession` excludes a session the engine has terminalized (carries `endedAt`)
    // even if its `status` is stale — so a completed session never lingers here as forever-'Working'.
    tasks.filter(t => t.cliSession && isActiveSession(t.cliSession)),
    [tasks]
  );

  return (
    <div
      ref={popoverRef}
      className="absolute right-0 top-full z-[100] mt-2 w-80 rounded-2xl border border-gray-200 bg-white/95 shadow-2xl backdrop-blur-xl dark:border-white/10 dark:bg-[#1a1b23]/95 overflow-hidden"
    >
      <div className="flex items-center justify-between border-b border-gray-100 px-4 py-3 dark:border-white/5">
        <h3 className="text-xs font-bold uppercase tracking-wider text-gray-500">Agent Management</h3>
        <button onClick={onClose} className="rounded-md p-1 hover:bg-gray-100 dark:hover:bg-white/10 transition-colors">
          <X className="h-4 w-4 text-gray-400" />
        </button>
      </div>

      <div className="p-3 border-b border-gray-100 dark:border-white/5 bg-gray-50/50 dark:bg-white/5">
        <div className="flex flex-col gap-1.5">
           <div className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wider text-gray-400">
             <Settings2 className="h-3 w-3" />
             Default Agent
           </div>
           <FrameworkSelector
             value={config?.defaultAgent || 'auto'}
             onChange={handleAgentChange}
             showAuto
             allowedFrameworks={['auto', 'claude', 'gemini', 'copilot']}
           />
        </div>
      </div>

      <div className="max-h-[320px] overflow-y-auto p-2 space-y-2">
        <div className="px-2 pt-1 pb-1 text-[10px] font-bold uppercase tracking-wider text-gray-400 flex items-center gap-1.5">
           <Bot className="h-3 w-3" />
           Active Sessions
        </div>
        {activeTasks.length === 0 ? (
          <div className="py-8 text-center text-sm text-gray-500">
            No active agent sessions.
          </div>
        ) : (
          activeTasks.map(task => {
            const groups = groupSessions(task.cliSessions);
            const multi = groups.find(g => g.isMulti && g.sessions.some(isActiveSession));
            if (multi) {
              return (
                <GroupItem
                  key={task.id}
                  task={task}
                  group={multi}
                  now={now}
                  onClose={onClose}
                  openTask={openTask}
                  handleStop={handleStop}
                />
              );
            }
            return (
              <SessionItem
                key={task.id}
                task={task}
                now={now}
                onClose={onClose}
                openTask={openTask}
                handleStop={handleStop}
              />
            );
          })
        )}
      </div>
      
      {activeTasks.length > 0 && (
        <div className="bg-gray-50 dark:bg-black/20 p-2 border-t border-gray-100 dark:border-white/5">
           <p className="text-[9px] text-center text-gray-400 uppercase tracking-widest font-bold">
             {activeTasks.length} session{activeTasks.length > 1 ? 's' : ''} running
           </p>
        </div>
      )}
    </div>
  );
});

