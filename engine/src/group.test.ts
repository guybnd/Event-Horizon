import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import os from 'os';
import { execFile } from 'child_process';
import { promisify } from 'util';
import {
  validateGroupConfig,
  loadGroupContext,
  summarizeGroup,
  buildMemberScopeArgs,
  normalizeRemoteForCompare,
  peekGroupMembers,
  activateMemberBinding,
  getMemberBinding,
  groupDocPathToStoreRelative,
  groupDocsLabel,
  GROUP_STORE_DIRNAME,
  GROUP_DOCS_BRANCH,
} from './group.js';

const execFileAsync = promisify(execFile);

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

  it('accepts an optional safe docsLabel', () => {
    const errors = validateGroupConfig({
      name: 'x',
      members: [{ name: 'a', role: 'api', remote: 'r' }],
      docsLabel: 'Platform',
    });
    expect(errors).toHaveLength(0);
  });

  it('rejects an unsafe docsLabel (path traversal / separators)', () => {
    for (const docsLabel of ['..', 'a/b', 'a\\b', '../evil']) {
      const errors = validateGroupConfig({
        name: 'x',
        members: [{ name: 'a', role: 'api', remote: 'r' }],
        docsLabel,
      });
      expect(errors.some((e) => e.path === 'docsLabel')).toBe(true);
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

  it('loads an optional docsLabel and surfaces it (default Product otherwise)', async () => {
    await fs.writeFile(
      path.join(root, 'group.json'),
      JSON.stringify({ name: 'p', members: [{ name: 'engine', role: 'api', remote: 'r' }], docsLabel: 'Platform' }),
      'utf-8',
    );
    const ctx = await loadGroupContext(root);
    expect(ctx!.config.docsLabel).toBe('Platform');
    expect(groupDocsLabel(ctx)).toBe('Platform');
    expect(summarizeGroup(ctx).docsLabel).toBe('Platform');
    // No docsLabel → default.
    expect(groupDocsLabel(null)).toBe('Product');
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

  it('reports registration state when a registry is supplied', async () => {
    await fs.writeFile(
      path.join(root, 'group.json'),
      JSON.stringify({ name: 'p', members: [{ name: 'engine', role: 'api', remote: 'r' }] }),
      'utf-8',
    );
    const ctx = await loadGroupContext(root);
    const memberPath = ctx!.members[0].path;
    await fs.mkdir(memberPath, { recursive: true }); // present checkout

    // Parent registered, member not → incomplete.
    const partial = summarizeGroup(ctx, [root]);
    expect(partial.parentRegistered).toBe(true);
    expect(partial.members![0].registered).toBe(false);
    expect(partial.registrationComplete).toBe(false);

    // Parent + member registered → complete.
    const full = summarizeGroup(ctx, [root, memberPath]);
    expect(full.registrationComplete).toBe(true);

    // No registry supplied → legacy shape, no registration fields.
    const legacy = summarizeGroup(ctx);
    expect(legacy.parentRegistered).toBeUndefined();
    expect('registered' in legacy.members![0]).toBe(false);

    await fs.rm(memberPath, { recursive: true, force: true });
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

describe('normalizeRemoteForCompare', () => {
  it('collapses equivalent spellings of the same repo to one key', () => {
    const variants = [
      'https://github.com/acme/engine.git',
      'https://github.com/acme/engine',
      'https://github.com/acme/engine/',
      'git@github.com:acme/engine.git',
      'ssh://git@github.com/acme/engine.git',
      'HTTPS://GitHub.com/ACME/Engine.git',
    ];
    const keys = variants.map(normalizeRemoteForCompare);
    expect(new Set(keys).size).toBe(1);
    expect(keys[0]).toBe('github.com/acme/engine');
  });

  it('distinguishes different repos', () => {
    expect(normalizeRemoteForCompare('git@github.com:acme/engine.git')).not.toBe(
      normalizeRemoteForCompare('git@github.com:acme/portal.git'),
    );
  });

  it('returns empty string for unusable input', () => {
    expect(normalizeRemoteForCompare('')).toBe('');
    expect(normalizeRemoteForCompare('   ')).toBe('');
  });
});

describe('peekGroupMembers', () => {
  let root: string;

  beforeEach(async () => {
    root = await makeTempRoot();
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('returns member identities without scaffolding the store', async () => {
    await fs.writeFile(
      path.join(root, 'group.json'),
      JSON.stringify({
        name: 'prod',
        members: [{ name: 'engine', role: 'api', remote: 'git@github.com:acme/engine.git' }],
      }),
      'utf-8',
    );
    const members = await peekGroupMembers(root);
    expect(members).toEqual([{ name: 'engine', remote: 'git@github.com:acme/engine.git' }]);
    // A peek must NOT create the .flux-group scaffold (unlike loadGroupContext).
    expect(existsSync(path.join(root, GROUP_STORE_DIRNAME))).toBe(false);
  });

  it('returns null when group.json is absent or malformed', async () => {
    expect(await peekGroupMembers(root)).toBeNull();
    await fs.writeFile(path.join(root, 'group.json'), '{ not valid json', 'utf-8');
    expect(await peekGroupMembers(root)).toBeNull();
  });
});

describe('activateMemberBinding (reverse-lookup discovery, Case 1)', () => {
  let parent: string;
  let member: string;

  async function gitInitWithRemote(repoRoot: string, remote: string): Promise<void> {
    await execFileAsync('git', ['-C', repoRoot, 'init'], { windowsHide: true });
    await execFileAsync('git', ['-C', repoRoot, 'remote', 'add', 'origin', remote], { windowsHide: true });
  }

  beforeEach(async () => {
    parent = await makeTempRoot();
    member = await makeTempRoot();
  });

  afterEach(async () => {
    await activateMemberBinding('___none___', []); // reset module state
    await fs.rm(parent, { recursive: true, force: true });
    await fs.rm(member, { recursive: true, force: true });
  });

  it('binds a member to a registered parent that lists its remote', async () => {
    const remote = 'git@github.com:acme/engine.git';
    await gitInitWithRemote(member, remote);
    await fs.writeFile(
      path.join(parent, 'group.json'),
      JSON.stringify({ name: 'prod', members: [{ name: 'engine', role: 'api', remote }] }),
      'utf-8',
    );

    const binding = await activateMemberBinding(member, [parent, member]);
    expect(binding).not.toBeNull();
    expect(binding!.memberName).toBe('engine');
    expect(binding!.parentRoot).toBe(path.resolve(parent));
    expect(binding!.parentGroup.groupStoreDir).toBe(path.join(path.resolve(parent), GROUP_STORE_DIRNAME));
    expect(getMemberBinding()).toBe(binding);
  });

  it('matches across equivalent remote spellings (member https vs parent scp)', async () => {
    await gitInitWithRemote(member, 'https://github.com/acme/engine.git');
    await fs.writeFile(
      path.join(parent, 'group.json'),
      JSON.stringify({
        name: 'prod',
        members: [{ name: 'engine', role: 'api', remote: 'git@github.com:acme/engine.git' }],
      }),
      'utf-8',
    );

    const binding = await activateMemberBinding(member, [parent, member]);
    expect(binding?.memberName).toBe('engine');
  });

  it('returns null when the workspace is itself a parent', async () => {
    await fs.writeFile(
      path.join(parent, 'group.json'),
      JSON.stringify({
        name: 'prod',
        members: [{ name: 'engine', role: 'api', remote: 'git@github.com:acme/engine.git' }],
      }),
      'utf-8',
    );
    expect(await activateMemberBinding(parent, [parent])).toBeNull();
    expect(getMemberBinding()).toBeNull();
  });

  it('returns null when no registered parent lists this remote', async () => {
    await gitInitWithRemote(member, 'git@github.com:acme/orphan.git');
    await fs.writeFile(
      path.join(parent, 'group.json'),
      JSON.stringify({
        name: 'prod',
        members: [{ name: 'engine', role: 'api', remote: 'git@github.com:acme/engine.git' }],
      }),
      'utf-8',
    );
    expect(await activateMemberBinding(member, [parent, member])).toBeNull();
    expect(getMemberBinding()).toBeNull();
  });

  it('returns null when the member checkout has no origin remote', async () => {
    await fs.writeFile(
      path.join(parent, 'group.json'),
      JSON.stringify({
        name: 'prod',
        members: [{ name: 'engine', role: 'api', remote: 'git@github.com:acme/engine.git' }],
      }),
      'utf-8',
    );
    // member has no git repo / no origin → cannot be identified.
    expect(await activateMemberBinding(member, [parent, member])).toBeNull();
  });
});

describe('groupDocPathToStoreRelative', () => {
  it('maps a Product/ doc path back to its store-relative markdown file', () => {
    expect(groupDocPathToStoreRelative('Product/index')).toBe('index.md');
    expect(groupDocPathToStoreRelative('Product/features/checkout')).toBe('features/checkout.md');
    expect(groupDocPathToStoreRelative('Product/contracts/orders-api')).toBe('contracts/orders-api.md');
  });

  it('rejects non-group paths and unsafe segments', () => {
    expect(groupDocPathToStoreRelative('index')).toBeNull();
    expect(groupDocPathToStoreRelative('Other/foo')).toBeNull();
    expect(groupDocPathToStoreRelative('Product')).toBeNull(); // prefix only, no doc
    expect(groupDocPathToStoreRelative('Product/..')).toBeNull();
    expect(groupDocPathToStoreRelative('Product/features/..')).toBeNull();
    expect(groupDocPathToStoreRelative('')).toBeNull();
  });

  it('honors a custom docs label prefix (FLUX-414)', () => {
    expect(groupDocPathToStoreRelative('Platform/features/checkout', 'Platform')).toBe('features/checkout.md');
    // The default 'Product' prefix no longer matches once a custom label is used.
    expect(groupDocPathToStoreRelative('Product/features/checkout', 'Platform')).toBeNull();
    expect(groupDocPathToStoreRelative('Platform/..', 'Platform')).toBeNull();
  });
});
