import { describe, it, expect, vi } from 'vitest';

// ─── Top-level mocks (Vitest hoists these) ───────────────────────────────────

vi.mock('./workspace.js', () => ({
  getWorkspaceRoot: () => '/tmp/test-repo',
  getActiveFluxDir: () => '/tmp/test-repo/.flux',
}));

vi.mock('../config.js', () => ({ getConfig: () => ({}) }));
vi.mock('../task-store.js', () => ({
  updateTaskWithHistory: vi.fn().mockResolvedValue(undefined),
  estimateCostUSD: vi.fn(() => 0),
}));
vi.mock('../events.js', () => ({ broadcastEvent: vi.fn() }));
vi.mock('../session-store.js', () => ({
  cliSessionsById: new Map(),
  cliSessionIdByTaskId: { get: vi.fn() },
  notifyGroupSessionTerminal: vi.fn(),
  notifyDelegationComplete: vi.fn(),
  checkAutoRestart: vi.fn(),
}));
vi.mock('../history.js', () => ({
  buildActivityEntry: vi.fn(),
  buildCommentEntry: vi.fn(),
  buildAgentMessageEntry: vi.fn(),
  buildAgentSessionEntry: vi.fn(() => ({ sessionId: 'x', progress: [] })),
  appendSessionProgress: vi.fn(),
  closeAgentSession: vi.fn(),
}));
vi.mock('../notifications.js', () => ({
  checkFrameworkHealth: vi.fn(),
  checkSkillStaleness: vi.fn(),
}));

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 1: captureDiffForPrompt export and DIFF_PROMPT_MAX_BYTES constant
//
// The ticket requires a new exported function `captureDiffForPrompt` and a new
// constant `DIFF_PROMPT_MAX_BYTES = 80 * 1024` in branch-manager.ts. These
// tests verify they exist and conform to the required interface contract.
// ─────────────────────────────────────────────────────────────────────────────

describe('captureDiffForPrompt — Step 1: prompt-sized diff capture', () => {
  it('exports DIFF_PROMPT_MAX_BYTES = 81920 (80KB)', async () => {
    const mod = await import('./branch-manager.js');
    expect(mod).toHaveProperty('DIFF_PROMPT_MAX_BYTES');
    expect(mod.DIFF_PROMPT_MAX_BYTES).toBe(80 * 1024);
  });

  it('exports captureDiffForPrompt as a function', async () => {
    const mod = await import('./branch-manager.js');
    expect(mod).toHaveProperty('captureDiffForPrompt');
    expect(typeof mod.captureDiffForPrompt).toBe('function');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 2: buildInitialPrompt — diff block injection (Step 2)
//
// The ticket requires buildInitialPrompt to accept an optional `diffBlock`
// parameter (3rd positional or via options) and inject it between "Latest
// activity" and the action instruction, BEFORE the persona appendPrompt.
// ─────────────────────────────────────────────────────────────────────────────

describe('buildInitialPrompt — Step 2: diff block injection', () => {
  const mockTask = {
    id: 'FLUX-100',
    title: 'Test ticket',
    status: 'In Progress',
    body: 'Some description',
    history: [],
  };

  it('injects diffBlock into the prompt when provided as 3rd argument', async () => {
    const { buildInitialPrompt } = await import('./agents/shared.js');
    const diffBlock = '## Scoped Diff (auto-injected)\n\nThe following diff represents the changes under review (abc123..my-branch):\n\n```diff\n+hello world\n```';

    const result = buildInitialPrompt(mockTask, 'persona suffix', { diffBlock });
    expect(result).toContain('Scoped Diff');
    expect(result).toContain('+hello world');
  });

  it('does NOT include diff content when diffBlock is omitted', async () => {
    const { buildInitialPrompt } = await import('./agents/shared.js');
    const result = buildInitialPrompt(mockTask, 'persona suffix');
    expect(result).not.toContain('Scoped Diff');
    expect(result).not.toContain('auto-injected');
  });

  it('does NOT include diff content when diffBlock is empty string', async () => {
    const { buildInitialPrompt } = await import('./agents/shared.js');
    const result = buildInitialPrompt(mockTask, 'persona suffix', { diffBlock: '' });
    expect(result).not.toContain('Scoped Diff');
  });

  it('positions diffBlock AFTER "Latest activity" section', async () => {
    const { buildInitialPrompt } = await import('./agents/shared.js');
    const diffBlock = '## Scoped Diff (auto-injected)\n\ndiff content here';

    const result = buildInitialPrompt(mockTask, 'persona', { diffBlock });
    const activityIdx = result.indexOf('Latest activity');
    const diffIdx = result.indexOf('Scoped Diff');

    expect(activityIdx).toBeGreaterThan(-1);
    expect(diffIdx).toBeGreaterThan(-1);
    expect(diffIdx).toBeGreaterThan(activityIdx);
  });

  it('positions diffBlock BEFORE the action instruction (MCP CRITICAL note)', async () => {
    const { buildInitialPrompt } = await import('./agents/shared.js');
    const diffBlock = '## Scoped Diff (auto-injected)\n\ndiff content here';

    const result = buildInitialPrompt(mockTask, 'persona', { diffBlock });
    const diffIdx = result.indexOf('Scoped Diff');
    const actionIdx = result.indexOf('CRITICAL: Use the "event-horizon" MCP tools');

    expect(diffIdx).toBeGreaterThan(-1);
    expect(actionIdx).toBeGreaterThan(-1);
    expect(diffIdx).toBeLessThan(actionIdx);
  });

  it('positions diffBlock BEFORE appendPrompt (persona suffix) for cache stability', async () => {
    const { buildInitialPrompt } = await import('./agents/shared.js');
    const diffBlock = '## Scoped Diff (auto-injected)\n\ndiff content';
    const personaSuffix = 'UNIQUE_PERSONA_MARKER_FOR_TEST';

    const result = buildInitialPrompt(mockTask, personaSuffix, { diffBlock });
    const diffIdx = result.indexOf('Scoped Diff');
    const personaIdx = result.indexOf('UNIQUE_PERSONA_MARKER_FOR_TEST');

    expect(diffIdx).toBeGreaterThan(-1);
    expect(personaIdx).toBeGreaterThan(-1);
    expect(diffIdx).toBeLessThan(personaIdx);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 3: Reviewer persona prompts — Step 4
//
// All 7 review-phase personas must no longer instruct agents to run `git diff
// HEAD~1`. Instead they should reference the diff already provided in their
// prompt prefix. Non-review personas and the orchestrator must be unchanged.
// ─────────────────────────────────────────────────────────────────────────────

describe('orchestration-personas — Step 4: reviewer prompts updated', () => {
  it('has at least 7 review-phase personas', async () => {
    const { ORCHESTRATION_PERSONAS } = await import('./orchestration-personas.js');
    const reviewPersonas = ORCHESTRATION_PERSONAS.filter(p => p.phases.includes('review'));
    expect(reviewPersonas.length).toBeGreaterThanOrEqual(7);
  });

  it('review-phase personas do NOT instruct "Run `git diff HEAD~1`"', async () => {
    const { ORCHESTRATION_PERSONAS } = await import('./orchestration-personas.js');
    const reviewPersonas = ORCHESTRATION_PERSONAS.filter(p => p.phases.includes('review'));

    for (const persona of reviewPersonas) {
      // The exact old instruction was:
      // "Run `git log --oneline -10` and `git diff HEAD~1` (or the implementationLink commit..."
      expect(persona.prompt, `Persona "${persona.id}" still has old git diff instruction`).not.toMatch(
        /`git diff HEAD~1`.*or the implementationLink/
      );
    }
  });

  it('review-phase personas reference the provided/scoped diff once composed for the review phase', async () => {
    // FLUX-1170: the diff-scoping instruction moved out of each persona's own
    // `.prompt` lens into the shared review-phase contract, composed in by
    // resolvePersonaPrompt — so this now checks the composed prompt, not the
    // raw lens text.
    const { ORCHESTRATION_PERSONAS, resolvePersonaPrompt } = await import('./orchestration-personas.js');
    const reviewPersonas = ORCHESTRATION_PERSONAS.filter(p => p.phases.includes('review'));

    for (const persona of reviewPersonas) {
      const composed = resolvePersonaPrompt(persona.id, undefined, 'review') ?? '';
      const referencesProvidedDiff =
        /scoped diff/i.test(composed) ||
        /diff provided/i.test(composed) ||
        /provided diff/i.test(composed) ||
        /provided above/i.test(composed) ||
        /review the.*diff/i.test(composed);

      expect(
        referencesProvidedDiff,
        `Persona "${persona.id}" does not reference the provided diff once composed`
      ).toBe(true);
    }
  });

  it('non-review personas (grooming, implementation, finalize) are unaffected', async () => {
    const { ORCHESTRATION_PERSONAS } = await import('./orchestration-personas.js');
    const nonReviewPersonas = ORCHESTRATION_PERSONAS.filter(p => !p.phases.includes('review'));

    for (const persona of nonReviewPersonas) {
      // Non-review personas should NOT reference "scoped diff provided" since
      // they don't receive diff injection
      expect(persona.prompt).not.toMatch(/scoped diff.*provided|provided diff.*above/i);
    }
  });

  it('the ORCHESTRATOR_PERSONA (combiner) does not reference running git diff HEAD~1', async () => {
    const { ORCHESTRATOR_PERSONA } = await import('./orchestration-personas.js');
    // The orchestrator reads ticket history comments, not the diff directly.
    // It should not instruct running git diff either.
    expect(ORCHESTRATOR_PERSONA.prompt).not.toMatch(/`git diff HEAD~1`/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 4: Gating — diff injection only for scatter-gather review sessions
//
// The spawn path must only inject the diff when:
// - groupType === 'scatter-gather', OR
// - an explicit injectDiff flag is set
// Non-review/non-orchestration sessions must NOT receive a diff block.
// ─────────────────────────────────────────────────────────────────────────────

describe('diff injection gating — Step 3: only scatter-gather sessions', () => {
  const mockTask = {
    id: 'FLUX-99',
    title: 'Test',
    status: 'In Progress',
    body: 'desc',
    history: [],
  };

  it('scatter-gather reviewer gets diff injected into prompt', async () => {
    const { buildInitialPrompt } = await import('./agents/shared.js');

    // When the scatter-gather spawn path calls buildInitialPrompt with diffBlock
    const diffBlock = '## Scoped Diff (auto-injected)\n\n```diff\n+feature code\n```';
    const prompt = buildInitialPrompt(mockTask, 'reviewer persona prompt', { diffBlock });
    expect(prompt).toContain('Scoped Diff');
    expect(prompt).toContain('+feature code');
  });

  it('standalone session (no diffBlock passed) does NOT see diff in prompt', async () => {
    const { buildInitialPrompt } = await import('./agents/shared.js');
    const prompt = buildInitialPrompt(mockTask, 'implementer persona prompt');
    expect(prompt).not.toContain('Scoped Diff');
    expect(prompt).not.toContain('auto-injected');
  });

  it('relay session (no diffBlock passed) does NOT see diff in prompt', async () => {
    const { buildInitialPrompt } = await import('./agents/shared.js');
    const prompt = buildInitialPrompt(mockTask, 'relay step prompt');
    expect(prompt).not.toContain('Scoped Diff');
  });
});
