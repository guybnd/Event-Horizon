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
  it('reports all six skill modules', async () => {
    const m = await computeSkillModuleMetrics();
    expect(m.modules.length).toBe(6);
    expect(m.modules.map((x) => x.name).sort()).toEqual(
      ['grooming', 'implementation', 'mapping', 'orchestrator', 'release', 'review'].sort(),
    );
  });
});

describe('computeContextBudget', () => {
  it('combines payload + launch prompt + skills and totals them', async () => {
    const b = await computeContextBudget(task);
    expect(b.ticketId).toBe('FLUX-1');
    expect(b.agentPayload.totalTokensEst).toBeGreaterThan(0);
    expect(b.ehMeasurableTotalTokensEst).toBe(
      b.agentPayload.totalTokensEst + b.launchPrompt.totalTokensEst + b.skillModules.totalTokensEst,
    );
    expect(b.caveats.length).toBeGreaterThan(0);
  });
});
