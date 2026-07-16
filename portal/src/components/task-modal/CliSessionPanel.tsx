import { CircleDot, Square, Bot } from 'lucide-react';
import { LaunchAgentSplitButton } from '../LaunchAgentSplitButton';
import { FrameworkSelector } from '../FrameworkSelector';
import type { CliFramework, CliSessionSummary, Config } from '../../types';
import { TokenBadge } from '../TokenBadge';
import { FRAMEWORK_ICONS } from '../../constants';

interface CliSessionPanelProps {
  cliSession: CliSessionSummary | null;
  cliSessionBusy: boolean;
  cliSessionError: string;
  selectedCliFramework: CliFramework;
  setSelectedCliFramework: (v: CliFramework) => void;
  skipPermissions: boolean;
  setSkipPermissions: (v: boolean) => void;
  sessionIsActive: boolean;
  liveOutputRef: React.RefObject<HTMLPreElement | null>;
  config: Config | null;
  tokenMetadata: { inputTokens?: number; outputTokens?: number; costUSD?: number; costIsEstimated?: boolean; cacheReadTokens?: number; cacheCreationTokens?: number } | undefined;
  onLaunch: (effortOverride?: string) => void;
  onStop: () => void;
  onToggleDisplayMode?: () => void;
}

export function CliSessionPanel({
  cliSession, cliSessionBusy, cliSessionError,
  selectedCliFramework, setSelectedCliFramework,
  skipPermissions, setSkipPermissions,
  sessionIsActive, liveOutputRef, config, tokenMetadata,
  onLaunch, onStop, onToggleDisplayMode,
}: CliSessionPanelProps) {
  const ActiveIcon = FRAMEWORK_ICONS[selectedCliFramework] || Bot;

  return (
    <div className="space-y-3 rounded-xl border border-gray-100 bg-gray-50 p-3 dark:border-white/5 dark:bg-black/20">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <p className="text-xs font-bold uppercase tracking-wider text-gray-400">Agent Session</p>
          {cliSession?.role && (
            <span className="rounded-full bg-violet-100 px-1.5 py-0.5 text-[9px] font-semibold text-violet-700 dark:bg-violet-500/10 dark:text-violet-300">
              {cliSession.role.replace(/^reviewer:/, '')}
            </span>
          )}
        </div>
        {cliSession && (
          <span className="inline-flex items-center gap-1 rounded-full bg-gray-200 px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-gray-700 dark:bg-white/10 dark:text-gray-300">
            <CircleDot className="h-3 w-3" />
            {cliSession.status}
          </span>
        )}
      </div>

      <div className="flex gap-2">
        <FrameworkSelector
          value={selectedCliFramework}
          onChange={(v) => setSelectedCliFramework(v as CliFramework)}
          disabled={sessionIsActive || cliSessionBusy}
          allowedFrameworks={['claude', 'gemini', 'copilot']}
        />
        <LaunchAgentSplitButton
          size="md"
          busy={cliSessionBusy}
          disabled={sessionIsActive}
          onLaunch={onLaunch}
          icon={ActiveIcon}
        />
        <button
          type="button"
          disabled={cliSessionBusy || !cliSession || !['pending', 'running', 'waiting-input'].includes(cliSession.status)}
          onClick={onStop}
          className="flex items-center justify-center gap-1.5 rounded-lg border border-gray-300 px-3 py-2 text-xs font-semibold text-gray-700 transition-colors hover:bg-gray-100 disabled:cursor-not-allowed disabled:opacity-50 dark:border-white/10 dark:text-gray-200 dark:hover:bg-white/5"
        >
          <Square className="h-4 w-4" />
          Stop
        </button>
      </div>

      <label className="flex cursor-pointer items-center gap-2">
        <input
          type="checkbox"
          checked={skipPermissions}
          onChange={(e) => setSkipPermissions(e.target.checked)}
          disabled={sessionIsActive}
          className="rounded"
        />
        <span className="text-xs text-gray-600 dark:text-gray-400">Skip permission prompts (run freely)</span>
      </label>

      {cliSession?.blockedReason && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 dark:border-amber-500/20 dark:bg-amber-500/10">
          <p className="text-xs font-semibold text-amber-700 dark:text-amber-300">Agent blocked — waiting for permission</p>
          <p className="mt-0.5 text-[11px] text-amber-600 dark:text-amber-400">{cliSession.blockedReason}</p>
        </div>
      )}

      {cliSession?.disallowedEhTools && cliSession.disallowedEhTools.length > 0 && (
        <details className="rounded-lg border border-gray-200 bg-white px-3 py-2 text-xs dark:border-white/10 dark:bg-white/5">
          <summary className="cursor-pointer select-none font-semibold text-gray-500 dark:text-gray-400">
            Tool scoping — {cliSession.disallowedEhTools.length} MCP tool{cliSession.disallowedEhTools.length === 1 ? '' : 's'} disallowed
          </summary>
          <p className="mt-1.5 break-words text-[11px] leading-relaxed text-gray-500 dark:text-gray-400">
            {cliSession.disallowedEhTools.join(', ')}
          </p>
        </details>
      )}

      {cliSessionError && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700 dark:border-red-500/20 dark:bg-red-500/10 dark:text-red-300">
          {cliSessionError}
        </div>
      )}

      {cliSession?.liveOutput && (
        <div>
          <p className="mb-1 text-[10px] font-bold uppercase tracking-wider text-gray-400">Live Output</p>
          <pre
            ref={liveOutputRef}
            className="max-h-48 overflow-y-auto rounded-lg bg-gray-900 p-2 text-[10px] leading-relaxed text-gray-200 dark:bg-black/60 whitespace-pre-wrap break-words"
          >
            {cliSession.liveOutput}
          </pre>
        </div>
      )}

      {(cliSession != null || tokenMetadata) && (
        <div className="flex flex-wrap gap-3 text-[11px] text-gray-500 dark:text-gray-400">
          {cliSession != null && (
            <TokenBadge
              data={cliSession}
              config={config}
              variant="panel"
              label="Session"
              onToggle={onToggleDisplayMode}
            />
          )}
          {tokenMetadata && (
            <TokenBadge
              data={tokenMetadata}
              config={config}
              variant="panel"
              label="Ticket total"
              onToggle={onToggleDisplayMode}
            />
          )}
        </div>
      )}
    </div>
  );
}
