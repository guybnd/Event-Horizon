// FLUX-1739 follow-up: every run records which EventHorizon produced it.
//
// The L2.5 friction layer measures EventHorizon itself, so a friction number without a version
// attached is unattributable. This is not hypothetical — the feature's own first live runs executed
// against three different engine builds as fixes landed between them, and the reports looked
// directly comparable while being nothing of the kind.
import { describe, it, expect, beforeEach } from 'vitest';
import { comparableProvenance, isEngineDirty, __resetProvenanceCache, type EnginePunchcard } from './benchmark-provenance.js';

function card(overrides: Partial<EnginePunchcard> = {}): EnginePunchcard {
  return { version: '1.12.0', commit: 'a'.repeat(40), dirty: false, capturedAt: '2026-01-01T00:00:00Z', ...overrides };
}

beforeEach(() => __resetProvenanceCache());

describe('comparableProvenance', () => {
  it('accepts two clean runs from the same commit', () => {
    expect(comparableProvenance(card(), card())).toBe(true);
  });

  it('rejects two different commits — a rebuild between suites breaks comparability', () => {
    expect(comparableProvenance(card(), card({ commit: 'b'.repeat(40) }))).toBe(false);
  });

  it('rejects a DIRTY tree even against an identical commit', () => {
    // A modified working tree cannot be shown equal to anything, including itself at another moment.
    // Recording the flag and then ignoring it would be worse than not recording it.
    expect(comparableProvenance(card({ dirty: true }), card())).toBe(false);
    expect(comparableProvenance(card(), card({ dirty: true }))).toBe(false);
    expect(comparableProvenance(card({ dirty: true }), card({ dirty: true }))).toBe(false);
  });

  it('rejects when either side has no commit — absent is not a match', () => {
    const noCommit = card();
    delete noCommit.commit;
    expect(comparableProvenance(noCommit, card())).toBe(false);
  });

  it('rejects when either side is missing entirely', () => {
    expect(comparableProvenance(undefined, card())).toBe(false);
    expect(comparableProvenance(card(), undefined)).toBe(false);
  });

  it('does not treat equal version strings as sufficient — the commit is the identity', () => {
    // Two builds of 1.12.0 can differ by every line of the runner. Version alone is a label.
    expect(comparableProvenance(card({ commit: 'a'.repeat(40) }), card({ commit: 'c'.repeat(40) }))).toBe(false);
  });
});

describe('isEngineDirty', () => {
  it('is clean on an empty status', () => {
    expect(isEngineDirty('')).toBe(false);
    expect(isEngineDirty('\n')).toBe(false);
  });

  it('ignores modifications OUTSIDE engine/ — they cannot reach a run pinned to baseCommit', () => {
    // The realistic case: a human editing docs in the checkout the engine runs from. Disqualifying
    // every suite on that machine would make the provenance rule protect nothing.
    expect(isEngineDirty(' M AGENTS.md\n M portal/src/App.tsx\n?? docs/notes.md\n')).toBe(false);
  });

  it('flags any change under engine/, staged, unstaged or untracked', () => {
    expect(isEngineDirty(' M engine/src/benchmark-runner.ts\n')).toBe(true);
    expect(isEngineDirty('A  engine/src/new.ts\n')).toBe(true);
    expect(isEngineDirty('?? engine/src/scratch.ts\n')).toBe(true);
  });

  it('follows a rename into or out of engine/', () => {
    expect(isEngineDirty('R  portal/x.ts -> engine/src/x.ts\n')).toBe(true);
    expect(isEngineDirty('R  engine/src/x.ts -> portal/x.ts\n')).toBe(true);
  });

  it('does not count a stray engine/node_modules entry', () => {
    expect(isEngineDirty('?? engine/node_modules/.cache\n')).toBe(false);
  });
});
