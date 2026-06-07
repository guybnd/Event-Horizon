import { describe, it, expect } from 'vitest';
import fs from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import os from 'os';
import {
  validateGitRemote,
  planGroupSetup,
  applyGroupSetup,
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
    const result = await applyGroupSetup(
      {
        parentRoot: parent,
        groupName: 'acme',
        members: [{ name: 'engine', role: 'api', remote: 'https://h/engine.git' }],
      },
      { gitRunner: okRunner },
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
    const result = await applyGroupSetup(
      {
        parentRoot: parent,
        groupName: 'acme',
        members: [
          { name: 'good', role: 'api', remote: 'https://h/good.git' },
          { name: 'bad', role: 'app', remote: 'https://h/bad.git' },
        ],
      },
      { gitRunner: runner },
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
    const result = await applyGroupSetup(
      {
        parentRoot: parent,
        groupName: 'acme',
        members: [{ name: 'absent', role: 'api', remote: 'https://h/absent.git' }],
      },
      { gitRunner: async () => ({ stdout: '', stderr: '' }) },
    );
    const m = result.members.find((x) => x.name === 'absent');
    expect(m?.action).toBe('clone');
    expect(m?.ok).toBe(false);
    expect(m?.error).toMatch(/auto-clone not performed/i);
  });
});
