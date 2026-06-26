/**
 * FLUX-803: the shared live-output tail — a dark terminal `<pre>` that scrolls the last slice of a
 * session's streamed stdout. Single source of truth for both the Run View session rows
 * ({@link RunView}) and the chat orchestration surfaces ({@link ChatOrchestration}), so the chat
 * doesn't reinvent (or drift from) RunView's output styling. Pass `className` for caller-specific
 * spacing (e.g. RunView's row margins); the terminal look stays fixed in light + dark mode.
 */
export function OutputTail({ text, className = '' }: { text: string; className?: string }) {
  return (
    <pre
      className={`max-h-40 overflow-y-auto whitespace-pre-wrap break-words rounded-lg bg-gray-900 p-2 text-[10px] leading-relaxed text-gray-200 dark:bg-black/60 ${className}`}
    >
      {text}
    </pre>
  );
}
