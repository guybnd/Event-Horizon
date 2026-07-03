import { describe, it, expect } from 'vitest';
import { isRateLimitError, isContextExhaustionError } from './claude-code.js';

// FLUX-1063: the Furnace stoker cools a charge down and auto-retries (rather than parking) when its
// session died from a TRANSIENT usage/rate limit. That hinges on this classifier separating a usage/rate
// limit from a context overflow (recovered differently) and from a real crash. It is deliberately
// disjoint from isContextExhaustionError: a context overflow must NOT be misread as a rate limit.
//
// Co-located in agents/ (like claude-code-context-exhaustion.test.ts) because it deep-imports a concrete
// adapter file, which the adapter-boundary guard forbids outside agents/.
describe('isRateLimitError — usage/rate-limit classifier (FLUX-1063)', () => {
  it('matches known usage/rate-limit signatures', () => {
    const positives = [
      "You've hit your session limit · resets 4:10am",
      'Rate limited: rejected [five_hour] (resets at 2026-07-02T18:10:00.000Z)',
      'rate_limit_event',
      'rate-limited',
      'usage limit reached, resets at 5pm',
      'API Error: 429 Too Many Requests',
      'HTTP 429',
      'quota exceeded for this account',
      'Overloaded',
    ];
    for (const msg of positives) {
      expect(isRateLimitError(msg), msg).toBe(true);
    }
  });

  it('does NOT match unrelated failures (conservative — anything else parks)', () => {
    const negatives = [
      'permission denied',
      'tool not allowed',
      'API Error: 500 Internal Server Error',
      'invalid request: missing field',
      'ECONNRESET',
      'unknown',
      '',
      undefined,
      null,
    ];
    for (const msg of negatives) {
      expect(isRateLimitError(msg), String(msg)).toBe(false);
    }
  });

  it('is disjoint from the context-exhaustion classifier (a context overflow is not a rate limit)', () => {
    const contextOverflows = [
      'prompt is too long: 250000 tokens > 200000 maximum',
      'context_length_exceeded',
      'This request exceeds the maximum context length for this model',
    ];
    for (const msg of contextOverflows) {
      expect(isContextExhaustionError(msg), msg).toBe(true);
      expect(isRateLimitError(msg), msg).toBe(false);
    }
  });
});
