import { useState, useEffect } from 'react';
import { Layers } from 'lucide-react';
import { fetchMcpPhases } from '../../api';

interface McpPhasesSectionProps {
  value: Record<string, string[]>;
  setValue: (v: Record<string, string[]>) => void;
}

const PHASE_COLORS: Record<string, string> = {
  grooming: 'bg-amber-600 text-white',
  implementation: 'bg-blue-600 text-white',
  review: 'bg-purple-600 text-white',
  release: 'bg-emerald-600 text-white',
};

export function McpPhasesSection({ value, setValue }: McpPhasesSectionProps) {
  const [servers, setServers] = useState<string[]>([]);
  const [phases, setPhases] = useState<string[]>([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    fetchMcpPhases()
      .then((c) => { setServers(c.servers); setPhases(c.phases); })
      .catch(() => {})
      .finally(() => setLoaded(true));
  }, []);

  const toggle = (server: string, phase: string) => {
    const cur = value[server] ?? [];
    const next = cur.includes(phase) ? cur.filter((p) => p !== phase) : [...cur, phase];
    const out = { ...value };
    if (next.length) out[server] = next; else delete out[server];
    setValue(out);
  };

  const strict = Object.keys(value).length > 0;

  return (
    <div>
      <div className="mb-2 flex items-center gap-2">
        <Layers className="h-4 w-4 text-gray-500" />
        <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100">MCP servers by phase</h3>
        <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${strict ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300' : 'bg-gray-100 text-gray-600 dark:bg-gray-500/10 dark:text-gray-400'}`}>
          {strict ? 'strict' : 'merge'}
        </span>
      </div>
      <p className="mb-4 text-xs text-gray-500">
        Scope MCP servers to the phases that need them — e.g. keep a heavy memory/search server out of grooming.
        No phases selected for a server = it loads in every phase (merge). Selecting any phase switches that spawn to
        strict mode (only the listed servers load; <code>.mcp.json</code>/global ignored). The <code>event-horizon</code> server always loads.
        Changes apply on Save.
      </p>

      {!loaded ? (
        <p className="text-xs text-gray-400">Loading servers…</p>
      ) : servers.length === 0 ? (
        <p className="text-xs text-gray-400">No MCP servers found in modules or .mcp.json.</p>
      ) : (
        <div className="space-y-2">
          {servers.map((server) => {
            const locked = server === 'event-horizon';
            return (
              <div key={server} className="flex items-center justify-between gap-3 rounded-lg border border-gray-100 px-3 py-2 dark:border-white/5">
                <span className="text-sm text-gray-700 dark:text-gray-200">
                  {server}
                  {locked && <span className="ml-1.5 text-[10px] text-gray-400">always loaded</span>}
                </span>
                <div className="flex flex-wrap gap-1.5">
                  {phases.map((phase) => {
                    const on = (value[server] ?? []).includes(phase);
                    return (
                      <button
                        key={phase}
                        type="button"
                        disabled={locked}
                        onClick={() => toggle(server, phase)}
                        className={`rounded-full px-2.5 py-1 text-[11px] font-medium transition-colors ${on ? (PHASE_COLORS[phase] ?? 'bg-gray-600 text-white') : 'bg-gray-100 text-gray-600 hover:bg-gray-200 dark:bg-white/5 dark:text-gray-400 dark:hover:bg-white/10'} ${locked ? 'cursor-not-allowed opacity-40' : ''}`}
                      >
                        {phase}
                      </button>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
