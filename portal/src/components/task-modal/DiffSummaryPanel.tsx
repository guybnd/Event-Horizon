import type { Task } from '../../types';

interface DiffSummaryPanelProps {
  task: Partial<Task>;
  onFileClick: (file: string) => void;
}

export function DiffSummaryPanel({ task, onFileClick }: DiffSummaryPanelProps) {
  const summary = task.diffSummary;
  if (!summary || summary.length === 0) return null;

  const totalAdditions = summary.reduce((acc, f) => acc + f.additions, 0);
  const totalDeletions = summary.reduce((acc, f) => acc + f.deletions, 0);

  return (
    <div>
      <p className="text-xs font-bold uppercase tracking-wider text-gray-400">Changes</p>
      <div className="mt-1.5 rounded-lg border border-gray-100 bg-gray-50 dark:border-white/5 dark:bg-black/10">
        <div className="flex gap-3 border-b border-gray-100 px-3 py-1.5 text-xs text-gray-500 dark:border-white/5 dark:text-gray-400">
          <span>{summary.length} file{summary.length !== 1 ? 's' : ''}</span>
          <span className="text-emerald-600 dark:text-emerald-400">+{totalAdditions}</span>
          <span className="text-red-500 dark:text-red-400">−{totalDeletions}</span>
        </div>
        <ul className="max-h-40 overflow-y-auto py-1">
          {summary.map((f) => (
            <li key={f.file}>
              <button
                onClick={() => onFileClick(f.file)}
                className="flex w-full items-center justify-between gap-2 px-3 py-1 text-left hover:bg-gray-100 dark:hover:bg-white/5"
              >
                <span className="truncate font-mono text-[11px] text-gray-700 dark:text-gray-300">{f.file}</span>
                <span className="shrink-0 text-[10px]">
                  <span className="text-emerald-600 dark:text-emerald-400">+{f.additions}</span>
                  {' '}
                  <span className="text-red-500 dark:text-red-400">−{f.deletions}</span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
