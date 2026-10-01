// FLUX-1739: concurrent runs must never share a ticket id.
//
// Found live during the first real multi-cell suite: two cells both minted `BENCH-2`, and the second
// died with "a worktree already exists ... on a different branch". `createTask` derives the next id
// by scanning for the current max and then AWAITS before writing the new ticket, so two callers that
// overlap across that await both compute `maxId + 1`.
//
// This matters more than a duplicate id: `taskWorktreeDir` derives the worktree path purely from the
// ticket id, so an id collision is also a worktree collision — which destroys the one-ticket-per-run
// premise that makes N repetitions of a single seed representable at all.
import { describe, it, expect } from 'vitest';
import { withTicketMintLock } from './benchmark-runner.js';

describe('withTicketMintLock', () => {
  it('serializes callers that would otherwise interleave across an await', async () => {
    // Models createTask's actual shape: read a shared counter, await, then write it back.
    let counter = 1;
    const minted: number[] = [];
    const mintRacy = async () => {
      const seen = counter;
      await new Promise((r) => setTimeout(r, 5)); // the getMaxIdFromRemote await
      counter = seen + 1;
      minted.push(seen + 1);
    };

    await Promise.all([1, 2, 3, 4].map(() => withTicketMintLock(mintRacy)));

    expect(minted).toEqual([2, 3, 4, 5]);
    expect(new Set(minted).size).toBe(4); // the property that actually matters: all distinct
  });

  it('WOULD collide without the lock — pins the bug this exists to prevent', async () => {
    let counter = 1;
    const minted: number[] = [];
    const mintRacy = async () => {
      const seen = counter;
      await new Promise((r) => setTimeout(r, 5));
      counter = seen + 1;
      minted.push(seen + 1);
    };

    await Promise.all([1, 2].map(() => mintRacy()));

    // Both saw counter === 1 before either wrote back, so both minted the same id.
    expect(new Set(minted).size).toBe(1);
  });

  it('releases the chain when a caller throws, so one failure cannot wedge minting', async () => {
    await expect(withTicketMintLock(async () => { throw new Error('mint failed'); })).rejects.toThrow('mint failed');
    await expect(withTicketMintLock(async () => 'ok')).resolves.toBe('ok');
  });

  it('returns each caller its own value', async () => {
    const out = await Promise.all([
      withTicketMintLock(async () => 'a'),
      withTicketMintLock(async () => 'b'),
      withTicketMintLock(async () => 'c'),
    ]);
    expect(out).toEqual(['a', 'b', 'c']);
  });
});
