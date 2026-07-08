import { describe, it, expect } from 'vitest';
import { resolveGateValue, DEFAULT_GATE_POLICY, depthForEffort, resolvePlanReviewDepth, hasHumanGateTouch, planBodyHash, SELF_ATTESTED_AUTHOR_FIELD, type GatePolicy } from './gate-policy.js';

describe('resolveGateValue (FLUX-1261 gate-policy cascade)', () => {
  const policy: GatePolicy = { boardDefault: { plan: 'auto-then-you', review: 'auto' } };

  it('falls back to the board default when no ticket override is set', () => {
    expect(resolveGateValue(policy, undefined, 'plan')).toBe('auto-then-you');
    expect(resolveGateValue(policy, null, 'review')).toBe('auto');
  });

  it('an explicit per-ticket override wins over the board default', () => {
    expect(resolveGateValue(policy, { plan: 'you' }, 'plan')).toBe('you');
    expect(resolveGateValue(policy, { review: 'you' }, 'review')).toBe('you');
  });

  it('an override only covering one gate leaves the other gate on the board default', () => {
    expect(resolveGateValue(policy, { plan: 'you' }, 'review')).toBe('auto');
  });

  it('falls back to the safe DEFAULT_GATE_POLICY when config is missing entirely', () => {
    expect(resolveGateValue(undefined, undefined, 'plan')).toBe(DEFAULT_GATE_POLICY.boardDefault.plan);
    expect(resolveGateValue(null, null, 'review')).toBe(DEFAULT_GATE_POLICY.boardDefault.review);
  });
});

describe('depthForEffort / resolvePlanReviewDepth (FLUX-1263 review-depth auto-pick)', () => {
  it('maps XS/S -> quick, M (or unknown) -> standard, L/XL -> thorough', () => {
    expect(depthForEffort('XS')).toBe('quick');
    expect(depthForEffort('S')).toBe('quick');
    expect(depthForEffort('M')).toBe('standard');
    expect(depthForEffort('L')).toBe('thorough');
    expect(depthForEffort('XL')).toBe('thorough');
    expect(depthForEffort(undefined)).toBe('standard');
    expect(depthForEffort(null)).toBe('standard');
    expect(depthForEffort('None')).toBe('standard');
  });

  it('a column-level fixed override wins over the effort-based auto-pick', () => {
    expect(resolvePlanReviewDepth('XS', 'thorough')).toBe('thorough');
    expect(resolvePlanReviewDepth('XL', 'quick')).toBe('quick');
  });

  it('`auto` (or an unset override) defers to the effort-based pick', () => {
    expect(resolvePlanReviewDepth('XS', 'auto')).toBe('quick');
    expect(resolvePlanReviewDepth('XL', undefined)).toBe('thorough');
    expect(resolvePlanReviewDepth('XL', null)).toBe('thorough');
  });
});

describe('hasHumanGateTouch (FLUX-1264 merge-lock runtime assertion)', () => {
  it('is false for missing/empty history', () => {
    expect(hasHumanGateTouch(undefined)).toBe(false);
    expect(hasHumanGateTouch(null)).toBe(false);
    expect(hasHumanGateTouch([])).toBe(false);
  });

  it('is false when every comment/status_change is Agent-authored', () => {
    expect(hasHumanGateTouch([
      { type: 'comment', user: 'Agent', comment: 'Implemented the thing.' },
      { type: 'status_change', user: 'Agent', from: 'In Progress', to: 'Ready' },
      { type: 'agent_session', user: 'Claude Code' },
    ])).toBe(false);
  });

  it('is true when a human left a comment', () => {
    expect(hasHumanGateTouch([
      { type: 'comment', user: 'Agent', comment: 'Ready for review.' },
      { type: 'comment', user: 'guybnd', comment: 'Looks good.' },
    ])).toBe(true);
  });

  it('is true when a human moved the status (a status_change entry not authored by Agent)', () => {
    expect(hasHumanGateTouch([
      { type: 'status_change', user: 'You', from: 'Ready', to: 'Done' },
    ])).toBe(true);
  });

  it('ignores non-comment/status_change entries even when human-authored (e.g. agent_session)', () => {
    expect(hasHumanGateTouch([
      { type: 'agent_session', user: 'guybnd' },
      { type: 'activity', user: 'guybnd', comment: 'Renamed something.' },
    ])).toBe(false);
  });

  it('is false for an empty or non-string user', () => {
    expect(hasHumanGateTouch([{ type: 'comment', user: '' }])).toBe(false);
    expect(hasHumanGateTouch([{ type: 'comment', user: undefined }])).toBe(false);
  });

  // FLUX-1271: add_note's `user` param is a fully caller-controlled string with no verification —
  // the same MCP session that can call finish_ticket can also call
  // add_note({ user: 'SomeHuman', ... }), forging a "human touch" from a single tool call.
  // mcp-server.ts stamps every comment entry it writes via add_note with this marker.
  it('ignores a comment/status_change entry marked selfAttested, regardless of its claimed user', () => {
    expect(hasHumanGateTouch([
      { type: 'comment', user: 'SomeHuman', comment: 'Looks good to me!', [SELF_ATTESTED_AUTHOR_FIELD]: true },
    ])).toBe(false);
    expect(hasHumanGateTouch([
      { type: 'status_change', user: 'SomeHuman', from: 'Ready', to: 'Done', [SELF_ATTESTED_AUTHOR_FIELD]: true },
    ])).toBe(false);
  });

  it('still trusts a same-shaped entry that is NOT marked selfAttested', () => {
    expect(hasHumanGateTouch([
      { type: 'comment', user: 'SomeHuman', comment: 'Looks good to me!' },
    ])).toBe(true);
    expect(hasHumanGateTouch([
      { type: 'comment', user: 'SomeHuman', comment: 'Looks good to me!', [SELF_ATTESTED_AUTHOR_FIELD]: false },
    ])).toBe(true);
  });
});

describe('planBodyHash (FLUX-1306 — parity with the portal copy)', () => {
  // Mirrored verbatim in portal/src/lib/planBodyHash.test.ts — these (input, expected hash) pairs
  // MUST match exactly in both files. The engine and portal hand-maintain byte-identical djb2
  // implementations (the portal can't import the engine package) with only a "keep in sync" comment
  // holding them together; this fixture is the actual regression net — a future edit to either side
  // without updating BOTH fixtures breaks a test instead of silently drifting the "has the plan
  // changed since review" comparison.
  const VECTORS: [string, string][] = [
    ['', '45h'],
    ['a', '3t3a'],
    ['Hello, World!', '15v59ji'],
    ['## Plan\n\n- step 1\n- step 2\n', 'zud1qr'],
    ['unicode: café — ✅', '1pk2edu'],
  ];

  it('matches the fixed hash for each vector (keep in sync with the portal copy)', () => {
    for (const [input, expected] of VECTORS) {
      expect(planBodyHash(input)).toBe(expected);
    }
  });

  it('is a pure function of the body (same input -> same output, always)', () => {
    expect(planBodyHash('same body')).toBe(planBodyHash('same body'));
  });
});
