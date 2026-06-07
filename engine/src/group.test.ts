import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import os from 'os';
import {
  validateGroupConfig,
  loadGroupContext,
  summarizeGroup,
  buildMemberScopeArgs,
  GROUP_STORE_DIRNAME,
  GROUP_DOCS_BRANCH,
} from './group.js';

async function makeTempRoot(): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), 'eh-group-test-'));
}

describe('validateGroupConfig', () => {
  it('accepts a minimal valid config', () => {
    const errors = validateGroupConfig({
      name: 'my-product',
      members: [{ name: 'engine', role: 'api', remote: 'git@github.com:acme/engine.git' }],
    });
    expect(errors).toEqual([]);
  });

  it('rejects a non-object', () => {
    expect(validateGroupConfig(null).length).toBeGreaterThan(0);
    expect(validateGroupConfig([]).length).toBeGreaterThan(0);
  });

  it('requires a non-empty name', () => {
    const errors = validateGroupConfig({ name: '', members: [{ name: 'a', role: 'api', remote: 'r' }] });
    expect(errors.some((e) => e.path === 'name')).toBe(true);
  });

  it('requires a non-empty members array', () => {
    expect(validateGroupConfig({ name: 'x', members: [] }).some((e) => e.path === 'members')).toBe(true);
    expect(validateGroupConfig({ name: 'x' }).some((e) => e.path === 'members')).toBe(true);
  });

  it('flags missing member fields', () => {
    const errors = validateGroupConfig({ name: 'x', members: [{ name: 'a' }] });
    expect(errors.some((e) => e.path === 'members[0].role')).toBe(true);
    expect(errors.some((e) => e.path === 'members[0].remote')).toBe(true);
  });

  it('flags duplicate member names', () => {
    const errors = validateGroupConfig({
      name: 'x',
      members: [
        { name: 'dup', role: 'api', remote: 'r1' },
        { name: 'dup', role: 'app', remote: 'r2' },
      ],
    });
    expect(errors.some((e) => /duplicate/.test(e.message))).toBe(true);
  });

  it('rejects unsafe member names (path traversal)', () => {
    for (const name of ['..', '.', '../evil', 'a/b', 'a\\b', 'foo/../bar']) {
      const errors = validateGroupConfig({
        name: 'x',
        members: [{ name, role: 'api', remote: 'r' }],
      });
      expect(errors.some((e) => /unsafe member name/.test(e.message))).toBe(true);
    }
  });

  it('accepts safe member names', () => {
    for (const name of ['frontend', 'api-server', 'shared_lib', 'app.v2', 'a1']) {
      const errors = validateGroupConfig({
        name: 'x',
        members: [{ name, role: 'api', remote: 'r' }],
      });
      expect(errors).toHaveLength(0);
    }
  });
});

describe('loadGroupContext', () => {
  let root: string;

  beforeEach(async () => {
    root = await makeTempRoot();
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('returns null when no group.json is present (single-repo mode)', async () => {
    expect(await loadGroupContext(root)).toBeNull();
  });

  it('throws on a present-but-invalid group.json', async () => {
    await fs.writeFile(path.join(root, 'group.json'), JSON.stringify({ name: '' }), 'utf-8');
    await expect(loadGroupContext(root)).rejects.toThrow(/Invalid group.json/);
  });

  it('loads members and defaults paths to ../<name>', async () => {
    await fs.writeFile(
      path.join(root, 'group.json'),
      JSON.stringify({
        name: 'my-product',
        members: [
          { name: 'engine', role: 'api', remote: 'git@github.com:acme/engine.git', testCommand: 'npm test' },
          { name: 'portal', role: 'frontend', remote: 'git@github.com:acme/portal.git' },
        ],
      }),
      'utf-8',
    );

    const ctx = await loadGroupContext(root);
    expect(ctx).not.toBeNull();
    expect(ctx!.config.name).toBe('my-product');
    expect(ctx!.docsBranch).toBe(GROUP_DOCS_BRANCH);
    expect(ctx!.members).toHaveLength(2);

    const engine = ctx!.members[0];
    expect(engine.path).toBe(path.resolve(root, '..', 'engine'));
    expect(engine.testCommand).toBe('npm test');
  });

  it('honors per-machine path overrides from group.local.json', async () => {
    await fs.writeFile(
      path.join(root, 'group.json'),
      JSON.stringify({ name: 'p', members: [{ name: 'homeup', role: 'app', remote: 'r' }] }),
      'utf-8',
    );
    await fs.writeFile(
      path.join(root, 'group.local.json'),
      JSON.stringify({ paths: { homeup: '../../apps/homeup' } }),
      'utf-8',
    );

    const ctx = await loadGroupContext(root);
    expect(ctx!.members[0].path).toBe(path.resolve(root, '..', '..', 'apps', 'homeup'));
  });

  it('scaffolds the canonical .flux-group store on load', async () => {
    await fs.writeFile(
      path.join(root, 'group.json'),
      JSON.stringify({ name: 'p', members: [{ name: 'a', role: 'api', remote: 'r' }] }),
      'utf-8',
    );

    await loadGroupContext(root);
    const storeDir = path.join(root, GROUP_STORE_DIRNAME);
    expect(existsSync(path.join(storeDir, 'index.md'))).toBe(true);
    expect(existsSync(path.join(storeDir, 'topology.md'))).toBe(true);
    expect(existsSync(path.join(storeDir, 'features'))).toBe(true);
    expect(existsSync(path.join(storeDir, 'contracts'))).toBe(true);
  });
});

describe('summarizeGroup', () => {
  let root: string;

  beforeEach(async () => {
    root = await makeTempRoot();
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('reports configured: false for a null context', () => {
    const summary = summarizeGroup(null);
    expect(summary.configured).toBe(false);
    expect(summary.message).toMatch(/No multi-repo group/);
    expect(summary.members).toBeUndefined();
  });

  it('projects members and omits testCommand when unset', async () => {
    await fs.writeFile(
      path.join(root, 'group.json'),
      JSON.stringify({
        name: 'p',
        members: [
          { name: 'engine', role: 'api', remote: 'r1', testCommand: 'npm test' },
          { name: 'portal', role: 'frontend', remote: 'r2' },
        ],
      }),
      'utf-8',
    );
    const ctx = await loadGroupContext(root);
    const summary = summarizeGroup(ctx);

    expect(summary.configured).toBe(true);
    expect(summary.name).toBe('p');
    expect(summary.members).toHaveLength(2);
    expect(summary.members![0].testCommand).toBe('npm test');
    expect('testCommand' in summary.members![1]).toBe(false);
  });

  it('re-checks pathExists live, not from the load-time snapshot', async () => {
    await fs.writeFile(
      path.join(root, 'group.json'),
      JSON.stringify({ name: 'p', members: [{ name: 'late', role: 'app', remote: 'r' }] }),
      'utf-8',
    );
    const ctx = await loadGroupContext(root);
    // At load the sibling ../late does not exist.
    expect(ctx!.members[0].pathExists).toBe(false);

    // Create the checkout *after* load.
    const lateDir = ctx!.members[0].path;
    await fs.mkdir(lateDir, { recursive: true });
    try {
      // The frozen snapshot still says false, but summarizeGroup re-checks live.
      expect(summarizeGroup(ctx).members![0].pathExists).toBe(true);
    } finally {
      await fs.rm(lateDir, { recursive: true, force: true });
    }
  });
});

describe('buildMemberScopeArgs', () => {
  let root: string;

  beforeEach(async () => {
    root = await makeTempRoot();
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('returns [] in single-repo mode (null context)', () => {
    expect(buildMemberScopeArgs(null)).toEqual([]);
  });

  it('emits --add-dir only for members whose checkout exists on disk', async () => {
    // Two members; create the checkout for only one of them.
    const presentDir = path.join(root, '..', 'present-' + path.basename(root));
    await fs.writeFile(
      path.join(root, 'group.json'),
      JSON.stringify({
        name: 'p',
        members: [
          { name: path.basename(presentDir), role: 'app', remote: 'r1' },
          { name: 'absent-member', role: 'api', remote: 'r2' },
        ],
      }),
      'utf-8',
    );
    await fs.mkdir(presentDir, { recursive: true });
    try {
      const ctx = await loadGroupContext(root);
      const args = buildMemberScopeArgs(ctx);
      expect(args).toEqual(['--add-dir', path.resolve(presentDir)]);
    } finally {
      await fs.rm(presentDir, { recursive: true, force: true });
    }
  });

  it('excludes a member whose path resolves to the parent root', async () => {
    // Override the member's path to point back at the parent root itself.
    await fs.writeFile(
      path.join(root, 'group.json'),
      JSON.stringify({ name: 'p', members: [{ name: 'self', role: 'app', remote: 'r' }] }),
      'utf-8',
    );
    await fs.writeFile(
      path.join(root, 'group.local.json'),
      JSON.stringify({ paths: { self: '.' } }),
      'utf-8',
    );
    const ctx = await loadGroupContext(root);
    expect(buildMemberScopeArgs(ctx)).toEqual([]);
  });
});
