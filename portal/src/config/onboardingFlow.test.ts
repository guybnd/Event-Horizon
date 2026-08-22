import { describe, it, expect } from 'vitest';
import rawFlow from './onboardingFlow.json';
import { validateFlow, visiblePages, type ConditionContext } from './onboardingFlow';

/**
 * FLUX-1683: the github-cli step must be present in the shipped flow, positioned
 * after pick-assistant, and visible under a default (no-condition) context —
 * it never blocks and is not conditioned off by default.
 */
describe('onboardingFlow — github-cli step', () => {
  const defaultCtx: ConditionContext = {
    storageMode: 'in-repo',
    assistant: 'claude',
    platform: 'linux',
    workspaceConfigured: true,
  };

  it('validateFlow(rawFlow) includes a github-cli page after pick-assistant', () => {
    const flow = validateFlow(rawFlow);
    const assistantIdx = flow.pages.findIndex((p) => p.widget === 'pick-assistant');
    const ghIdx = flow.pages.findIndex((p) => p.widget === 'github-cli');
    expect(assistantIdx).toBeGreaterThanOrEqual(0);
    expect(ghIdx).toBeGreaterThan(assistantIdx);
  });

  it('the github-cli page is a system, non-required, locked widget depending only on pick-folder', () => {
    const flow = validateFlow(rawFlow);
    const ghPage = flow.pages.find((p) => p.widget === 'github-cli');
    expect(ghPage).toBeDefined();
    expect(ghPage?.system).toBe(true);
    expect(ghPage?.required).toBe(false);
    expect(ghPage?.locked).toBe(true);
    expect(ghPage?.dependsOn).toEqual(['pick-folder']);
  });

  it('visiblePages keeps the github-cli page under a default context (never conditioned off)', () => {
    const flow = validateFlow(rawFlow);
    const visible = visiblePages(flow.pages, defaultCtx);
    expect(visible.some((p) => p.widget === 'github-cli')).toBe(true);
  });
});
