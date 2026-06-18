import { useState } from 'react';
import { useAppSelector } from '../store/useAppSelector';
import { TaskCard } from './TaskCard';

function parseSemver(v: string): [number, number, number] {
  const match = v.replace(/^v/, '').match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!match) return [0, 0, 0];
  return [parseInt(match[1]), parseInt(match[2]), parseInt(match[3])];
}

function compareSemverDesc(a: string, b: string): number {
  const [aMaj, aMin, aPatch] = parseSemver(a);
  const [bMaj, bMin, bPatch] = parseSemver(b);
  if (bMaj !== aMaj) return bMaj - aMaj;
  if (bMin !== aMin) return bMin - aMin;
  return bPatch - aPatch;
}

export function ReleasesScreen() {
  const tasks = useAppSelector((s) => s.tasks);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  const releasedTasks = tasks.filter(t => t.status === 'Released');

  const releases = releasedTasks.reduce((acc, task) => {
    const v = task.version || 'Unversioned';
    if (!acc[v]) acc[v] = [];
    acc[v].push(task);
    return acc;
  }, {} as Record<string, typeof releasedTasks>);

  const sortedVersions = Object.keys(releases).sort(compareSemverDesc);

  function toggleCollapse(version: string) {
    setCollapsed(prev => {
      const next = new Set(prev);
      if (next.has(version)) next.delete(version);
      else next.add(version);
      return next;
    });
  }

  return (
    <div className="max-w-4xl mx-auto py-8">
      <h1 className="text-3xl font-bold mb-8 text-gray-900 dark:text-gray-100">Releases</h1>
      {sortedVersions.length === 0 ? (
        <div className="text-gray-500 dark:text-gray-400">No releases found.</div>
      ) : (
        <div className="space-y-4">
          {sortedVersions.map(version => {
            const versionTasks = releases[version];
            const firstTask = versionTasks[0];
            const releaseDate = firstTask?.releasedAt ? new Date(firstTask.releasedAt).toLocaleDateString() : '';
            const docPath = firstTask?.releaseDocPath;
            const isCollapsed = collapsed.has(version);

            return (
              <div key={version} className="border border-gray-200 dark:border-gray-800 rounded-lg bg-white dark:bg-gray-800/50">
                <div
                  className="flex items-center justify-between p-6 cursor-pointer select-none"
                  onClick={() => toggleCollapse(version)}
                >
                  <div className="flex items-center gap-3">
                    <svg
                      className={`w-5 h-5 text-gray-400 transition-transform duration-200 ${isCollapsed ? '-rotate-90' : ''}`}
                      fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}
                    >
                      <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
                    </svg>
                    <h2 className="text-2xl font-bold text-gray-800 dark:text-gray-200">{version}</h2>
                    <span className="text-sm text-gray-400 dark:text-gray-500">
                      {versionTasks.length} {versionTasks.length === 1 ? 'ticket' : 'tickets'}
                    </span>
                  </div>
                  <div className="flex items-center gap-4" onClick={e => e.stopPropagation()}>
                    {releaseDate && (
                      <span className="text-sm text-gray-500 dark:text-gray-400">Released on {releaseDate}</span>
                    )}
                    {docPath && (
                      <button
                        onClick={() => {
                          const url = new URL(window.location.href);
                          url.pathname = '/docs';
                          url.searchParams.set('doc', docPath);
                          window.history.pushState({}, '', url);
                          window.dispatchEvent(new CustomEvent('flux:navigate'));
                        }}
                        className="text-sm text-blue-600 dark:text-blue-400 hover:underline cursor-pointer"
                      >
                        View Release Notes
                      </button>
                    )}
                  </div>
                </div>
                {!isCollapsed && (
                  <div className="px-6 pb-6 grid grid-cols-1 md:grid-cols-2 gap-4">
                    {versionTasks.map(task => (
                      <TaskCard key={task.id} task={task} />
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
