import { describe, it, expect, beforeEach } from 'vitest';
import { validateParentLink, subtaskIds, tasksCache } from './task-store.js';

/**
 * FLUX-1068: `update_ticket` (and the REST PUT route) can now (re)link existing tickets under a
 * parent. Both surfaces share `validateParentLink` to reject self-parenting and cycles before any
 * write, and `subtaskIds` to normalize a `subtasks` frontmatter array to a plain string[].
 */
describe('validateParentLink (FLUX-1068)', () => {
  beforeEach(() => {
    // Reset the shared cache to a small ancestry chain: A → B → C (B's parent is A, C's parent is B).
    for (const k of Object.keys(tasksCache)) delete tasksCache[k];
    tasksCache['FLUX-A'] = { id: 'FLUX-A' };
    tasksCache['FLUX-B'] = { id: 'FLUX-B', parentId: 'FLUX-A' };
    tasksCache['FLUX-C'] = { id: 'FLUX-C', parentId: 'FLUX-B' };
    tasksCache['FLUX-D'] = { id: 'FLUX-D' };
  });

  it('allows a valid new parent link', () => {
    expect(validateParentLink('FLUX-D', 'FLUX-A')).toBeNull();
  });

  it('allows detaching (null/undefined parent)', () => {
    expect(validateParentLink('FLUX-C', null)).toBeNull();
    expect(validateParentLink('FLUX-C', undefined)).toBeNull();
  });

  it('rejects self-parenting', () => {
    const err = validateParentLink('FLUX-A', 'FLUX-A');
    expect(err).toContain('its own parent');
  });

  it('rejects a direct cycle (A under B when B is under A)', () => {
    // A is an ancestor of B, so parenting A under B would close the loop.
    const err = validateParentLink('FLUX-A', 'FLUX-B');
    expect(err).toContain('cycle');
  });

  it('rejects a deep cycle (A under C when A→B→C)', () => {
    const err = validateParentLink('FLUX-A', 'FLUX-C');
    expect(err).toContain('cycle');
  });

  it('does not loop forever on a pre-existing cycle in the data', () => {
    tasksCache['FLUX-X'] = { id: 'FLUX-X', parentId: 'FLUX-Y' };
    tasksCache['FLUX-Y'] = { id: 'FLUX-Y', parentId: 'FLUX-X' };
    // FLUX-D is not part of the broken loop, so the walk terminates and the link is allowed.
    expect(validateParentLink('FLUX-D', 'FLUX-X')).toBeNull();
  });
});

describe('subtaskIds (FLUX-1068)', () => {
  it('normalizes string ids, legacy inline {id} objects, and drops empties', () => {
    expect(subtaskIds(['FLUX-1', { id: 'FLUX-2' }, { title: 'no id' }, null, ''])).toEqual([
      'FLUX-1',
      'FLUX-2',
    ]);
  });

  it('returns [] for non-array input', () => {
    expect(subtaskIds(undefined)).toEqual([]);
    expect(subtaskIds(null)).toEqual([]);
  });
});
