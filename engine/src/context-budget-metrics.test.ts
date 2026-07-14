import { describe, it, expect } from 'vitest';
import {
  computeLaunchPromptMetrics,
  computeSkillModuleMetrics,
  computeContextBudget,
} from './context-budget-metrics.js';

const task = {
  id: 'FLUX-1',
  title: 'A ticket',
  status: 'Todo',
  tags: ['alpha'],
  body: 'x'.repeat(200),
  history: [{ type: 'comment', user: 'Guy', comment: 'note' }],
};

describe('computeLaunchPromptMetrics', () => {
  it('derives phase and partitions the (no-body) launch prompt', () => {
    const m = computeLaunchPromptMetrics(task);
    expect(m.phase).toBe('implementation');
    expect(m.totalTokensEst).toBeGreaterThan(0);

    // FLUX-498: the body is no longer echoed in the launch prompt.
    expect(m.sections.find((s) => s.name === 'ticket body (echoed)')).toBeUndefined();

    // sections partition the total exactly (remainder = total - modules)
    const sumBytes = m.sections.reduce((s, x) => s + x.bytes, 0);
    expect(sumBytes).toBe(m.totalBytes);
  });
});

describe('computeSkillModuleMetrics', () => {
  it('FLUX-1377: reports the core plus the phase module, not all six modules', async () => {
    const m = await computeSkillModuleMetrics('implementation');
    expect(m.modules.length).toBe(2);
    expect(m.modules[0]!.name).toContain('core');
    expect(m.modules[1]!.name).toContain('implementation module');
    expect(m.coreTokensEst).toBeGreaterThan(0);
    expect(m.coreTokensEst).toBeLessThan(m.totalTokensEst);
    // The trimmed core stays well under the ~4k-token ceiling the ticket targets.
    expect(m.coreTokensEst).toBeLessThan(4000);
  });

  it('reports the core only when no phase module applies', async () => {
    const m = await computeSkillModuleMetrics(undefined);
    expect(m.modules.length).toBe(1);
    expect(m.totalTokensEst).toBe(m.coreTokensEst);
  });
});

describe('computeContextBudget', () => {
  it('combines payload + launch prompt + core (not core+module, already counted in launchPrompt) + EH tool schemas and totals them', async () => {
    const b = await computeContextBudget(task);
    expect(b.ticketId).toBe('FLUX-1');
    expect(b.agentPayload.totalTokensEst).toBeGreaterThan(0);
    expect(b.ehMeasurableTotalTokensEst).toBe(
      b.agentPayload.totalTokensEst +
        b.launchPrompt.totalTokensEst +
        b.skillModules.coreTokensEst +
        b.ehToolSchemas.totalTokensEst,
    );
    expect(b.caveats.length).toBeGreaterThan(0);
  });

  it('FLUX-1376: measures EH\'s own MCP tool schemas in-process, not a stale/hardcoded snapshot', async () => {
    const b = await computeContextBudget(task);
    expect(b.ehToolSchemas.ok).toBe(true);
    expect(b.ehToolSchemas.id).toBe('event-horizon');
    expect(b.ehToolSchemas.toolCount).toBeGreaterThan(20);
    expect(b.ehToolSchemas.totalTokensEst).toBeGreaterThan(0);
    // Per-tool breakdown, sorted heaviest-first, to target future description-diet work.
    expect(b.ehToolSchemas.tools.length).toBe(b.ehToolSchemas.toolCount);
    expect(b.ehToolSchemas.tools.some((t) => t.name === 'get_ticket')).toBe(true);
    for (let i = 1; i < b.ehToolSchemas.tools.length; i++) {
      expect(b.ehToolSchemas.tools[i - 1]!.bytes).toBeGreaterThanOrEqual(b.ehToolSchemas.tools[i]!.bytes);
    }
    // The old caveat citing the (now-Archived) FLUX-491/FLUX-481 as a measurement blocker is gone.
    expect(b.caveats.join(' ')).not.toMatch(/FLUX-491|FLUX-481/);
  });
});
