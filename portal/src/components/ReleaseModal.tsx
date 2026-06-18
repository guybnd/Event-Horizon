import { useState, useEffect } from 'react';
import { useAppSelector, useAppActions } from '../store/useAppSelector';
import { X, Loader2 } from 'lucide-react';
import { updateTask, fetchDoc, updateDoc, createDoc } from '../api';
import type { BasicHistoryEntry, Task } from '../types';

interface ReleaseModalProps {
  tasks: Task[];
  onClose: () => void;
}

export function ReleaseModal({ tasks: initialTasks, onClose }: ReleaseModalProps) {
  const { triggerRefresh } = useAppActions();
  const config = useAppSelector((s) => s.config);
  const currentUser = useAppSelector((s) => s.currentUser);
  const [selectedTasks, setSelectedTasks] = useState<Set<string>>(new Set(initialTasks.map(t => t.id)));
  const [version, setVersion] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  const handleRelease = async () => {
    if (!version.trim() || selectedTasks.size === 0) return;
    setIsSubmitting(true);

    try {
      const releaseSettings = config?.releaseSettings || {
        generateDistinctFiles: true,
        releaseNotesPath: 'release-notes'
      };

      const tasksToRelease = initialTasks.filter(t => selectedTasks.has(t.id));
      
      // Generate release notes
      let notes = `## Release ${version}\n*Released at ${new Date().toISOString()}*\n\n### Tickets\n\n`;
      for (const t of tasksToRelease) {
        notes += `- **${t.id}**: ${t.title}\n`;
      }
      notes += '\n';

      const basePath = releaseSettings.releaseNotesPath.replace(/^\//, '').replace(/\/$/, '');
      let docRelativePath = '';
      let finalDocContent = notes;

      if (releaseSettings.generateDistinctFiles) {
        docRelativePath = `${basePath}/${version}`;
        await createDoc({
          path: `${docRelativePath}.md`,
          title: `Release ${version}`,
          body: notes,
        });
      } else {
        docRelativePath = `${basePath}/release_notes`;
        try {
          const existingDoc = await fetchDoc(`${docRelativePath}.md`);
          finalDocContent = notes + (existingDoc.body || '');
          await updateDoc(`${docRelativePath}.md`, { body: finalDocContent });
        } catch {
          await createDoc({
            path: `${docRelativePath}.md`,
            title: 'Release Notes',
            body: notes,
          });
        }
      }

      const releasedAt = new Date().toISOString();

      // Update tasks
      await Promise.all(
        tasksToRelease.map(t => {
          const releaseEntry: BasicHistoryEntry = {
            type: 'status_change',
            from: t.status,
            to: 'Released',
            user: currentUser,
            date: releasedAt,
          };
          const newHistory = [...(t.history || []), releaseEntry];

          return updateTask(t.id, {
            status: 'Released',
            version,
            releasedAt,
            releaseDocPath: docRelativePath,
            history: newHistory,
            updatedBy: currentUser,
          });
        })
      );

      triggerRefresh();
      onClose();
    } catch (err) {
      console.error('Failed to orchestrate release from UI:', err);
      alert('Failed to release tasks. Check console for details.');
    } finally {
      setIsSubmitting(false);
    }
  };

  const toggleTask = (id: string) => {
    setSelectedTasks(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm animate-in fade-in duration-200">
      <div 
        className="w-full max-w-lg bg-white dark:bg-[#1a1b23] border border-gray-200 dark:border-white/10 rounded-2xl shadow-xl flex flex-col max-h-[85vh] animate-in zoom-in-95 duration-200"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100 dark:border-white/5 shrink-0">
          <h2 className="text-lg font-bold text-gray-900 dark:text-gray-100">Create Release</h2>
          <button 
            onClick={onClose}
            className="p-2 -mr-2 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 rounded-lg hover:bg-gray-100 dark:hover:bg-white/5"
            disabled={isSubmitting}
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-6 overflow-y-auto flex-1 space-y-6">
          <div className="space-y-2">
            <label className="block text-sm font-bold text-gray-700 dark:text-gray-300">Version Label</label>
            <input 
              autoFocus
              value={version}
              onChange={e => setVersion(e.target.value)}
              placeholder="e.g. v1.2.0"
              disabled={isSubmitting}
              className="w-full bg-gray-50 dark:bg-black/20 border border-gray-200 dark:border-white/10 rounded-xl px-4 py-2.5 outline-none focus:border-primary text-sm transition-colors"
            />
          </div>

          <div className="space-y-3">
            <div className="flex items-center justify-between text-sm">
              <label className="font-bold text-gray-700 dark:text-gray-300">Select tickets for release</label>
              <span className="text-gray-500 font-medium">{selectedTasks.size} of {initialTasks.length} selected</span>
            </div>
            
            <div className="border border-gray-100 dark:border-white/5 rounded-xl divide-y divide-gray-100 dark:divide-white/5 overflow-hidden">
              {initialTasks.map(t => (
                <label 
                  key={t.id} 
                  className={`flex items-start gap-3 p-3 cursor-pointer transition-colors ${
                    selectedTasks.has(t.id) 
                      ? 'bg-primary/5 hover:bg-primary/10' 
                      : 'hover:bg-gray-50 dark:hover:bg-white/5'
                  }`}
                >
                  <input 
                    type="checkbox"
                    checked={selectedTasks.has(t.id)}
                    onChange={() => toggleTask(t.id)}
                    disabled={isSubmitting}
                    className="mt-1 cursor-pointer"
                  />
                  <div className="min-w-0 flex-1">
                    <div className="font-bold text-sm text-gray-900 dark:text-gray-100 truncate">
                      {t.id}
                    </div>
                    <div className="text-xs text-gray-500 truncate mt-0.5">
                      {t.title}
                    </div>
                  </div>
                </label>
              ))}
            </div>
          </div>
        </div>

        <div className="p-6 border-t border-gray-100 dark:border-white/5 bg-gray-50 dark:bg-black/10 shrink-0 flex justify-end gap-3 rounded-b-2xl">
          <button
            onClick={onClose}
            disabled={isSubmitting}
            className="px-4 py-2 text-sm font-bold text-gray-600 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-white/10 transition-colors rounded-xl"
          >
            Cancel
          </button>
          <button
            onClick={handleRelease}
            disabled={isSubmitting || !version.trim() || selectedTasks.size === 0}
            className="flex items-center justify-center gap-2 min-w-[120px] px-4 py-2 bg-primary hover:bg-primary-hover text-white text-sm font-bold transition-colors rounded-xl disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {isSubmitting ? (
              <><Loader2 className="w-4 h-4 animate-spin" /> Releasing...</>
            ) : (
              'Release Tickets'
            )}
          </button>
        </div>
      </div>
    </div>
  );
}