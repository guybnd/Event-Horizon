import { describe, it, expect } from 'vitest';
import { truncateMiddle, groupRegistrationGaps, parentDirOf, multiRepoNudge, groupWorkspaces, resolveDocEditability } from './utils';
import type { GroupStatus, GroupMemberSummary, WorkspaceInfo } from './api';
import type { Doc } from './types';

describe('truncateMiddle', () => {
  it('returns the string unchanged when shorter than maxLen', () => {
    expect(truncateMiddle('short', 10)).toBe('short');
  });

  it('returns the string unchanged when exactly maxLen', () => {
    expect(truncateMiddle('abcdefg', 7)).toBe('abcdefg');
  });

  it('truncates in the middle with ellipsis when exceeding maxLen', () => {
    expect(truncateMiddle('abcdefghij', 7)).toBe('abc…hij');
  });

  it('handles even split correctly', () => {
    expect(truncateMiddle('abcdefgh', 5)).toBe('ab…gh');
  });

  it('handles maxLen of 1 (edge: only ellipsis fits)', () => {
    expect(truncateMiddle('abcdef', 1)).toBe('…');
  });

  it('returns empty string for empty input', () => {
    expect(truncateMiddle('', 5)).toBe('');
  });

  it('handles maxLen larger than string length', () => {
    expect(truncateMiddle('ab', 5)).toBe('ab');
  });

  it('handles single-character strings', () => {
    expect(truncateMiddle('a', 5)).toBe('a');
  });

  it('handles maxLen of 3 (minimum useful: 1 char + ellipsis + 1 char)', () => {
    expect(truncateMiddle('abcdefgh', 3)).toBe('a…h');
  });

  it('uses the unicode ellipsis character (…), not three dots', () => {
    const result = truncateMiddle('abcdefghij', 7);
    expect(result).toContain('…');
    expect(result).not.toContain('...');
  });

  it('result length never exceeds maxLen', () => {
    const inputs = ['abcdefghijklmnop', 'hello world this is long', '12345678901234567890'];
    for (const input of inputs) {
      for (let maxLen = 1; maxLen < input.length; maxLen++) {
        const result = truncateMiddle(input, maxLen);
        expect(result.length).toBeLessThanOrEqual(maxLen);
      }
    }
  });

  it('preserves start and end characters of the original string', () => {
    const result = truncateMiddle('abcdefghij', 7);
    expect(result.startsWith('abc')).toBe(true);
    expect(result.endsWith('hij')).toBe(true);
  });
});

describe('groupRegistrationGaps', () => {
  const member = (over: Partial<GroupMemberSummary>): GroupMemberSummary => ({
    name: 'engine', role: 'api', remote: 'r', path: '/p/engine', pathExists: true, ...over,
  });

  it('reports no gap for a null or unconfigured status', () => {
    expect(groupRegistrationGaps(null).hasGap).toBe(false);
    expect(groupRegistrationGaps({ configured: false }).hasGap).toBe(false);
  });

  it('reports no gap when registration state was not computed', () => {
    // registrationComplete undefined → legacy summary, no registry was supplied.
    const status: GroupStatus = { configured: true, name: 'p', members: [member({ registered: undefined })] };
    expect(groupRegistrationGaps(status).hasGap).toBe(false);
  });

  it('reports no gap when registration is complete', () => {
    const status: GroupStatus = {
      configured: true, name: 'p', registrationComplete: true, parentRegistered: true,
      members: [member({ registered: true })],
    };
    expect(groupRegistrationGaps(status).hasGap).toBe(false);
  });

  it('flags an unregistered parent', () => {
    const status: GroupStatus = {
      configured: true, name: 'p', registrationComplete: false,
      parentRoot: '/p', parentRegistered: false,
      members: [member({ registered: true })],
    };
    const gaps = groupRegistrationGaps(status);
    expect(gaps.parentMissing).toBe(true);
    expect(gaps.missingMembers).toHaveLength(0);
    expect(gaps.hasGap).toBe(true);
  });

  it('flags only present, unregistered members (skips absent ones)', () => {
    const status: GroupStatus = {
      configured: true, name: 'p', registrationComplete: false, parentRegistered: true,
      members: [
        member({ name: 'engine', registered: false, pathExists: true }),  // gap
        member({ name: 'portal', registered: false, pathExists: false }), // absent → not actionable
        member({ name: 'docs', registered: true, pathExists: true }),     // already registered
      ],
    };
    const gaps = groupRegistrationGaps(status);
    expect(gaps.parentMissing).toBe(false);
    expect(gaps.missingMembers.map((m) => m.name)).toEqual(['engine']);
    expect(gaps.hasGap).toBe(true);
  });

  it('reports no actionable gap when only absent members are unregistered', () => {
    const status: GroupStatus = {
      configured: true, name: 'p', registrationComplete: false, parentRegistered: true,
      members: [member({ registered: false, pathExists: false })],
    };
    // registrationComplete is false (engine counts only present members), but there's
    // nothing the user can register here, so the banner must not appear.
    expect(groupRegistrationGaps(status).hasGap).toBe(false);
  });
});

describe('parentDirOf', () => {
  it('returns the parent of a posix path', () => {
    expect(parentDirOf('/home/me/repos/engine')).toBe('/home/me/repos');
  });

  it('returns the parent of a windows path', () => {
    expect(parentDirOf('C:\\GitHub\\engine')).toBe('C:\\GitHub');
  });

  it('strips a trailing separator first', () => {
    expect(parentDirOf('/a/b/c/')).toBe('/a/b');
  });

  it('returns null when there is no meaningful parent', () => {
    expect(parentDirOf('')).toBeNull();
    expect(parentDirOf('/')).toBeNull();
    expect(parentDirOf('engine')).toBeNull();
  });
});

describe('multiRepoNudge', () => {
  it('nudges when not configured, dismissed=false, and >=2 siblings', () => {
    expect(multiRepoNudge({ groupConfigured: false, siblingRepoCount: 3, dismissed: false })).toBe(3);
  });

  it('does not nudge when dismissed', () => {
    expect(multiRepoNudge({ groupConfigured: false, siblingRepoCount: 5, dismissed: true })).toBeNull();
  });

  it('does not nudge when a group is already configured', () => {
    expect(multiRepoNudge({ groupConfigured: true, siblingRepoCount: 5, dismissed: false })).toBeNull();
  });

  it('does not nudge below the 2-repo threshold', () => {
    expect(multiRepoNudge({ groupConfigured: false, siblingRepoCount: 1, dismissed: false })).toBeNull();
    expect(multiRepoNudge({ groupConfigured: undefined, siblingRepoCount: 0, dismissed: false })).toBeNull();
  });
});

describe('groupWorkspaces', () => {
  const ws = (path: string, group?: WorkspaceInfo['group']): WorkspaceInfo => ({
    path,
    displayName: path.split('/').pop()!,
    active: false,
    available: true,
    open: false,
    closable: false,
    liveSessionCount: 0,
    ...(group ? { group } : {}),
  });

  it('returns no groups and all entries ungrouped when none belong to a group', () => {
    const result = groupWorkspaces([ws('/a'), ws('/b')]);
    expect(result.groups).toEqual([]);
    expect(result.ungrouped.map((i) => i.ws.path)).toEqual(['/a', '/b']);
  });

  it('groups parent + members under the parent path, parent first', () => {
    const list = [
      ws('/member', { groupName: 'prod', role: 'member', parentPath: '/parent', memberName: 'engine' }),
      ws('/loose'),
      ws('/parent', { groupName: 'prod', role: 'parent', parentPath: '/parent' }),
    ];
    const result = groupWorkspaces(list);

    expect(result.groups).toHaveLength(1);
    expect(result.groups[0].groupName).toBe('prod');
    expect(result.groups[0].parentPath).toBe('/parent');
    expect(result.groups[0].items.map((i) => i.ws.path)).toEqual(['/parent', '/member']);
    expect(result.ungrouped.map((i) => i.ws.path)).toEqual(['/loose']);
  });

  it('preserves the original registry index on every item', () => {
    const list = [
      ws('/member', { groupName: 'prod', role: 'member', parentPath: '/parent', memberName: 'engine' }),
      ws('/parent', { groupName: 'prod', role: 'parent', parentPath: '/parent' }),
    ];
    const result = groupWorkspaces(list);
    const indexByPath = new Map(result.groups[0].items.map((i) => [i.ws.path, i.index]));
    expect(indexByPath.get('/member')).toBe(0);
    expect(indexByPath.get('/parent')).toBe(1);
  });

  it('keeps distinct groups separate even when names collide', () => {
    const list = [
      ws('/p1', { groupName: 'prod', role: 'parent', parentPath: '/p1' }),
      ws('/p2', { groupName: 'prod', role: 'parent', parentPath: '/p2' }),
    ];
    const result = groupWorkspaces(list);
    expect(result.groups.map((g) => g.parentPath)).toEqual(['/p1', '/p2']);
  });
});

describe('resolveDocEditability', () => {
  const doc = (over: Partial<Doc> = {}): Doc => ({
    path: 'Product/features/x',
    title: 'X',
    body: '',
    slug: 'x',
    directory: 'Product/features',
    ...over,
  });

  it('is not editable with no doc selected', () => {
    expect(resolveDocEditability(null, true)).toEqual({ editable: false, viaParent: false });
  });

  it('is not editable when the user lacks docs-edit permission', () => {
    expect(resolveDocEditability(doc(), false)).toEqual({ editable: false, viaParent: false });
  });

  it('edits a normal repo doc in place (no group routing)', () => {
    expect(resolveDocEditability(doc({ path: 'guide', group: undefined }), true)).toEqual({
      editable: true,
      viaParent: false,
    });
  });

  it("edits a parent's own group doc in place (group, not readOnly, not viaParent)", () => {
    expect(resolveDocEditability(doc({ group: true, readOnly: false }), true)).toEqual({
      editable: true,
      viaParent: false,
    });
  });

  it('edits a bound member group doc but routes through the parent (viaParent)', () => {
    expect(resolveDocEditability(doc({ group: true, readOnly: false, viaParent: true }), true)).toEqual({
      editable: true,
      viaParent: true,
    });
  });

  it('treats a viaParent doc as editable even if it is also flagged readOnly', () => {
    expect(resolveDocEditability(doc({ group: true, readOnly: true, viaParent: true }), true)).toEqual({
      editable: true,
      viaParent: true,
    });
  });

  it('is not editable for a genuinely read-only doc with no writer', () => {
    expect(resolveDocEditability(doc({ group: true, readOnly: true }), true)).toEqual({
      editable: false,
      viaParent: false,
    });
  });
});
