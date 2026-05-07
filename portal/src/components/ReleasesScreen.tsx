import { useApp } from '../AppContext';
import { TaskCard } from './TaskCard';

export function ReleasesScreen() {
  const { tasks } = useApp();

  const releasedTasks = tasks.filter(t => t.status === 'Released');
  
  // Group by version
  const releases = releasedTasks.reduce((acc, task) => {
    const v = task.version || 'Unversioned';
    if (!acc[v]) acc[v] = [];
    acc[v].push(task);
    return acc;
  }, {} as Record<string, typeof releasedTasks>);

  // Sort versions descending (simple string sort for now, ideally semantic version sorting)
  const sortedVersions = Object.keys(releases).sort((a, b) => b.localeCompare(a));

  return (
    <div className="max-w-4xl mx-auto py-8">
      <h1 className="text-3xl font-bold mb-8 text-gray-900 dark:text-gray-100">Releases</h1>
      {sortedVersions.length === 0 ? (
        <div className="text-gray-500 dark:text-gray-400">No releases found.</div>
      ) : (
        <div className="space-y-12">
          {sortedVersions.map(version => {
            const versionTasks = releases[version];
            const firstTask = versionTasks[0];
            const releaseDate = firstTask?.releasedAt ? new Date(firstTask.releasedAt).toLocaleDateString() : '';
            const docPath = firstTask?.releaseDocPath;

            return (
              <div key={version} className="border border-gray-200 dark:border-gray-800 rounded-lg p-6 bg-white dark:bg-gray-800/50">
                <div className="flex items-center justify-between mb-4">
                  <h2 className="text-2xl font-bold text-gray-800 dark:text-gray-200">
                    {version}
                  </h2>
                  <div className="flex items-center gap-4">
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
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  {versionTasks.map(task => (
                    <TaskCard key={task.id} task={task} />
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
