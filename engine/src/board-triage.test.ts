import { getWorkspace } from './workspace-context.js';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// FLUX-966: mock the real `gh` call so the dead-PR signal tests never shell out.
const getPullRequestStatus = vi.fn(async (_branch: string): Promise<{ number: number; state: string } | null> => null);
vi.mock('./branch-manager.js', () => ({
  getPullRequestStatus: (...args: [string]) => getPullRequestStatus(...args),
}));

import { buildTriageFragment, STALE_GROOMING_MS, STALE_REQUIRE_INPUT_MS, MAX_PR_CHECKS } from './board-triage.js';


const DAY_MS = 24 * 60 * 60 * 1000;
// board-triage.ts's own display cap (MAX_LIST) — kept module-private; mirrored here so the
// truncation tests don't hardcode a magic number that could silently drift out of sync.
const MAX_LIST = 8;

function isoDaysAgo(days: number): string {
  return new Date(Date.now() - days * DAY_MS).toISOString();
}

function statusChange(to: string, daysAgo: number) {
  return { type: 'status_change', from: 'Todo', to, user: 'Agent', date: isoDaysAgo(daysAgo) };
}

function swimlaneSet(swimlane: string, daysAgo: number) {
  return { type: 'swimlane_change', action: 'set', swimlane, user: 'Agent', date: isoDaysAgo(daysAgo) };
}

function created(daysAgo: number) {
  return { type: 'activity', user: 'Agent', comment: 'Created ticket.', date: isoDaysAgo(daysAgo) };
}

function seed(id: string, over: Record<string, unknown>) {
  getWorkspace().tasks[id] = { id, title: id, status: 'Todo', ...over };
}

describe('buildTriageFragment', () => {
  beforeEach(() => {
    for (const k of Object.keys(getWorkspace().tasks)) delete getWorkspace().tasks[k];
    getPullRequestStatus.mockReset();
    getPullRequestStatus.mockResolvedValue(null);
  });

  afterEach(() => {
    for (const k of Object.keys(getWorkspace().tasks)) delete getWorkspace().tasks[k];
  });

  it('reports a healthy board when nothing qualifies', async () => {
    seed('FLUX-1', { status: 'Todo' });
    const fragment = await buildTriageFragment();
    expect(fragment).toContain('No staleness signals found — board looks healthy.');
    expect(fragment).not.toContain('flagged');
  });

  describe('stale Grooming / Require Input', () => {
    it('flags a Grooming ticket past the threshold with the right day count', async () => {
      const days = Math.floor(STALE_GROOMING_MS / DAY_MS) + 5;
      seed('FLUX-2', { status: 'Grooming', history: [statusChange('Grooming', days)] });
      const fragment = await buildTriageFragment();
      expect(fragment).toContain(`FLUX-2: Grooming, no activity in ${days}d`);
    });

    it('does not flag a Grooming ticket under the threshold', async () => {
      seed('FLUX-3', { status: 'Grooming', history: [statusChange('Grooming', 2)] });
      const fragment = await buildTriageFragment();
      expect(fragment).not.toContain('FLUX-3');
      expect(fragment).toContain('board looks healthy');
    });

    it('flags a Require Input ticket past its (shorter) threshold, the way it actually arrives there (swimlane set, status unchanged)', async () => {
      const days = Math.floor(STALE_REQUIRE_INPUT_MS / DAY_MS) + 1;
      seed('FLUX-4', { status: 'In Progress', swimlane: 'require-input', history: [swimlaneSet('require-input', days)] });
      const fragment = await buildTriageFragment();
      expect(fragment).toContain(`FLUX-4: Require Input, no activity in ${days}d`);
    });

    it('does not flag a Require Input ticket under its threshold', async () => {
      seed('FLUX-4b', { status: 'In Progress', swimlane: 'require-input', history: [swimlaneSet('require-input', 1)] });
      const fragment = await buildTriageFragment();
      expect(fragment).not.toContain('FLUX-4b');
    });

    it('falls back to legacy literal "Require Input" status when no swimlane is set', async () => {
      const days = Math.floor(STALE_REQUIRE_INPUT_MS / DAY_MS) + 1;
      seed('FLUX-4c', { status: 'Require Input', history: [statusChange('Require Input', days)] });
      const fragment = await buildTriageFragment();
      expect(fragment).toContain(`FLUX-4c: Require Input, no activity in ${days}d`);
    });

    it('falls back to the earliest history date when no status_change entry exists', async () => {
      const days = Math.floor(STALE_GROOMING_MS / DAY_MS) + 3;
      seed('FLUX-5', { status: 'Grooming', history: [created(days)] });
      const fragment = await buildTriageFragment();
      expect(fragment).toContain(`FLUX-5: Grooming, no activity in ${days}d`);
    });

    it('treats missing/malformed history as not-stale instead of crashing', async () => {
      seed('FLUX-6', { status: 'Grooming', history: undefined });
      seed('FLUX-7', { status: 'Grooming', history: [{ type: 'status_change', date: 'not-a-date' }] });
      const fragment = await buildTriageFragment();
      expect(fragment).not.toContain('FLUX-6');
      expect(fragment).not.toContain('FLUX-7');
    });

    it('ignores statuses outside Grooming/Require Input', async () => {
      const days = Math.floor(STALE_GROOMING_MS / DAY_MS) + 10;
      seed('FLUX-8', { status: 'Todo', history: [statusChange('Todo', days)] });
      const fragment = await buildTriageFragment();
      expect(fragment).not.toContain('FLUX-8');
    });
  });

  describe('orphaned subtasks', () => {
    it('flags a subtask whose parent is Done', async () => {
      seed('FLUX-10', { status: 'Done' });
      seed('FLUX-11', { status: 'Todo', parentId: 'FLUX-10' });
      const fragment = await buildTriageFragment();
      expect(fragment).toContain('FLUX-11: orphaned (parent FLUX-10 is Done)');
    });

    it('flags a subtask whose parent is Archived', async () => {
      seed('FLUX-12', { status: 'Archived' });
      seed('FLUX-13', { status: 'In Progress', parentId: 'FLUX-12' });
      const fragment = await buildTriageFragment();
      expect(fragment).toContain('FLUX-13: orphaned (parent FLUX-12 is Archived)');
    });

    it('does not flag a subtask whose parent is still active', async () => {
      seed('FLUX-14', { status: 'In Progress' });
      seed('FLUX-15', { status: 'Todo', parentId: 'FLUX-14' });
      const fragment = await buildTriageFragment();
      expect(fragment).not.toContain('FLUX-15');
    });

    it('does not flag a subtask that is itself terminal', async () => {
      seed('FLUX-16', { status: 'Done' });
      seed('FLUX-17', { status: 'Done', parentId: 'FLUX-16' });
      const fragment = await buildTriageFragment();
      expect(fragment).not.toContain('FLUX-17');
    });
  });

  describe('duplicate titles', () => {
    it('groups two non-terminal tickets with exact-normalized-matching titles', async () => {
      seed('FLUX-20', { status: 'Todo', title: 'Fix the login bug!' });
      seed('FLUX-21', { status: 'Grooming', title: 'fix, the login bug' });
      const fragment = await buildTriageFragment();
      expect(fragment).toContain('FLUX-20: possible duplicate of FLUX-21');
      expect(fragment).toContain('FLUX-21: possible duplicate of FLUX-20');
    });

    it('excludes terminal tickets from duplicate grouping', async () => {
      seed('FLUX-22', { status: 'Todo', title: 'Same title' });
      seed('FLUX-23', { status: 'Done', title: 'Same title' });
      const fragment = await buildTriageFragment();
      expect(fragment).not.toContain('duplicate');
    });

    it('does not flag a unique title', async () => {
      seed('FLUX-24', { status: 'Todo', title: 'Totally unique title' });
      const fragment = await buildTriageFragment();
      expect(fragment).not.toContain('duplicate');
    });
  });

  describe('dead/missing PRs on Ready tickets', () => {
    it('flags a Ready+branched ticket with no PR found', async () => {
      getPullRequestStatus.mockResolvedValue(null);
      seed('FLUX-30', { status: 'Ready', branch: 'flux/FLUX-30' });
      const fragment = await buildTriageFragment();
      expect(fragment).toContain('FLUX-30: Ready, no PR found');
    });

    it('flags a Ready+branched ticket whose PR was merged elsewhere', async () => {
      getPullRequestStatus.mockResolvedValue({ number: 42, state: 'MERGED' });
      seed('FLUX-31', { status: 'Ready', branch: 'flux/FLUX-31' });
      const fragment = await buildTriageFragment();
      expect(fragment).toContain('FLUX-31: Ready, PR merged #42 elsewhere');
    });

    it('flags a Ready+branched ticket whose PR was closed elsewhere', async () => {
      getPullRequestStatus.mockResolvedValue({ number: 7, state: 'CLOSED' });
      seed('FLUX-32', { status: 'Ready', branch: 'flux/FLUX-32' });
      const fragment = await buildTriageFragment();
      expect(fragment).toContain('FLUX-32: Ready, PR closed #7 elsewhere');
    });

    it('does not flag a Ready+branched ticket whose PR is still open', async () => {
      getPullRequestStatus.mockResolvedValue({ number: 9, state: 'OPEN' });
      seed('FLUX-33', { status: 'Ready', branch: 'flux/FLUX-33' });
      const fragment = await buildTriageFragment();
      expect(fragment).not.toContain('FLUX-33');
    });

    it('does not check Ready tickets with no branch', async () => {
      seed('FLUX-34', { status: 'Ready' });
      await buildTriageFragment();
      expect(getPullRequestStatus).not.toHaveBeenCalled();
    });

    it('skips a ticket whose gh check rejects instead of failing the whole sweep', async () => {
      getPullRequestStatus.mockImplementation(async (branch: string) =>
        branch === 'flux/FLUX-35' ? Promise.reject(new Error('gh: rate limited')) : { number: 1, state: 'MERGED' },
      );
      seed('FLUX-35', { status: 'Ready', branch: 'flux/FLUX-35' });
      seed('FLUX-36', { status: 'Ready', branch: 'flux/FLUX-36' });
      const fragment = await buildTriageFragment();
      expect(fragment).not.toContain('FLUX-35');
      expect(fragment).toContain('FLUX-36: Ready, PR merged #1 elsewhere');
    });

    it('caps the number of gh calls at MAX_PR_CHECKS and notes the truncation', async () => {
      getPullRequestStatus.mockResolvedValue(null);
      const total = MAX_PR_CHECKS + 5;
      for (let i = 0; i < total; i++) {
        seed(`FLUX-4${i}`, { status: 'Ready', branch: `flux/FLUX-4${i}` });
      }
      const fragment = await buildTriageFragment();
      expect(getPullRequestStatus).toHaveBeenCalledTimes(MAX_PR_CHECKS);
      expect(fragment).toContain(`Dead-PR check capped: only checked ${MAX_PR_CHECKS} of ${total} Ready+branched tickets`);
    });
  });

  it('combines multiple signals on one ticket into a single line, not duplicated entries', async () => {
    seed('FLUX-50', { status: 'Done' });
    const days = Math.floor(STALE_GROOMING_MS / DAY_MS) + 1;
    seed('FLUX-51', { status: 'Grooming', parentId: 'FLUX-50', history: [statusChange('Grooming', days)] });
    const fragment = await buildTriageFragment();
    const occurrences = fragment.split('FLUX-51:').length - 1;
    expect(occurrences).toBe(1);
    expect(fragment).toContain(`FLUX-51: Grooming, no activity in ${days}d; orphaned (parent FLUX-50 is Done)`);
  });

  it('caps the displayed ticket list and notes how many were truncated', async () => {
    const days = Math.floor(STALE_GROOMING_MS / DAY_MS) + 1;
    const total = MAX_LIST + 3;
    for (let i = 0; i < total; i++) {
      seed(`FLUX-6${i}`, { status: 'Grooming', history: [statusChange('Grooming', days)] });
    }
    const fragment = await buildTriageFragment();
    expect(fragment).toContain(`+${total - MAX_LIST} more flagged ticket(s) not shown.`);
  });
});
