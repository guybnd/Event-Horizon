import { memo, useRef, useEffect, useMemo, useCallback } from 'react';
import { Bot, Square, ExternalLink, CircleDot, X, Settings2 } from 'lucide-react';
import type { Task, CliFramework } from '../types';
import { stopTaskCliSession } from '../api';
import { useApp } from '../AppContext';
import { FRAMEWORK_ICONS } from '../constants';
import { FrameworkSelector } from './FrameworkSelector';

interface Props {
  tasks: Task[];
  onClose: () => void;
  openTask: (task: Task) => void;
}

interface SessionItemProps {
  task: Task;
  onClose: () => void;
  openTask: (task: Task) => void;
  handleStop: (e: React.MouseEvent, taskId: string) => void;
}

const SessionItem = memo(function SessionItem({ task, onClose, openTask, handleStop }: SessionItemProps) {
  const session = task.cliSession!;
  const Icon = FRAMEWORK_ICONS[session.framework] || Bot;
  const statusColor = session.status === 'running' ? 'text-emerald-500' : session.status === 'waiting-input' ? 'text-amber-500' : 'text-gray-400';
  
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
                  {session.role.replace('reviewer:', '')}
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
        <div className="flex items-center gap-1.5 px-1 py-0.5 rounded bg-emerald-50 text-[10px] font-medium text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300">
          <CircleDot className="h-2.5 w-2.5 animate-pulse" />
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

export const ActiveSessionsPopover = memo(function ActiveSessionsPopover({ tasks, onClose, openTask }: Props) {
  const { triggerRefresh, config, saveConfig } = useApp();
  const popoverRef = useRef<HTMLDivElement>(null);

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
      await stopTaskCliSession(taskId);
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
    tasks.filter(t => t.cliSession && ['pending', 'running', 'waiting-input'].includes(t.cliSession.status)),
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
          activeTasks.map(task => (
            <SessionItem 
              key={task.id} 
              task={task} 
              onClose={onClose} 
              openTask={openTask} 
              handleStop={handleStop} 
            />
          ))
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

