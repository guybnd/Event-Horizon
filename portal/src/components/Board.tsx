import { useEffect, useState } from 'react';
import { DndContext, DragOverlay, pointerWithin } from '@dnd-kit/core';
import type { DragEndEvent, DragStartEvent } from '@dnd-kit/core';
import { Column } from './Column';
import { TaskCard } from './TaskCard';
import { fetchTasks, updateTask } from '../api';
import { useApp } from '../AppContext';
import type { Task } from '../types';
import { Loader2 } from 'lucide-react';

export function Board() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeTask, setActiveTask] = useState<Task | null>(null);
  const { refreshTrigger, config, currentUser, triggerRefresh } = useApp();

  const [pendingStatusChange, setPendingStatusChange] = useState<{taskId: string, newStatus: string, oldStatus: string} | null>(null);
  const [commentText, setCommentText] = useState('');

  useEffect(() => {
    fetchTasks()
      .then(setTasks)
      .catch(console.error)
      .finally(() => setLoading(false));
  }, [refreshTrigger]);

  if (loading || !config) {
    return (
      <div className="flex items-center justify-center h-full">
        <Loader2 className="w-8 h-8 animate-spin text-primary" />
      </div>
    );
  }

  const extraStatuses = Array.from(new Set(tasks.map(t => t.status)))
    .filter(s => !config.columns.find(c => c.name === s) && !config.hiddenStatuses.find(h => h.name === s));

  const allColumns = [...config.columns.map(c => c.name), ...extraStatuses];

  const handleDragStart = (event: DragStartEvent) => {
    const { active } = event;
    const task = tasks.find(t => t.id === active.id);
    if (task) setActiveTask(task);
  };

  const handleDragEnd = async (event: DragEndEvent) => {
    const { active, over } = event;
    setActiveTask(null);
    if (!over) return;

    const taskId = active.id as string;
    const newStatus = over.id as string;
    const task = tasks.find(t => t.id === taskId);
    if (!task || task.status === newStatus) return;

    if (config.requireCommentOnStatusChange) {
      setPendingStatusChange({ taskId, newStatus, oldStatus: task.status });
      return;
    }

    await applyStatusChange(taskId, newStatus, task.status);
  };

  const applyStatusChange = async (taskId: string, newStatus: string, oldStatus: string, comment?: string) => {
    const task = tasks.find(t => t.id === taskId);
    if (!task) return;

    const newHistory = [...(task.history || []), {
      type: 'status_change',
      from: oldStatus,
      to: newStatus,
      user: currentUser,
      date: new Date().toISOString(),
      comment
    }];

    setTasks(prev => prev.map(t => t.id === taskId ? { ...t, status: newStatus, history: newHistory as any } : t));

    try {
      await updateTask(taskId, { status: newStatus, history: newHistory, updatedBy: currentUser } as any);
      triggerRefresh();
    } catch (err) {
      console.error(err);
      setTasks(prev => prev.map(t => t.id === taskId ? { ...t, status: oldStatus } : t));
    }
    setPendingStatusChange(null);
    setCommentText('');
  };

  return (
    <>
      <DndContext onDragStart={handleDragStart} onDragEnd={handleDragEnd} collisionDetection={pointerWithin}>
        <div className="flex gap-6 overflow-x-auto h-full pb-4 items-start">
          {allColumns.map(columnId => (
            <Column key={columnId} id={columnId} title={columnId} tasks={tasks.filter(t => t.status === columnId)} />
          ))}
        </div>
        <DragOverlay>{activeTask ? <TaskCard task={activeTask} isOverlay /> : null}</DragOverlay>
      </DndContext>

      {pendingStatusChange && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/40 backdrop-blur-sm pointer-events-auto">
          <div className="bg-white dark:bg-[#1a1b23] p-6 rounded-xl shadow-2xl w-[400px] border border-gray-200 dark:border-white/10">
            <h3 className="text-lg font-bold mb-2">Update Status</h3>
            <p className="text-sm text-gray-500 mb-4">Moving task to <span className="font-bold text-primary">{pendingStatusChange.newStatus}</span>. Add a quick note?</p>
            <textarea 
              autoFocus
              className="w-full bg-gray-50 dark:bg-black/20 border border-gray-200 dark:border-white/10 rounded-lg px-3 py-2 outline-none focus:border-primary resize-none text-sm mb-4 h-24"
              placeholder="Optional comment..."
              value={commentText} onChange={e => setCommentText(e.target.value)}
            />
            <div className="flex justify-end gap-3">
              <button 
                onClick={() => setPendingStatusChange(null)}
                className="px-4 py-2 rounded-lg text-sm font-medium hover:bg-gray-100 dark:hover:bg-white/5 cursor-pointer transition-colors"
              >Cancel</button>
              <button 
                onClick={() => applyStatusChange(pendingStatusChange.taskId, pendingStatusChange.newStatus, pendingStatusChange.oldStatus, commentText)}
                className="px-4 py-2 bg-primary hover:bg-primary-hover text-white rounded-lg text-sm font-medium cursor-pointer transition-colors"
              >Save Update</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
