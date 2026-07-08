import { describe, it, expect } from 'vitest';
import {
  clipExcerpt, clearPlanReviewDraft, formatRegroomNotes, loadPlanReviewDraft, savePlanReviewDraft,
  PLAN_ANNOTATION_EXCERPT_MAX,
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
