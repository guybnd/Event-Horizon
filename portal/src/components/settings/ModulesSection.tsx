import { useState, useEffect } from 'react';
import { Package, Plus, Trash2, ChevronDown, ChevronUp, Terminal, Sparkles, RefreshCw, ExternalLink } from 'lucide-react';
import { fetchModuleCatalog, fetchModuleStatuses, triggerModuleProbe, ehEventSourceUrl } from '../../api';
import type { ModuleDeclaration, ProbeResult } from '../../types';

interface ModulesSectionProps {
  modules: ModuleDeclaration[];
  setModules: (modules: ModuleDeclaration[]) => void;
}

function PhaseTag({ phase }: { phase: string }) {
  const colors: Record<string, string> = {
    implementation: 'bg-blue-100 text-blue-700 dark:bg-blue-500/10 dark:text-blue-300',
    review: 'bg-purple-100 text-purple-700 dark:bg-purple-500/10 dark:text-purple-300',
    grooming: 'bg-amber-100 text-amber-700 dark:bg-amber-500/10 dark:text-amber-300',
  };
  return (
    <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${colors[phase] ?? 'bg-gray-100 text-gray-600 dark:bg-gray-500/10 dark:text-gray-400'}`}>
      {phase}
    </span>
  );
}

function ProbeStatusDot({ result, onRecheck }: { result: ProbeResult | undefined; onRecheck: () => void }) {
  const status = result?.status ?? 'unknown';

  const dot: Record<string, string> = {
    ok: 'bg-emerald-500',
    error: 'bg-red-500',
    checking: 'bg-amber-400 animate-pulse',
    unknown: 'bg-gray-300 dark:bg-gray-600',
  };

  const label: Record<string, string> = {
    ok: 'Running',
    error: 'Failed',
    checking: 'Checking…',
    unknown: '',
  };

  const labelColor: Record<string, string> = {
    ok: 'text-emerald-600 dark:text-emerald-400',
    error: 'text-red-500 dark:text-red-400',
    checking: 'text-amber-500 dark:text-amber-400',
    unknown: 'text-gray-400',
  };

  return (
    <div className="flex items-center gap-1.5">
      <span className={`inline-block h-2 w-2 rounded-full shrink-0 ${dot[status]}`} title={result?.message || status} />
      {label[status] && (
        <span className={`text-[10px] font-semibold ${labelColor[status]}`}>{label[status]}</span>
      )}
      <button
        onClick={(e) => { e.stopPropagation(); onRecheck(); }}
        title="Re-check"
        className="rounded p-0.5 text-gray-300 hover:text-gray-500 dark:hover:text-gray-300 transition-colors"
      >
        <RefreshCw className="h-3 w-3" />
      </button>
    </div>
  );
}

function ModuleCard({
  module,
  probeResult,
  onToggle,
  onRemove,
  onRecheck,
}: {
  module: ModuleDeclaration;
  probeResult: ProbeResult | undefined;
  onToggle: () => void;
  onRemove: () => void;
  onRecheck: () => void;
}) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className={`rounded-xl border transition-colors ${module.enabled ? 'border-primary/30 bg-primary/5 dark:border-primary/20 dark:bg-primary/5' : 'border-gray-200 bg-white dark:border-white/10 dark:bg-black/10'}`}>
      <div className="flex items-center gap-3 px-4 py-3">
        {/* Toggle */}
        <button
          onClick={onToggle}
          title={module.enabled ? 'Disable module' : 'Enable module'}
          className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border-2 border-transparent transition-colors focus:outline-none ${module.enabled ? 'bg-primary' : 'bg-gray-300 dark:bg-white/20'}`}
        >
          <span className={`pointer-events-none inline-block h-4 w-4 rounded-full bg-white shadow-sm transition-transform ${module.enabled ? 'translate-x-4' : 'translate-x-0'}`} />
        </button>

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm font-semibold text-gray-900 dark:text-gray-100">{module.name}</span>
            {/* For MCP modules show probe status dot; for prompt-only show ACTIVE pill */}
            {module.enabled && module.mcpServer && (
              <ProbeStatusDot result={probeResult} onRecheck={onRecheck} />
            )}
            {module.enabled && !module.mcpServer && (
              <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-bold text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300">
                ACTIVE
              </span>
            )}
            {module.mcpServer && (
              <span className="flex items-center gap-1 rounded-full bg-gray-100 px-2 py-0.5 text-[10px] font-semibold text-gray-600 dark:bg-white/10 dark:text-gray-400">
                <Terminal className="h-2.5 w-2.5" />
                MCP
              </span>
            )}
            {module.promptFragment && (
              <span className="flex items-center gap-1 rounded-full bg-gray-100 px-2 py-0.5 text-[10px] font-semibold text-gray-600 dark:bg-white/10 dark:text-gray-400">
                <Sparkles className="h-2.5 w-2.5" />
                Prompt
              </span>
            )}
            {module.phases && module.phases.length > 0 && module.phases.map(p => <PhaseTag key={p} phase={p} />)}
          </div>
          <p className="mt-0.5 text-xs text-gray-500 dark:text-gray-400 truncate">{module.description}</p>
        </div>

        <div className="flex items-center gap-1 shrink-0">
          <button
            onClick={() => setExpanded(e => !e)}
            className="rounded-md p-1.5 text-gray-400 hover:bg-gray-100 hover:text-gray-600 dark:hover:bg-white/10 dark:hover:text-gray-300 transition-colors"
            title="Show details"
          >
            {expanded ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
          </button>
          <button
            onClick={onRemove}
            className="rounded-md p-1.5 text-gray-400 hover:bg-red-50 hover:text-red-500 dark:hover:bg-red-500/10 dark:hover:text-red-400 transition-colors"
            title="Remove from config"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      {expanded && (
        <div className="border-t border-gray-200 dark:border-white/10 px-4 py-3 space-y-2.5">
          {module.mcpServer && (
            <div>
              <div className="flex items-center justify-between mb-1">
                <div className="text-[10px] font-bold uppercase tracking-wider text-gray-400">MCP Server</div>
              </div>
              <code className="block rounded-md bg-gray-900 px-3 py-2 text-[11px] text-green-400 font-mono">
                {module.mcpServer.command} {module.mcpServer.args.join(' ')}
              </code>
              {probeResult?.status === 'error' && (
                <div className="mt-1.5 rounded-md bg-red-50 dark:bg-red-500/10 border border-red-200 dark:border-red-500/20 px-3 py-2.5 space-y-2">
                  {module.installDocs ? (
                    <>
                      <p className="text-[11px] font-semibold text-red-600 dark:text-red-400">
                        Server not found — installation required
                      </p>
                      <div className="space-y-1">
                        <p className="text-[11px] text-gray-500 dark:text-gray-400">
                          Requires: <span className="font-medium text-gray-700 dark:text-gray-300">{module.installDocs.requires}</span>
                          {module.installDocs.url && (
                            <a href={module.installDocs.url} target="_blank" rel="noreferrer"
                              className="ml-1.5 inline-flex items-center gap-0.5 text-primary hover:underline">
                              install guide <ExternalLink className="h-2.5 w-2.5" />
                            </a>
                          )}
                        </p>
                        <code className="block rounded bg-gray-900 px-2.5 py-1.5 text-[11px] text-green-400 font-mono">
                          {module.installDocs.command}
                        </code>
                      </div>
                    </>
                  ) : (
                    <p className="text-[11px] text-red-600 dark:text-red-400 font-mono whitespace-pre-wrap">
                      {probeResult.message || 'Server failed to start'}
                    </p>
                  )}
                </div>
              )}
              <p className="mt-1.5 text-[11px] text-gray-500">
                Injected into agent sessions automatically when enabled. Tools appear in the agent's tool list at session start.
              </p>
            </div>
          )}
          {module.promptFragment && (
            <div>
              <div className="text-[10px] font-bold uppercase tracking-wider text-gray-400 mb-1">Prompt Fragment</div>
              <pre className="rounded-md bg-gray-50 dark:bg-black/20 border border-gray-200 dark:border-white/10 px-3 py-2 text-[11px] text-gray-700 dark:text-gray-300 font-mono whitespace-pre-wrap max-h-24 overflow-y-auto">
                {module.promptFragment}
              </pre>
              <p className="mt-1.5 text-[11px] text-gray-500">
                Injected into the agent's initial prompt at session start.
                {module.phases && module.phases.length > 0 && ` Only active during: ${module.phases.join(', ')}.`}
              </p>
            </div>
          )}
          {module.conditions?.requireTags && module.conditions.requireTags.length > 0 && (
            <div>
              <div className="text-[10px] font-bold uppercase tracking-wider text-gray-400 mb-1">Required Tags</div>
              <p className="text-[11px] text-gray-500">Only active on tickets tagged: {module.conditions.requireTags.join(', ')}</p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function ModulesSection({ modules, setModules }: ModulesSectionProps) {
  const [catalog, setCatalog] = useState<ModuleDeclaration[]>([]);
  const [catalogLoading, setCatalogLoading] = useState(true);
  const [probeStatuses, setProbeStatuses] = useState<Record<string, import('../../types').ProbeResult>>({});

  // Initial status fetch
  useEffect(() => {
    fetchModuleStatuses()
      .then(setProbeStatuses)
      .catch(() => {});
  }, []);

  // SSE subscription for live probe status updates
  useEffect(() => {
    const es = new EventSource(ehEventSourceUrl('/events'));
    es.addEventListener('module-status', (e: MessageEvent) => {
      const { id, status, message, checkedAt } = JSON.parse(e.data) as { id: string; status: import('../../types').ProbeStatus; message: string; checkedAt: string };
      setProbeStatuses(prev => ({ ...prev, [id]: { status, message, checkedAt } }));
    });
    return () => es.close();
  }, []);

  useEffect(() => {
    fetchModuleCatalog()
      .then(setCatalog)
      .catch(console.error)
      .finally(() => setCatalogLoading(false));
  }, []);

  const configuredIds = new Set(modules.map(m => m.id));

  const toggle = (id: string) => {
    setModules(modules.map(m => m.id === id ? { ...m, enabled: !m.enabled } : m));
  };

  const remove = (id: string) => {
    setModules(modules.filter(m => m.id !== id));
  };

  const addFromCatalog = (template: ModuleDeclaration) => {
    setModules([...modules, { ...template, enabled: true }]);
  };

  const recheck = (id: string) => {
    setProbeStatuses(prev => ({ ...prev, [id]: { status: 'checking', message: 'Starting server process…', checkedAt: new Date().toISOString() } }));
    triggerModuleProbe(id).catch(() => {});
  };

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-base font-bold text-gray-800 dark:text-gray-200 mb-1">Agent Modules</h3>
        <p className="text-xs text-gray-500">
          Modules extend agent sessions with extra MCP tools and prompt context.
          Enable a module and save settings — MCP servers and prompt fragments are injected automatically at session start.
        </p>
      </div>

      {/* Configured modules */}
      <div>
        <div className="flex items-center justify-between mb-3">
          <h4 className="text-xs font-bold uppercase tracking-wider text-gray-500">Configured Modules ({modules.length})</h4>
        </div>
        {modules.length === 0 ? (
          <div className="rounded-xl border border-dashed border-gray-200 dark:border-white/10 py-8 text-center">
            <Package className="h-8 w-8 mx-auto text-gray-300 dark:text-gray-600 mb-2" />
            <p className="text-sm text-gray-400 dark:text-gray-500">No modules configured yet.</p>
            <p className="text-xs text-gray-400 dark:text-gray-500 mt-1">Add one from the catalog below.</p>
          </div>
        ) : (
          <div className="space-y-2">
            {modules.map(m => (
              <ModuleCard
                key={m.id}
                module={m}
                probeResult={probeStatuses[m.id]}
                onToggle={() => toggle(m.id)}
                onRemove={() => remove(m.id)}
                onRecheck={() => recheck(m.id)}
              />
            ))}
          </div>
        )}
      </div>

      {/* Catalog */}
      <div>
        <h4 className="text-xs font-bold uppercase tracking-wider text-gray-500 mb-3">
          Available from Catalog
        </h4>
        {catalogLoading ? (
          <p className="text-xs text-gray-400">Loading catalog…</p>
        ) : catalog.length === 0 ? (
          <p className="text-xs text-gray-400">No catalog items available.</p>
        ) : (
          <div className="space-y-2">
            {catalog.map(item => {
              const alreadyAdded = configuredIds.has(item.id);
              return (
                <div key={item.id} className="flex items-center gap-3 rounded-xl border border-gray-200 bg-gray-50/80 px-4 py-3 dark:border-white/10 dark:bg-black/10">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-sm font-semibold text-gray-900 dark:text-gray-100">{item.name}</span>
                      {item.mcpServer && (
                        <span className="flex items-center gap-1 rounded-full bg-gray-100 px-2 py-0.5 text-[10px] font-semibold text-gray-600 dark:bg-white/10 dark:text-gray-400">
                          <Terminal className="h-2.5 w-2.5" />
                          MCP
                        </span>
                      )}
                      {item.promptFragment && (
                        <span className="flex items-center gap-1 rounded-full bg-gray-100 px-2 py-0.5 text-[10px] font-semibold text-gray-600 dark:bg-white/10 dark:text-gray-400">
                          <Sparkles className="h-2.5 w-2.5" />
                          Prompt
                        </span>
                      )}
                      {item.phases && item.phases.length > 0 && item.phases.map(p => <PhaseTag key={p} phase={p} />)}
                    </div>
                    <p className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">{item.description}</p>
                  </div>
                  <button
                    onClick={() => addFromCatalog(item)}
                    disabled={alreadyAdded}
                    className={`shrink-0 flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold transition-colors ${alreadyAdded ? 'bg-gray-100 text-gray-400 cursor-not-allowed dark:bg-white/5 dark:text-gray-600' : 'bg-primary text-white hover:bg-primary-hover'}`}
                  >
                    <Plus className="h-3.5 w-3.5" />
                    {alreadyAdded ? 'Added' : 'Add'}
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
