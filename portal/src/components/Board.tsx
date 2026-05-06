import { useEffect, useState } from 'react';
import { DndContext, DragOverlay, pointerWithin } from '@dnd-kit/core';
import type { DragEndEvent, DragStartEvent } from '@dnd-kit/core';
import { Column } from './Column';
import { TaskCard } from './TaskCard';
import { fetchConfig, fetchTasks, updateTask } from '../api';
import type { Task, Config } from '../types';
import { Loader2 } from 'lucide-react';

export function Board() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [config, setConfig] = useState<Config | null>(null);
  const [loading, setLoading] = useState(true);
  const [activeTask, setActiveTask] = useState<Task | null>(null);

  useEffect(() => {
    Promise.all([fetchConfig(), fetchTasks()])
      .then(([configData, tasksData]) => {
        setConfig(configData);
        setTasks(tasksData);
      })
      .catch(err => console.error("Failed to load initial data:", err))
      .finally(() => setLoading(false));
  }, []);

  if (loading || !config) {
    return (
      <div className="flex items-center justify-center h-full">
        <Loader2 className="w-8 h-8 animate-spin text-primary" />
      </div>
    );
  }

  // Find all unique statuses from tasks that aren't in columns and aren't hidden
  const extraStatuses = Array.from(new Set(tasks.map(t => t.status)))
    .filter(s => !config.columns.includes(s) && !config.hiddenStatuses.includes(s));

  const allColumns = [...config.columns, ...extraStatuses];

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

    // Optimistic update
    setTasks(prev => prev.map(t => t.id === taskId ? { ...t, status: newStatus } : t));

    try {
      await updateTask(taskId, { status: newStatus });
    } catch (err) {
      console.error("Failed to save task status:", err);
      // Revert on failure
      setTasks(prev => prev.map(t => t.id === taskId ? { ...t, status: task.status } : t));
    }
  };

  return (
    <DndContext 
      onDragStart={handleDragStart} 
      onDragEnd={handleDragEnd}
      collisionDetection={pointerWithin}
    >
      <div className="flex gap-6 overflow-x-auto h-full pb-4 items-start">
        {allColumns.map(columnId => (
          <Column
            key={columnId}
            id={columnId}
            title={columnId}
            tasks={tasks.filter(t => t.status === columnId)}
          />
        ))}
      </div>

      <DragOverlay>
        {activeTask ? <TaskCard task={activeTask} /> : null}
      </DragOverlay>
    </DndContext>
  );
}
