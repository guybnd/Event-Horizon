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

// FLUX-1502: the communication blocks (user-facing style + inter-agent protocol) compose onto
// EVERY resolved persona — leads included (the PHASE_CONTRACTS lead exemption is about
// status-authority conflicts, which pure prose-style blocks don't have). The user axis is a
// selectable style; the inter-agent axis is one fixed protocol, on/off only.
describe('resolvePersonaPrompt — communication blocks (FLUX-1502)', () => {
  it('appends both default blocks (concise user style + inter-agent protocol) to a worker persona', async () => {
    const { resolvePersonaPrompt } = await import('./orchestration-personas.js');
    const prompt = resolvePersonaPrompt('qa-correctness', undefined, 'review') ?? '';
    expect(prompt).toContain('## Communication style — to the user');
    expect(prompt).toContain('concise and reader-first');
    expect(prompt).toContain('## Inter-agent protocol');
    expect(prompt).toContain('When DELEGATING');
  });

  it('appends them to lead personas too — unlike the phase contract', async () => {
    const { resolvePersonaPrompt } = await import('./orchestration-personas.js');
    for (const id of ['orchestrator', 'supervisor', 'dev-lead', 'planner']) {
      const prompt = resolvePersonaPrompt(id) ?? '';
      expect(prompt, id).toContain('## Communication style — to the user');
      expect(prompt, id).toContain('## Inter-agent protocol');
    }
  });

  it('keeps the focus comment last, after the blocks', async () => {
    const { resolvePersonaPrompt } = await import('./orchestration-personas.js');
    const prompt = resolvePersonaPrompt('senior-dev', 'focus on the auth module', 'review') ?? '';
    expect(prompt.indexOf('focus on the auth module')).toBeGreaterThan(prompt.indexOf('## Inter-agent protocol'));
  });

  it('selects the detailed user style, keeps the protocol fixed', async () => {
    const { resolvePersonaPrompt } = await import('./orchestration-personas.js');
    const { getConfig } = await import('./config.js');
    getConfig().communicationStyle = { user: 'detailed', interAgent: true };
    try {
      const prompt = resolvePersonaPrompt('senior-dev', undefined, 'review') ?? '';
      expect(prompt).toContain('explanatory and self-teaching');
      expect(prompt).not.toContain('concise and reader-first');
      expect(prompt).toContain('## Inter-agent protocol');
    } finally {
      getConfig().communicationStyle = { user: 'concise', customText: '', interAgent: true };
    }
  });

  it('injects custom text under the user-style heading; empty custom falls back to concise', async () => {
    const { resolvePersonaPrompt } = await import('./orchestration-personas.js');
    const { getConfig } = await import('./config.js');
    getConfig().communicationStyle = { user: 'custom', customText: 'CUSTOM_STYLE_SENTINEL rules.', interAgent: false };
    try {
      const prompt = resolvePersonaPrompt('senior-dev', undefined, 'review') ?? '';
      expect(prompt).toContain('## Communication style — to the user\nCUSTOM_STYLE_SENTINEL rules.');
      expect(prompt).not.toContain('## Inter-agent protocol');
      getConfig().communicationStyle = { user: 'custom', customText: '   ', interAgent: false };
      expect(resolvePersonaPrompt('senior-dev', undefined, 'review')).toContain('concise and reader-first');
    } finally {
      getConfig().communicationStyle = { user: 'concise', customText: '', interAgent: true };
    }
  });

  it('omits everything when both axes are off', async () => {
    const { resolvePersonaPrompt } = await import('./orchestration-personas.js');
    const { getConfig } = await import('./config.js');
    getConfig().communicationStyle = { user: 'off', interAgent: false };
    try {
      const prompt = resolvePersonaPrompt('senior-dev', undefined, 'review') ?? '';
      expect(prompt).not.toContain('## Communication style');
      expect(prompt).not.toContain('## Inter-agent protocol');
    } finally {
      getConfig().communicationStyle = { user: 'concise', customText: '', interAgent: true };
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
    const { getConfig } = await import('./config.js');
    const config = getConfig();
    const prior = config.furnaceSettings?.smelterMode;
    delete config.furnaceSettings?.smelterMode;
    try {
      const prompt = resolvePersonaPrompt('smelter') ?? '';
      expect(prompt).toContain('Furnace Operator ("Smelter")');
      expect(prompt).toContain('Authority — Drafting mode');
      expect(prompt).not.toContain('Authority — Operator mode');
    } finally {
      config.furnaceSettings.smelterMode = prior;
    }
  });

  it('composes the operator-mode contract when furnaceSettings.smelterMode is "operator"', async () => {
    const { resolvePersonaPrompt } = await import('./orchestration-personas.js');
    const { getConfig } = await import('./config.js');
    const config = getConfig();
    const prior = config.furnaceSettings?.smelterMode;
    config.furnaceSettings.smelterMode = 'operator';
    try {
      const prompt = resolvePersonaPrompt('smelter') ?? '';
      expect(prompt).toContain('Authority — Operator mode');
      expect(prompt).not.toContain('Authority — Drafting mode');
    } finally {
      config.furnaceSettings.smelterMode = prior;
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

describe('disallowedEhToolsForPersona — per-role MCP toolset deny-list scoping (FLUX-1434)', () => {
  it('returns undefined (full toolset) for every lead persona', async () => {
    const { disallowedEhToolsForPersona, getPersonaById } = await import('./orchestration-personas.js');
    for (const id of ['orchestrator', 'supervisor', 'dev-lead', 'smelter', 'planner']) {
      expect(getPersonaById(id)?.role, id).toBe('lead');
      expect(disallowedEhToolsForPersona({ personaId: id }), id).toBeUndefined();
    }
  });

  it('returns undefined (full toolset) for every flex persona', async () => {
    const { disallowedEhToolsForPersona, getPersonaById } = await import('./orchestration-personas.js');
    for (const id of ['senior-dev', 'finalizer']) {
      expect(getPersonaById(id)?.role, id).toBe('flex');
      expect(disallowedEhToolsForPersona({ personaId: id }), id).toBeUndefined();
    }
  });

  it('returns undefined for no personaId or an unresolvable one (fail open)', async () => {
    const { disallowedEhToolsForPersona } = await import('./orchestration-personas.js');
    expect(disallowedEhToolsForPersona({})).toBeUndefined();
    expect(disallowedEhToolsForPersona({ personaId: 'not-a-real-persona' })).toBeUndefined();
  });

  it('scopes a base review-lens worker down to the category-deny default (no phase/position context)', async () => {
    const { disallowedEhToolsForPersona } = await import('./orchestration-personas.js');
    for (const id of ['qa-correctness', 'security-auditor', 'angry-linus', 'architect', 'perf-expert', 'ux-expert', 'dry-reviewer', 'context-scout', 'test-engineer', 'shipper']) {
      const disallowed = disallowedEhToolsForPersona({ personaId: id }) ?? [];
      expect(disallowed, id).toContain('change_status');
      expect(disallowed, id).toContain('update_ticket');
      expect(disallowed, id).toContain('furnace_build');
      expect(disallowed, id).not.toContain('get_ticket');
      expect(disallowed, id).not.toContain('add_note');
    }
  });

  it('restores change_status for personas whose own prompt calls it (requirements-interrogator, regrounder, implementer) regardless of position', async () => {
    const { disallowedEhToolsForPersona } = await import('./orchestration-personas.js');
    for (const id of ['requirements-interrogator', 'regrounder', 'implementer']) {
      // persona.enableTools applies unconditionally — even for a delegate position, unlike phaseBaseline.
      const disallowed = disallowedEhToolsForPersona({ personaId: id, patternPosition: 'assistant' }) ?? [];
      expect(disallowed, id).not.toContain('change_status');
      expect(disallowed, id).not.toContain('get_ticket');
      expect(disallowed, id).not.toContain('add_note');
    }
    // regrounder and requirements-interrogator still don't get everything — furnace tools stay out.
    expect(disallowedEhToolsForPersona({ personaId: 'requirements-interrogator' })).toContain('furnace_build');
  });

  it('gives epic-decomposer create_ticket/update_ticket/ask_user_question but not change_status', async () => {
    const { disallowedEhToolsForPersona } = await import('./orchestration-personas.js');
    const disallowed = disallowedEhToolsForPersona({ personaId: 'epic-decomposer' }) ?? [];
    expect(disallowed).not.toContain('create_ticket');
    expect(disallowed).not.toContain('update_ticket');
    expect(disallowed).not.toContain('ask_user_question');
    expect(disallowed).toContain('change_status');
  });

  it('gives docs-auditor update_ticket but not change_status', async () => {
    const { disallowedEhToolsForPersona } = await import('./orchestration-personas.js');
    const disallowed = disallowedEhToolsForPersona({ personaId: 'docs-auditor' }) ?? [];
    expect(disallowed).not.toContain('update_ticket');
    expect(disallowed).toContain('change_status');
  });

  it('a deprecated sole-reviewer-of-record focus note still restores the full write set (pre-upgrade fallback)', async () => {
    const { disallowedEhToolsForPersona } = await import('./orchestration-personas.js');
    const scoped = disallowedEhToolsForPersona({ personaId: 'qa-correctness' }) ?? [];
    expect(scoped).toContain('change_status');
    const solo = disallowedEhToolsForPersona({ personaId: 'qa-correctness', focusComment: 'You are the SOLE reviewer for this ticket.' }) ?? [];
    expect(solo).not.toContain('change_status');
    expect(solo).not.toContain('update_ticket');
    // Still scoped away from furnace/epic tooling the review lens never needs.
    expect(solo).toContain('furnace_build');
  });

  it('recognizes the exact SOLE_REVIEWER_FOCUS wording furnace-stoker.ts historically sent ("ONLY reviewer")', async () => {
    const { disallowedEhToolsForPersona } = await import('./orchestration-personas.js');
    const focus = 'You are the ONLY reviewer for this ticket in this Furnace run — no orchestrator will synthesize other reviews, so you own the decision.';
    const disallowed = disallowedEhToolsForPersona({ personaId: 'security-auditor', focusComment: focus }) ?? [];
    expect(disallowed).not.toContain('change_status');
  });

  it('every worker persona in the roster resolves to a non-empty, non-full disallow list', async () => {
    const { ORCHESTRATION_PERSONAS, disallowedEhToolsForPersona } = await import('./orchestration-personas.js');
    const workers = ORCHESTRATION_PERSONAS.filter((p) => p.role === 'worker');
    expect(workers.length).toBeGreaterThan(0);
    for (const p of workers) {
      const disallowed = disallowedEhToolsForPersona({ personaId: p.id });
      expect(Array.isArray(disallowed), p.id).toBe(true);
      expect((disallowed ?? []).length, p.id).toBeGreaterThan(0);
      // The mandatory floor (NEVER_DENY: retained on every scoped-down session at minimum).
      expect(disallowed, p.id).not.toContain('add_note');
      expect(disallowed, p.id).not.toContain('get_ticket');
      expect(disallowed, p.id).not.toContain('ask_user_question');
      expect(disallowed, p.id).not.toContain('permission_prompt');
    }
  });

  describe('phase baseline (FLUX-1434) — standalone/lead positions only', () => {
    it('grants a worker persona the phase mission tools when launched standalone', async () => {
      const { disallowedEhToolsForPersona } = await import('./orchestration-personas.js');
      // qa-correctness has no persona.enableTools of its own — a standalone launch in the review
      // phase still gets the review phase baseline (fixes "any standalone launch of a phase with a
      // worker persona" as a class, FLUX-1385 regression #3's generic form).
      const disallowed = disallowedEhToolsForPersona({ personaId: 'qa-correctness', phase: 'review' }) ?? [];
      expect(disallowed).not.toContain('change_status');
      expect(disallowed).not.toContain('create_ticket');
      expect(disallowed).not.toContain('update_ticket');
      // Still scoped away from what the review phase baseline doesn't grant.
      expect(disallowed).toContain('furnace_build');
    });

    it('grants the grooming phase baseline including publish_artifact (fixes plan-revise, regression #1)', async () => {
      const { disallowedEhToolsForPersona } = await import('./orchestration-personas.js');
      const disallowed = disallowedEhToolsForPersona({ personaId: 'requirements-interrogator', phase: 'grooming' }) ?? [];
      expect(disallowed).not.toContain('update_ticket');
      expect(disallowed).not.toContain('publish_artifact');
      expect(disallowed).not.toContain('create_ticket');
    });

    it('does NOT grant the phase baseline to a delegate position (assistant/step)', async () => {
      const { disallowedEhToolsForPersona } = await import('./orchestration-personas.js');
      for (const patternPosition of ['assistant', 'step'] as const) {
        const disallowed = disallowedEhToolsForPersona({ personaId: 'qa-correctness', phase: 'review', patternPosition }) ?? [];
        expect(disallowed, patternPosition).toContain('change_status');
        expect(disallowed, patternPosition).toContain('update_ticket');
      }
    });

    it('treats an undefined patternPosition as standalone (not a delegate)', async () => {
      const { disallowedEhToolsForPersona } = await import('./orchestration-personas.js');
      const explicit = disallowedEhToolsForPersona({ personaId: 'qa-correctness', phase: 'review', patternPosition: 'standalone' }) ?? [];
      const implicit = disallowedEhToolsForPersona({ personaId: 'qa-correctness', phase: 'review' }) ?? [];
      expect(implicit.sort()).toEqual(explicit.sort());
    });

    it('grants the phase baseline for lead/combiner positions too', async () => {
      const { disallowedEhToolsForPersona } = await import('./orchestration-personas.js');
      for (const patternPosition of ['lead', 'combiner'] as const) {
        const disallowed = disallowedEhToolsForPersona({ personaId: 'qa-correctness', phase: 'review', patternPosition }) ?? [];
        expect(disallowed, patternPosition).not.toContain('change_status');
      }
    });
  });

  describe('dispatch.enableTools (FLUX-1434) — explicit per-launch grant, regardless of position', () => {
    it('grants an explicit tool even to a delegate position', async () => {
      const { disallowedEhToolsForPersona } = await import('./orchestration-personas.js');
      const disallowed = disallowedEhToolsForPersona({
        personaId: 'qa-correctness',
        patternPosition: 'assistant',
        enableTools: ['furnace_ticket'],
      }) ?? [];
      expect(disallowed).not.toContain('furnace_ticket');
      // Nothing else is granted just because one tool was.
      expect(disallowed).toContain('change_status');
    });

    it('is what fixes the Furnace sole reviewer needing furnace_ticket (regression #2)', async () => {
      const { disallowedEhToolsForPersona } = await import('./orchestration-personas.js');
      const disallowed = disallowedEhToolsForPersona({
        personaId: 'qa-correctness',
        phase: 'review',
        patternPosition: 'standalone',
        enableTools: ['furnace_ticket'],
      }) ?? [];
      expect(disallowed).not.toContain('furnace_ticket');
      expect(disallowed).not.toContain('create_ticket'); // from the review phase baseline
    });
  });

  describe('NEVER_DENY floor (FLUX-1434)', () => {
    it('is never in the deny list regardless of role or context', async () => {
      const { disallowedEhToolsForPersona, NEVER_DENY } = await import('./orchestration-personas.js');
      const disallowed = disallowedEhToolsForPersona({ personaId: 'context-scout' }) ?? [];
      for (const t of NEVER_DENY) expect(disallowed, t).not.toContain(t);
    });
  });

  describe('custom worker personas (FLUX-1434 regression #4)', () => {
    it('a custom worker persona with no declared enableTools gets the role default', async () => {
      const { disallowedEhToolsForPersona, saveCustomPersona, deleteCustomPersona, CATEGORY_DENY_DEFAULTS } = await import('./orchestration-personas.js');
      await saveCustomPersona({
        id: 'custom-worker-test',
        label: 'Custom Worker',
        description: 'test-only',
        role: 'worker',
        phases: [],
        requiredCapabilities: [],
        prompt: 'You are a custom worker.',
      });
      try {
        const disallowed = disallowedEhToolsForPersona({ personaId: 'custom-worker-test' }) ?? [];
        expect(disallowed.sort()).toEqual(CATEGORY_DENY_DEFAULTS.worker.slice().sort());
      } finally {
        await deleteCustomPersona('custom-worker-test');
      }
    });

    it('a custom worker persona with declared enableTools gets exactly that re-enable', async () => {
      const { disallowedEhToolsForPersona, saveCustomPersona, deleteCustomPersona } = await import('./orchestration-personas.js');
      await saveCustomPersona({
        id: 'custom-worker-enabled-test',
        label: 'Custom Worker (enabled)',
        description: 'test-only',
        role: 'worker',
        phases: [],
        requiredCapabilities: [],
        prompt: 'You are a custom worker.',
        enableTools: ['create_ticket'],
      });
      try {
        const disallowed = disallowedEhToolsForPersona({ personaId: 'custom-worker-enabled-test' }) ?? [];
        expect(disallowed).not.toContain('create_ticket');
        expect(disallowed).toContain('change_status');
      } finally {
        await deleteCustomPersona('custom-worker-enabled-test');
      }
    });
  });

  describe('toolScoping.categoryDeny board-config override (FLUX-1434)', () => {
    it('a configured override fully replaces the shipped worker deny list', async () => {
      const { disallowedEhToolsForPersona } = await import('./orchestration-personas.js');
      const { getConfig } = await import('./config.js');
      const config = getConfig();
      const prior = config.toolScoping;
      config.toolScoping = { categoryDeny: { worker: ['create_ticket'] } };
      try {
        const disallowed = disallowedEhToolsForPersona({ personaId: 'context-scout' }) ?? [];
        expect(disallowed).toEqual(['create_ticket']);
      } finally {
        config.toolScoping = prior;
      }
    });

    it('the NEVER_DENY floor still applies even if a misconfigured override lists a floor tool', async () => {
      const { disallowedEhToolsForPersona } = await import('./orchestration-personas.js');
      const { getConfig } = await import('./config.js');
      const config = getConfig();
      const prior = config.toolScoping;
      config.toolScoping = { categoryDeny: { worker: ['create_ticket', 'get_ticket', 'add_note'] } };
      try {
        const disallowed = disallowedEhToolsForPersona({ personaId: 'context-scout' }) ?? [];
        expect(disallowed).toEqual(['create_ticket']);
      } finally {
        config.toolScoping = prior;
      }
    });
  });
});

// FLUX-1434 CI lint: no persona prompt POSITIVELY instructs a tool call its own scoping would
// deny in EVERY launch position. `persona.enableTools` is the only re-enable guaranteed
// regardless of position (PHASE_BASELINE only applies to standalone/lead; dispatch.enableTools is
// per-launch, not a property of the prompt text itself) — so a backtick-quoted EH tool name a
// persona's prompt tells it to CALL must be covered by `persona.enableTools` (∪ the undeniable
// NEVER_DENY floor), or the persona can be launched as a delegate and told to do something it
// structurally cannot. This is the automated form of the regression class FLUX-1385 shipped
// (a persona's own prompt outrunning its scoping) for the one surface (persona prompts) where
// "positive instruction" vs "explicit negation" is unambiguous prose (`do NOT use X`) — the
// composed PHASE_CONTRACTS review text and Furnace/gate-runner focus constants use CONDITIONAL
// phrasing ("...unless you are the sole reviewer...") a simple lint can't safely classify without
// false positives, so those are covered by the targeted scenario tests above instead (the
// sole-reviewer-focus / phase-baseline / dispatch.enableTools describe blocks).
describe('CI lint — persona prompts never reference a tool their own scoping denies (FLUX-1434)', () => {
  it('extracts backtick tool references per sentence and checks positive ones against enableTools', async () => {
    const { ORCHESTRATION_PERSONAS, CATEGORY_DENY_DEFAULTS, NEVER_DENY } = await import('./orchestration-personas.js');
    const knownTools = new Set([...CATEGORY_DENY_DEFAULTS.worker, ...NEVER_DENY]);
    const negationCue = /\b(do\s+not|does\s+not|never|won't|cannot|can't)\b/i;
    const violations: string[] = [];

    for (const persona of ORCHESTRATION_PERSONAS) {
      if (persona.role !== 'worker') continue;
      const allowed = new Set([...(persona.enableTools ?? []), ...NEVER_DENY]);
      // Split into sentence-ish chunks so a negation earlier in the SAME sentence (e.g. "Do NOT
      // use `change_status` unless...") suppresses that occurrence, without also suppressing an
      // unrelated positive reference to the same tool in a LATER sentence.
      const sentences = persona.prompt.split(/(?<=[.!?\n])\s+/);
      // A tool name in backticks immediately followed by one of these nouns is a DATA reference
      // (e.g. "the `branch` field", "`publish_artifact` revisions") — several tool names collide
      // with ticket-frontmatter field names or generic nouns, not an instruction to call the tool.
      const dataReferenceNoun = /^\s+(field|revision|revisions)\b/i;
      for (const sentence of sentences) {
        const negated = negationCue.test(sentence);
        const matches = sentence.matchAll(/`([a-z_]+)`/g);
        for (const m of matches) {
          const tool = m[1]!;
          if (!knownTools.has(tool) || negated) continue;
          if (dataReferenceNoun.test(sentence.slice(m.index! + m[0].length))) continue;
          if (!allowed.has(tool)) violations.push(`${persona.id}: prompt references \`${tool}\` positively but persona.enableTools doesn't include it`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it('every persona.enableTools entry is a real, currently-registered EH tool name (drift guard)', async () => {
    const { ORCHESTRATION_PERSONAS, CATEGORY_DENY_DEFAULTS, NEVER_DENY } = await import('./orchestration-personas.js');
    const knownTools = new Set([...CATEGORY_DENY_DEFAULTS.worker, ...NEVER_DENY]);
    for (const persona of ORCHESTRATION_PERSONAS) {
      for (const tool of persona.enableTools ?? []) {
        expect(knownTools.has(tool), `${persona.id}: enableTools has unknown tool "${tool}"`).toBe(true);
      }
    }
  });
});

describe('resolveSoloChatPersona — phase-default resolution (FLUX-1226)', () => {
  it('resolves the phase-default built-in persona for every launch phase', async () => {
    const { resolveSoloChatPersona } = await import('./orchestration-personas.js');
    const expectedIds: Record<string, string> = {
      chat: 'phase-default-chat',
      grooming: 'phase-default-grooming',
      'fast-path': 'phase-default-fast-path',
      'batch-grooming': 'phase-default-batch-grooming',
      implementation: 'phase-default-implementation',
      review: 'phase-default-review',
      finalize: 'phase-default-finalize',
    };
    for (const [phase, id] of Object.entries(expectedIds)) {
      const persona = resolveSoloChatPersona(phase as never);
      expect(persona?.id, `phase=${phase}`).toBe(id);
      expect(persona?.role, `phase=${phase}`).toBe('lead');
    }
  });

  it('returns undefined for no phase and for an unrecognized phase', async () => {
    const { resolveSoloChatPersona } = await import('./orchestration-personas.js');
    expect(resolveSoloChatPersona(undefined)).toBeUndefined();
    expect(resolveSoloChatPersona('not-a-real-phase' as never)).toBeUndefined();
  });

  it('an explicit personaId wins over the phase default when it resolves', async () => {
    const { resolveSoloChatPersona } = await import('./orchestration-personas.js');
    const persona = resolveSoloChatPersona('implementation', 'dev-lead');
    expect(persona?.id).toBe('dev-lead');
  });

  it('falls back to the phase default when the explicit personaId does not resolve', async () => {
    const { resolveSoloChatPersona } = await import('./orchestration-personas.js');
    const persona = resolveSoloChatPersona('implementation', 'no-such-persona');
    expect(persona?.id).toBe('phase-default-implementation');
  });

  it('a custom worker persona listing the phase in `phases` does NOT take over solo resolution (no user phase-override tier)', async () => {
    const { resolveSoloChatPersona, saveCustomPersona, deleteCustomPersona } = await import('./orchestration-personas.js');
    await saveCustomPersona({
      id: 'custom-grooming-worker',
      label: 'Custom Grooming Worker',
      description: 'test-only persona for the no-override-tier guard',
      role: 'worker',
      phases: ['grooming'],
      requiredCapabilities: [],
      prompt: 'You are a custom grooming worker.',
    });
    try {
      const persona = resolveSoloChatPersona('grooming');
      expect(persona?.id).toBe('phase-default-grooming');
      expect(persona?.role).toBe('lead');
    } finally {
      await deleteCustomPersona('custom-grooming-worker');
    }
  });

  it('phase-default personas are hidden from every persona picker, like the Smelter', async () => {
    const { listSelectablePersonaMeta } = await import('./orchestration-personas.js');
    const hiddenIds = ['phase-default-chat', 'phase-default-grooming', 'phase-default-fast-path', 'phase-default-batch-grooming', 'phase-default-implementation', 'phase-default-review', 'phase-default-finalize'];
    for (const phase of ['grooming', 'implementation', 'review', 'finalize'] as const) {
      const ids = listSelectablePersonaMeta(phase).map((p) => p.id);
      for (const hidden of hiddenIds) expect(ids).not.toContain(hidden);
    }
    const allIds = listSelectablePersonaMeta().map((p) => p.id);
    for (const hidden of hiddenIds) expect(allIds).not.toContain(hidden);
  });

  it('phase-default personas are role:lead and stay PHASE_CONTRACTS-exempt (no auto-composed contract)', async () => {
    const { resolvePersonaPrompt } = await import('./orchestration-personas.js');
    const prompt = resolvePersonaPrompt('phase-default-review', undefined, 'review') ?? '';
    expect(prompt).not.toContain('Status decision');
    expect(prompt).not.toContain('Diff scoping');
  });

  it('phase-default personas are never EH-tool-scoped (role:lead ⇒ disallowedEhToolsForPersona is undefined)', async () => {
    const { disallowedEhToolsForPersona } = await import('./orchestration-personas.js');
    for (const personaId of ['phase-default-grooming', 'phase-default-batch-grooming', 'phase-default-implementation', 'phase-default-review', 'phase-default-finalize']) {
      const denied = disallowedEhToolsForPersona({ personaId, phase: 'implementation' });
      expect(denied, personaId).toBeUndefined();
    }
  });
});

// FLUX-1462: LEAD_PHASE_DENY — a dispatched, personaId-less solo phase session (the case the test
// directly above does NOT cover — that one always passes an explicit personaId) now gets a
// deliberate per-phase trim for grooming/review. Every other phase, and every non-standalone
// patternPosition (worker delegates, scatter-gather orchestrator/combiner leads), must stay
// exactly as before this ticket.
describe('disallowedEhToolsForPersona — dispatched solo lead per-phase trim (FLUX-1462)', () => {
  it('trims LEAD_PHASE_DENY for a personaId-less standalone grooming/review dispatch', async () => {
    const { disallowedEhToolsForPersona, LEAD_PHASE_DENY } = await import('./orchestration-personas.js');
    for (const phase of ['grooming', 'review', 'batch-grooming'] as const) {
      const denied = disallowedEhToolsForPersona({ phase });
      expect(denied?.sort(), phase).toEqual(LEAD_PHASE_DENY[phase]?.slice().sort());
    }
  });

  // FLUX-1562: an explicit patternPosition:'standalone' must trim identically to the undefined
  // case above — production only reaches `undefined` because cli-session.ts:317 normalizes the
  // string away before it hits this function; the gate itself must not depend on that normalization.
  it('trims LEAD_PHASE_DENY identically for an explicit patternPosition:"standalone"', async () => {
    const { disallowedEhToolsForPersona, LEAD_PHASE_DENY } = await import('./orchestration-personas.js');
    for (const phase of ['grooming', 'review'] as const) {
      const denied = disallowedEhToolsForPersona({ phase, patternPosition: 'standalone' });
      expect(denied?.sort(), phase).toEqual(LEAD_PHASE_DENY[phase]?.slice().sort());
    }
  });

  it('leaves every other phase un-scoped for a personaId-less standalone dispatch', async () => {
    const { disallowedEhToolsForPersona } = await import('./orchestration-personas.js');
    for (const phase of ['implementation', 'fast-path', 'finalize'] as const) {
      expect(disallowedEhToolsForPersona({ phase }), phase).toBeUndefined();
    }
    expect(disallowedEhToolsForPersona({})).toBeUndefined();
  });

  it('does not trim a non-standalone patternPosition (worker delegate, or a scatter-gather lead/combiner)', async () => {
    const { disallowedEhToolsForPersona } = await import('./orchestration-personas.js');
    for (const patternPosition of ['assistant', 'step', 'lead', 'combiner'] as const) {
      expect(disallowedEhToolsForPersona({ phase: 'grooming', patternPosition }), patternPosition).toBeUndefined();
    }
  });

  it('an explicit enableTools grant re-enables an individual trimmed tool', async () => {
    const { disallowedEhToolsForPersona } = await import('./orchestration-personas.js');
    const denied = disallowedEhToolsForPersona({ phase: 'review', enableTools: ['finish_ticket'] });
    expect(denied).not.toContain('finish_ticket');
    expect(denied).toEqual(expect.arrayContaining(['branch', 'merge_tickets']));
  });

  it('every LEAD_PHASE_DENY entry is a real, currently-registered EH tool name (drift guard)', async () => {
    const { LEAD_PHASE_DENY, CATEGORY_DENY_DEFAULTS, NEVER_DENY } = await import('./orchestration-personas.js');
    const knownTools = new Set([...CATEGORY_DENY_DEFAULTS.worker, ...NEVER_DENY]);
    for (const [phase, tools] of Object.entries(LEAD_PHASE_DENY)) {
      for (const tool of tools ?? []) expect(knownTools.has(tool), `${phase}: unknown tool "${tool}"`).toBe(true);
    }
  });
});

describe('resolveSoloChatPersona — Scratchpad persona (FLUX-1479 / FLUX-1226 Phase D)', () => {
  it('resolves the Scratchpad persona for phase:"chat" + isScratch:true', async () => {
    const { resolveSoloChatPersona } = await import('./orchestration-personas.js');
    const persona = resolveSoloChatPersona('chat', undefined, true);
    expect(persona?.id).toBe('phase-default-scratchpad');
    expect(persona?.role).toBe('lead');
  });

  it('a plain chat (isScratch false/omitted) still resolves the ordinary chat default, not Scratchpad', async () => {
    const { resolveSoloChatPersona } = await import('./orchestration-personas.js');
    expect(resolveSoloChatPersona('chat', undefined, false)?.id).toBe('phase-default-chat');
    expect(resolveSoloChatPersona('chat')?.id).toBe('phase-default-chat');
  });

  it('isScratch is only consulted for phase:"chat" — a non-chat phase ignores it', async () => {
    const { resolveSoloChatPersona } = await import('./orchestration-personas.js');
    expect(resolveSoloChatPersona('grooming', undefined, true)?.id).toBe('phase-default-grooming');
  });

  it('an explicit personaId still wins over the Scratchpad default', async () => {
    const { resolveSoloChatPersona } = await import('./orchestration-personas.js');
    const persona = resolveSoloChatPersona('chat', 'dev-lead', true);
    expect(persona?.id).toBe('dev-lead');
  });

  it('the Scratchpad persona is hidden from every persona picker, like the other phase defaults', async () => {
    const { listSelectablePersonaMeta } = await import('./orchestration-personas.js');
    expect(listSelectablePersonaMeta().map((p) => p.id)).not.toContain('phase-default-scratchpad');
  });

  it('the Scratchpad persona is never EH-tool-scoped (role:lead)', async () => {
    const { disallowedEhToolsForPersona } = await import('./orchestration-personas.js');
    expect(disallowedEhToolsForPersona({ personaId: 'phase-default-scratchpad', phase: 'chat' })).toBeUndefined();
  });
});

describe('OrchestrationPersona.model — per-phase model override field (FLUX-1479 / FLUX-1226 Phase F)', () => {
  it('resolveSoloChatPersona surfaces a custom persona\'s model field unchanged', async () => {
    const { resolveSoloChatPersona, saveCustomPersona, deleteCustomPersona } = await import('./orchestration-personas.js');
    await saveCustomPersona({
      id: 'custom-cheap-reviewer',
      label: 'Custom Cheap Reviewer',
      description: 'test-only persona for the persona.model resolution test',
      role: 'lead',
      phases: ['review'],
      requiredCapabilities: [],
      prompt: 'You are a cost-conscious reviewer.',
      model: 'claude-haiku-4-5-20251001',
    });
    try {
      const persona = resolveSoloChatPersona('review', 'custom-cheap-reviewer');
      expect(persona?.model).toBe('claude-haiku-4-5-20251001');
    } finally {
      await deleteCustomPersona('custom-cheap-reviewer');
    }
  });

  it('the built-in phase-default personas declare no model override by default', async () => {
    const { resolveSoloChatPersona } = await import('./orchestration-personas.js');
    for (const phase of ['chat', 'grooming', 'fast-path', 'batch-grooming', 'implementation', 'review', 'finalize'] as const) {
      expect(resolveSoloChatPersona(phase)?.model, `phase=${phase}`).toBeUndefined();
    }
  });
});
