import { describe, it, expect } from 'vitest';
import { isContextExhaustionError } from './claude-code.js';

// FLUX-1047: the Furnace stoker retries a charge whose session died from context-window exhaustion
// (recoverable — a fresh session helps) instead of parking it. That hinges on this classifier correctly
// separating a context overflow from a real crash / API error / permission denial / usage-limit throttle.
// The matcher is deliberately CONSERVATIVE: a false positive would burn a retry on a truly-broken charge.
//
// Co-located in agents/ (like copilot-mcp-config.test.ts) because it deep-imports a concrete adapter file,
// which the adapter-boundary guard forbids outside agents/.
describe('isContextExhaustionError — context-window overflow classifier (FLUX-1047)', () => {
  it('matches known context-window overflow signatures', () => {
    const positives = [
      'prompt is too long: 250000 tokens > 200000 maximum',
      'API Error: 400 prompt is too long',
      'context_length_exceeded',
      'context length exceeded',
      'This request exceeds the maximum context length for this model',
      'The input exceeds the context window',
      'the conversation is too large to fit in the context window',
      'Context window overflow',
      'too many tokens',
    ];
    for (const msg of positives) {
      expect(isContextExhaustionError(msg), msg).toBe(true);
    }
  });

  it('does NOT match unrelated failures (conservative — anything else parks)', () => {
    const negatives = [
      'permission denied',
      'tool not allowed',
      'API Error: 500 Internal Server Error',
      'Overloaded',
      'invalid request: missing field',
      'rate_limit_event',
      'usage limit reached, resets at 5pm',
      'ECONNRESET',
      'unknown',
      '',
      undefined,
      null,
    ];
    for (const msg of negatives) {
      expect(isContextExhaustionError(msg), String(msg)).toBe(false);
    }
  });
});
