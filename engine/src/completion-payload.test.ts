import { describe, it, expect } from 'vitest';
import {
  sanitizeCompletion,
  COMPLETION_MAX_CHANGED_FILES,
  COMPLETION_MAX_VALIDATION_ENTRIES,
  COMPLETION_MAX_DECISIONS,
  COMPLETION_MAX_DECISION_LENGTH,
  COMPLETION_MAX_RESIDUAL_RISK_LENGTH,
  COMPLETION_MAX_SERIALIZED_BYTES,
} from './completion-payload.js';

/**
 * FLUX-1147: `sanitizeCompletion` is the pure, best-effort validator behind the `completion` param
 * on `change_status` / `finish_ticket`. It must NEVER throw — malformed/oversized input is
 * dropped/truncated instead of rejected, since a garbage payload must never block a status move.
 */
describe('sanitizeCompletion (FLUX-1147)', () => {
  it('passes a valid full payload through unchanged', () => {
    const input = {
      changedFiles: ['engine/src/foo.ts', 'portal/src/Bar.tsx'],
      validation: [{ command: 'npm run typecheck', passed: true }],
      decisions: ['Used a frontmatter field instead of a history entry.'],
      residualRisk: 'None identified.',
      docsUpdated: ['.docs/event-horizon/reference/mcp-tools.md'],
    };
    expect(sanitizeCompletion(input)).toEqual(input);
  });

  it('accepts docsUpdated as a boolean', () => {
    expect(sanitizeCompletion({ docsUpdated: true })).toEqual({ docsUpdated: true });
    expect(sanitizeCompletion({ docsUpdated: false })).toEqual({ docsUpdated: false });
  });

  it('is undefined when raw is absent, null, an array, or a non-object', () => {
    expect(sanitizeCompletion(undefined)).toBeUndefined();
    expect(sanitizeCompletion(null)).toBeUndefined();
    expect(sanitizeCompletion([1, 2, 3])).toBeUndefined();
    expect(sanitizeCompletion('garbage string')).toBeUndefined();
    expect(sanitizeCompletion(42)).toBeUndefined();
  });

  it('stores an explicit empty object as empty (not undefined)', () => {
    expect(sanitizeCompletion({})).toEqual({});
  });

  it('drops wrong-typed fields instead of throwing, keeping the valid ones', () => {
    const result = sanitizeCompletion({
      changedFiles: 'not-an-array',
      validation: 123,
      decisions: [1, 2, { not: 'a string' }, 'a real decision'],
      residualRisk: 999,
      docsUpdated: { not: 'valid' },
      unknownField: 'ignored',
    });
    expect(result).toEqual({ decisions: ['a real decision'] });
  });

  it('drops malformed validation entries (missing command/passed, wrong types) but keeps valid ones', () => {
    const result = sanitizeCompletion({
      validation: [
        { command: 'npm test', passed: true },
        { command: 'npm run lint' }, // missing passed
        { passed: false }, // missing command
        { command: 123, passed: true }, // wrong type
        { command: 'npm run build', passed: 'yes' }, // wrong type
      ],
    });
    expect(result).toEqual({ validation: [{ command: 'npm test', passed: true }] });
  });

  it('caps changedFiles at COMPLETION_MAX_CHANGED_FILES entries', () => {
    const files = Array.from({ length: COMPLETION_MAX_CHANGED_FILES + 50 }, (_, i) => `file-${i}.ts`);
    const result = sanitizeCompletion({ changedFiles: files });
    expect(result?.changedFiles).toHaveLength(COMPLETION_MAX_CHANGED_FILES);
    expect(result?.changedFiles?.[0]).toBe('file-0.ts');
  });

  it('caps validation at COMPLETION_MAX_VALIDATION_ENTRIES entries', () => {
    const entries = Array.from({ length: COMPLETION_MAX_VALIDATION_ENTRIES + 10 }, (_, i) => ({
      command: `cmd-${i}`,
      passed: true,
    }));
    const result = sanitizeCompletion({ validation: entries });
    expect(result?.validation).toHaveLength(COMPLETION_MAX_VALIDATION_ENTRIES);
  });

  it('caps decisions at COMPLETION_MAX_DECISIONS entries and truncates long strings', () => {
    const decisions = Array.from({ length: COMPLETION_MAX_DECISIONS + 5 }, (_, i) => `decision ${i}`);
    const result = sanitizeCompletion({ decisions });
    expect(result?.decisions).toHaveLength(COMPLETION_MAX_DECISIONS);

    const longDecision = 'x'.repeat(COMPLETION_MAX_DECISION_LENGTH + 100);
    const truncated = sanitizeCompletion({ decisions: [longDecision] });
    expect(truncated?.decisions?.[0]?.length).toBe(COMPLETION_MAX_DECISION_LENGTH);
  });

  it('truncates an oversized residualRisk string to the cap', () => {
    const huge = 'r'.repeat(COMPLETION_MAX_RESIDUAL_RISK_LENGTH + 5000);
    const result = sanitizeCompletion({ residualRisk: huge });
    expect(result?.residualRisk?.length).toBe(COMPLETION_MAX_RESIDUAL_RISK_LENGTH);
  });

  it('never throws and stays within the overall serialized size cap for a maximal adversarial payload', () => {
    const files = Array.from({ length: 500 }, (_, i) => `a/very/long/nested/path/for/file-number-${i}.ts`);
    const validation = Array.from({ length: 200 }, (_, i) => ({ command: `some very long command ${i} `.repeat(5), passed: i % 2 === 0 }));
    const decisions = Array.from({ length: 100 }, (_, i) => `a fairly long decision string number ${i} `.repeat(10));
    const residualRisk = 'z'.repeat(50_000);

    let result: ReturnType<typeof sanitizeCompletion>;
    expect(() => {
      result = sanitizeCompletion({ changedFiles: files, validation, decisions, residualRisk });
    }).not.toThrow();

    expect(Buffer.byteLength(JSON.stringify(result), 'utf-8')).toBeLessThanOrEqual(COMPLETION_MAX_SERIALIZED_BYTES);
  });

  it('never throws on deeply malformed/garbage top-level input shapes', () => {
    const garbageInputs: unknown[] = [
      { changedFiles: [{}, [], null, undefined, 5] },
      { validation: ['a', 'b', null, 5, true] },
      { residualRisk: {} },
      { docsUpdated: 123 },
      Symbol('nope'),
      () => {},
      new Date(),
    ];
    for (const garbage of garbageInputs) {
      expect(() => sanitizeCompletion(garbage)).not.toThrow();
    }
  });
});
