import { useState, useRef, useEffect } from 'react';
import { ChevronDown, Bot, Zap, Code, Cloud, Terminal, Cpu, Layout } from 'lucide-react';

export type ExtendedFramework = 'auto' | 'claude' | 'gemini' | 'copilot' | 'cursor' | 'cline' | 'windsurf' | 'antigravity' | 'generic';

interface Props {
  value: string;
  onChange: (v: string) => void;
  disabled?: boolean;
  showAuto?: boolean;
  allowedFrameworks?: ExtendedFramework[];
}

const FRAMEWORKS: { id: ExtendedFramework; label: string; icon: any; color: string; description: string }[] = [
  { id: 'auto', label: 'Auto-Detect', icon: Cpu, color: 'text-gray-400', description: 'Detect based on workspace' },
  { id: 'claude', label: 'Claude Code', icon: Bot, color: 'text-orange-500', description: 'Anthropic\'s CLI agent' },
  { id: 'gemini', label: 'Gemini CLI', icon: Zap, color: 'text-blue-500', description: 'Google\'s CLI agent' },
  { id: 'copilot', label: 'Copilot CLI', icon: Terminal, color: 'text-purple-500', description: 'GitHub CLI extension' },
  { id: 'cursor', label: 'Cursor', icon: Code, color: 'text-cyan-500', description: 'AI Code Editor rules' },
  { id: 'cline', label: 'Cline', icon: Cloud, color: 'text-sky-500', description: 'VS Code Extension' },
  { id: 'windsurf', label: 'Windsurf', icon: Layout, color: 'text-emerald-500', description: 'AI Agent Editor' },
  { id: 'antigravity', label: 'Antigravity', icon: Zap, color: 'text-yellow-500', description: 'Custom agent framework' },
  { id: 'generic', label: 'Generic', icon: Terminal, color: 'text-gray-500', description: 'Standard markdown rules' },
];

export function FrameworkSelector({ value, onChange, disabled, showAuto, allowedFrameworks }: Props) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const available = FRAMEWORKS.filter(f => {
    if (!showAuto && f.id === 'auto') return false;
    if (allowedFrameworks && !allowedFrameworks.includes(f.id)) return false;
    return true;
  });
  const selected = available.find((f) => f.id === value) || available[0];
  const SelectedIcon = selected.icon;

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

  return (
    <div ref={containerRef} className="relative flex-1 min-w-0">
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen(!open)}
        className="flex w-full items-center justify-between gap-2 rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm font-medium transition-all hover:border-primary/50 focus:border-primary disabled:cursor-not-allowed disabled:opacity-60 dark:border-white/10 dark:bg-[#252630] dark:text-gray-100"
      >
        <div className="flex items-center gap-2 truncate">
          <SelectedIcon className={`h-4 w-4 shrink-0 ${selected.color}`} />
          <span className="truncate">{selected.label}</span>
        </div>
        <ChevronDown className={`h-4 w-4 shrink-0 text-gray-400 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>

      {open && (
        <div className="absolute left-0 right-0 top-full z-50 mt-1 max-h-[300px] overflow-y-auto rounded-xl border border-gray-200 bg-white py-1 shadow-xl dark:border-white/10 dark:bg-[#1e1f2a]">
          {available.map((f) => {
            const Icon = f.icon;
            const isSelected = f.id === value;
            return (
              <button
                key={f.id}
                type="button"
                onClick={() => {
                  onChange(f.id);
                  setOpen(false);
                }}
                className={`flex w-full items-center gap-3 px-3 py-2 text-left transition-colors hover:bg-gray-50 dark:hover:bg-white/5 ${
                  isSelected ? 'bg-primary/5 text-primary font-semibold dark:bg-primary/10' : 'text-gray-700 dark:text-gray-300'
                }`}
              >
                <Icon className={`h-4 w-4 shrink-0 ${f.color}`} />
                <div className="flex-1 min-w-0">
                  <div className="truncate text-sm">{f.label}</div>
                  <div className="truncate text-[10px] font-normal opacity-60">{f.description}</div>
                </div>
                {isSelected && (
                  <div className="h-1.5 w-1.5 rounded-full bg-primary" />
                )}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
