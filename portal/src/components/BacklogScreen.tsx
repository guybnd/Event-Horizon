import { useState } from 'react';
import { useApp } from '../AppContext';
import { updateTask } from '../api';
import { Loader2, Plus } from 'lucide-react';
import { TaskViewControls } from './TaskViewControls';
import { filterAndSortTasks } from '../taskSearch';

export function BacklogScreen() {
  const {
    openTaskModal,
    triggerRefresh,
    currentProject,
    config,
    currentUser,
    searchQuery,
    sortOption,
    filterAssignee,
    filterPriority,
    filterTag,
    tasks: liveTasks,
    tasksLoading,
    taskLiveEvents,
  } = useApp();
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);

  const tasks = liveTasks.filter((task) => task.status === 'Backlog' || task.status.toLowerCase() === 'backlog');

  if ((tasksLoading && liveTasks.length === 0) || !config) {
    return (
      <div className="flex items-center justify-center h-full">
        <Loader2 className="w-8 h-8 animate-spin text-primary" />
      </div>
    );
  }

  const selectedTask = tasks.find(t => t.id === selectedTaskId);
  const allStatuses = [...config.columns.map(c => c.name), ...config.hiddenStatuses.map(c => c.name)];
  const visibleTasks = filterAndSortTasks(tasks, config, {
    searchQuery,
    sortOption,
    filterAssignee,
    filterPriority,
    filterTag,
  });
  const selectedVisibleTask = visibleTasks.find(t => t.id === selectedTaskId) || null;

  const handleStatusChange = async (newStatus: string) => {
    if (!selectedTask) return;
    
    const newHistory = [...(selectedTask.history || []), {
      type: 'status_change',
      from: selectedTask.status,
      to: newStatus,
      user: currentUser,
      date: new Date().toISOString()
    }];

    try {
      await updateTask(selectedTask.id, { status: newStatus, history: newHistory as any, updatedBy: currentUser } as any);
      triggerRefresh();
      setSelectedTaskId(null);
    } catch(err) {
      console.error(err);
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col gap-6">
      <TaskViewControls
        title="Backlog filters"
        searchPlaceholder="Filter backlog items"
        visibleCount={visibleTasks.length}
        totalCount={tasks.length}
        itemLabel="backlog tickets"
      />

      <div className="flex min-h-0 flex-1 gap-6">
      {/* List View */}
      <div className="w-1/3 min-h-0 flex flex-col bg-white/50 dark:bg-[#1f2028]/50 rounded-2xl border border-gray-200 dark:border-white/5 overflow-hidden">
        <div className="p-4 border-b border-gray-200 dark:border-white/5 flex items-center justify-between bg-white/80 dark:bg-[#252630]/80">
          <h2 className="font-semibold text-gray-800 dark:text-gray-200">Backlog Items ({visibleTasks.length})</h2>
          <button 
            onClick={() => openTaskModal({ status: 'Backlog', projectKey: currentProject } as any)}
            className="flex items-center gap-1 text-xs font-medium bg-primary text-white px-2 py-1.5 rounded hover:bg-primary-hover cursor-pointer transition-colors"
          >
            <Plus className="w-3 h-3" /> Add
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-3 flex flex-col gap-2">
          {visibleTasks.length === 0 && (
            <p className="text-sm text-gray-500 text-center mt-10">{searchQuery.trim() ? 'No backlog items match the current filters.' : 'No backlog items.'}</p>
          )}
          {visibleTasks.map(task => (
            (() => {
              const liveEvent = taskLiveEvents[task.id];
              const liveAnimationClass = liveEvent
                ? liveEvent.kind === 'created'
                  ? 'task-live-created'
                  : liveEvent.kind === 'moved'
                    ? 'task-live-moved'
                    : 'task-live-updated'
                : '';

              return (
            <div 
              key={task.id}
              onClick={() => setSelectedTaskId(task.id)}
              className={`p-3 rounded-lg border cursor-pointer transition-all flex flex-col ${
                selectedTaskId === task.id 
                  ? 'border-primary bg-primary/5 shadow-sm' 
                  : 'border-gray-200 dark:border-white/5 bg-white dark:bg-[#252630] hover:border-gray-300 dark:hover:border-white/20'
              } ${liveAnimationClass}`}
            >
              <h4 className="text-sm font-medium text-gray-900 dark:text-gray-100 leading-snug">{task.title || 'Untitled Task'}</h4>
              <span className="text-[10px] font-bold text-gray-400 mt-0.5 tracking-wider">{task.id}</span>
            </div>
              );
            })()
          ))}
        </div>
      </div>

      {/* Details View */}
      <div className="flex-1 min-h-0 bg-white/50 dark:bg-[#1f2028]/50 rounded-2xl border border-gray-200 dark:border-white/5 flex flex-col overflow-hidden">
        {selectedVisibleTask ? (
          <div className="flex flex-col h-full">
            <div className="p-6 border-b border-gray-200 dark:border-white/5 flex justify-between items-start bg-white/80 dark:bg-[#252630]/80">
              <div>
                <h2 className="text-2xl font-bold text-gray-900 dark:text-white mb-1 leading-tight">{selectedVisibleTask.title || 'Untitled Task'}</h2>
                <h3 className="text-sm text-gray-400 font-bold tracking-wider">{selectedVisibleTask.id}</h3>
              </div>
              <div className="flex items-center gap-3">
                <select
                  value={selectedVisibleTask.status}
                  onChange={e => handleStatusChange(e.target.value)}
                  className="bg-white dark:bg-[#252630] border border-gray-200 dark:border-white/10 rounded-lg px-3 py-2 text-sm font-medium focus:border-primary outline-none cursor-pointer"
                >
                  {allStatuses.map(s => <option key={s} value={s}>{s}</option>)}
                </select>
                <button 
                  onClick={() => openTaskModal(selectedVisibleTask)}
                  className="px-4 py-2 bg-gray-100 dark:bg-white/10 hover:bg-gray-200 dark:hover:bg-white/20 rounded-lg text-sm font-medium transition-colors cursor-pointer"
                >
                  Edit Task
                </button>
              </div>
            </div>
            <div className="p-6 flex-1 overflow-y-auto">
              <div className="grid grid-cols-2 gap-6 mb-8">
                <div>
                  <span className="block text-xs font-bold text-gray-400 uppercase tracking-wider mb-1">Assignee</span>
                  <p className="text-sm font-medium">{selectedVisibleTask.assignee || 'Unassigned'}</p>
                </div>
                <div>
                  <span className="block text-xs font-bold text-gray-400 uppercase tracking-wider mb-1">Tags</span>
                  <div className="flex gap-2 flex-wrap mt-1">
                    {selectedVisibleTask.tags?.map(tag => {
                      const tagColor = config.tags.find(t => t.name === tag)?.color || 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300';
                      return (
                        <span key={tag} className={`px-2 py-0.5 rounded text-xs font-medium ${tagColor}`}>
                          {tag}
                        </span>
                      );
                    }) || <span className="text-sm text-gray-500">None</span>}
                  </div>
                </div>
              </div>
              
              <div>
                <span className="block text-xs font-bold text-gray-400 uppercase tracking-wider mb-3">Description</span>
                <div className="prose prose-sm dark:prose-invert max-w-none font-mono text-sm bg-gray-50 dark:bg-black/20 p-4 rounded-xl border border-gray-100 dark:border-white/5 whitespace-pre-wrap">
                  {selectedVisibleTask.body || 'No description provided.'}
                </div>
              </div>
            </div>
          </div>
        ) : (
          <div className="flex-1 flex items-center justify-center text-gray-400">
            <p>Select a task to view details</p>
          </div>
        )}
      </div>
      </div>
    </div>
  );
}
