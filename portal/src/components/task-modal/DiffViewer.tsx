import { useEffect, useState } from 'react';
import { ArrowLeft } from 'lucide-react';
import { fetchTaskDiff } from '../../api';
import { DiffLines } from '../DiffLines';

interface DiffViewerProps {
  taskId: string;
  file: string;
  onBack: () => void;
}

export function DiffViewer({ taskId, file, onBack }: DiffViewerProps) {
  const [content, setContent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setContent(null);
    setError(null);
    fetchTaskDiff(taskId, file)
      .then((text) => {
        if (cancelled) return;
        if (text === null) setError('No diff stored for this ticket.');
        else setContent(text);
      })
      .catch((err) => {
        if (!cancelled) setError(err.message || 'Failed to load diff');
      });
    return () => { cancelled = true; };
  }, [taskId, file]);

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-3 border-b border-gray-200 px-6 py-3 dark:border-white/10">
        <button
          onClick={onBack}
          className="flex items-center gap-1 rounded-md px-2 py-1 text-xs text-gray-500 hover:bg-gray-100 hover:text-gray-700 dark:hover:bg-white/5 dark:hover:text-gray-200"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          Back to description
        </button>
        <span className="truncate font-mono text-xs text-gray-700 dark:text-gray-200">{file}</span>
      </div>
      <div className="flex-1 overflow-auto px-6 py-4">
        {error && <p className="text-xs text-red-500">{error}</p>}
        {!error && content === null && <p className="text-xs text-gray-400">Loading diff…</p>}
        {!error && content !== null && <DiffLines content={content} />}
      </div>
    </div>
  );
}
