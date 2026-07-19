import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { buildInitialPrompt } from './shared.js';
import { getConfig } from '../config.js';
import type { LaunchPhase } from './types.js';

// FLUX-1226 (C1) — load-bearing byte-compat gate for the Mission-block -> persona migration.
//
// Before this ticket, every launch phase's role text was a hardcoded literal inside
// `buildInitialPrompt`'s `switch(opts.phase)`. This migrates that text into the persona catalog
// (`orchestration-personas.ts`, `PHASE_DEFAULT_PERSONAS` + `resolveSoloChatPersona`) as the single
// source of truth, resolved and rendered back into the exact same prompt text at build time.
//
// The FLUX-1377 phase skill module is stubbed below: `loadSkillModuleBodySync` reads the live
// `.docs/skills/event-horizon-<module>.md` bodies from disk, so snapshotting them verbatim would
// couple this gate to routine skill-doc edits — every version bump on master would fail these
// snapshots with a diff that has nothing to do with the migration this file guards (it did:
// #580/#581 landed between this branch's fork and merge and broke 3/10 cases). The stub keeps
// WHICH phases inject a module under test (`isInjectablePhaseModule` stays real, and the stub
// sentinel appears under `## Phase Skill:` exactly where the real body would) while the body
// content stays owned by the docs, not this snapshot.
//
// This snapshot file (with the stub) was verified against the UNMODIFIED baseline — the pre-rewire
// parent commit still produces byte-identical output for all cases — so any diff after the
// migration is a real behavior change to every solo chat / dispatched session's prompt and must be
// treated as a Blocker, not re-approved by regenerating the snapshot.
vi.mock('../skill-modules.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../skill-modules.js')>();
  return {
    ...actual,
    loadSkillModuleBodySync: (module: string) =>
      `(phase skill module '${module}' body stubbed — live .docs/skills content is deliberately not under this snapshot)`,
  };
});
// FLUX-1383: 'batch-grooming' is appended at the END, not inserted mid-list — every snapshot in
// this file's "every phase on X" loops is positional (index-numbered, not phase-named), so
// inserting a new phase anywhere but last would shift every subsequent phase's snapshot index and
// spuriously fail this byte-compat gate for phases this ticket never touched.
const ALL_PHASES: LaunchPhase[] = ['chat', 'grooming', 'fast-path', 'implementation', 'review', 'finalize', 'batch-grooming'];

const baseTask = {
  id: 'FLUX-9001',
  title: 'Byte-compat snapshot fixture',
  status: 'In Progress',
  body: 'irrelevant',
  history: [],
  tags: [],
};

// FLUX-1502: the config-driven communication blocks are a deliberate, feature-owned addition
// on top of the migrated mission text — they have their own coverage (build-initial-prompt.test.ts /
// orchestration-personas.test.ts). Pin them OFF here so these snapshots keep guarding exactly what
// they were verified against: the FLUX-1226 pre-migration baseline.
beforeAll(() => { getConfig().communicationStyle = { user: 'off', interAgent: false }; });
afterAll(() => { getConfig().communicationStyle = { user: 'concise', customText: '', interAgent: true }; });

describe('buildInitialPrompt phase mission text — byte-compat snapshot (FLUX-1226 C1)', () => {
  for (const phase of ALL_PHASES) {
    it(`matches the pre-migration baseline for phase "${phase}" (claude, standalone)`, () => {
      const prompt = buildInitialPrompt(baseTask, '', { phase, framework: 'claude' });
      expect(prompt).toMatchSnapshot();
    });
  }

  it('matches the pre-migration baseline for the chat phase with the FLUX-926 edit gate active', () => {
    const prompt = buildInitialPrompt(baseTask, '', { phase: 'chat', framework: 'claude', editsGated: true });
    expect(prompt).toMatchSnapshot();
  });

  it('matches the pre-migration baseline for the chat phase on a scratch ticket with the edit gate active', () => {
    const scratchTask = { ...baseTask, kind: 'scratch' };
    const prompt = buildInitialPrompt(scratchTask, '', { phase: 'chat', framework: 'claude', editsGated: true });
    expect(prompt).toMatchSnapshot();
  });

  it('matches the pre-migration baseline for every phase on copilot (non-Claude parity path)', () => {
    for (const phase of ALL_PHASES) {
      const prompt = buildInitialPrompt(baseTask, '', { phase, framework: 'copilot' });
      expect(prompt).toMatchSnapshot();
    }
  });

  it('matches the pre-migration baseline for an unrecognized phase string (falls through to the status-derived fallback, untouched by this migration)', () => {
    const prompt = buildInitialPrompt(baseTask, '', { phase: 'not-a-real-phase', framework: 'claude' });
    expect(prompt).toMatchSnapshot();
  });
});
