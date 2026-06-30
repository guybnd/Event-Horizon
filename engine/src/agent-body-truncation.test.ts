import { describe, it, expect } from 'vitest';
import { truncateBodyForAgent, AGENT_BODY_LIMIT } from './task-store.js';

/**
 * FLUX-879: AXI #3 content-truncation-with-size-hint applied to the ticket `body`
 * in the agent view. `truncateBodyForAgent` is pure + exported so the trim/hint logic
 * is exercised without building a full task (mirrors the `evaluateWorktreeReadyRefusal`
 * / `describeEmptyTicketList` / `nextStepForStatus` idiom).
 */
describe('truncateBodyForAgent (FLUX-879 body truncation)', () => {
  it('passes a normal-sized body through untouched (returns {})', () => {
    expect(truncateBodyForAgent('a short plan')).toEqual({});
  });

  it('passes a body exactly at the limit through untouched', () => {
    const atLimit = 'x'.repeat(AGENT_BODY_LIMIT);
    expect(truncateBodyForAgent(atLimit)).toEqual({});
  });

  it('truncates an oversized body, keeping the head + a recoverable size hint', () => {
    const omitted = 5_000;
    const big = 'x'.repeat(AGENT_BODY_LIMIT + omitted);
    const r = truncateBodyForAgent(big);
    expect(r.bodyTruncated).toBe(true);
    expect(r.bodyOmittedChars).toBe(omitted);
    // Head is kept (up to the limit) and the hint names the escape hatch.
    expect(r.body!.startsWith('x'.repeat(AGENT_BODY_LIMIT))).toBe(true);
    expect(r.body).toContain('fullBody:true');
    expect(r.body).toContain(`${omitted} of ${big.length}`);
    // The returned body is far smaller than the original (the whole point).
    expect(r.body!.length).toBeLessThan(big.length);
  });

  it('honors the fullBody escape hatch (returns {} even when oversized)', () => {
    const big = 'x'.repeat(AGENT_BODY_LIMIT + 10_000);
    expect(truncateBodyForAgent(big, true)).toEqual({});
  });

  it('leaves a non-string body alone (returns {})', () => {
    expect(truncateBodyForAgent(undefined)).toEqual({});
    expect(truncateBodyForAgent(null)).toEqual({});
  });
});
