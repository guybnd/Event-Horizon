// FLUX-1469: focus text is dynamic facts + verdict contract + one-line check stubs + a pull pointer
// for full methodology — not the full ~2.4KB static paragraph set pushed (and re-persisted) on every
// pass. These tests are the load-bearing safety net: the verdict contract must never move behind a
// pull, and every check's stub must survive the split (no check silently dropped).

import { describe, it, expect } from 'vitest';
import {
  planReviewFocus,
  PLAN_VERDICT_CONTRACT,
  METHODOLOGY_PULL_POINTER,
  ANCHOR_CHECK,
  REGROUND_CHECK,
  AC_COVERAGE_CHECK,
  CONSEQUENCE_CHECK,
  DUPLICATE_CHECK,
  ADVERSARIAL_CHECK,
} from './gate-runner.js';
import { planLint, formatLintFindings, BODY_WARN_CHARS } from './models/plan-lint.js';

describe('planReviewFocus (FLUX-1469 text-split)', () => {
  it('carries the verdict contract verbatim at every depth', () => {
    for (const depth of ['quick', 'standard', 'thorough'] as const) {
      expect(planReviewFocus(depth, true)).toContain(PLAN_VERDICT_CONTRACT);
    }
  });

  it('names the exact read_skill pull call', () => {
    expect(planReviewFocus('thorough', true)).toContain(METHODOLOGY_PULL_POINTER);
    expect(METHODOLOGY_PULL_POINTER).toContain("read_skill('orchestrator', 'Plan-review methodology')");
  });

  it('quick depth includes only the anchor + artifact stubs', () => {
    const focus = planReviewFocus('quick', true);
    expect(focus).toContain(ANCHOR_CHECK);
    expect(focus).not.toContain(REGROUND_CHECK);
    expect(focus).not.toContain(AC_COVERAGE_CHECK);
    expect(focus).not.toContain(CONSEQUENCE_CHECK);
    expect(focus).not.toContain(DUPLICATE_CHECK);
    expect(focus).not.toContain(ADVERSARIAL_CHECK);
  });

  it('standard depth adds reground + AC-coverage + consequence-tracing stubs, not duplicate/adversarial (FLUX-1480)', () => {
    const focus = planReviewFocus('standard', true);
    expect(focus).toContain(ANCHOR_CHECK);
    expect(focus).toContain(REGROUND_CHECK);
    expect(focus).toContain(AC_COVERAGE_CHECK);
    expect(focus).toContain(CONSEQUENCE_CHECK);
    expect(focus).not.toContain(DUPLICATE_CHECK);
    expect(focus).not.toContain(ADVERSARIAL_CHECK);
  });

  it('thorough depth includes every check stub (no check silently dropped by the split)', () => {
    const focus = planReviewFocus('thorough', true);
    for (const stub of [ANCHOR_CHECK, REGROUND_CHECK, AC_COVERAGE_CHECK, CONSEQUENCE_CHECK, DUPLICATE_CHECK, ADVERSARIAL_CHECK]) {
      expect(focus).toContain(stub);
    }
  });

  it('shrank meaningfully vs. the pre-split full-paragraph shape (each stub is a one-liner, not a paragraph)', () => {
    for (const stub of [ANCHOR_CHECK, REGROUND_CHECK, AC_COVERAGE_CHECK, CONSEQUENCE_CHECK, DUPLICATE_CHECK, ADVERSARIAL_CHECK]) {
      expect(stub.length).toBeLessThan(180);
    }
  });

  it('the artifact fact (dynamic, lint-injected) stays pushed verbatim for both hasArtifact states', () => {
    expect(planReviewFocus('quick', true)).toContain('a plan artifact revision has already been published');
    expect(planReviewFocus('quick', false)).toContain('no `publish_artifact` revision exists');
  });

  it('appends lint findings verbatim when present', () => {
    const focus = planReviewFocus('quick', true, 'W1: no artifact published');
    expect(focus).toContain('W1: no artifact published');
  });

  it('an oversize body (W2, FLUX-1584) rides the deterministic-lint path into the dispatched focus', () => {
    const lint = planLint({ body: 'x'.repeat(BODY_WARN_CHARS + 1), effort: 'M', hasArtifact: true });
    const focus = planReviewFocus('quick', true, formatLintFindings(lint.warns));
    expect(focus).toContain('W2');
    expect(focus).toContain(`soft limit ${BODY_WARN_CHARS}`);
  });
});
