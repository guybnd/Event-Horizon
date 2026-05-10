import { useEffect, useRef, useState } from 'react';
import { Bot, ChevronDown } from 'lucide-react';

const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
type EffortLevel = typeof EFFORT_LEVELS[number];

interface Props {
  /** Called when the main button or an effort option is clicked. */
  onLaunch: (effortOverride?: EffortLevel) => void;
  disabled?: boolean;
  busy?: boolean;
  /** Visual size variant */
  size?: 'sm' | 'md';
}

export function LaunchAgentSplitButton({ onLaunch, disabled, busy, size = 'md' }: Props) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);

  const isDisabled = disabled || busy;

  if (size === 'sm') {
    return (
      <div ref={containerRef} className="relative flex">
        <button
          type="button"
          disabled={isDisabled}
          onClick={() => onLaunch()}
          className="flex items-center gap-1.5 rounded-l-md bg-gray-900 px-3 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-gray-700 disabled:opacity-50 dark:bg-white/10 dark:hover:bg-white/20"
        >
          <Bot className="h-3.5 w-3.5" />
          {busy ? 'Starting…' : 'Launch Agent'}
        </button>
        <button
          type="button"
          disabled={isDisabled}
          onClick={() => setOpen((v) => !v)}
          className="flex items-center justify-center rounded-r-md border-l border-white/20 bg-gray-900 px-1.5 py-1.5 text-xs text-white transition-colors hover:bg-gray-700 disabled:opacity-50 dark:bg-white/10 dark:border-white/10 dark:hover:bg-white/20"
          aria-label="Choose effort level"
        >
          <ChevronDown className="h-3 w-3" />
        </button>
        {open && (
          <div className="absolute right-0 top-full z-50 mt-1 min-w-[130px] rounded-xl border border-gray-200 bg-white py-1 shadow-xl dark:border-white/10 dark:bg-[#1e1f2a]">
            <div className="px-3 py-1 text-[10px] font-bold uppercase tracking-wider text-gray-400">Effort override</div>
            {EFFORT_LEVELS.map((lvl) => (
              <button
                key={lvl}
                type="button"
                onClick={() => { setOpen(false); onLaunch(lvl); }}
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-gray-700 transition-colors hover:bg-gray-100 dark:text-gray-200 dark:hover:bg-white/5"
              >
                {lvl}
              </button>
            ))}
          </div>
        )}
      </div>
    );
  }

  // md variant — used in the sidebar panel
  return (
    <div ref={containerRef} className="relative flex">
      <button
        type="button"
        disabled={isDisabled}
        onClick={() => onLaunch()}
        className="flex flex-1 items-center justify-center gap-1.5 rounded-l-lg bg-primary px-3 py-2 text-xs font-semibold text-white transition-colors hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-50"
      >
        <Bot className="h-4 w-4" />
        {busy ? 'Starting…' : 'Launch'}
      </button>
      <button
        type="button"
        disabled={isDisabled}
        onClick={() => setOpen((v) => !v)}
        className="flex items-center justify-center rounded-r-lg border-l border-white/20 bg-primary px-2 py-2 text-white transition-colors hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-50"
        aria-label="Choose effort level"
      >
        <ChevronDown className="h-3.5 w-3.5" />
      </button>
      {open && (
        <div className="absolute right-0 top-full z-50 mt-1 min-w-[130px] rounded-xl border border-gray-200 bg-white py-1 shadow-xl dark:border-white/10 dark:bg-[#1e1f2a]">
          <div className="px-3 py-1 text-[10px] font-bold uppercase tracking-wider text-gray-400">Effort override</div>
          {EFFORT_LEVELS.map((lvl) => (
            <button
              key={lvl}
              type="button"
              onClick={() => { setOpen(false); onLaunch(lvl); }}
              className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-gray-700 transition-colors hover:bg-gray-100 dark:text-gray-200 dark:hover:bg-white/5"
            >
              {lvl}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
