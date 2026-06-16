// Shared presentational renderer for a unified diff blob — used by the task-modal
// DiffViewer and the cross-worktree Changes panel (FLUX-530).

function classifyLine(line: string): string {
  if (line.startsWith('+++') || line.startsWith('---')) return 'text-gray-400';
  if (line.startsWith('@@')) return 'text-violet-600 dark:text-violet-400';
  if (line.startsWith('diff --git') || line.startsWith('index ')) return 'text-gray-500';
  if (line.startsWith('+')) return 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300';
  if (line.startsWith('-')) return 'bg-red-500/10 text-red-700 dark:text-red-300';
  return 'text-gray-700 dark:text-gray-300';
}

export function DiffLines({ content }: { content: string }) {
  const lines = content.split('\n');
  return (
    <pre className="whitespace-pre font-mono text-[11px] leading-relaxed">
      {lines.map((line, i) => (
        <div key={i} className={`${classifyLine(line)} px-2`}>{line || ' '}</div>
      ))}
    </pre>
  );
}
