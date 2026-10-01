// FLUX-1739: the Benchmark Analyst persona — the assertions SMELTER_PERSONA already carries, plus
// the constraints that keep the report deterministic.
import { describe, it, expect } from 'vitest';
import { getPersonaById, listSelectablePersonaMeta, BENCHMARK_ANALYST_PERSONA } from './orchestration-personas.js';

describe('benchmark-analyst persona', () => {
  it('resolves by id', () => {
    const p = getPersonaById('benchmark-analyst');
    expect(p).toBeDefined();
    expect(p!.id).toBe('benchmark-analyst');
  });

  it('is a lead — never EH-tool-scoped, never contract-composed', () => {
    expect(BENCHMARK_ANALYST_PERSONA.role).toBe('lead');
    expect(BENCHMARK_ANALYST_PERSONA.phases).toEqual([]);
    expect(BENCHMARK_ANALYST_PERSONA.requiredCapabilities).toEqual([]);
  });

  it('is NOT selectable — it is dispatched by the runner, not chosen or delegated to', () => {
    expect(listSelectablePersonaMeta().some((p) => p.id === 'benchmark-analyst')).toBe(false);
  });

  it('forbids producing numbers, which is what keeps the report deterministic', () => {
    const prompt = BENCHMARK_ANALYST_PERSONA.prompt;
    expect(prompt).toMatch(/never state an L1\/L2\/L3 number/i);
    expect(prompt).toMatch(/reproducible without you/i);
  });

  it('requires a runId and an evidence locator on every claim', () => {
    expect(BENCHMARK_ANALYST_PERSONA.prompt).toMatch(/runId.*evidence locator/is);
    expect(BENCHMARK_ANALYST_PERSONA.prompt).toMatch(/uncited claim/i);
  });

  it('grants no ticket filing — it proposes, a human promotes', () => {
    expect(BENCHMARK_ANALYST_PERSONA.prompt).toMatch(/never file a ticket/i);
    expect(BENCHMARK_ANALYST_PERSONA.prompt).toMatch(/a human promotes/i);
  });

  it('stores dissent beside a computed grade rather than replacing it', () => {
    expect(BENCHMARK_ANALYST_PERSONA.prompt).toMatch(/never replaces it/i);
  });

  it('tells the reader a single seed is a single data point', () => {
    expect(BENCHMARK_ANALYST_PERSONA.prompt).toMatch(/single data point/i);
  });
});
