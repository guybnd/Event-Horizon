import { describe, it, expect } from 'vitest';
import { planLint, formatLintFindings, BODY_WARN_CHARS, type PlanLintInput } from './plan-lint.js';

/** Long-enough filler so body-length-gated rules (B1/B3 thresholds) can be crossed deliberately. */
const filler = (n: number) => 'x'.repeat(n);

const AC_CHECKLIST = '## Acceptance criteria\n\n- [ ] one\n- [x] two\n';
const TESTS_HEADING = '## Recommended Tests\n\nSomething.\n';
const TLDR = '> **TL;DR** — a summary.\n\n';

function base(overrides: Partial<PlanLintInput> = {}): PlanLintInput {
  return { body: '', effort: 'M', hasArtifact: true, ...overrides };
}

describe('planLint (FLUX-1379)', () => {
  describe('B1 — leading TL;DR', () => {
    it('bounces a substantial body with no leading TL;DR', () => {
      const result = planLint(base({ body: `Some plan text.\n\n${AC_CHECKLIST}${filler(400)}` }));
      expect(result.bounces.map((f) => f.code)).toContain('B1');
    });

    it('passes with a plain `> TL;DR` blockquote (case-insensitive, no bold)', () => {
      const result = planLint(base({ body: `> tl;dr something\n\n${AC_CHECKLIST}${filler(400)}` }));
      expect(result.bounces.map((f) => f.code)).not.toContain('B1');
    });

    it('passes with the bold `> **TL;DR**` form', () => {
      const result = planLint(base({ body: `${TLDR}${AC_CHECKLIST}${filler(400)}` }));
      expect(result.bounces.map((f) => f.code)).not.toContain('B1');
    });

    it('does not require TL;DR for a short body', () => {
      const result = planLint(base({ body: `${AC_CHECKLIST}` }));
      expect(result.bounces.map((f) => f.code)).not.toContain('B1');
    });

    it('does not fire for a TL;DR appearing well past the leading window', () => {
      const result = planLint(base({ body: `${filler(700)}\n\n> **TL;DR** — too late.\n\n${AC_CHECKLIST}` }));
      expect(result.bounces.map((f) => f.code)).toContain('B1');
    });
  });

  describe('B2 — acceptance criteria checklist (M+ only)', () => {
    it('bounces M+ with no Acceptance criteria heading at all', () => {
      const result = planLint(base({ effort: 'M', body: `${TLDR}${filler(400)}` }));
      expect(result.bounces.map((f) => f.code)).toContain('B2');
    });

    it('bounces M+ with an Acceptance criteria heading but no checkbox', () => {
      const result = planLint(base({ effort: 'M', body: `${TLDR}## Acceptance criteria\n\nJust prose, no checkboxes.\n${filler(400)}` }));
      expect(result.bounces.map((f) => f.code)).toContain('B2');
    });

    it('passes M+ with a checklist under the heading', () => {
      const result = planLint(base({ effort: 'M', body: `${TLDR}${AC_CHECKLIST}${filler(400)}` }));
      expect(result.bounces.map((f) => f.code)).not.toContain('B2');
    });

    it('does not apply to XS/S', () => {
      const result = planLint(base({ effort: 'XS', body: 'Two sentences is fine.' }));
      expect(result.bounces.map((f) => f.code)).not.toContain('B2');
    });
  });

  describe('B3 — essentially empty body (M+ only)', () => {
    it('bounces an M+ ticket with a near-empty body', () => {
      const result = planLint(base({ effort: 'M', body: 'Too short.' }));
      expect(result.bounces.map((f) => f.code)).toContain('B3');
    });

    it('passes an M+ ticket once the body clears the threshold', () => {
      const result = planLint(base({ effort: 'M', body: `${TLDR}${AC_CHECKLIST}${filler(400)}` }));
      expect(result.bounces.map((f) => f.code)).not.toContain('B3');
    });

    it('does not apply to XS/S — short plans are legitimate there', () => {
      const result = planLint(base({ effort: 'S', body: 'Two sentences.' }));
      expect(result.bounces.map((f) => f.code)).not.toContain('B3');
    });
  });

  describe('B4 — Recommended Tests heading (L/XL only)', () => {
    it('bounces L/XL with no tests heading', () => {
      const result = planLint(base({ effort: 'L', body: `${TLDR}${AC_CHECKLIST}${filler(400)}` }));
      expect(result.bounces.map((f) => f.code)).toContain('B4');
    });

    it('accepts the `## Test plan` heading spelling too', () => {
      const result = planLint(base({ effort: 'XL', body: `${TLDR}${AC_CHECKLIST}## Test plan\n\nSomething.\n${filler(400)}` }));
      expect(result.bounces.map((f) => f.code)).not.toContain('B4');
    });

    it('passes L/XL with a Recommended Tests heading', () => {
      const result = planLint(base({ effort: 'L', body: `${TLDR}${AC_CHECKLIST}${TESTS_HEADING}${filler(400)}` }));
      expect(result.bounces.map((f) => f.code)).not.toContain('B4');
    });

    it('does not apply to M', () => {
      const result = planLint(base({ effort: 'M', body: `${TLDR}${AC_CHECKLIST}${filler(400)}` }));
      expect(result.bounces.map((f) => f.code)).not.toContain('B4');
    });
  });

  describe('B5 — effort unset', () => {
    it('bounces when effort is null/undefined/blank', () => {
      expect(planLint(base({ effort: null, body: `${TLDR}${AC_CHECKLIST}${filler(400)}` })).bounces.map((f) => f.code)).toContain('B5');
      expect(planLint(base({ effort: undefined, body: `${TLDR}${AC_CHECKLIST}${filler(400)}` })).bounces.map((f) => f.code)).toContain('B5');
      expect(planLint(base({ effort: '  ', body: `${TLDR}${AC_CHECKLIST}${filler(400)}` })).bounces.map((f) => f.code)).toContain('B5');
    });

    it('suppresses B2/B3/B4 when effort is unset (can\'t judge applicability)', () => {
      const result = planLint(base({ effort: null, body: 'short' }));
      expect(result.bounces.map((f) => f.code)).toEqual(['B5']);
    });

    it('an explicit "None" effort is treated as a set (M-tier) value, not unset', () => {
      const result = planLint(base({ effort: 'None', body: `${TLDR}${AC_CHECKLIST}${filler(400)}` }));
      expect(result.bounces.map((f) => f.code)).not.toContain('B5');
    });
  });

  describe('W1 — missing artifact (M+ only, warn not bounce)', () => {
    it('warns (never bounces) on an M+ plan with no artifact', () => {
      const result = planLint(base({ effort: 'M', hasArtifact: false, body: `${TLDR}${AC_CHECKLIST}${filler(400)}` }));
      expect(result.warns.map((f) => f.code)).toContain('W1');
      expect(result.bounces).toHaveLength(0);
    });

    it('is silent once an artifact exists', () => {
      const result = planLint(base({ effort: 'M', hasArtifact: true, body: `${TLDR}${AC_CHECKLIST}${filler(400)}` }));
      expect(result.warns).toHaveLength(0);
    });

    it('does not apply to XS/S', () => {
      const result = planLint(base({ effort: 'XS', hasArtifact: false, body: 'Two sentences.' }));
      expect(result.warns).toHaveLength(0);
    });
  });

  describe('W2 — oversize body (warn not bounce, FLUX-1584)', () => {
    it('warns once the body exceeds BODY_WARN_CHARS', () => {
      const result = planLint(base({ effort: 'M', body: `${TLDR}${AC_CHECKLIST}${filler(BODY_WARN_CHARS)}` }));
      expect(result.warns.map((f) => f.code)).toContain('W2');
      expect(result.bounces).toHaveLength(0);
    });

    it('is silent at exactly the threshold (over, not at-or-over)', () => {
      const result = planLint(base({ effort: 'M', body: filler(BODY_WARN_CHARS) }));
      expect(result.warns.map((f) => f.code)).not.toContain('W2');
    });

    it('is silent for a body under the threshold', () => {
      const result = planLint(base({ effort: 'M', body: `${TLDR}${AC_CHECKLIST}${filler(400)}` }));
      expect(result.warns.map((f) => f.code)).not.toContain('W2');
    });

    it('applies regardless of effort tier (XS/S included — the soft limit is universal)', () => {
      const result = planLint(base({ effort: 'XS', body: filler(BODY_WARN_CHARS + 1) }));
      expect(result.warns.map((f) => f.code)).toContain('W2');
    });

    it('names the char count in the message', () => {
      const body = filler(BODY_WARN_CHARS + 1);
      const result = planLint(base({ effort: 'M', body }));
      const w2 = result.warns.find((f) => f.code === 'W2');
      expect(w2?.message).toContain(String(body.length));
    });
  });

  describe('a clean M+ plan passes with no findings at all', () => {
    it('produces zero bounces and zero warns', () => {
      const result = planLint(base({ effort: 'L', hasArtifact: true, body: `${TLDR}${AC_CHECKLIST}${TESTS_HEADING}${filler(400)}` }));
      expect(result.bounces).toHaveLength(0);
      expect(result.warns).toHaveLength(0);
    });
  });
});

describe('formatLintFindings', () => {
  it('renders one bullet per finding with the code bolded', () => {
    expect(formatLintFindings([{ code: 'B1', message: 'missing TL;DR' }, { code: 'B5', message: 'no effort' }]))
      .toBe('- **B1**: missing TL;DR\n- **B5**: no effort');
  });

  it('renders an empty string for no findings', () => {
    expect(formatLintFindings([])).toBe('');
  });
});
