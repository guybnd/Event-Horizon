import { useState } from 'react';
import { Activity, ChevronDown, ChevronRight, Info } from 'lucide-react';
import { fetchTaskContextBudget, fetchMcpSchemas, fetchSpawnServers, fetchMcpPhases, saveMcpPhases, type BudgetSection, type ContextBudget, type McpSchemaReport, type SpawnServersReport, type McpPhasesConfig } from '../../api';

function fmtTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

function Bars({ sections }: { sections: BudgetSection[] }) {
  return (
    <>
      {sections.map((s) => (
        <div key={s.name}>
          <div className="flex items-center justify-between text-gray-600 dark:text-gray-300">
            <span>{s.name}</span>
            <span>~{fmtTokens(s.tokensEst)} tok · {s.pct}%</span>
          </div>
          <div className="mt-0.5 h-1.5 w-full overflow-hidden rounded bg-gray-200 dark:bg-white/10">
            <div className="h-full rounded bg-primary/60" style={{ width: `${Math.min(100, s.pct)}%` }} />
          </div>
        </div>
      ))}
    </>
  );
}

function GroupHeading({ label, tokens }: { label: string; tokens: number }) {
  return (
    <div className="flex items-center justify-between pt-2 font-medium text-gray-500">
      <span className="uppercase tracking-wide">{label}</span>
      <span>~{fmtTokens(tokens)} tok</span>
    </div>
  );
}

/**
 * Debug panel: "where does this ticket's agent context go" — the get_ticket
 * payload, the launch prompt EH builds, and the fixed skill modules. Collapsed
 * by default; fetches on first expand. The data is from a separate debug
 * endpoint and never touches what an agent actually reads.
 */
export function PayloadSizePanel({ taskId }: { taskId: string }) {
  const [open, setOpen] = useState(false);
  const [budget, setBudget] = useState<ContextBudget | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ehToolsOpen, setEhToolsOpen] = useState(false);
  const [mcp, setMcp] = useState<McpSchemaReport | null>(null);
  const [mcpLoading, setMcpLoading] = useState(false);
  const [mcpError, setMcpError] = useState<string | null>(null);

  const probeMcp = () => {
    if (mcpLoading) return;
    setMcpLoading(true);
    setMcpError(null);
    fetchMcpSchemas()
      .then(setMcp)
      .catch(() => setMcpError('Probe failed'))
      .finally(() => setMcpLoading(false));
  };

  const [spawn, setSpawn] = useState<SpawnServersReport | null>(null);
  const [phasesCfg, setPhasesCfg] = useState<McpPhasesConfig | null>(null);
  const [draft, setDraft] = useState<Record<string, string[]>>({});
  const [savingPhases, setSavingPhases] = useState(false);

  const toggle = () => {
    const next = !open;
    setOpen(next);
    if (next && !budget && !loading) {
      setLoading(true);
      setError(null);
      fetchTaskContextBudget(taskId)
        .then(setBudget)
        .catch(() => setError('Failed to load context budget'))
        .finally(() => setLoading(false));
      fetchSpawnServers().then(setSpawn).catch(() => {});
      fetchMcpPhases().then((c) => { setPhasesCfg(c); setDraft(c.mcpServerPhases); }).catch(() => {});
    }
  };

  const togglePhase = (server: string, phase: string) => {
    setDraft((prev) => {
      const cur = prev[server] ?? [];
      const next = cur.includes(phase) ? cur.filter((p) => p !== phase) : [...cur, phase];
      const out = { ...prev };
      if (next.length) out[server] = next; else delete out[server];
      return out;
    });
  };

  const savePhases = () => {
    if (savingPhases) return;
    setSavingPhases(true);
    saveMcpPhases(draft)
      .then(() => Promise.all([fetchSpawnServers().then(setSpawn), fetchMcpPhases().then((c) => { setPhasesCfg(c); setDraft(c.mcpServerPhases); })]))
      .catch(() => {})
      .finally(() => setSavingPhases(false));
  };

  return (
    <div className="rounded-xl border border-gray-100 bg-gray-50 p-3 dark:border-white/5 dark:bg-black/10">
      <button
        type="button"
        onClick={toggle}
        className="flex w-full items-center gap-2 text-sm font-medium text-gray-700 dark:text-gray-200"
      >
        {open ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
        <Activity className="h-4 w-4" />
        Context budget
        {budget && <span className="ml-auto text-xs font-normal text-gray-500">~{fmtTokens(budget.ehMeasurableTotalTokensEst)} tok</span>}
      </button>

      {open && (
        <div className="mt-3 space-y-2 text-xs">
          {loading && <div className="text-gray-500">Measuring…</div>}
          {error && <div className="text-red-500">{error}</div>}
          {budget && (
            <>
              <div className="text-gray-500">
                EH-measurable static context: <span className="font-medium text-gray-700 dark:text-gray-200">~{fmtTokens(budget.ehMeasurableTotalTokensEst)} tok</span> (+ MCP schemas below). Excludes the host system prompt and live accumulation — see notes.
              </div>
              {budget.session?.inputTokens != null && (
                <div className="text-gray-500">
                  This session's actual input: <span className="font-medium text-gray-700 dark:text-gray-200">~{fmtTokens(budget.session.inputTokens)} tok</span>
                  {budget.session.cacheReadTokens != null && <> · {fmtTokens(budget.session.cacheReadTokens)} cache-read</>}
                  . The gap above is conversation + tool-result accumulation (host-only).
                </div>
              )}

              <GroupHeading label="get_ticket payload" tokens={budget.agentPayload.totalTokensEst} />
              <Bars sections={budget.agentPayload.sections} />
              {budget.agentPayload.historyBreakdown.map((h) => (
                <div key={h.name} className="flex items-center justify-between pl-2 text-gray-500">
                  <span>· {h.name} ({h.count})</span>
                  <span>~{fmtTokens(h.tokensEst)} tok</span>
                </div>
              ))}

              <GroupHeading label={`launch prompt${budget.launchPrompt.phase ? ` (${budget.launchPrompt.phase})` : ''}`} tokens={budget.launchPrompt.totalTokensEst} />
              <Bars sections={budget.launchPrompt.sections} />

              <GroupHeading label="skill modules · core (installed, every session)" tokens={budget.skillModules.coreTokensEst} />
              {budget.skillModules.modules.filter((m) => !m.name.includes('injected')).map((m) => (
                <div key={m.name} className="flex items-center justify-between text-gray-600 dark:text-gray-300">
                  <span>{m.name}{m.missing ? ' (missing)' : ''}</span>
                  <span>~{fmtTokens(m.tokensEst)} tok</span>
                </div>
              ))}
              {budget.skillModules.modules.some((m) => m.name.includes('injected')) && (
                <div className="pl-2 text-gray-400">The phase module is injected into the launch prompt above, not loaded separately — counted there only.</div>
              )}

              <button
                type="button"
                onClick={() => setEhToolsOpen((v) => !v)}
                className="flex w-full items-center justify-between pt-2 font-medium text-gray-500"
              >
                <span className="flex items-center gap-1 uppercase tracking-wide">
                  {budget.ehToolSchemas.ok && budget.ehToolSchemas.tools.length > 0 && (
                    ehToolsOpen ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />
                  )}
                  EH's own MCP tool schemas{budget.ehToolSchemas.ok ? ` (${budget.ehToolSchemas.toolCount} tools)` : ''}
                </span>
                <span>{budget.ehToolSchemas.ok ? `~${fmtTokens(budget.ehToolSchemas.totalTokensEst)} tok` : (budget.ehToolSchemas.error ?? 'failed')}</span>
              </button>
              {ehToolsOpen && budget.ehToolSchemas.ok && (
                <div className="space-y-0.5 pl-2">
                  {budget.ehToolSchemas.tools.map((t) => (
                    <div key={t.name} className="flex items-center justify-between text-gray-600 dark:text-gray-300">
                      <span>· {t.name}</span>
                      <span>~{fmtTokens(t.tokensEst)} tok</span>
                    </div>
                  ))}
                </div>
              )}

              {phasesCfg && (
                <>
                  <div className="flex items-center justify-between pt-2 font-medium text-gray-500">
                    <span className="uppercase tracking-wide">Scope servers by phase</span>
                    <button
                      type="button"
                      onClick={savePhases}
                      disabled={savingPhases}
                      className="rounded bg-primary/80 px-2 py-0.5 text-[11px] font-normal text-white hover:bg-primary disabled:opacity-50"
                    >
                      {savingPhases ? 'Saving…' : 'Save'}
                    </button>
                  </div>
                  <div className="text-gray-400">No boxes = loads everywhere (merge). Any box = that server loads only in checked phases (strict).</div>
                  {phasesCfg.servers.map((server) => {
                    const locked = server === 'event-horizon';
                    return (
                      <div key={server} className="flex items-center justify-between gap-2">
                        <span className="text-gray-600 dark:text-gray-300">{server}{locked ? ' (always)' : ''}</span>
                        <div className="flex gap-1">
                          {phasesCfg.phases.map((phase) => {
                            const on = (draft[server] ?? []).includes(phase);
                            return (
                              <button
                                key={phase}
                                type="button"
                                disabled={locked}
                                onClick={() => togglePhase(server, phase)}
                                title={phase}
                                className={`rounded px-1 py-0.5 text-[10px] ${on ? 'bg-primary/70 text-white' : 'bg-gray-200 text-gray-600 dark:bg-white/10 dark:text-gray-300'} ${locked ? 'opacity-40' : 'hover:bg-primary/40'}`}
                              >
                                {phase.slice(0, 3)}
                              </button>
                            );
                          })}
                        </div>
                      </div>
                    );
                  })}
                </>
              )}

              {spawn && (
                <>
                  <div className="flex items-center justify-between pt-2 font-medium text-gray-500">
                    <span className="uppercase tracking-wide">MCP servers per phase</span>
                    <span className="text-gray-400">{spawn.strict ? 'strict' : 'merge'}</span>
                  </div>
                  {Object.entries(spawn.phases).map(([phase, servers]) => (
                    <div key={phase} className="flex items-start justify-between gap-2 text-gray-600 dark:text-gray-300">
                      <span>{phase}</span>
                      <span className="text-right">{servers.length ? servers.join(', ') : '—'}</span>
                    </div>
                  ))}
                </>
              )}

              <div className="flex gap-1.5 pt-2 text-gray-400">
                <Info className="mt-0.5 h-3 w-3 shrink-0" />
                <ul className="space-y-0.5">
                  {budget.caveats.map((c) => (
                    <li key={c}>{c}</li>
                  ))}
                </ul>
              </div>

              <div className="flex items-center justify-between pt-2 font-medium text-gray-500">
                <span className="uppercase tracking-wide">MCP server schemas{mcp ? ` · ~${fmtTokens(mcp.totalTokensEst)} tok` : ''}</span>
                <button
                  type="button"
                  onClick={probeMcp}
                  disabled={mcpLoading}
                  className="rounded bg-gray-200 px-2 py-0.5 text-[11px] font-normal text-gray-700 hover:bg-gray-300 disabled:opacity-50 dark:bg-white/10 dark:text-gray-200 dark:hover:bg-white/20"
                >
                  {mcpLoading ? 'Probing…' : mcp ? 'Re-probe' : 'Probe (spawns servers)'}
                </button>
              </div>
              {mcpError && <div className="text-red-500">{mcpError}</div>}
              {mcp && mcp.servers.length === 0 && <div className="text-gray-500">{mcp.note}</div>}
              {mcp && mcp.servers.map((s) => (
                <div key={s.id} className="flex items-center justify-between text-gray-600 dark:text-gray-300">
                  <span>
                    {s.id}
                    <span className="text-gray-400"> · {s.source}</span>
                    {s.ok ? ` (${s.toolCount} tools${s.instructionsTokensEst ? ` +instr ${fmtTokens(s.instructionsTokensEst)}` : ''})` : ' (failed)'}
                  </span>
                  <span>{s.ok ? `~${fmtTokens(s.totalTokensEst)} tok` : (s.error ?? 'error')}</span>
                </div>
              ))}
            </>
          )}
        </div>
      )}
    </div>
  );
}
