import { describe, it, expect } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import { resolveChangedFiles } from '../scripts/test-changed.mjs';
import { createGitFixture, git, setGitIdentity } from './test-helpers/git-fixture.js';

// Meta-tests for FLUX-1665's targeted-gate changed-file resolution: exercised against a
// synthetic git repo (never the real EventHorizon repo) so committed/uncommitted/untracked
// union logic and the empty/unresolvable-base fallback are provable in isolation.

describe('test-changed.mjs resolveChangedFiles (FLUX-1665)', () => {
  it('finds a file changed since the merge-base with the base branch', async () => {
    const repo = await createGitFixture();
    await setGitIdentity(repo);
    await git(repo, ['checkout', '-b', 'feature']);
    await fs.mkdir(path.join(repo, 'engine', 'src'), { recursive: true });
    await fs.writeFile(path.join(repo, 'engine', 'src', 'touched.ts'), 'export const x = 1;\n');
    await git(repo, ['add', '-A']);
    await git(repo, ['commit', '-m', 'touch engine/src file']);

    const changed = resolveChangedFiles(repo, 'master');
    expect(changed).toEqual(['src/touched.ts']);
  });

  it('includes uncommitted (unstaged) tracked changes', async () => {
    const repo = await createGitFixture();
    await setGitIdentity(repo);
    await fs.mkdir(path.join(repo, 'engine', 'src'), { recursive: true });
    await fs.writeFile(path.join(repo, 'engine', 'src', 'tracked.ts'), 'export const x = 1;\n');
    await git(repo, ['add', '-A']);
    await git(repo, ['commit', '-m', 'add tracked file']);
    await fs.writeFile(path.join(repo, 'engine', 'src', 'tracked.ts'), 'export const x = 2;\n');

    const changed = resolveChangedFiles(repo, 'master');
    expect(changed).toEqual(['src/tracked.ts']);
  });

  it('includes untracked (new) files', async () => {
    const repo = await createGitFixture();
    await setGitIdentity(repo);
    await fs.mkdir(path.join(repo, 'engine', 'src'), { recursive: true });
    await fs.writeFile(path.join(repo, 'engine', 'src', 'new-file.ts'), 'export const x = 1;\n');

    const changed = resolveChangedFiles(repo, 'master');
    expect(changed).toEqual(['src/new-file.ts']);
  });

  it('filters out files outside engine/src', async () => {
    const repo = await createGitFixture();
    await setGitIdentity(repo);
    await fs.mkdir(path.join(repo, 'engine', 'src'), { recursive: true });
    await fs.mkdir(path.join(repo, 'portal', 'src'), { recursive: true });
    await fs.writeFile(path.join(repo, 'engine', 'src', 'in-scope.ts'), 'export const x = 1;\n');
    await fs.writeFile(path.join(repo, 'portal', 'src', 'out-of-scope.ts'), 'export const y = 1;\n');
    await fs.writeFile(path.join(repo, 'README.md'), '# root file\n');

    const changed = resolveChangedFiles(repo, 'master');
    expect(changed).toEqual(['src/in-scope.ts']);
  });

  it('falls back to an empty change set when the base ref does not resolve', async () => {
    const repo = await createGitFixture();
    await setGitIdentity(repo);
    // Deliberately never create a local 'nonexistent-base-branch' ref.
    const changed = resolveChangedFiles(repo, 'nonexistent-base-branch');
    expect(changed).toEqual([]);
  });

  it('returns an empty change set on a clean repo with no changes at all', async () => {
    const repo = await createGitFixture();
    await setGitIdentity(repo);
    const changed = resolveChangedFiles(repo, 'master');
    expect(changed).toEqual([]);
  });
});
