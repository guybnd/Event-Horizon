import { describe, it, expect } from 'vitest';
import { isSafeStreamId } from './transcript.js';

/**
 * FLUX-833 review (M4): `isSafeStreamId` gates an agent-supplied `conversationId` before it becomes
 * a transcript filename segment (`${id}.jsonl`). It must accept real stream ids (ticket ids + the
 * `__board__` sentinel) and reject anything that could escape the transcripts dir.
 */
describe('isSafeStreamId (transcript stream-id validator)', () => {
  it('accepts real ticket ids and the board sentinel', () => {
    for (const id of ['FLUX-833', 'PR-141', '__board__', 'ABC-1', 'a.b-c_d']) {
      expect(isSafeStreamId(id)).toBe(true);
    }
  });

  it('rejects path separators, parent refs, and other escape attempts', () => {
    for (const id of ['../evil', '..\\evil', 'a/b', 'a\\b', '..', '.', 'foo/..', 'a/../b', '', ' ', 'a b', 'a\0b']) {
      expect(isSafeStreamId(id)).toBe(false);
    }
  });

  it('rejects an over-long id', () => {
    expect(isSafeStreamId('x'.repeat(129))).toBe(false);
    expect(isSafeStreamId('x'.repeat(128))).toBe(true);
  });
});
