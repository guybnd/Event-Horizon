import { describe, it, expect } from 'vitest';
import { matchGatePolicyPreset, countGatePolicyOverrides, GATE_POLICY_PRESETS } from './gatePolicyPresets';
import type { Task } from '../types';

function makeTask(overrides: Partial<Task> = {}): Task {
  return { id: 'FLUX-1', status: 'Todo', ...overrides } as Task;
}

describe('matchGatePolicyPreset (FLUX-1264)', () => {
  it('matches Manual (you/you)', () => {
    expect(matchGatePolicyPreset({ plan: 'you', review: 'you' })).toBe('manual');
  });

  it('matches Guided (auto-then-you/auto-then-you)', () => {
    expect(matchGatePolicyPreset({ plan: 'auto-then-you', review: 'auto-then-you' })).toBe('guided');
  });

  it('matches Autonomous (auto/auto)', () => {
    expect(matchGatePolicyPreset({ plan: 'auto', review: 'auto' })).toBe('autonomous');
  });

  it('returns null for a custom mix that matches no preset', () => {
    expect(matchGatePolicyPreset({ plan: 'auto', review: 'you' })).toBeNull();
  });

  it('returns null when boardDefault is missing entirely', () => {
    expect(matchGatePolicyPreset(undefined)).toBeNull();
    expect(matchGatePolicyPreset(null)).toBeNull();
  });

  it('the preset table matches the resolved parent-epic values exactly', () => {
    expect(GATE_POLICY_PRESETS.manual).toEqual({ plan: 'you', review: 'you' });
    expect(GATE_POLICY_PRESETS.guided).toEqual({ plan: 'auto-then-you', review: 'auto-then-you' });
    expect(GATE_POLICY_PRESETS.autonomous).toEqual({ plan: 'auto', review: 'auto' });
  });
});

describe('countGatePolicyOverrides (FLUX-1264)', () => {
  it('is 0 with no tasks or an empty list', () => {
    expect(countGatePolicyOverrides(undefined)).toBe(0);
    expect(countGatePolicyOverrides([])).toBe(0);
  });

  it('ignores tasks with no override', () => {
    expect(countGatePolicyOverrides([makeTask(), makeTask({ id: 'FLUX-2' })])).toBe(0);
  });

  it('counts a task overriding just one gate', () => {
    const tasks = [makeTask({ gatePolicyOverride: { plan: 'auto' } })];
    expect(countGatePolicyOverrides(tasks)).toBe(1);
  });

  it('counts a task overriding both gates once, not twice', () => {
    const tasks = [makeTask({ gatePolicyOverride: { plan: 'auto', review: 'you' } })];
    expect(countGatePolicyOverrides(tasks)).toBe(1);
  });

  it('counts multiple diverging tickets, skipping non-overriding ones', () => {
    const tasks = [
      makeTask({ id: 'FLUX-1', gatePolicyOverride: { review: 'auto' } }),
      makeTask({ id: 'FLUX-2' }),
      makeTask({ id: 'FLUX-3', gatePolicyOverride: { plan: 'you' } }),
    ];
    expect(countGatePolicyOverrides(tasks)).toBe(2);
  });

  it('ignores an empty override object (no gate actually set)', () => {
    const tasks = [makeTask({ gatePolicyOverride: {} })];
    expect(countGatePolicyOverrides(tasks)).toBe(0);
  });
});
