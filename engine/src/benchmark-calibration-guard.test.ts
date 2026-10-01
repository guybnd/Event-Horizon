import { describe, it, expect } from 'vitest';
import { looksLikeNoTestsRan, looksLikeTestTimeout } from './benchmark-validation.js';

describe('looksLikeTestTimeout', () => {
  it('recognises vitest and jest per-test timeouts', () => {
    expect(looksLikeTestTimeout('Error: Test timed out in 30000ms.\n ❯ src/x.test.ts:12:3')).toBe(true);
    expect(looksLikeTestTimeout('thrown: "Exceeded timeout of 5000 ms for a test."')).toBe(true);
  });

  it('does not fire on an ordinary assertion failure or empty output', () => {
    expect(looksLikeTestTimeout('AssertionError: expected 1 to be 2')).toBe(false);
    expect(looksLikeTestTimeout(undefined)).toBe(false);
  });
});

// Calibration accepts a seed when the held-out check exits non-zero at base. A runner that exits
// non-zero because it could not run ANY test (config incompatible with the shared node_modules,
// missing file) must not count — observed live on an older seed, where vitest exited 1 with
// "no tests / 1 error" and the suite calibrated as genuine.

describe('looksLikeNoTestsRan', () => {
  it('flags vitest with no test files and an unhandled error', () => {
    expect(looksLikeNoTestsRan(' Test Files  no tests\n      Tests  no tests\n     Errors  1 error\n')).toBe(true);
  });

  it('flags jest "No tests found"', () => {
    expect(looksLikeNoTestsRan('No tests found, exiting with code 1')).toBe(true);
  });

  it('does NOT flag a genuine failing run', () => {
    expect(looksLikeNoTestsRan(' Test Files  1 failed (1)\n      Tests  5 failed | 2 passed (7)\n')).toBe(false);
  });

  it('does NOT flag a run with errors AND real test counts — that is a failing seed, not a broken runner', () => {
    expect(looksLikeNoTestsRan('     Errors  1 error\n      Tests  3 failed | 1 passed (4)\n')).toBe(false);
  });

  it('is false on empty output', () => {
    expect(looksLikeNoTestsRan(undefined)).toBe(false);
    expect(looksLikeNoTestsRan('')).toBe(false);
  });
});
