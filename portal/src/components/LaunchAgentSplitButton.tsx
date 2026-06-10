import { Bot, type LucideIcon } from 'lucide-react';

interface Props {
  /** Called when the launch button is clicked. */
  onLaunch: () => void;
  disabled?: boolean;
  busy?: boolean;
  /** Visual size variant */
  size?: 'sm' | 'md';
  icon?: LucideIcon;
}

/**
 * Direct "Launch Agent" button used by the in-modal CLI session panel. Reasoning
 * effort is no longer chosen here — it lives in the orchestration launcher modal.
 */
export function LaunchAgentSplitButton({ onLaunch, disabled, busy, size = 'md', icon: Icon = Bot }: Props) {
  const isDisabled = disabled || busy;

  if (size === 'sm') {
    return (
      <button
        type="button"
        disabled={isDisabled}
        onClick={() => onLaunch()}
        className="eh-btn-accent flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
      >
        <Icon className="h-3.5 w-3.5" />
        {busy ? 'Starting…' : 'Launch Agent'}
      </button>
    );
  }

  // md variant — used in the sidebar panel
  return (
    <button
      type="button"
      disabled={isDisabled}
      onClick={() => onLaunch()}
      className="matrix-accent-button eh-btn-accent flex flex-1 items-center justify-center gap-1.5 rounded-lg px-3 py-2 text-xs font-semibold transition-colors cursor-pointer disabled:cursor-not-allowed disabled:opacity-50"
    >
      <Icon className="h-4 w-4" />
      {busy ? 'Starting…' : 'Launch'}
    </button>
  );
}
