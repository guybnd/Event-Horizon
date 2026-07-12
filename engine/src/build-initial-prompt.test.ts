import { describe, it, expect } from 'vitest';
import { buildInitialPrompt } from './agents/shared.js';
import { CLI_CAPABILITIES, type CliFramework } from './agents/types.js';

// FLUX-960: shape test for the shared, capability-gated buildInitialPrompt. This locks the
// GATING MECHANISM (which sections appear for which framework) — it cannot verify that a live
// CLI actually behaves correctly on the resulting prompt; that needs the manual per-phase,
// per-framework dispatch the ticket calls out separately.
const FRAMEWORKS: CliFramework[] = ['claude', 'copilot', 'gemini'];
// The framework buildInitialPrompt resolves to when the caller omits `framework`
// (backward compat for pre-FLUX-960 callers). Named here so the default-parity test below
// asserts against a typed constant rather than a bare per-CLI literal (adapter-boundary).
const DEFAULT_FRAMEWORK: CliFramework = 'claude';

const mockTask = {
  id: 'FLUX-1',
  title: 'Test ticket',
  status: 'Todo',
  body: 'SENTINEL_BODY_SHOULD_NOT_BE_ECHOED',
  history: [],
  tags: [],
};

describe('buildInitialPrompt — parity by default (FLUX-960)', () => {
  it('never echoes task.body for any framework — all rely on get_ticket (FLUX-498, now universal)', () => {
    for (const framework of FRAMEWORKS) {
      const prompt = buildInitialPrompt(mockTask, '', { phase: 'implementation', framework });
      expect(prompt).not.toContain('SENTINEL_BODY_SHOULD_NOT_BE_ECHOED');
      expect(prompt).toContain(`get_ticket("${mockTask.id}")`);
    }
  });

  it('gives every framework the same phase-based mission text (finalize/fast-path — no phase module applies)', () => {
    // finalize and fast-path (FLUX-1380) have no phase skill module — grooming/implementation/review
    // do (see the FLUX-1377 test below) — so their mission text stays byte-identical across frameworks.
    for (const phase of ['finalize', 'fast-path'] as const) {
      const prompts = FRAMEWORKS.map((framework) => buildInitialPrompt(mockTask, '', { phase, framework }));
      // Strip the requireInputStopInstruction (the one line that's allowed to differ per
      // selfPause) before comparing — everything else must be byte-identical across frameworks.
      const normalized = prompts.map((p) => p.split('\n').slice(0, -1).join('\n'));
      expect(new Set(normalized).size).toBe(1);
    }
  });

  it('FLUX-1377: injects the phase skill module for Claude only (grooming/implementation/review) — copilot/gemini stay in parity with each other', () => {
    const phases = ['grooming', 'implementation', 'review'] as const;
    for (const phase of phases) {
      const claudePrompt = buildInitialPrompt(mockTask, '', { phase, framework: 'claude' });
      const copilotPrompt = buildInitialPrompt(mockTask, '', { phase, framework: 'copilot' });
      const geminiPrompt = buildInitialPrompt(mockTask, '', { phase, framework: 'gemini' });

      expect(claudePrompt).toContain(`## Phase Skill: ${phase}`);
      expect(copilotPrompt).not.toContain('## Phase Skill:');
      expect(geminiPrompt).not.toContain('## Phase Skill:');

      // Non-Claude frameworks still stay byte-identical to each other (minus the
      // selfPause-gated closing line) — the FLUX-960 parity guarantee still holds for them.
      const normalized = [copilotPrompt, geminiPrompt].map((p) => p.split('\n').slice(0, -1).join('\n'));
      expect(new Set(normalized).size).toBe(1);
    }
  });

  it('FLUX-1377: excludes delegate/relay spawns from phase module injection even on Claude', () => {
    const dispatched = buildInitialPrompt(mockTask, '', { phase: 'implementation', framework: 'claude' });
    const delegateSpawn = buildInitialPrompt(mockTask, '', { phase: 'implementation', framework: 'claude', patternPosition: 'assistant' });
    const relaySpawn = buildInitialPrompt(mockTask, '', { phase: 'implementation', framework: 'claude', patternPosition: 'step' });
    expect(dispatched).toContain('## Phase Skill:');
    expect(delegateSpawn).not.toContain('## Phase Skill:');
    expect(relaySpawn).not.toContain('## Phase Skill:');
  });

  it('restricts the ORCHESTRATION PROPOSALS paragraph (chat phase) to frameworks with the supervisor capability', () => {
    for (const framework of FRAMEWORKS) {
      const prompt = buildInitialPrompt(mockTask, '', { phase: 'chat', framework });
      const hasParagraph = prompt.includes('ORCHESTRATION PROPOSALS');
      expect(hasParagraph).toBe(CLI_CAPABILITIES[framework].supervisor);
    }
  });

  it('gives every framework the universal end-of-turn action contract and ask_user_question routing in chat phase', () => {
    for (const framework of FRAMEWORKS) {
      const prompt = buildInitialPrompt(mockTask, '', { phase: 'chat', framework });
      expect(prompt).toContain('END-OF-TURN ACTION CONTRACT');
      expect(prompt).toContain('call the ask_user_question tool');
    }
  });

  it('picks the Require-Input closing instruction based on the selfPause capability, not a framework literal', () => {
    for (const framework of FRAMEWORKS) {
      const prompt = buildInitialPrompt(mockTask, '', { phase: 'implementation', framework });
      if (CLI_CAPABILITIES[framework].selfPause) {
        expect(prompt).toContain('STOP immediately after');
      } else {
        expect(prompt).not.toContain('STOP immediately after');
        expect(prompt).toContain('end your turn there');
      }
    }
  });

  it('includes a provided diffBlock for every framework — parameter-driven, not framework-gated', () => {
    for (const framework of FRAMEWORKS) {
      const prompt = buildInitialPrompt(mockTask, '', { phase: 'review', framework, diffBlock: 'SENTINEL_DIFF_BLOCK' });
      expect(prompt).toContain('SENTINEL_DIFF_BLOCK');
    }
  });

  it('appends the FLUX-926 file-edit-gated note in chat phase only when editsGated is true, for every framework', () => {
    for (const framework of FRAMEWORKS) {
      const gated = buildInitialPrompt(mockTask, '', { phase: 'chat', framework, editsGated: true });
      const ungated = buildInitialPrompt(mockTask, '', { phase: 'chat', framework, editsGated: false });
      const omitted = buildInitialPrompt(mockTask, '', { phase: 'chat', framework });
      expect(gated).toContain('FLUX-926');
      expect(ungated).not.toContain('FLUX-926');
      expect(omitted).not.toContain('FLUX-926');
    }
  });

  it('FLUX-1123: the edit-gated note wording matches chatEditGateEnforced — only Claude claims a real block', () => {
    for (const framework of FRAMEWORKS) {
      const gated = buildInitialPrompt(mockTask, '', { phase: 'chat', framework, editsGated: true });
      if (CLI_CAPABILITIES[framework].chatEditGateEnforced) {
        expect(gated).toContain('the CLI will refuse them');
      } else {
        expect(gated).not.toContain('the CLI will refuse them');
        expect(gated).toContain('no enforced file-edit block');
      }
    }
  });

  it('defaults to claude when framework is omitted (backward compatibility for pre-FLUX-960 callers)', () => {
    const withDefault = buildInitialPrompt(mockTask, '', { phase: 'implementation' });
    const explicitClaude = buildInitialPrompt(mockTask, '', { phase: 'implementation', framework: DEFAULT_FRAMEWORK });
    expect(withDefault).toBe(explicitClaude);
  });

  it('FLUX-1380: fast-path mission includes inline grooming, the bail-out contract, and commit-before-Ready, for every framework', () => {
    for (const framework of FRAMEWORKS) {
      const prompt = buildInitialPrompt(mockTask, '', { phase: 'fast-path', framework });
      expect(prompt).toContain('FAST-PATH');
      expect(prompt).toContain('GROOM IT INLINE');
      // Bail-out contract: too-big work escapes to the normal plan-gated Todo path instead of implementing.
      expect(prompt).toContain('ELIGIBILITY CHECK');
      expect(prompt).toContain('move to "Todo"');
      // FLUX-730: commit-before-Ready applies here exactly as it does for plain implementation.
      expect(prompt).toContain('FLUX-730');
      expect(prompt).toContain('completion summary');
    }
  });

  it('falls back to status-based instructions identically across frameworks when no phase is given', () => {
    // Same normalization as the phase-based test: strip the one line allowed to differ per
    // selfPause before comparing.
    const prompts = FRAMEWORKS.map((framework) => buildInitialPrompt(mockTask, '', { framework }));
    const normalized = prompts.map((p) => p.split('\n').slice(0, -1).join('\n'));
    expect(new Set(normalized).size).toBe(1);
  });
});
