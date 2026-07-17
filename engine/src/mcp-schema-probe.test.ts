import { describe, it, expect } from 'vitest';
import { probeMcpServer, probeModuleMcpSchemas, probeSelfMcpSchema } from './mcp-schema-probe.js';

describe('probeModuleMcpSchemas', () => {
  it('returns an empty, well-formed report when no module servers are active', async () => {
    const report = await probeModuleMcpSchemas();
    expect(Array.isArray(report.servers)).toBe(true);
    expect(report.servers.length).toBe(0);
    expect(report.totalTokensEst).toBe(0);
    expect(report.note).toMatch(/No module MCP servers/i);
  });
});

describe('probeMcpServer', () => {
  it('isolates failure when the server command does not exist', async () => {
    const r = await probeMcpServer('bogus', { command: 'eh-no-such-mcp-binary-xyz', args: [] }, 3000);
    expect(r.ok).toBe(false);
    expect(r.toolCount).toBe(0);
    expect(r.totalTokensEst).toBe(0);
    expect(r.error).toBeTruthy();
  }, 10000);
});

describe('probeSelfMcpSchema', () => {
  it('FLUX-1376: measures EH\'s own registered tool schemas in-process (no subprocess/network)', async () => {
    const r = await probeSelfMcpSchema();
    expect(r.ok).toBe(true);
    expect(r.id).toBe('event-horizon');
    expect(r.source).toBe('self');
    expect(r.toolCount).toBeGreaterThan(20);
    expect(r.toolsTokensEst).toBeGreaterThan(0);
    expect(r.tools.find((t) => t.name === 'get_ticket')).toBeTruthy();
    expect(r.totalTokensEst).toBe(r.toolsTokensEst + r.instructionsTokensEst);
  });

  it('FLUX-1434: a scoped worker persona drops a majority of the real registered tool-schema tokens', async () => {
    const { disallowedEhToolsForPersona } = await import('./orchestration-personas.js');
    const r = await probeSelfMcpSchema();
    const disallowed = new Set(disallowedEhToolsForPersona({ personaId: 'qa-correctness' }));
    expect(disallowed.size).toBeGreaterThan(0);
    const dropped = r.tools.filter((t) => disallowed.has(t.name));
    const kept = r.tools.filter((t) => !disallowed.has(t.name));
    const droppedTokens = dropped.reduce((s, t) => s + t.tokensEst, 0);
    const keptTokens = kept.reduce((s, t) => s + t.tokensEst, 0);
    // Every dropped name must be a real, currently-registered tool (catches CATEGORY_DENY_DEFAULTS drift).
    expect(dropped.length).toBe(disallowed.size);
    expect(kept.some((t) => t.name === 'get_ticket')).toBe(true);
    expect(kept.some((t) => t.name === 'add_note')).toBe(true);
    // The whole point of the ticket: a worker delegate's real schema bill drops materially.
    expect(droppedTokens).toBeGreaterThan(keptTokens);
    expect(droppedTokens / r.toolsTokensEst).toBeGreaterThan(0.5);
  });

  it('FLUX-1434: CATEGORY_DENY_DEFAULTS/NEVER_DENY (orchestration-personas.ts) name only real registered tools', async () => {
    // Drift guard for the hand-maintained deny-list constants — if a tool is renamed/removed in
    // mcp-server.ts without updating them, a stale name here would silently no-op (the CLI's
    // `--disallowed-tools` just never matches it) instead of failing loudly. Deliberately NOT a
    // full-coverage check (unlike the old ALL_EH_TOOL_NAMES-based version) — the deny-list model
    // fails OPEN by construction: a newly registered tool absent from both constants is simply
    // never scoped down for anyone, which is intentional, not drift.
    const { CATEGORY_DENY_DEFAULTS, NEVER_DENY } = await import('./orchestration-personas.js');
    const r = await probeSelfMcpSchema();
    const registeredNames = new Set(r.tools.map((t) => t.name));
    for (const t of [...CATEGORY_DENY_DEFAULTS.worker, ...CATEGORY_DENY_DEFAULTS.lead, ...CATEGORY_DENY_DEFAULTS.flex, ...NEVER_DENY]) {
      expect(registeredNames.has(t), t).toBe(true);
    }
  });

  it('FLUX-1434 savings guard: a worker delegate keeps a materially trimmed toolset', async () => {
    // Protects the FLUX-1376 token win from regressing back toward "everything granted" via an
    // ever-growing pile of persona.enableTools/dispatch.enableTools re-enables.
    const { disallowedEhToolsForPersona } = await import('./orchestration-personas.js');
    const disallowed = disallowedEhToolsForPersona({ personaId: 'context-scout', patternPosition: 'assistant' }) ?? [];
    expect(disallowed.length).toBeGreaterThanOrEqual(20);
  });

  it('FLUX-1468 description-diet budget: toolsBytes stays at or below the post-diet baseline + slack', async () => {
    // Locks in the FLUX-1468 tool-description diet so schema text can't silently regrow.
    // Pre-diet baseline (measured 2026-07-17, before this ticket): 37,369 bytes / 31 tools.
    // Post-diet (this ticket): 29,476 bytes — a real 21% cut of lore/rationale text out of tool
    // descriptions and param `.describe()` calls, moved to `read_skill('tools', '<tool>')`
    // (event-horizon-tools.md). The remaining ~14.3k bytes is JSON-schema STRUCTURE (property
    // names, types, enums, required arrays across ~180 fields) — not description text — and is
    // NOT reducible by this diet without deleting behavioral contract or schema shape, which the
    // ticket's own risk control forbids. That structural floor is why the ticket's ≥40% target
    // (which would require cutting ~65% of all description text, including single-clause params
    // like "Ticket ID") was not reachable while keeping every kept sentence genuinely contract-
    // shaped — see the FLUX-1468 completion comment for the full before/after breakdown.
    const POST_DIET_BASELINE_BYTES = 29_476;
    const SLACK_BYTES = 1_500; // headroom for legitimate new param/tool additions before this fails.
    const r = await probeSelfMcpSchema();
    expect(r.ok).toBe(true);
    expect(r.toolsBytes).toBeLessThanOrEqual(POST_DIET_BASELINE_BYTES + SLACK_BYTES);
  });
});
