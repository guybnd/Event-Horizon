import { describe, it, expect } from 'vitest';
import { hasCompletionContent } from './completionSummary';

/**
 * FLUX-1147: `hasCompletionContent` gates the `CompletionSummary` render — an explicit `{}` (or a
 * payload with only empty arrays) must render nothing extra, matching the engine sanitizer's
 * "stored as empty" contract for an explicitly-empty `completion` object.
 */
describe('hasCompletionContent (FLUX-1147)', () => {
  it('is false for null/undefined', () => {
    expect(hasCompletionContent(null)).toBe(false);
    expect(hasCompletionContent(undefined)).toBe(false);
  });

  it('is false for an empty object', () => {
    expect(hasCompletionContent({})).toBe(false);
  });

  it('is false when every array field is present but empty', () => {
    expect(hasCompletionContent({ changedFiles: [], validation: [], decisions: [] })).toBe(false);
  });

  it('is true when changedFiles has at least one entry', () => {
    expect(hasCompletionContent({ changedFiles: ['a.ts'] })).toBe(true);
  });

  it('is true when validation has at least one entry', () => {
    expect(hasCompletionContent({ validation: [{ command: 'npm test', passed: true }] })).toBe(true);
  });

  it('is true when decisions has at least one entry', () => {
    expect(hasCompletionContent({ decisions: ['did a thing'] })).toBe(true);
  });

  it('is true for a non-empty residualRisk string, false for an empty one', () => {
    expect(hasCompletionContent({ residualRisk: 'some risk' })).toBe(true);
    expect(hasCompletionContent({ residualRisk: '' })).toBe(false);
  });

  it('docsUpdated: true/false booleans both count as content; an empty array does not', () => {
    expect(hasCompletionContent({ docsUpdated: true })).toBe(true);
    expect(hasCompletionContent({ docsUpdated: false })).toBe(true);
    expect(hasCompletionContent({ docsUpdated: [] })).toBe(false);
    expect(hasCompletionContent({ docsUpdated: ['README.md'] })).toBe(true);
  });
});
