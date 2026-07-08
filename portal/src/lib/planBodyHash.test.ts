import { describe, it, expect } from 'vitest';
import { planBodyHash } from './planBodyHash';

// FLUX-1306: parity fixture with the engine's copy (engine/src/models/gate-policy.test.ts) — these
// (input, expected hash) pairs MUST match exactly in both files. The engine and portal
// hand-maintain byte-identical djb2 implementations (the portal can't import the engine package)
// with only a "keep in sync" comment holding them together; this fixture is the actual regression
// net — a future edit to either side without updating BOTH fixtures breaks a test instead of
// silently drifting the "has the plan changed since review" comparison.
const VECTORS: [string, string][] = [
  ['', '45h'],
  ['a', '3t3a'],
  ['Hello, World!', '15v59ji'],
  ['## Plan\n\n- step 1\n- step 2\n', 'zud1qr'],
  ['unicode: café — ✅', '1pk2edu'],
];

describe('planBodyHash (FLUX-1306 — parity with the engine copy)', () => {
  it('matches the fixed hash for each vector (keep in sync with the engine copy)', () => {
    for (const [input, expected] of VECTORS) {
      expect(planBodyHash(input)).toBe(expected);
    }
  });

  it('is a pure function of the body (same input -> same output, always)', () => {
    expect(planBodyHash('same body')).toBe(planBodyHash('same body'));
  });
});
