import { describe, it, expect } from 'vitest';
import {
  clipExcerpt, clearPlanReviewDraft, formatArtifactAnnotations, formatRegroomNotes, loadPlanReviewDraft,
  savePlanReviewDraft, PLAN_ANNOTATION_EXCERPT_MAX, type ArtifactAnnotation,
} from './planAnnotations';

describe('clipExcerpt (FLUX-1303)', () => {
  it('collapses whitespace and trims', () => {
    expect(clipExcerpt('  make the\n  TL;DR   bigger  ')).toBe('make the TL;DR bigger');
  });

  it('clips overlong selections with an ellipsis', () => {
    const long = 'x'.repeat(PLAN_ANNOTATION_EXCERPT_MAX + 50);
    const clipped = clipExcerpt(long);
    expect(clipped.length).toBe(PLAN_ANNOTATION_EXCERPT_MAX + 1); // +1 for the ellipsis
    expect(clipped.endsWith('…')).toBe(true);
  });
});

describe('formatRegroomNotes (FLUX-1303)', () => {
  it('bundles region-anchored annotations ahead of the freeform notes', () => {
    const out = formatRegroomNotes(
      [
        { excerpt: 'detect a TL;DR blockquote', note: 'use the primary accent, not amber' },
        { excerpt: 'npm run check passes', note: 'also add a vitest case' },
      ],
      'General: keep the diff small.',
    );
    expect(out).toBe(
      '🎯 Plan annotations · 2 regions:\n\n' +
      '> detect a TL;DR blockquote\nuse the primary accent, not amber\n\n' +
      '> npm run check passes\nalso add a vitest case\n\n' +
      'General: keep the diff small.',
    );
  });

  it('works with only annotations, only freeform, or neither', () => {
    expect(formatRegroomNotes([{ excerpt: 'a', note: 'b' }], '  ')).toBe('🎯 Plan annotations · 1 region:\n\n> a\nb');
    expect(formatRegroomNotes([], ' just this ')).toBe('just this');
    expect(formatRegroomNotes([], '')).toBe('');
  });
});

describe('formatArtifactAnnotations — guided-control kinds (FLUX-1440)', () => {
  const base: Omit<ArtifactAnnotation, 'kind' | 'value'> = {
    id: 1,
    selector: '#delay-slider',
    text: '',
    label: '',
    note: '',
    rev: 3,
  };

  it('renders the captured value for a feel annotation', () => {
    const out = formatArtifactAnnotations([{ ...base, kind: 'feel', value: '340' }]);
    expect(out).toContain('· value: `340`');
  });

  it('uses label as a descriptive prefix when present (the engine bakes any unit into value itself)', () => {
    const out = formatArtifactAnnotations([{ ...base, kind: 'feel', value: '340ms', label: 'Scroll speed' }]);
    expect(out).toContain('· Scroll speed: `340ms`');
  });

  it('renders the chosen option for a decision annotation', () => {
    const out = formatArtifactAnnotations([{ ...base, kind: 'decision', value: 'auto' }]);
    expect(out).toContain('→ chose `auto`');
  });

  it('prefixes a decision with its question when label is present', () => {
    const out = formatArtifactAnnotations([{ ...base, kind: 'decision', value: 'auto', label: 'Empty-state treatment?' }]);
    expect(out).toContain('→ Empty-state treatment? — chose `auto`');
  });

  it('falls back to existing text/element rendering when value is absent', () => {
    const feelNoValue = formatArtifactAnnotations([{ ...base, kind: 'feel', text: 'a control' }]);
    expect(feelNoValue).not.toContain('value:');
    expect(feelNoValue).toContain('> a control');

    const decisionNoValue = formatArtifactAnnotations([{ ...base, kind: 'decision', label: 'a picker' }]);
    expect(decisionNoValue).not.toContain('chose');
    expect(decisionNoValue).toContain('> (no excerpt)');
  });

  it('appends a raw right-click element capture\'s value so it is not dropped', () => {
    const out = formatArtifactAnnotations([{ ...base, kind: 'element', label: 'input#delay', value: '340' }]);
    expect(out).toContain('⊙ `input#delay` = `340`');
  });

  it('renders an element annotation with no captured value exactly as before', () => {
    const out = formatArtifactAnnotations([{ ...base, kind: 'element', label: 'div.card' }]);
    expect(out).toContain('⊙ `div.card`\n');
    expect(out).not.toContain('=');
  });
});

describe('plan-review draft store (FLUX-1303)', () => {
  it('persists a draft per ticket outside any component scope and clears on demand', () => {
    savePlanReviewDraft('FLUX-1', { annotations: [{ excerpt: 'a', note: 'b' }], notes: 'freeform' });
    savePlanReviewDraft('FLUX-2', { annotations: [], notes: 'other ticket' });
    expect(loadPlanReviewDraft('FLUX-1')).toEqual({ annotations: [{ excerpt: 'a', note: 'b' }], notes: 'freeform' });
    expect(loadPlanReviewDraft('FLUX-2').notes).toBe('other ticket');
    clearPlanReviewDraft('FLUX-1');
    expect(loadPlanReviewDraft('FLUX-1')).toEqual({ annotations: [], notes: '' });
    expect(loadPlanReviewDraft('FLUX-2').notes).toBe('other ticket');
    clearPlanReviewDraft('FLUX-2');
  });

  it('prunes an emptied draft instead of storing blanks', () => {
    savePlanReviewDraft('FLUX-3', { annotations: [{ excerpt: 'a', note: 'b' }], notes: '' });
    savePlanReviewDraft('FLUX-3', { annotations: [], notes: '   ' });
    expect(loadPlanReviewDraft('FLUX-3')).toEqual({ annotations: [], notes: '' });
  });
});

describe('plan-review draft staleness (FLUX-1306)', () => {
  it('drops a draft whose bodyHash no longer matches the current plan (composed against superseded text)', () => {
    savePlanReviewDraft('FLUX-4', { annotations: [{ excerpt: 'old excerpt', note: 'note' }], notes: 'stale', bodyHash: 'hash-a' });
    expect(loadPlanReviewDraft('FLUX-4', 'hash-b')).toEqual({ annotations: [], notes: '' });
    // Dropping it is also destructive (not just filtered on read) — a later load with no hash check sees nothing either.
    expect(loadPlanReviewDraft('FLUX-4')).toEqual({ annotations: [], notes: '' });
  });

  it('keeps a draft whose bodyHash still matches the current plan', () => {
    savePlanReviewDraft('FLUX-5', { annotations: [{ excerpt: 'e', note: 'n' }], notes: 'fresh', bodyHash: 'hash-a' });
    expect(loadPlanReviewDraft('FLUX-5', 'hash-a')).toEqual({ annotations: [{ excerpt: 'e', note: 'n' }], notes: 'fresh', bodyHash: 'hash-a' });
    clearPlanReviewDraft('FLUX-5');
  });

  it('does not treat a draft with no recorded bodyHash as stale (fail open for older drafts)', () => {
    savePlanReviewDraft('FLUX-6', { annotations: [], notes: 'no hash recorded' });
    expect(loadPlanReviewDraft('FLUX-6', 'hash-b').notes).toBe('no hash recorded');
    clearPlanReviewDraft('FLUX-6');
  });
});
