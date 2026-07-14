import { describe, it, expect } from 'vitest';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import matter from 'gray-matter';
import {
  deriveGist,
  buildDoneIndexBlock,
  hasExistingVersionBlock,
  normalizeReleaseVersion,
  bumpPackageJsonVersions,
  bumpLockfileVersion,
  type ReleaseTask,
} from './release.js';

function task(id: string, title: string, history: unknown[]): ReleaseTask {
  const parsed = matter(`---\nid: ${id}\ntitle: ${title}\nstatus: Done\n---\nbody`);
  parsed.data.history = history;
  return { id, parsed, filePath: `/flux/${id}.md` };
}

describe('deriveGist', () => {
  it('returns undefined for an empty history', () => {
    expect(deriveGist([])).toBeUndefined();
  });

  it('returns undefined when no entry has type "comment"', () => {
    expect(deriveGist([{ type: 'status_change', from: 'Todo', to: 'Done' }])).toBeUndefined();
  });

  it('picks the most recent comment entry', () => {
    const history = [
      { type: 'comment', comment: 'older comment' },
      { type: 'status_change', from: 'In Progress', to: 'Ready' },
      { type: 'comment', comment: 'Fixed the thing.' },
    ];
    expect(deriveGist(history)).toBe('Fixed the thing.');
  });

  it('collapses multi-line comments to a single line', () => {
    const history = [{ type: 'comment', comment: 'Line one.\n\nLine two.\nLine three.' }];
    expect(deriveGist(history)).toBe('Line one. Line two. Line three.');
  });

  it('truncates long comments to ~120 chars with an ellipsis', () => {
    const long = 'x'.repeat(200);
    const gist = deriveGist([{ type: 'comment', comment: long }])!;
    expect(gist.length).toBe(120);
    expect(gist.endsWith('…')).toBe(true);
  });

  it('skips comment entries with a blank/whitespace-only comment', () => {
    const history = [
      { type: 'comment', comment: 'real gist' },
      { type: 'comment', comment: '   ' },
    ];
    expect(deriveGist(history)).toBe('real gist');
  });

  it('ignores malformed entries without throwing', () => {
    expect(deriveGist([null, 42, 'string-entry', { type: 'comment', comment: 123 }])).toBeUndefined();
  });

  it('prefers the tagged completion comment over a later untagged one (FLUX-1205)', () => {
    const history = [
      { type: 'comment', comment: 'The actual completion summary.', completionComment: true },
      { type: 'status_change', from: 'Ready', to: 'Done' },
      { type: 'comment', comment: 'A stray note added while sitting in Done.' },
    ];
    expect(deriveGist(history)).toBe('The actual completion summary.');
  });

  it('picks the latest tagged completion comment when several are present', () => {
    const history = [
      { type: 'comment', comment: 'Ready-time summary.', completionComment: true },
      { type: 'comment', comment: 'finish_ticket summary.', completionComment: true },
    ];
    expect(deriveGist(history)).toBe('finish_ticket summary.');
  });

  it('falls back to the last comment for tickets that predate the completion tag', () => {
    const history = [
      { type: 'comment', comment: 'older comment' },
      { type: 'comment', comment: 'newest comment' },
    ];
    expect(deriveGist(history)).toBe('newest comment');
  });

  it('skips a blank tagged completion comment and falls back to a real comment', () => {
    const history = [
      { type: 'comment', comment: 'real gist' },
      { type: 'comment', comment: '   ', completionComment: true },
    ];
    expect(deriveGist(history)).toBe('real gist');
  });
});

describe('buildDoneIndexBlock', () => {
  it('formats one line per ticket, with gist when present and title-only fallback otherwise', () => {
    const tasks = [
      task('FLUX-1', 'Fix the bug', [{ type: 'comment', comment: 'Fixed via patch X.' }]),
      task('FLUX-2', 'Add the feature', []),
    ];
    const block = buildDoneIndexBlock('v2.0.0', tasks);
    expect(block).toContain('## Release v2.0.0');
    expect(block).toContain('- **FLUX-1**: Fix the bug — Fixed via patch X.\n');
    expect(block).toContain('- **FLUX-2**: Add the feature\n');
    expect(block).not.toContain('FLUX-2**: Add the feature —');
  });

  it('is a no-op-safe empty block when given zero tasks', () => {
    const block = buildDoneIndexBlock('v3.0.0', []);
    expect(block).toContain('## Release v3.0.0');
    expect(block.trim().split('\n')).toHaveLength(1);
  });
});

describe('hasExistingVersionBlock', () => {
  it('returns false on empty/unrelated content', () => {
    expect(hasExistingVersionBlock('', 'v1.0.0')).toBe(false);
    expect(hasExistingVersionBlock('## Release v0.9.0\n', 'v1.0.0')).toBe(false);
  });

  it('returns true when the version heading is already present', () => {
    expect(hasExistingVersionBlock('## Release v1.0.0 — 2026-01-01\n', 'v1.0.0')).toBe(true);
  });

  it('does not false-positive on a version that is a prefix of an already-indexed one', () => {
    expect(hasExistingVersionBlock('## Release v2.0.0 — 2026-01-01T00:00:00.000Z\n\n', 'v2')).toBe(false);
    expect(hasExistingVersionBlock('## Release v1.0.1 — 2026-01-01T00:00:00.000Z\n\n', 'v1.0')).toBe(false);
  });

  it('still matches when the version contains regex-special characters', () => {
    expect(hasExistingVersionBlock('## Release v1.2.0+build.1 — 2026-01-01\n', 'v1.2.0+build.1')).toBe(true);
  });
});

describe('normalizeReleaseVersion', () => {
  it('accepts a bare semver and derives both forms', () => {
    expect(normalizeReleaseVersion('1.5.0')).toEqual({ input: '1.5.0', bare: '1.5.0', v: 'v1.5.0', valid: true });
  });

  it('accepts a v-prefixed semver identically (leading v stripped for bare)', () => {
    expect(normalizeReleaseVersion('v1.5.0')).toEqual({ input: 'v1.5.0', bare: '1.5.0', v: 'v1.5.0', valid: true });
  });

  it('trims surrounding whitespace before normalizing', () => {
    expect(normalizeReleaseVersion('  v2.0.0  ')).toMatchObject({ bare: '2.0.0', v: 'v2.0.0', valid: true });
  });

  it('accepts prerelease and build metadata', () => {
    expect(normalizeReleaseVersion('v1.5.0-rc.1')).toMatchObject({ bare: '1.5.0-rc.1', valid: true });
    expect(normalizeReleaseVersion('1.5.0+build.7')).toMatchObject({ bare: '1.5.0+build.7', valid: true });
  });

  it('marks a non-semver arg invalid (partial version, freeform tag, empty)', () => {
    expect(normalizeReleaseVersion('1.5').valid).toBe(false);
    expect(normalizeReleaseVersion('hotfix').valid).toBe(false);
    expect(normalizeReleaseVersion('').valid).toBe(false);
  });

  it('does not strip a leading "v" that is not a version prefix', () => {
    // `vnext` is a tag, not `v` + version — leave it intact and report invalid.
    expect(normalizeReleaseVersion('vnext')).toMatchObject({ bare: 'vnext', valid: false });
  });
});

describe('bumpPackageJsonVersions', () => {
  async function makeRepo(): Promise<string> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'eh-release-'));
    await fs.writeFile(path.join(dir, 'package.json'), '{\n  "name": "root",\n  "version": "1.4.1"\n}\n');
    await fs.mkdir(path.join(dir, 'engine'));
    await fs.writeFile(path.join(dir, 'engine', 'package.json'), '{\n  "name": "engine",\n  "version": "1.4.1"\n}\n');
    await fs.mkdir(path.join(dir, 'portal'));
    await fs.writeFile(path.join(dir, 'portal', 'package.json'), '{\n  "name": "portal",\n  "version": "1.4.1"\n}\n');
    await fs.mkdir(path.join(dir, 'electron'));
    await fs.writeFile(path.join(dir, 'electron', 'package.json'), '{\n  "name": "electron",\n  "version": "1.4.1"\n}\n');
    return dir;
  }
  const readVersion = async (p: string) => JSON.parse(await fs.readFile(p, 'utf-8')).version as string;

  it('bumps all four package.json files in lockstep, preserving formatting', async () => {
    const dir = await makeRepo();
    await bumpPackageJsonVersions(dir, '1.5.0');
    expect(await readVersion(path.join(dir, 'package.json'))).toBe('1.5.0');
    expect(await readVersion(path.join(dir, 'engine', 'package.json'))).toBe('1.5.0');
    expect(await readVersion(path.join(dir, 'portal', 'package.json'))).toBe('1.5.0');
    expect(await readVersion(path.join(dir, 'electron', 'package.json'))).toBe('1.5.0');
    // Only the version line changed — the file is still valid JSON with its other keys intact.
    const root = await fs.readFile(path.join(dir, 'package.json'), 'utf-8');
    expect(root).toContain('"name": "root"');
    expect(root.endsWith('}\n')).toBe(true);
  });

  it('is a no-op for a missing package.json without throwing', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'eh-release-'));
    await fs.writeFile(path.join(dir, 'package.json'), '{\n  "version": "1.4.1"\n}\n');
    // engine/, portal/, and electron/ deliberately absent.
    await expect(bumpPackageJsonVersions(dir, '1.5.0')).resolves.toBeUndefined();
    expect(await readVersion(path.join(dir, 'package.json'))).toBe('1.5.0');
  });
});

describe('bumpLockfileVersion', () => {
  function lockfileFixture(version: string, depVersion: string): string {
    return JSON.stringify(
      {
        name: 'event-horizon',
        version,
        lockfileVersion: 3,
        requires: true,
        packages: {
          '': { name: 'event-horizon', version, license: 'PolyForm-Noncommercial-1.0.0' },
          'node_modules/some-dep': { version: depVersion, license: 'MIT' },
        },
      },
      null,
      2,
    ) + '\n';
  }

  it('bumps both root event-horizon entries but leaves a dependency version untouched', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'eh-release-'));
    const lockPath = path.join(dir, 'package-lock.json');
    await fs.writeFile(lockPath, lockfileFixture('1.4.1', '3.2.1'));
    await bumpLockfileVersion(dir, '1.5.0');
    const parsed = JSON.parse(await fs.readFile(lockPath, 'utf-8'));
    expect(parsed.version).toBe('1.5.0');
    expect(parsed.packages[''].version).toBe('1.5.0');
    expect(parsed.packages['node_modules/some-dep'].version).toBe('3.2.1');
  });

  it('bumps both root event-horizon entries in a CRLF lockfile but leaves a dependency version untouched', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'eh-release-'));
    const lockPath = path.join(dir, 'package-lock.json');
    await fs.writeFile(lockPath, lockfileFixture('1.4.1', '3.2.1').replace(/\n/g, '\r\n'));
    await bumpLockfileVersion(dir, '1.5.0');
    const raw = await fs.readFile(lockPath, 'utf-8');
    expect(raw).toContain('\r\n');
    const parsed = JSON.parse(raw);
    expect(parsed.version).toBe('1.5.0');
    expect(parsed.packages[''].version).toBe('1.5.0');
    expect(parsed.packages['node_modules/some-dep'].version).toBe('3.2.1');
  });

  it('is a no-op for a missing package-lock.json without throwing', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'eh-release-'));
    await expect(bumpLockfileVersion(dir, '1.5.0')).resolves.toBeUndefined();
  });

  it('is a no-op when already at the target version', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'eh-release-'));
    const lockPath = path.join(dir, 'package-lock.json');
    const fixture = lockfileFixture('1.5.0', '3.2.1');
    await fs.writeFile(lockPath, fixture);
    await bumpLockfileVersion(dir, '1.5.0');
    expect(await fs.readFile(lockPath, 'utf-8')).toBe(fixture);
  });
});
