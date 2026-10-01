// FLUX-1739: the tamper guard is what makes a benchmark verdict mean anything — the exit code is
// only trustworthy because the agent could not reach the thing producing it.
//
// These run against a real git fixture because the guarantee IS the interaction between the working
// tree, the checkout, and the copy-aside — a mocked filesystem would assert the code I wrote rather
// than the property I need.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createGitFixture } from './test-helpers/git-fixture.js';
import { runGit } from './git-exec.js';
import {
  detectTamper,
  pathIsHeldOut,
  runGuardedValidation,
  spawnValidation,
} from './benchmark-validation.js';
import type { BenchmarkValidation } from './models/benchmark.js';

// A trivial cross-platform command — deliberately NOT `git`, which check-git-exec.mjs forbids
// spawning directly outside git-exec.ts.
const NODE = process.execPath;

/** For the spawn-level tests: a self-contained command with no repo behind it. */
function validation(overrides: Partial<BenchmarkValidation> = {}): BenchmarkValidation {
  return {
    command: NODE,
    args: ['-e', 'process.exit(0)'],
    paths: ['check.js'],
    timeoutMs: 30_000,
    ...overrides,
  };
}

/** For the repo tests: actually RUNS the held-out check, which is the whole point of the guard. */
function repoValidation(overrides: Partial<BenchmarkValidation> = {}): BenchmarkValidation {
  return { command: NODE, args: ['check.js'], paths: ['check.js'], timeoutMs: 30_000, ...overrides };
}

describe('pathIsHeldOut / detectTamper (pure)', () => {
  it('matches an exact path', () => {
    expect(pathIsHeldOut('check.js', 'check.js')).toBe(true);
  });

  it('matches a descendant of a held-out directory but not a sibling prefix', () => {
    expect(pathIsHeldOut('tests/a/b.js', 'tests')).toBe(true);
    expect(pathIsHeldOut('tests-other/a.js', 'tests')).toBe(false);
  });

  it('normalizes separators so a Windows diff path matches a POSIX manifest', () => {
    expect(pathIsHeldOut('tests\\a\\b.js', 'tests')).toBe(true);
  });

  it('reports every changed held-out path, and none when the run stayed clear', () => {
    expect(detectTamper(['src/a.ts', 'check.js'], ['check.js'])).toEqual(['check.js']);
    expect(detectTamper(['src/a.ts'], ['check.js'])).toEqual([]);
  });
});

describe('spawnValidation', () => {
  let dir: string;
  beforeAll(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), 'eh-bench-spawn-')); });
  afterAll(async () => { await fs.rm(dir, { recursive: true, force: true }).catch(() => {}); });

  it('passes on exit 0', async () => {
    const out = await spawnValidation(validation(), dir);
    expect(out.exitCode).toBe(0);
    expect(out.passed).toBe(true);
    expect(out.timedOut).toBe(false);
  });

  it('fails on a non-zero exit and keeps a bounded output tail', async () => {
    const out = await spawnValidation(
      validation({ args: ['-e', 'console.log("boom"); process.exit(3)'] }),
      dir,
    );
    expect(out.exitCode).toBe(3);
    expect(out.passed).toBe(false);
    expect(out.outputTail).toContain('boom');
  });

  it('does not pass a run that timed out, whatever exit code the kill produced', async () => {
    const out = await spawnValidation(
      validation({ args: ['-e', 'setTimeout(() => {}, 60000)'], timeoutMs: 300 }),
      dir,
    );
    expect(out.timedOut).toBe(true);
    expect(out.passed).toBe(false);
  });

  it('does not interpret the command through a shell', async () => {
    // If this went through a shell, the `&&` would run a second command and the exit code would
    // be 0. Spawned execFile-shaped, the whole string is one (missing) executable.
    const out = await spawnValidation(
      { command: 'definitely-not-a-real-binary && exit 0', args: [], paths: [], timeoutMs: 5000 },
      dir,
    );
    expect(out.passed).toBe(false);
  });
});

describe('runGuardedValidation against a real repo', () => {
  let repo: string;

  beforeAll(async () => {
    repo = await createGitFixture({
      templateKey: 'benchmark-validation',
      populate: async (root) => {
        // The held-out check: passes only when src/answer.txt says "42".
        await fs.writeFile(
          path.join(root, 'check.js'),
          'const fs=require("fs");const v=fs.readFileSync("src/answer.txt","utf8").trim();process.exit(v==="42"?0:1);',
          'utf-8',
        );
        await fs.mkdir(path.join(root, 'src'), { recursive: true });
        await fs.writeFile(path.join(root, 'src', 'answer.txt'), 'wrong', 'utf-8');
      },
    });
  });

  afterAll(async () => { await fs.rm(repo, { recursive: true, force: true }).catch(() => {}); });

  async function head(): Promise<string> {
    return (await runGit(['rev-parse', 'HEAD'], { cwd: repo })).stdout.trim();
  }

  it('passes when the agent genuinely solved the task', async () => {
    const base = await head();
    await fs.writeFile(path.join(repo, 'src', 'answer.txt'), '42', 'utf-8');
    const res = await runGuardedValidation({
      worktreePath: repo, baseCommit: base, validation: repoValidation(), changedPaths: ['src/answer.txt'],
    });
    expect(res.outcome.passed).toBe(true);
    expect(res.tampered).toBe(false);
  });

  it('an agent that WEAKENS the check still fails it, and is recorded as tampering', async () => {
    const base = await head();
    await fs.writeFile(path.join(repo, 'src', 'answer.txt'), 'wrong', 'utf-8');
    // Rewrite the check to always pass — the classic gaming move.
    await fs.writeFile(path.join(repo, 'check.js'), 'process.exit(0);', 'utf-8');

    const res = await runGuardedValidation({
      worktreePath: repo, baseCommit: base, validation: repoValidation(), changedPaths: ['check.js'],
    });
    expect(res.outcome.passed).toBe(false); // restored before it ran
    expect(res.tampered).toBe(true);

    // ...and the agent's version is handed back afterwards, not destroyed.
    expect(await fs.readFile(path.join(repo, 'check.js'), 'utf-8')).toBe('process.exit(0);');
    await runGit(['checkout', '--', '.'], { cwd: repo });
  });

  it('an agent that DELETES the check still fails it, and gets the deletion back', async () => {
    const base = await head();
    await fs.rm(path.join(repo, 'check.js'));
    const res = await runGuardedValidation({
      worktreePath: repo, baseCommit: base, validation: repoValidation(), changedPaths: ['check.js'],
    });
    expect(res.outcome.passed).toBe(false);
    expect(res.tampered).toBe(true);
    // The restore recreated it; the copy-back must return the tree to what the agent left.
    await expect(fs.access(path.join(repo, 'check.js'))).rejects.toThrow();
    await runGit(['checkout', '--', '.'], { cwd: repo });
  });

  it('a run whose ONLY edit is inside a held-out path still gets that edit back', async () => {
    // Without the copy-back this edit would be silently destroyed by the restore, and the run would
    // also measure an empty diff — flipping a real solve to unsolved.
    const base = await head();
    await fs.writeFile(path.join(repo, 'check.js'), '// agent note\nprocess.exit(1);', 'utf-8');
    await runGuardedValidation({
      worktreePath: repo, baseCommit: base, validation: repoValidation(), changedPaths: ['check.js'],
    });
    expect(await fs.readFile(path.join(repo, 'check.js'), 'utf-8')).toContain('agent note');
    await runGit(['checkout', '--', '.'], { cwd: repo });
  });

  it('never reports a pass when the held-out restore itself failed', async () => {
    const res = await runGuardedValidation({
      worktreePath: repo,
      baseCommit: await head(),
      validation: repoValidation({ paths: ['does/not/exist/at/base.js'] }),
      changedPaths: [],
    });
    expect(res.outcome.passed).toBe(false);
    expect(res.outcome.outputTail).toContain('held-out restore failed');
  });
});
