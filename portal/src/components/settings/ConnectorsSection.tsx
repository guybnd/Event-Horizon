import { Plug, Terminal, Globe, RefreshCw, AlertTriangle } from 'lucide-react';
import { useConnectorStatuses } from './useConnectorStatuses';
import type { ConnectorStatus, ProbeResult } from '../../types';

function StatusDot({ probe, onRecheck }: { probe: ProbeResult | undefined; onRecheck: () => void }) {
  const status = probe?.status ?? 'unknown';

  const dot: Record<string, string> = {
    ok: 'bg-emerald-500',
    error: 'bg-red-500',
    checking: 'bg-amber-400 animate-pulse',
    unknown: 'bg-gray-300 dark:bg-gray-600',
  };

  const label: Record<string, string> = {
    ok: 'Authenticated',
    error: 'Failed',
    checking: 'Checking…',
    unknown: 'Not checked',
  };

  const labelColor: Record<string, string> = {
    ok: 'text-emerald-600 dark:text-emerald-400',
    error: 'text-red-500 dark:text-red-400',
    checking: 'text-amber-500 dark:text-amber-400',
    unknown: 'text-gray-400',
  };

  return (
    <div className="flex items-center gap-1.5">
      <span className={`inline-block h-2 w-2 rounded-full shrink-0 ${dot[status]}`} title={probe?.message || status} />
      <span className={`text-[10px] font-semibold ${labelColor[status]}`}>{label[status]}</span>
      <button
        onClick={(e) => { e.stopPropagation(); onRecheck(); }}
        title="Test connection"
        className="rounded p-0.5 text-gray-300 hover:text-gray-500 dark:hover:text-gray-300 transition-colors"
      >
        <RefreshCw className="h-3 w-3" />
      </button>
    </div>
  );
}

function SourceBadge({ source }: { source: ConnectorStatus['source'] }) {
  return (
    <span className="flex items-center gap-1 rounded-full bg-gray-100 px-2 py-0.5 text-[10px] font-semibold text-gray-600 dark:bg-white/10 dark:text-gray-400">
      {source === 'module' ? <Terminal className="h-2.5 w-2.5" /> : <Globe className="h-2.5 w-2.5" />}
      {source === 'module' ? 'Module' : 'Workspace'}
    </span>
  );
}

function EnvChip({ name, present }: { name: string; present: boolean }) {
  return (
    <span
      className={`rounded-full px-2 py-0.5 text-[10px] font-mono font-semibold ${
        present
          ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300'
          : 'bg-red-100 text-red-700 dark:bg-red-500/10 dark:text-red-300'
      }`}
    >
      {name} {present ? '✓' : '✗'}
    </span>
  );
}

function ConnectorCard({ connector, onRecheck }: { connector: ConnectorStatus; onRecheck: () => void }) {
  const probe = connector.probe;
  const missing = probe?.env?.missing ?? [];
  const needsRestart = probe?.status === 'error' && missing.length > 0;

  return (
    <div className="rounded-xl border border-gray-200 bg-white dark:border-white/10 dark:bg-black/10">
      <div className="flex items-start gap-3 px-4 py-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm font-semibold text-gray-900 dark:text-gray-100">{connector.name}</span>
            <StatusDot probe={probe} onRecheck={onRecheck} />
            <SourceBadge source={connector.source} />
          </div>

          {connector.requiredEnv.length > 0 && (
            <div className="mt-1.5 flex items-center gap-1.5 flex-wrap">
              {connector.requiredEnv.map((name) => (
                <EnvChip key={name} name={name} present={!missing.includes(name)} />
              ))}
            </div>
          )}

          {needsRestart && (
            <p className="mt-1.5 text-[11px] text-red-600 dark:text-red-400">
              Restart the engine to pick up new env vars — {missing.join(', ')} not present in the engine process.
            </p>
          )}
          {!needsRestart && probe?.status === 'error' && (
            <p className="mt-1.5 text-[11px] text-red-600 dark:text-red-400 font-mono whitespace-pre-wrap">
              {probe.upstreamStatus ? `HTTP ${probe.upstreamStatus} — ` : ''}{probe.message || 'Auth probe failed'}
            </p>
          )}

          <p className="mt-1 text-[10px] text-gray-400">
            {probe?.checkedAt ? `Last checked ${new Date(probe.checkedAt).toLocaleTimeString()}` : 'Not checked yet'}
          </p>
        </div>
      </div>
    </div>
  );
}

export function ConnectorsSection() {
  const { connectors, loading, recheck } = useConnectorStatuses();
  const needingRestart = connectors.filter((c) => c.probe?.status === 'error' && (c.probe?.env?.missing.length ?? 0) > 0);

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-base font-bold text-gray-800 dark:text-gray-200 mb-1">Connectors</h3>
        <p className="text-xs text-gray-500">
          Every configured external integration — module MCP servers and workspace <code className="font-mono">.mcp.json</code> servers —
          with a live auth check and required env var presence. Names only; values are never shown, logged, or sent anywhere.
        </p>
      </div>

      {needingRestart.length > 0 && (
        <div className="flex items-center gap-2 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 dark:border-amber-500/20 dark:bg-amber-500/10">
          <AlertTriangle className="h-4 w-4 shrink-0 text-amber-500" />
          <p className="text-xs text-amber-700 dark:text-amber-300">
            {needingRestart.length} connector{needingRestart.length > 1 ? 's' : ''} {needingRestart.length > 1 ? 'are' : 'is'} missing a required env var.
            If you set it after the engine started, restart the engine to pick it up.
          </p>
        </div>
      )}

      {loading ? (
        <p className="text-xs text-gray-400">Loading connectors…</p>
      ) : connectors.length === 0 ? (
        <div className="rounded-xl border border-dashed border-gray-200 dark:border-white/10 py-8 text-center">
          <Plug className="h-8 w-8 mx-auto text-gray-300 dark:text-gray-600 mb-2" />
          <p className="text-sm text-gray-400 dark:text-gray-500">No connectors configured yet.</p>
          <p className="text-xs text-gray-400 dark:text-gray-500 mt-1">Enable a module with an MCP server, or add one to this workspace's .mcp.json.</p>
        </div>
      ) : (
        <div className="space-y-2">
          {connectors.map((c) => (
            <ConnectorCard key={c.id} connector={c} onRecheck={() => recheck(c.id)} />
          ))}
        </div>
      )}
    </div>
  );
}
