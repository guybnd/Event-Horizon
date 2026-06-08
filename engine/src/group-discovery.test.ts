import { describe, it, expect } from 'vitest';
import fs from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import os from 'os';
import {
  scanFolderForRepos,
  createDedicatedParent,
  type GitRunner,
} from './group-discovery.js';
import { GROUP_CONFIG_FILENAME, GROUP_STORE_DIRNAME } from './group.js';

async function makeFolder(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'eh-discover-'));
}

/** Make `dir` look like a git repo (the scan only checks for a `.git` entry). */
async function fakeGitRepo(dir: string): Promise<void> {
  await fs.mkdir(path.join(dir, '.git'), { recursive: true });
}

/** In-memory workspace registry matching the WorkspaceRegistrar signature. */
function fakeRegistry(initial: string[] = []) {
  const entries = initial.map((p) => path.resolve(p));
  const labels = new Map<string, string | undefined>();
  return {
    entries,
    labels,
    registerWorkspace: async (p: string, label?: string) => {
      const resolved = path.resolve(p);
      if (!entries.some((e) => e === resolved)) {
        entries.push(resolved);
        labels.set(resolved, label);
      }
    },
  };
}

const noopGit: GitRunner = async () => ({ stdout: '', stderr: '' });

describe('scanFolderForRepos', () => {
  it('lists immediate-child git repos and skips non-repos and SKIP_DIRS', async () => {
    const folder = await makeFolder();
    try {
      await fakeGitRepo(path.join(folder, 'engine'));
      await fakeGitRepo(path.join(folder, 'portal'));
      await fs.mkdir(path.join(folder, 'notes'), { recursive: true }); // plain dir, no .git
      await fakeGitRepo(path.join(folder, 'node_modules')); // SKIP_DIR even if it has .git
      await fs.writeFile(path.join(folder, 'README.md'), '# root', 'utf-8'); // a file

      const result = await scanFolderForRepos(folder);
      const names = result.repos.map((r) => r.name).sort();
      expect(names).toEqual(['engine', 'portal']);
      expect(result.folder).toBe(path.resolve(folder));
      // No origin remote configured in these bare .git stubs.
      expect(result.repos.every((r) => r.remote === null)).toBe(true);
      expect(result.repos.every((r) => r.registered === false)).toBe(true);
      expect(result.repos.every((r) => r.isGroupParent === false)).toBe(true);
    } finally {
      await fs.rm(folder, { recursive: true, force: true });
    }
  });

  it('flags a child that already hosts a group.json as a group parent', async () => {
    const folder = await makeFolder();
    try {
      const parent = path.join(folder, 'product-group');
      await fakeGitRepo(parent);
      await fs.writeFile(
        path.join(parent, GROUP_CONFIG_FILENAME),
        JSON.stringify({ name: 'prod', members: [{ name: 'engine', role: 'api', remote: 'https://h/e.git' }] }),
        'utf-8',
      );
      const result = await scanFolderForRepos(folder);
      const parentRepo = result.repos.find((r) => r.name === 'product-group');
      expect(parentRepo?.isGroupParent).toBe(true);
    } finally {
      await fs.rm(folder, { recursive: true, force: true });
    }
  });

  it('does not recurse into nested packages', async () => {
    const folder = await makeFolder();
    try {
      const mono = path.join(folder, 'mono');
      await fakeGitRepo(mono);
      await fakeGitRepo(path.join(mono, 'packages', 'inner')); // nested, must be ignored
      const result = await scanFolderForRepos(folder);
      expect(result.repos.map((r) => r.name)).toEqual(['mono']);
    } finally {
      await fs.rm(folder, { recursive: true, force: true });
    }
  });

  it('throws for a missing folder', async () => {
    await expect(scanFolderForRepos(path.join(os.tmpdir(), 'eh-does-not-exist-xyz'))).rejects.toThrow(/does not exist/i);
  });
});

describe('createDedicatedParent', () => {
  it('git inits, scaffolds the store, writes group.json, and registers the parent', async () => {
    const folder = await makeFolder();
    const parentPath = path.join(folder, 'my-group');
    const reg = fakeRegistry();
    let initRan = false;
    const git: GitRunner = async (_cwd, args) => {
      if (args[0] === 'init') initRan = true;
      return { stdout: '', stderr: '' };
    };
    try {
      const result = await createDedicatedParent(
        { parentPath, groupName: 'My Group', members: [{ name: 'engine', role: 'api', remote: 'https://h/e.git' }] },
        { gitRunner: git, registerWorkspace: reg.registerWorkspace },
      );
      expect(initRan).toBe(true);
      expect(result.gitInitialized).toBe(true);
      expect(result.wroteConfig).toBe(true);
      expect(result.scaffoldedStore).toBe(true);
      expect(result.registered).toBe(true);

      // group.json written with the supplied name + member.
      const cfg = JSON.parse(await fs.readFile(path.join(parentPath, GROUP_CONFIG_FILENAME), 'utf-8'));
      expect(cfg.name).toBe('My Group');
      expect(cfg.members).toHaveLength(1);
      expect(cfg.members[0].name).toBe('engine');

      // Store scaffolded and parent registered with the group-name label.
      expect(existsSync(path.join(parentPath, GROUP_STORE_DIRNAME))).toBe(true);
      expect(reg.entries).toContain(path.resolve(parentPath));
      expect(reg.labels.get(path.resolve(parentPath))).toBe('My Group');
    } finally {
      await fs.rm(folder, { recursive: true, force: true });
    }
  });

  it('refuses to clobber an existing group.json (routes to repair)', async () => {
    const folder = await makeFolder();
    const parentPath = path.join(folder, 'existing');
    try {
      await fs.mkdir(parentPath, { recursive: true });
      await fs.writeFile(
        path.join(parentPath, GROUP_CONFIG_FILENAME),
        JSON.stringify({ name: 'old', members: [] }),
        'utf-8',
      );
      await expect(
        createDedicatedParent(
          { parentPath, groupName: 'new', members: [{ name: 'engine', role: 'api', remote: 'https://h/e.git' }] },
          { gitRunner: noopGit, registerWorkspace: fakeRegistry().registerWorkspace },
        ),
      ).rejects.toThrow(/already exists/i);
    } finally {
      await fs.rm(folder, { recursive: true, force: true });
    }
  });

  it('rejects a member with an unsafe remote', async () => {
    const folder = await makeFolder();
    const parentPath = path.join(folder, 'g');
    try {
      await expect(
        createDedicatedParent(
          { parentPath, groupName: 'g', members: [{ name: 'bad', role: 'api', remote: 'ext::sh -c whoami' }] },
          { gitRunner: noopGit, registerWorkspace: fakeRegistry().registerWorkspace },
        ),
      ).rejects.toThrow();
      // Nothing was created for the rejected input.
      expect(existsSync(path.join(parentPath, GROUP_CONFIG_FILENAME))).toBe(false);
    } finally {
      await fs.rm(folder, { recursive: true, force: true });
    }
  });

  it('skips git init when the directory is already a repo', async () => {
    const folder = await makeFolder();
    const parentPath = path.join(folder, 'prerepo');
    try {
      await fakeGitRepo(parentPath); // already a repo
      let initRan = false;
      const git: GitRunner = async (_cwd, args) => {
        if (args[0] === 'init') initRan = true;
        return { stdout: '', stderr: '' };
      };
      const result = await createDedicatedParent(
        { parentPath, groupName: 'g', members: [{ name: 'engine', role: 'api', remote: 'https://h/e.git' }] },
        { gitRunner: git, registerWorkspace: fakeRegistry().registerWorkspace },
      );
      expect(initRan).toBe(false);
      expect(result.gitInitialized).toBe(false);
      expect(result.wroteConfig).toBe(true);
    } finally {
      await fs.rm(folder, { recursive: true, force: true });
    }
  });

  it('registers members with known paths and pins them in group.local.json', async () => {
    const folder = await makeFolder();
    const parentPath = path.join(folder, 'product-group');
    const memberA = path.join(folder, 'payments');
    const memberB = path.join(folder, 'web');
    const reg = fakeRegistry();
    try {
      await fakeGitRepo(memberA);
      await fakeGitRepo(memberB);
      const result = await createDedicatedParent(
        {
          parentPath,
          groupName: 'Prod',
          members: [
            { name: 'payments', role: 'api', remote: 'https://h/p.git', path: memberA },
            { name: 'web', role: 'app', remote: 'https://h/w.git', path: memberB },
          ],
        },
        { gitRunner: noopGit, registerWorkspace: reg.registerWorkspace },
      );

      // Parent + both members registered (member label is the member name).
      expect(reg.entries).toContain(path.resolve(parentPath));
      expect(reg.entries).toContain(path.resolve(memberA));
      expect(reg.entries).toContain(path.resolve(memberB));
      expect(reg.labels.get(path.resolve(memberA))).toBe('payments');

      expect(result.memberRegistrations.every((m) => m.registered)).toBe(true);
      expect(result.wroteLocalConfig).toBe(true);

      // group.local.json pins each member's real checkout path.
      const local = JSON.parse(await fs.readFile(path.join(parentPath, 'group.local.json'), 'utf-8'));
      expect(local.paths.payments).toBe(path.resolve(memberA));
      expect(local.paths.web).toBe(path.resolve(memberB));
    } finally {
      await fs.rm(folder, { recursive: true, force: true });
    }
  });

  it('reports a gap for a member whose path is missing or not supplied', async () => {
    const folder = await makeFolder();
    const parentPath = path.join(folder, 'product-group');
    const reg = fakeRegistry();
    try {
      const result = await createDedicatedParent(
        {
          parentPath,
          groupName: 'Prod',
          members: [
            // path points at a directory that doesn't exist on disk
            { name: 'ghost', role: 'api', remote: 'https://h/g.git', path: path.join(folder, 'nope') },
            // no path supplied at all
            { name: 'pathless', role: 'app', remote: 'https://h/p.git' },
          ],
        },
        { gitRunner: noopGit, registerWorkspace: reg.registerWorkspace },
      );

      const ghost = result.memberRegistrations.find((m) => m.name === 'ghost');
      const pathless = result.memberRegistrations.find((m) => m.name === 'pathless');
      expect(ghost?.registered).toBe(false);
      expect(ghost?.reason).toMatch(/not found/i);
      expect(pathless?.registered).toBe(false);
      expect(pathless?.reason).toMatch(/no local path/i);

      // Neither member was registered; only the parent is in the registry.
      expect(reg.entries).toContain(path.resolve(parentPath));
      expect(reg.entries).not.toContain(path.join(folder, 'nope'));
      // group.local.json still pins the supplied (even if missing) path for ghost.
      expect(result.wroteLocalConfig).toBe(true);
    } finally {
      await fs.rm(folder, { recursive: true, force: true });
    }
  });
});
