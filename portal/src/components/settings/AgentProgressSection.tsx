interface AgentProgressSectionProps {
  agentProgressEnabled: boolean;
  setAgentProgressEnabled: (v: boolean) => void;
  agentProgressDelay: number;
  setAgentProgressDelay: (v: number) => void;
}

export function AgentProgressSection({
  agentProgressEnabled,
  setAgentProgressEnabled,
  agentProgressDelay,
  setAgentProgressDelay,
}: AgentProgressSectionProps) {
  return (
    <div className="rounded-2xl border border-gray-200 bg-gray-50/80 p-5 dark:border-white/10 dark:bg-black/10">
      <h3 className="text-base font-bold text-gray-800 dark:text-gray-200 mb-1">Agent Progress Display</h3>
      <p className="text-xs text-gray-500 mb-5">Control how AI agent activity is displayed on task cards.</p>

      <div className="mb-6">
        <label className="flex items-center gap-3 cursor-pointer">
          <input
            type="checkbox"
            checked={agentProgressEnabled}
            onChange={(e) => setAgentProgressEnabled(e.target.checked)}
            className="h-5 w-5 rounded border-gray-300 text-primary focus:ring-primary"
          />
          <div>
            <p className="text-sm font-semibold text-gray-800 dark:text-gray-200">Show AI progress on cards</p>
            <p className="text-xs text-gray-500">Display live agent activity and latest progress messages directly on task cards</p>
          </div>
        </label>
      </div>

      <div className={agentProgressEnabled ? '' : 'opacity-50 pointer-events-none'}>
        <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-gray-500">Progress Display Delay</label>
        <input
          type="range"
          min={0}
          max={10}
          value={agentProgressDelay}
          onChange={(e) => setAgentProgressDelay(parseInt(e.target.value, 10))}
          disabled={!agentProgressEnabled}
          className="w-full max-w-xs"
        />
        <p className="mt-1 text-sm text-gray-700 dark:text-gray-300">
          {agentProgressDelay === 0 ? 'Show immediately' : `Show after ${agentProgressDelay} second${agentProgressDelay > 1 ? 's' : ''}`}
        </p>
        <p className="mt-1 text-xs text-gray-500">How long to wait before displaying progress updates on cards</p>
      </div>
    </div>
  );
}
