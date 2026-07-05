/**
 * Shared pill-chip filter row (FLUX-1114) — lifted out of OperationsTab's local `ChipRow` so
 * EngineEventsTab's category filter (TerminalPanel.tsx) renders with the same markup/styling
 * instead of duplicating the inline button list.
 */
export function FilterChipRow<T extends string>({
  label,
  options,
  value,
  onChange,
}: {
  label?: string;
  options: readonly T[];
  value: T;
  onChange: (v: T) => void;
}) {
  return (
    <div className="flex items-center gap-1.5 flex-wrap" aria-label={label}>
      {options.map(o => (
        <button
          key={o}
          onClick={() => onChange(o)}
          className={`px-2.5 py-0.5 rounded-full text-[10px] font-semibold transition-colors cursor-pointer border ${
            value === o
              ? 'border-[var(--eh-accent)] text-[var(--eh-accent)] bg-[var(--eh-accent-glow)]'
              : 'border-transparent text-gray-500 hover:text-gray-300'
          }`}
        >
          {o}
        </button>
      ))}
    </div>
  );
}
