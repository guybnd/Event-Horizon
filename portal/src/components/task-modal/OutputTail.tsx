/**
 * FLUX-803: the shared live-output tail — a dark terminal `<pre>` that scrolls the last slice of a
 * session's streamed stdout. Single source of truth for both the Run View session rows
 * ({@link RunView}) and the chat orchestration surfaces ({@link ChatOrchestration}), so the chat
 * doesn't reinvent (or drift from) RunView's output styling. Pass `className` for caller-specific
 * spacing (e.g. RunView's row margins); the terminal look stays fixed in light + dark mode.
 */
export function OutputTail({ text, className = '', notice }: { text: string; className?: string; notice?: string }) {
  return (
    <div className={className}>
      {notice && (
        <p className="mb-1 px-0.5 text-[10px] italic text-gray-500 dark:text-gray-400">{notice}</p>
      )}
      <pre className="max-h-40 overflow-y-auto whitespace-pre-wrap break-words rounded-lg bg-gray-900 p-2 text-[10px] leading-relaxed text-gray-200 dark:bg-black/60">
        {text}
      </pre>
    </div>
  );
}
