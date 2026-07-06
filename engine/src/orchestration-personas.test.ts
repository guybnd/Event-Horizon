import { describe, it, expect, afterAll, vi } from 'vitest';
import fs from 'fs/promises';

// FLUX-1170: resolvePersonaPrompt composes a persona's lens with a shared
// per-phase contract. saveCustomPersona/deleteCustomPersona write real (small)
// files under the flux dir, so point it at a disposable temp path rather than
// the real workspace — mirrors the fixed-path mock convention used elsewhere
// in this test suite (see diff-prompt-injection.test.ts).
const TEST_FLUX_DIR = '/tmp/eh-orchestration-personas-test/.flux';

vi.mock('./workspace.js', () => ({
  getActiveFluxDir: () => TEST_FLUX_DIR,
}));

afterAll(async () => {
  await fs.rm('/tmp/eh-orchestration-personas-test', { recursive: true, force: true }).catch(() => {});
});

describe('resolvePersonaPrompt — phase contract composition (FLUX-1170)', () => {
  it('composes a built-in review persona with the review phase contract', async () => {
    const { resolvePersonaPrompt } = await import('./orchestration-personas.js');
    const prompt = resolvePersonaPrompt('senior-dev', undefined, 'review');
    expect(prompt).toContain('acting as a senior friendly developer');
    expect(prompt).toContain('Status decision');
    expect(prompt).toContain("reviewState: 'approved'");
  });

  it('omits the contract when no phase is given', async () => {
    const { resolvePersonaPrompt } = await import('./orchestration-personas.js');
    const prompt = resolvePersonaPrompt('senior-dev');
    expect(prompt).not.toContain('Status decision');
  });

  it('omits the contract for a phase with none defined', async () => {
    const { resolvePersonaPrompt } = await import('./orchestration-personas.js');
    const prompt = resolvePersonaPrompt('planner', undefined, 'grooming');
    expect(prompt).not.toContain('Status decision');
  });

  it('appends the focus comment after the composed lens + contract', async () => {
    const { resolvePersonaPrompt } = await import('./orchestration-personas.js');
    const prompt = resolvePersonaPrompt('senior-dev', 'focus on the auth module', 'review') ?? '';
    const contractIdx = prompt.indexOf('Status decision');
    const focusIdx = prompt.indexOf('focus on the auth module');
    expect(contractIdx).toBeGreaterThan(-1);
    expect(focusIdx).toBeGreaterThan(contractIdx);
  });

  it('returns undefined for an unknown persona id', async () => {
    const { resolvePersonaPrompt } = await import('./orchestration-personas.js');
    expect(resolvePersonaPrompt('nope-not-a-real-persona', undefined, 'review')).toBeUndefined();
  });

  it('does not append the review contract to the orchestrator lead persona', async () => {
    const { resolvePersonaPrompt } = await import('./orchestration-personas.js');
    const prompt = resolvePersonaPrompt('orchestrator', undefined, 'review') ?? '';
    expect(prompt).toContain('code review orchestrator');
    // The orchestrator's own posting/status-decision text must survive unmodified...
    expect(prompt).toContain('REVIEW SYNTHESIS');
    expect(prompt).toContain('You have full authority to change the ticket status');
    // ...and the contract's conflicting versions of the same rules must not be appended.
    expect(prompt).not.toContain('Start with **APPROVED** or **CHANGES NEEDED**');
    expect(prompt).not.toContain('Do NOT use `change_status` unless your focus instructions explicitly say you are the SOLE reviewer');
  });

  it('does not append the review contract to the supervisor lead persona', async () => {
    const { resolvePersonaPrompt } = await import('./orchestration-personas.js');
    const prompt = resolvePersonaPrompt('supervisor', undefined, 'review') ?? '';
    expect(prompt).toContain('supervisor agent coordinating specialist delegates');
    expect(prompt).not.toContain('Start with **APPROVED** or **CHANGES NEEDED**');
    expect(prompt).not.toContain('Do NOT use `change_status` unless your focus instructions explicitly say you are the SOLE reviewer');
  });

  it('a custom persona declared for the review phase inherits the review contract', async () => {
    const { resolvePersonaPrompt, saveCustomPersona, deleteCustomPersona } = await import('./orchestration-personas.js');
    await saveCustomPersona({
      id: 'custom-reviewer-test',
      label: 'Custom Reviewer',
      description: 'test-only persona',
      role: 'worker',
      phases: ['review'],
      requiredCapabilities: [],
      prompt: 'You are a custom reviewer lens.',
    });
    try {
      const prompt = resolvePersonaPrompt('custom-reviewer-test', undefined, 'review');
      expect(prompt).toContain('You are a custom reviewer lens.');
      expect(prompt).toContain('Status decision');
    } finally {
      await deleteCustomPersona('custom-reviewer-test');
    }
  });
});

describe('coordinator retirement (FLUX-1177)', () => {
  it('is no longer selectable — folded into supervisor', async () => {
    const { listSelectablePersonaMeta } = await import('./orchestration-personas.js');
    const ids = listSelectablePersonaMeta().map((p) => p.id);
    expect(ids).not.toContain('coordinator');
    expect(ids).toContain('supervisor');
  });

  it('getPersonaById aliases the old id to the supervisor persona instead of 404ing', async () => {
    const { getPersonaById } = await import('./orchestration-personas.js');
    const aliased = getPersonaById('coordinator');
    const supervisor = getPersonaById('supervisor');
    expect(aliased).toBeDefined();
    expect(aliased?.id).toBe('supervisor');
    expect(aliased).toEqual(supervisor);
  });

  it('resolvePersonaPrompt resolves the old id to the supervisor prompt', async () => {
    const { resolvePersonaPrompt } = await import('./orchestration-personas.js');
    const prompt = resolvePersonaPrompt('coordinator');
    expect(prompt).toContain('supervisor agent coordinating specialist delegates');
  });

  it('a custom persona saved under the retired id wins over the alias (FLUX-1198)', async () => {
    const { getPersonaById, saveCustomPersona, deleteCustomPersona } = await import('./orchestration-personas.js');
    await saveCustomPersona({
      id: 'coordinator',
      label: 'My Coordinator',
      description: 'test-only persona reusing a retired id',
      role: 'lead',
      phases: [],
      requiredCapabilities: [],
      prompt: 'You are a custom coordinator.',
    });
    try {
      const persona = getPersonaById('coordinator');
      expect(persona?.prompt).toBe('You are a custom coordinator.');
      expect(persona?.builtIn).toBe(false);
    } finally {
      await deleteCustomPersona('coordinator');
    }
  });
});

describe('resolvePersonaPrompt — Smelter mode-gated authority (FLUX-1175)', () => {
  it('is registered as a phase-agnostic lead persona', async () => {
    const { getPersonaById } = await import('./orchestration-personas.js');
    const persona = getPersonaById('smelter');
    expect(persona?.role).toBe('lead');
    expect(persona?.phases).toEqual([]);
  });

  it('defaults to the drafting-mode contract when smelterMode is unset', async () => {
    const { resolvePersonaPrompt } = await import('./orchestration-personas.js');
    const { configCache } = await import('./config.js');
    const prior = configCache.furnaceSettings?.smelterMode;
    delete configCache.furnaceSettings?.smelterMode;
    try {
      const prompt = resolvePersonaPrompt('smelter') ?? '';
      expect(prompt).toContain('Furnace Operator ("Smelter")');
      expect(prompt).toContain('Authority — Drafting mode');
      expect(prompt).not.toContain('Authority — Operator mode');
    } finally {
      configCache.furnaceSettings.smelterMode = prior;
    }
  });

  it('composes the operator-mode contract when furnaceSettings.smelterMode is "operator"', async () => {
    const { resolvePersonaPrompt } = await import('./orchestration-personas.js');
    const { configCache } = await import('./config.js');
    const prior = configCache.furnaceSettings?.smelterMode;
    configCache.furnaceSettings.smelterMode = 'operator';
    try {
      const prompt = resolvePersonaPrompt('smelter') ?? '';
      expect(prompt).toContain('Authority — Operator mode');
      expect(prompt).not.toContain('Authority — Drafting mode');
    } finally {
      configCache.furnaceSettings.smelterMode = prior;
    }
  });

  it('does not append a phase contract to the smelter lead persona even when a phase is given', async () => {
    const { resolvePersonaPrompt } = await import('./orchestration-personas.js');
    const prompt = resolvePersonaPrompt('smelter', undefined, 'review') ?? '';
    expect(prompt).not.toContain('Status decision');
  });

  it('is excluded from the phase-scoped selectable persona list despite phases: []', async () => {
    // The Smelter is furnace-only (its prompt never reads the launched ticket) and must
    // not leak into per-ticket pickers like OrchestrationLauncher's "Lead agent" select,
    // which keeps any phases:[] persona for every phase. Unlike Supervisor/Coordinator
    // (generic, ticket-agnostic delegation leads), it has no place there.
    const { listSelectablePersonaMeta } = await import('./orchestration-personas.js');
    for (const phase of ['grooming', 'implementation', 'review', 'finalize'] as const) {
      const ids = listSelectablePersonaMeta(phase).map((p) => p.id);
      expect(ids).not.toContain('smelter');
    }
    expect(listSelectablePersonaMeta().map((p) => p.id)).not.toContain('smelter');
  });
});

describe('getPersonaById — retired-id alias must not shadow a same-named custom persona (FLUX-1198)', () => {
  it('resolves a custom persona saved under a retired built-in id, not the alias target', async () => {
    const { getPersonaById, saveCustomPersona, deleteCustomPersona } = await import('./orchestration-personas.js');
    await saveCustomPersona({
      id: 'committer',
      label: 'Custom Committer',
      description: 'test-only persona reusing a retired id',
      role: 'worker',
      phases: [],
      requiredCapabilities: [],
      prompt: 'You are a custom committer lens.',
    });
    try {
      const persona = getPersonaById('committer');
      expect(persona?.prompt).toBe('You are a custom committer lens.');
      expect(persona?.builtIn).toBe(false);
    } finally {
      await deleteCustomPersona('committer');
    }
  });

  it('still redirects the retired id to its alias target when no custom persona overrides it', async () => {
    const { getPersonaById } = await import('./orchestration-personas.js');
    const persona = getPersonaById('committer');
    expect(persona?.id).toBe('shipper');
  });
});
