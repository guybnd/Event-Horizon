import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./git-exec.js', () => ({
  runGit: vi.fn(),
  resolveDefaultBranchName: vi.fn(),
}));
vi.mock('./task-store.js', () => ({
  updateTaskWithHistory: vi.fn(),
}));
vi.mock('./events.js', () => ({
  broadcastEvent: vi.fn(),
}));

import { runGit, resolveDefaultBranchName } from './git-exec.js';
import { updateTaskWithHistory } from './task-store.js';
import { broadcastEvent } from './events.js';
import { parseClosingTrailers, closeTicketsFromDefaultBranchCommits } from './commit-close.js';
import type { Workspace } from './workspace-context.js';
import type { CachedTicket } from './pr-cleanup.js';

const runGitMock = vi.mocked(runGit);
const resolveDefaultBranchNameMock = vi.mocked(resolveDefaultBranchName);
const updateTaskWithHistoryMock = vi.mocked(updateTaskWithHistory);
const broadcastEventMock = vi.mocked(broadcastEvent);

describe('parseClosingTrailers', () => {
  const keys = ['FLUX'];

  it.each([
    ['Closes: FLUX-123', ['FLUX-123']],
    ['closes FLUX-123', ['FLUX-123']],
    ['Closes:FLUX-123', ['FLUX-123']],
    ['feat: thing (Closes: FLUX-123)', ['FLUX-123']],
    ['Fixes: FLUX-1', ['FLUX-1']],
    ['Resolves: FLUX-1', ['FLUX-1']],
    ['Closes: FLUX-1, FLUX-2', ['FLUX-1', 'FLUX-2']],
  ])('matches %s', (message, expected) => {
    expect(parseClosingTrailers(message, keys)).toEqual(expected);
  });

  it.each([
    ['(FLUX-123)'],
    ['[FLUX-123]'],
    ['for FLUX-123'],
    ['FLUX-123'],
    ['closesFLUX-123'],
  ])('does not match %s', (message) => {
    expect(parseClosingTrailers(message, keys)).toEqual([]);
  });

  it('rejects "uncloses" and "foocloses"', () => {
    expect(parseClosingTrailers('uncloses FLUX-1', keys)).toEqual([]);
    expect(parseClosingTrailers('foocloses FLUX-1', keys)).toEqual([]);
  });

  it('drops ids whose project key is not in projectKeys', () => {
    expect(parseClosingTrailers('Closes: OTHER-1', keys)).toEqual([]);
  });

  it('de-duplicates repeated ids', () => {
    expect(parseClosingTrailers('Closes: FLUX-1. Also fixes FLUX-1.', keys)).toEqual(['FLUX-1']);
  });
});

describe('closeTicketsFromDefaultBranchCommits', () => {
  let rootCounter = 0;

  beforeEach(() => {
    vi.clearAllMocks();
    rootCounter += 1;
  });

  // Each test gets its OWN workspace root — the reconciler keys its in-memory head-SHA early-out
  // by workspaceRoot (module-level, process-lifetime map), so reusing a root across tests would
  // let one test's "unchanged head" state silently short-circuit the next test's sweep.
  function uniqueRoot() {
    return `/ws-${rootCounter}`;
  }

  function makeWs(root: string, tasks: Record<string, Partial<CachedTicket>>): Workspace {
    return { root, config: { projects: ['FLUX'] }, tasks } as unknown as Workspace;
  }

  function mockGitLog(head: string, records: Array<{ sha: string; subject: string; body?: string }>) {
    const out = records.map((r) => `${r.sha}\x1f${r.subject}\x1f${r.body ?? ''}\x1e`).join('');
    runGitMock.mockImplementation(async (args: string[]) => {
      if (args[0] === 'rev-parse' && args[1] === '--verify' && args.length === 4) return { stdout: `${head}\n`, stderr: '' };
      if (args[0] === 'rev-parse') return { stdout: `${head}\n`, stderr: '' };
      if (args[0] === 'log') return { stdout: out, stderr: '' };
      return { stdout: '', stderr: '' };
    });
  }

  it('resolves name via origin/HEAD absent -> local main', async () => {
    resolveDefaultBranchNameMock.mockResolvedValue('main');
    const root = uniqueRoot();
    mockGitLog('deadbeef', [{ sha: 'abc123ff', subject: 'Closes: FLUX-1' }]);
    const ws = makeWs(root, { 'FLUX-1': { id: 'FLUX-1', status: 'In Progress', history: [] } });
    await closeTicketsFromDefaultBranchCommits(root, ws);
    expect(updateTaskWithHistoryMock).toHaveBeenCalledWith('FLUX-1', expect.objectContaining({ nextStatus: 'Done' }), ws);
  });

  it('advances a ticket with a Closes trailer to Done with the commit sha as implementationLink', async () => {
    resolveDefaultBranchNameMock.mockResolvedValue('main');
    const root = uniqueRoot();
    mockGitLog('deadbeef', [{ sha: 'abc123ff', subject: 'Closes: FLUX-1' }]);
    const ws = makeWs(root, { 'FLUX-1': { id: 'FLUX-1', status: 'In Progress', history: [] } });
    await closeTicketsFromDefaultBranchCommits(root, ws);
    expect(updateTaskWithHistoryMock).toHaveBeenCalledWith('FLUX-1', expect.objectContaining({
      nextStatus: 'Done',
      extraFields: expect.objectContaining({ implementationLink: 'abc123ff' }),
    }), ws);
    expect(broadcastEventMock).toHaveBeenCalledWith('taskUpdated', { id: 'FLUX-1' });
  });

  it('preserves an existing implementationLink', async () => {
    resolveDefaultBranchNameMock.mockResolvedValue('main');
    const root = uniqueRoot();
    mockGitLog('deadbeef', [{ sha: 'abc123ff', subject: 'Closes: FLUX-1' }]);
    const ws = makeWs(root, { 'FLUX-1': { id: 'FLUX-1', status: 'In Progress', history: [], implementationLink: 'pre-existing' } });
    await closeTicketsFromDefaultBranchCommits(root, ws);
    const call = updateTaskWithHistoryMock.mock.calls[0]?.[1] as { extraFields?: { implementationLink?: string } } | undefined;
    expect(call?.extraFields?.implementationLink).toBeUndefined();
  });

  it('guard: unknown ticket id -> no write', async () => {
    resolveDefaultBranchNameMock.mockResolvedValue('main');
    const root = uniqueRoot();
    mockGitLog('deadbeef', [{ sha: 'abc123ff', subject: 'Closes: FLUX-999' }]);
    const ws = makeWs(root, {});
    await closeTicketsFromDefaultBranchCommits(root, ws);
    expect(updateTaskWithHistoryMock).not.toHaveBeenCalled();
  });

  it('guard: kind pr -> no write', async () => {
    resolveDefaultBranchNameMock.mockResolvedValue('main');
    const root = uniqueRoot();
    mockGitLog('deadbeef', [{ sha: 'abc123ff', subject: 'Closes: FLUX-1' }]);
    const ws = makeWs(root, { 'FLUX-1': { id: 'FLUX-1', status: 'In Progress', kind: 'pr', history: [] } });
    await closeTicketsFromDefaultBranchCommits(root, ws);
    expect(updateTaskWithHistoryMock).not.toHaveBeenCalled();
  });

  it('guard: terminal status -> no write', async () => {
    resolveDefaultBranchNameMock.mockResolvedValue('main');
    const root = uniqueRoot();
    mockGitLog('deadbeef', [{ sha: 'abc123ff', subject: 'Closes: FLUX-1' }]);
    const ws = makeWs(root, { 'FLUX-1': { id: 'FLUX-1', status: 'Done', history: [] } });
    await closeTicketsFromDefaultBranchCommits(root, ws);
    expect(updateTaskWithHistoryMock).not.toHaveBeenCalled();
  });

  it('guard: previously reached Done (reopen) -> no write', async () => {
    resolveDefaultBranchNameMock.mockResolvedValue('main');
    const root = uniqueRoot();
    mockGitLog('deadbeef', [{ sha: 'abc123ff', subject: 'Closes: FLUX-1' }]);
    const ws = makeWs(root, { 'FLUX-1': { id: 'FLUX-1', status: 'In Progress', history: [{ type: 'status_change', to: 'Done' }] } });
    await closeTicketsFromDefaultBranchCommits(root, ws);
    expect(updateTaskWithHistoryMock).not.toHaveBeenCalled();
  });

  it('guard: branch set to something other than default -> no write', async () => {
    resolveDefaultBranchNameMock.mockResolvedValue('main');
    const root = uniqueRoot();
    mockGitLog('deadbeef', [{ sha: 'abc123ff', subject: 'Closes: FLUX-1' }]);
    const ws = makeWs(root, { 'FLUX-1': { id: 'FLUX-1', status: 'In Progress', branch: 'flux/some-other', history: [] } });
    await closeTicketsFromDefaultBranchCommits(root, ws);
    expect(updateTaskWithHistoryMock).not.toHaveBeenCalled();
  });

  it('guard 5 positive arm: branch equal to default -> still closes', async () => {
    resolveDefaultBranchNameMock.mockResolvedValue('main');
    const root = uniqueRoot();
    mockGitLog('deadbeef', [{ sha: 'abc123ff', subject: 'Closes: FLUX-1' }]);
    const ws = makeWs(root, { 'FLUX-1': { id: 'FLUX-1', status: 'In Progress', branch: 'main', history: [] } });
    await closeTicketsFromDefaultBranchCommits(root, ws);
    expect(updateTaskWithHistoryMock).toHaveBeenCalledWith('FLUX-1', expect.objectContaining({ nextStatus: 'Done' }), ws);
  });

  it('passes a stable idempotencyKey on the close write', async () => {
    resolveDefaultBranchNameMock.mockResolvedValue('main');
    const root = uniqueRoot();
    mockGitLog('deadbeef', [{ sha: 'abc123ff', subject: 'Closes: FLUX-1' }]);
    const ws = makeWs(root, { 'FLUX-1': { id: 'FLUX-1', status: 'In Progress', history: [] } });
    await closeTicketsFromDefaultBranchCommits(root, ws);
    expect(updateTaskWithHistoryMock).toHaveBeenCalledWith('FLUX-1', expect.objectContaining({
      idempotencyKey: 'commit-close:abc123ff:FLUX-1',
    }), ws);
  });

  it('origin/<def> ref-selection fallback: local ref missing, remote-tracking ref present -> scans origin/<def>', async () => {
    resolveDefaultBranchNameMock.mockResolvedValue('main');
    const root = uniqueRoot();
    const out = `abc123ff\x1fCloses: FLUX-1\x1f\x1e`;
    runGitMock.mockImplementation(async (args: string[]) => {
      if (args[0] === 'rev-parse' && args[1] === '--verify' && args[3] === 'refs/heads/main') {
        throw new Error('no such ref');
      }
      if (args[0] === 'rev-parse' && args[1] === '--verify' && args[3] === 'refs/remotes/origin/main') {
        return { stdout: 'deadbeef\n', stderr: '' };
      }
      if (args[0] === 'rev-parse' && args[1] === '--verify' && args[2] === '--quiet') {
        return { stdout: 'deadbeef\n', stderr: '' };
      }
      if (args[0] === 'log') return { stdout: out, stderr: '' };
      return { stdout: '', stderr: '' };
    });
    const ws = makeWs(root, { 'FLUX-1': { id: 'FLUX-1', status: 'In Progress', history: [] } });
    await closeTicketsFromDefaultBranchCommits(root, ws);
    const logCall = runGitMock.mock.calls.find(([args]) => args[0] === 'log');
    expect(logCall?.[0][1]).toBe('origin/main');
    expect(updateTaskWithHistoryMock).toHaveBeenCalledWith('FLUX-1', expect.objectContaining({ nextStatus: 'Done' }), ws);
  });

  it('no matching ref for the resolved default name -> returns without writing', async () => {
    resolveDefaultBranchNameMock.mockResolvedValue('main');
    const root = uniqueRoot();
    runGitMock.mockRejectedValue(new Error('no such ref'));
    const ws = makeWs(root, { 'FLUX-1': { id: 'FLUX-1', status: 'In Progress', history: [] } });
    await closeTicketsFromDefaultBranchCommits(root, ws);
    expect(updateTaskWithHistoryMock).not.toHaveBeenCalled();
  });

  it('idempotent: second sweep over an unchanged head is a no-op', async () => {
    resolveDefaultBranchNameMock.mockResolvedValue('main');
    const root = uniqueRoot();
    mockGitLog('deadbeef', [{ sha: 'abc123ff', subject: 'Closes: FLUX-1' }]);
    const ws = makeWs(root, { 'FLUX-1': { id: 'FLUX-1', status: 'Done', history: [] } });
    await closeTicketsFromDefaultBranchCommits(root, ws);
    await closeTicketsFromDefaultBranchCommits(root, ws);
    // Both runs skip via the terminal-status guard; the second run should also short-circuit via
    // the unchanged-head early-out (git log invoked only once total, not twice).
    const logCalls = runGitMock.mock.calls.filter(([args]) => args[0] === 'log');
    expect(logCalls.length).toBe(1);
  });
});
