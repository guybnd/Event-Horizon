import { describe, it, expect } from 'vitest';
import fs from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import os from 'os';
import {
  validateGitRemote,
  planGroupSetup,
  applyGroupSetup,
  ensureGroupRegistered,
  type GitRunner,
} from './group-setup.js';
import { GROUP_CONFIG_FILENAME, GROUP_STORE_DIRNAME } from './group.js';

async function makeTempRoot(): Promise<string> {
  // Create a parent dir, then a child that acts as the EH parent repo, so that
  // sibling members resolve to <tmp>/<name> next to the parent.
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'eh-setup-test-'));
  const parent = path.join(base, 'parent');
  await fs.mkdir(parent, { recursive: true });
  return parent;
}

/**
 * In-memory workspace registry so setup/backfill tests never touch the real
 * global settings file. Mirrors addWorkspaceEntry's de-dupe-by-path behavior.
 */
function fakeRegistry(initial: string[] = []) {
  const entries = initial.map((p) => path.resolve(p));
  const labels = new Map<string, string | undefined>();
  return {
    entries,
    labels,
    listWorkspaces: async () => entries.map((p) => ({ path: p })),
    registerWorkspace: async (p: string, label?: string) => {
      const resolved = path.resolve(p);
      if (!entries.some((e) => e === resolved)) {
        entries.push(resolved);
        labels.set(resolved, label);
      }
    },
  };
}

describe('validateGitRemote', () => {
  it('accepts https and ssh scp-like remotes', () => {
    expect(validateGitRemote('https://github.com/acme/engine.git').ok).toBe(true);
    expect(validateGitRemote('git@github.com:acme/engine.git').ok).toBe(true);
    expect(validateGitRemote('ssh://git@host.tld/acme/engine.git').ok).toBe(true);
    expect(validateGitRemote('git://host.tld/acme/engine.git').ok).toBe(true);
  });

  it('rejects ext:: transport and option injection', () => {
    expect(validateGitRemote('ext::sh -c "touch /tmp/pwn"').ok).toBe(false);
    expect(validateGitRemote('https://h/r.git --upload-pack=evil').ok).toBe(false);
    expect(validateGitRemote('--upload-pack=evil').ok).toBe(false);
    expect(validateGitRemote('fd::7').ok).toBe(false);
  });

  it('rejects shell metacharacters and leading dash', () => {
    expect(validateGitRemote('https://h/r.git; rm -rf /').ok).toBe(false);
    expect(validateGitRemote('https://h/$(whoami).git').ok).toBe(false);
    expect(validateGitRemote('-oProxyCommand=evil').ok).toBe(false);
    expect(validateGitRemote('').ok).toBe(false);
  });

  it('only accepts local paths when allowLocal is set', () => {
    const local = path.join(os.tmpdir(), 'some-repo');
    expect(validateGitRemote(local).ok).toBe(false);
    expect(validateGitRemote(local, { allowLocal: true }).ok).toBe(true);
    expect(validateGitRemote('file:///tmp/some-repo', { allowLocal: true }).ok).toBe(true);
  });
});

describe('planGroupSetup', () => {
  it('plans a create when no group.json exists', async () => {
    const parent = await makeTempRoot();
    const plan = await planGroupSetup({
      parentRoot: parent,
      groupName: 'acme',
      members: [{ name: 'engine', role: 'api', remote: 'https://h/engine.git' }],
    });
    expect(plan.alreadyConfigured).toBe(false);
    expect(plan.files.find((f) => f.path === GROUP_CONFIG_FILENAME)?.action).toBe('create');
    expect(plan.orphanBranch.action).toBe('create');
    expect(plan.gitignore.length).toBeGreaterThan(0);
  });

  it('reports register for a present member and clone for an absent one', async () => {
    const parent = await makeTempRoot();
    // Create a sibling checkout for "engine".
    await fs.mkdir(path.resolve(parent, '..', 'engine'), { recursive: true });
    const plan = await planGroupSetup({
      parentRoot: parent,
      groupName: 'acme',
      members: [
        { name: 'engine', role: 'api', remote: 'https://h/engine.git' },
        { name: 'portal', role: 'app', remote: 'https://h/portal.git' },
      ],
    });
    expect(plan.members.find((m) => m.name === 'engine')?.action).toBe('register');
    expect(plan.members.find((m) => m.name === 'portal')?.action).toBe('clone');
    expect(plan.warnings.some((w) => w.toLowerCase().includes('clone'))).toBe(true);
  });

  it('marks exists + warns when group.json already present and not forced', async () => {
    const parent = await makeTempRoot();
    await fs.writeFile(path.join(parent, GROUP_CONFIG_FILENAME), '{}', 'utf-8');
    const plan = await planGroupSetup({
      parentRoot: parent,
      groupName: 'acme',
      members: [{ name: 'engine', role: 'api', remote: 'https://h/engine.git' }],
    });
    expect(plan.alreadyConfigured).toBe(true);
    expect(plan.files.find((f) => f.path === GROUP_CONFIG_FILENAME)?.action).toBe('exists');
    expect(plan.warnings.some((w) => w.includes('already exists'))).toBe(true);
  });

  it('throws on an invalid member remote', async () => {
    const parent = await makeTempRoot();
    await expect(
      planGroupSetup({
        parentRoot: parent,
        groupName: 'acme',
        members: [{ name: 'engine', role: 'api', remote: 'ext::sh -c evil' }],
      }),
    ).rejects.toThrow(/invalid remote/i);
  });

  it('throws on an invalid config (path traversal name)', async () => {
    const parent = await makeTempRoot();
    await expect(
      planGroupSetup({
        parentRoot: parent,
        groupName: 'acme',
        members: [{ name: '../evil', role: 'api', remote: 'https://h/e.git' }],
      }),
    ).rejects.toThrow(/invalid group config/i);
  });
});

describe('applyGroupSetup', () => {
  it('writes group.json, patches .gitignore, scaffolds store', async () => {
    const parent = await makeTempRoot();
    await fs.mkdir(path.resolve(parent, '..', 'engine'), { recursive: true });
    const okRunner: GitRunner = async () => ({ stdout: 'true', stderr: '' });
    const reg = fakeRegistry();
    const result = await applyGroupSetup(
      {
        parentRoot: parent,
        groupName: 'acme',
        members: [{ name: 'engine', role: 'api', remote: 'https://h/engine.git' }],
      },
      { gitRunner: okRunner, listWorkspaces: reg.listWorkspaces, registerWorkspace: reg.registerWorkspace },
    );
    expect(result.wroteConfig).toBe(true);
    expect(result.scaffoldedStore).toBe(true);
    expect(existsSync(path.join(parent, GROUP_CONFIG_FILENAME))).toBe(true);
    expect(existsSync(path.join(parent, GROUP_STORE_DIRNAME))).toBe(true);
    const gitignore = await fs.readFile(path.join(parent, '.gitignore'), 'utf-8');
    expect(gitignore).toContain('group.local.json');
    expect(result.members[0]).toMatchObject({ name: 'engine', action: 'register', ok: true });
  });

  it('isolates member failures — one bad member does not abort the rest', async () => {
    const parent = await makeTempRoot();
    await fs.mkdir(path.resolve(parent, '..', 'good'), { recursive: true });
    await fs.mkdir(path.resolve(parent, '..', 'bad'), { recursive: true });
    const runner: GitRunner = async (cwd) => {
      if (cwd.endsWith('bad')) throw new Error('not a git repo');
      return { stdout: 'true', stderr: '' };
    };
    const reg = fakeRegistry();
    const result = await applyGroupSetup(
      {
        parentRoot: parent,
        groupName: 'acme',
        members: [
          { name: 'good', role: 'api', remote: 'https://h/good.git' },
          { name: 'bad', role: 'app', remote: 'https://h/bad.git' },
        ],
      },
      { gitRunner: runner, listWorkspaces: reg.listWorkspaces, registerWorkspace: reg.registerWorkspace },
    );
    expect(result.members.find((m) => m.name === 'good')?.ok).toBe(true);
    expect(result.members.find((m) => m.name === 'bad')?.ok).toBe(false);
    expect(result.members.find((m) => m.name === 'bad')?.error).toMatch(/not a git repo/);
  });

  it('refuses to overwrite an existing group.json without force', async () => {
    const parent = await makeTempRoot();
    await fs.writeFile(path.join(parent, GROUP_CONFIG_FILENAME), '{}', 'utf-8');
    await expect(
      applyGroupSetup({
        parentRoot: parent,
        groupName: 'acme',
        members: [{ name: 'engine', role: 'api', remote: 'https://h/engine.git' }],
      }),
    ).rejects.toThrow(/already exists/i);
  });

  it('reports clone members as not-performed in this slice', async () => {
    const parent = await makeTempRoot();
    const reg = fakeRegistry();
    const result = await applyGroupSetup(
      {
        parentRoot: parent,
        groupName: 'acme',
        members: [{ name: 'absent', role: 'api', remote: 'https://h/absent.git' }],
      },
      { gitRunner: async () => ({ stdout: '', stderr: '' }), listWorkspaces: reg.listWorkspaces, registerWorkspace: reg.registerWorkspace },
    );
    const m = result.members.find((x) => x.name === 'absent');
    expect(m?.action).toBe('clone');
    expect(m?.ok).toBe(false);
    expect(m?.error).toMatch(/auto-clone not performed/i);
  });
});

describe('registration (Case 1 guardrail)', () => {
  it('plans registration for the parent and present members only', async () => {
    const parent = await makeTempRoot();
    await fs.mkdir(path.resolve(parent, '..', 'engine'), { recursive: true });
    const reg = fakeRegistry([parent]); // parent already registered
    const plan = await planGroupSetup(
      {
        parentRoot: parent,
        groupName: 'acme',
        members: [
          { name: 'engine', role: 'api', remote: 'https://h/engine.git' }, // present → register
          { name: 'portal', role: 'app', remote: 'https://h/portal.git' }, // absent → clone, not registered
        ],
      },
      { listWorkspaces: reg.listWorkspaces },
    );
    expect(plan.registrations.find((r) => r.kind === 'parent')?.alreadyRegistered).toBe(true);
    const engineReg = plan.registrations.find((r) => r.name === 'engine');
    expect(engineReg?.kind).toBe('member');
    expect(engineReg?.alreadyRegistered).toBe(false);
    expect(plan.registrations.some((r) => r.name === 'portal')).toBe(false);
  });

  it('registers the parent and verified members, idempotently', async () => {
    const parent = await makeTempRoot();
    await fs.mkdir(path.resolve(parent, '..', 'engine'), { recursive: true });
    const okRunner: GitRunner = async () => ({ stdout: 'true', stderr: '' });
    const reg = fakeRegistry();
    const result = await applyGroupSetup(
      {
        parentRoot: parent,
        groupName: 'acme',
        members: [
          { name: 'engine', role: 'api', remote: 'https://h/engine.git' },
          { name: 'absent', role: 'app', remote: 'https://h/absent.git' }, // clone-only
        ],
      },
      { gitRunner: okRunner, listWorkspaces: reg.listWorkspaces, registerWorkspace: reg.registerWorkspace },
    );
    const enginePath = path.resolve(parent, '..', 'engine');
    expect(reg.entries).toContain(path.resolve(parent));
    expect(reg.entries).toContain(enginePath);
    expect(result.registrations.find((r) => r.name === 'engine')?.ok).toBe(true);
    expect(result.registrations.some((r) => r.name === 'absent')).toBe(false); // clone-only not registered

    // Entries are labeled with the group/member name, not the bare folder.
    expect(reg.labels.get(path.resolve(parent))).toBe('acme');
    expect(reg.labels.get(enginePath)).toBe('engine');

    // Idempotent: a forced re-apply registers nothing new.
    const before = reg.entries.length;
    await applyGroupSetup(
      {
        parentRoot: parent,
        groupName: 'acme',
        force: true,
        members: [{ name: 'engine', role: 'api', remote: 'https://h/engine.git' }],
      },
      { gitRunner: okRunner, listWorkspaces: reg.listWorkspaces, registerWorkspace: reg.registerWorkspace },
    );
    expect(reg.entries.length).toBe(before);
  });

  it('backfills an existing group without rewriting group.json', async () => {
    const parent = await makeTempRoot();
    await fs.mkdir(path.resolve(parent, '..', 'engine'), { recursive: true });
    await fs.writeFile(
      path.join(parent, GROUP_CONFIG_FILENAME),
      JSON.stringify({ name: 'acme', members: [{ name: 'engine', role: 'api', remote: 'https://h/engine.git' }] }),
      'utf-8',
    );
    const configBefore = await fs.readFile(path.join(parent, GROUP_CONFIG_FILENAME), 'utf-8');
    const reg = fakeRegistry([parent]); // parent registered, engine missing
    const result = await ensureGroupRegistered(parent, {
      listWorkspaces: reg.listWorkspaces,
      registerWorkspace: reg.registerWorkspace,
    });
    const enginePath = path.resolve(parent, '..', 'engine');
    expect(reg.entries).toContain(enginePath);
    expect(result.registrations.find((r) => r.kind === 'parent')?.alreadyRegistered).toBe(true);
    expect(result.registrations.find((r) => r.name === 'engine')?.ok).toBe(true);
    expect(result.complete).toBe(true);
    // group.json is never rewritten by the backfill.
    expect(await fs.readFile(path.join(parent, GROUP_CONFIG_FILENAME), 'utf-8')).toBe(configBefore);
  });

  it('dryRun reports the registration gap without writing', async () => {
    const parent = await makeTempRoot();
    await fs.mkdir(path.resolve(parent, '..', 'engine'), { recursive: true });
    await fs.writeFile(
      path.join(parent, GROUP_CONFIG_FILENAME),
      JSON.stringify({ name: 'acme', members: [{ name: 'engine', role: 'api', remote: 'https://h/engine.git' }] }),
      'utf-8',
    );
    const reg = fakeRegistry([]); // nothing registered
    const result = await ensureGroupRegistered(parent, {
      listWorkspaces: reg.listWorkspaces,
      registerWorkspace: reg.registerWorkspace,
      dryRun: true,
    });
    expect(reg.entries.length).toBe(0); // no writes in dryRun
    expect(result.complete).toBe(false); // a gap exists
    expect(result.registrations.find((r) => r.kind === 'parent')?.alreadyRegistered).toBe(false);
  });

  it('throws when no group is configured', async () => {
    const parent = await makeTempRoot();
    const reg = fakeRegistry();
    await expect(
      ensureGroupRegistered(parent, { listWorkspaces: reg.listWorkspaces, registerWorkspace: reg.registerWorkspace }),
    ).rejects.toThrow(/no multi-repo group is configured/i);
  });
});
