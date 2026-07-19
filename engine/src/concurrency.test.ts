import { describe, it, expect } from 'vitest';
import { runWithConcurrency } from './concurrency.js';

describe('runWithConcurrency (FLUX-1547)', () => {
  it('processes every item exactly once', async () => {
    const items = Array.from({ length: 37 }, (_, i) => i);
    const seen: number[] = [];
    await runWithConcurrency(items, 8, async (item) => {
      seen.push(item);
    });
    expect(seen.slice().sort((a, b) => a - b)).toEqual(items);
  });

  it('never runs more than `concurrency` workers at once', async () => {
    const items = Array.from({ length: 20 }, (_, i) => i);
    let active = 0;
    let maxActive = 0;
    await runWithConcurrency(items, 4, async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setImmediate(resolve));
      active -= 1;
    });
    expect(maxActive).toBeLessThanOrEqual(4);
    expect(maxActive).toBeGreaterThan(1);
  });

  it('clamps the pool size to the item count', async () => {
    const items = [1, 2];
    let active = 0;
    let maxActive = 0;
    await runWithConcurrency(items, 16, async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setImmediate(resolve));
      active -= 1;
    });
    expect(maxActive).toBeLessThanOrEqual(2);
  });

  it('resolves immediately for an empty item list', async () => {
    let ran = false;
    await runWithConcurrency([], 8, async () => {
      ran = true;
    });
    expect(ran).toBe(false);
  });

  it('propagates a worker error out of the pool', async () => {
    await expect(
      runWithConcurrency([1, 2, 3], 2, async (item) => {
        if (item === 2) throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
  });
});
