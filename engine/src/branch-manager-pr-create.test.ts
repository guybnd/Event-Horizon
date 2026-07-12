import { describe, it, expect, beforeEach, vi } from 'vitest';
import { setWorkspaceRoot } from './workspace.js';

// FLUX-1223 — createPullRequest used to silently discard a ticket's title/body whenever an OPEN PR
// already existed on the branch (the sequential-batch shared-branch case): it just returned the
// existing URL, so only the FIRST ticket to reach Ready on a shared branch ever got its content
// into the PR. Mock git-exec so no real `gh`/`git` is spawned; assert the read-modify-write append.
const runGh = vi.fn();
const runGit = vi.fn();
vi.mock('./git-exec.js', () => ({
  runGh: (args: string[]) => runGh(args),
  runGit: (args: string[], opts?: unknown) => runGit(args, opts),
}));

const { createPullRequest } = await import('./branch-manager.js');

beforeEach(() => {
  runGh.mockReset();
  runGit.mockReset();
  runGit.mockResolvedValue({ stdout: '', stderr: '' });
  setWorkspaceRoot('/tmp/fake-repo');
});

describe('createPullRequest (FLUX-1223)', () => {
  it('creates a fresh PR when none exists yet on the branch, embedding the dedup marker in the body', async () => {
    runGh
      .mockRejectedValueOnce(new Error('no pull requests found')) // pr view
      .mockResolvedValueOnce({ stdout: 'https://github.com/o/r/pull/1\n', stderr: '' }); // pr create
    const url = await createPullRequest('flux/seq', 'FLUX-1: first ticket', 'body one', 'FLUX-1');
    expect(url).toBe('https://github.com/o/r/pull/1');
    // The OPENING body carries the same marked-section shape the append path uses, so a later
    // re-raise of the SAME ticket finds the marker and doesn't duplicate the description.
    expect(runGh).toHaveBeenCalledWith([
      'pr', 'create', '--title', 'FLUX-1: first ticket',
      '--body', '<!-- flux:FLUX-1 -->\n### FLUX-1: first ticket\n\nbody one',
      '--head', 'flux/seq',
    ]);
  });

  it('does NOT duplicate the description when the SAME ticket re-raises its still-open PR', async () => {
    // First raise: no PR yet → pr create with the marked opening body.
    runGh
      .mockRejectedValueOnce(new Error('no pull requests found')) // pr view (1st raise)
      .mockResolvedValueOnce({ stdout: 'https://github.com/o/r/pull/1\n', stderr: '' }); // pr create
    await createPullRequest('flux/FLUX-1-fix', 'FLUX-1: fix', 'the description', 'FLUX-1');
    const openingBody = (runGh.mock.calls[1]![0] as string[])[
      (runGh.mock.calls[1]![0] as string[]).indexOf('--body') + 1
    ]!;

    // Second raise (e.g. Ready → In Progress → Ready): PR is OPEN and already carries FLUX-1's
    // marker from the create above → the append-dedup guard short-circuits, no pr edit, no dup.
    runGh.mockReset();
    runGit.mockResolvedValue({ stdout: '', stderr: '' });
    runGh.mockResolvedValueOnce({
      stdout: JSON.stringify({ url: 'https://github.com/o/r/pull/1', state: 'OPEN', title: 'FLUX-1: fix', body: openingBody }),
      stderr: '',
    });

    const url = await createPullRequest('flux/FLUX-1-fix', 'FLUX-1: fix', 'the description', 'FLUX-1');
    expect(url).toBe('https://github.com/o/r/pull/1');
    // Only the `pr view` lookup — no `pr edit`, because FLUX-1's marker is already present.
    expect(runGh).toHaveBeenCalledTimes(1);
    expect(runGh).not.toHaveBeenCalledWith(expect.arrayContaining(['edit']));
  });

  it('appends the new ticket as a section instead of discarding it when an OPEN PR already exists', async () => {
    runGh.mockResolvedValueOnce({
      stdout: JSON.stringify({ url: 'https://github.com/o/r/pull/1', state: 'OPEN', title: 'FLUX-1: first ticket', body: '<!-- flux:FLUX-1 -->\n### FLUX-1: first ticket\n\nbody one' }),
      stderr: '',
    });
    runGh.mockResolvedValueOnce({ stdout: '', stderr: '' }); // pr edit

    const url = await createPullRequest('flux/seq', 'FLUX-2: second ticket', 'body two', 'FLUX-2');

    expect(url).toBe('https://github.com/o/r/pull/1');
    expect(runGh).toHaveBeenCalledTimes(2);
    const editArgs = runGh.mock.calls[1]![0] as string[];
    expect(editArgs[0]).toBe('pr');
    expect(editArgs[1]).toBe('edit');
    expect(editArgs[2]).toBe('https://github.com/o/r/pull/1');
    const bodyIdx = editArgs.indexOf('--body');
    const newBody = editArgs[bodyIdx + 1]!;
    // Original section preserved, new section appended.
    expect(newBody).toContain('<!-- flux:FLUX-1 -->');
    expect(newBody).toContain('body one');
    expect(newBody).toContain('<!-- flux:FLUX-2 -->');
    expect(newBody).toContain('### FLUX-2: second ticket');
    expect(newBody).toContain('body two');
    // Title evolves to reflect both tickets.
    const titleIdx = editArgs.indexOf('--title');
    expect(editArgs[titleIdx + 1]).toBe('FLUX-1: first ticket (+FLUX-2)');
    // No `pr create` call — the existing PR is reused, not replaced.
    expect(runGh).not.toHaveBeenCalledWith(expect.arrayContaining(['create']));
  });

  it('is idempotent — retrying the SAME ticket does not duplicate its section or re-edit the PR', async () => {
    runGh.mockResolvedValueOnce({
      stdout: JSON.stringify({ url: 'https://github.com/o/r/pull/1', state: 'OPEN', title: 'FLUX-1: first ticket', body: '<!-- flux:FLUX-1 -->\n### FLUX-1: first ticket\n\nbody one\n\n---\n<!-- flux:FLUX-2 -->\n### FLUX-2: second ticket\n\nbody two' }),
      stderr: '',
    });

    const url = await createPullRequest('flux/seq', 'FLUX-2: second ticket (retry)', 'body two retry', 'FLUX-2');

    expect(url).toBe('https://github.com/o/r/pull/1');
    // Only the `pr view` lookup — no `pr edit`, since FLUX-2's marker is already present.
    expect(runGh).toHaveBeenCalledTimes(1);
  });

  it('returns the existing PR URL unchanged when no ticketId is supplied (back-compat)', async () => {
    runGh.mockResolvedValueOnce({
      stdout: JSON.stringify({ url: 'https://github.com/o/r/pull/1', state: 'OPEN', title: 'Some title', body: 'some body' }),
      stderr: '',
    });
    const url = await createPullRequest('flux/plain', 'New title', 'new body');
    expect(url).toBe('https://github.com/o/r/pull/1');
    expect(runGh).toHaveBeenCalledTimes(1); // no edit attempted without a ticketId marker
  });
});
