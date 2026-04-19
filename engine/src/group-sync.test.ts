import { describe, it, expect } from 'vitest';
import { fanOutGroupDocs, type GitRunner, type MemberSyncResult } from './group-sync.js';
import type { GroupContext, ResolvedMember } from './group.js';

function makeGroup(members: Array<Partial<ResolvedMember>>): GroupContext {
  return {
    parentRoot: '/tmp/parent',
    config: { name: 'acme', members: members as ResolvedMember[] },
    members: members.map((m) => ({
      name: m.name ?? 'x',
      role: m.role ?? 'api',
      remote: m.remote ?? 'https://h/x.git',
      path: m.path ?? '/tmp/x',
      pathExists: m.pathExists ?? true,
    })),
    groupStoreDir: '/tmp/parent/.flux-group',
    docsBranch: 'flux-group-docs',
  };
}

describe('fanOutGroupDocs', () => {
  it('pushes to each member by URL with the flux-group-docs refspec', async () => {
    const calls: Array<{ cwd: string; args: string[] }> = [];
    const runner: GitRunner = async (cwd, args) => {
      calls.push({ cwd, args });
      return { stdout: '', stderr: '' };
    };
    const group = makeGroup([
      { name: 'engine', remote: 'https://h/engine.git' },
      { name: 'portal', remote: 'git@github.com:acme/portal.git' },
    ]);
    const results = await fanOutGroupDocs(group, { gitRunner: runner });

    expect(results.every((r) => r.ok)).toBe(true);
    expect(calls).toHaveLength(2);
    expect(calls[0]).toEqual({
      cwd: '/tmp/parent',
      args: ['push', 'https://h/engine.git', 'flux-group-docs:flux-group-docs'],
    });
  });

  it('rejects an invalid member remote before touching git', async () => {
    let pushed = false;
    const runner: GitRunner = async () => {
      pushed = true;
      return { stdout: '', stderr: '' };
    };
    const group = makeGroup([{ name: 'evil', remote: 'ext::sh -c "touch /tmp/pwn"' }]);
    const results = await fanOutGroupDocs(group, { gitRunner: runner });

    expect(pushed).toBe(false);
    expect(results[0].ok).toBe(false);
    expect(results[0].error).toMatch(/invalid remote/i);
  });

  it('isolates failures — one member failing does not abort the rest', async () => {
    const runner: GitRunner = async (_cwd, args) => {
      if (args[1] === 'https://h/bad.git') throw new Error('Authentication failed');
      return { stdout: '', stderr: '' };
    };
    const group = makeGroup([
      { name: 'good', remote: 'https://h/good.git' },
      { name: 'bad', remote: 'https://h/bad.git' },
      { name: 'good2', remote: 'https://h/good2.git' },
    ]);
    const results = await fanOutGroupDocs(group, { gitRunner: runner });

    const byName = (n: string) => results.find((r) => r.name === n) as MemberSyncResult;
    expect(byName('good').ok).toBe(true);
    expect(byName('good2').ok).toBe(true);
    expect(byName('bad').ok).toBe(false);
    expect(byName('bad').error).toMatch(/authentication failed/i);
  });

  it('flags a diverged member (non-fast-forward rejection) without forcing', async () => {
    const runner: GitRunner = async () => {
      throw new Error(
        '! [rejected]        flux-group-docs -> flux-group-docs (fetch first)\nerror: failed to push some refs',
      );
    };
    const group = makeGroup([{ name: 'ahead', remote: 'https://h/ahead.git' }]);
    const results = await fanOutGroupDocs(group, { gitRunner: runner });

    expect(results[0].ok).toBe(false);
    expect(results[0].diverged).toBe(true);
  });

  it('allows local remotes only when allowLocalRemotes is set', async () => {
    const runner: GitRunner = async () => ({ stdout: '', stderr: '' });
    const group = makeGroup([{ name: 'local', remote: 'C:\\repos\\member.git' }]);

    const blocked = await fanOutGroupDocs(group, { gitRunner: runner });
    expect(blocked[0].ok).toBe(false);

    const allowed = await fanOutGroupDocs(group, { gitRunner: runner, allowLocalRemotes: true });
    expect(allowed[0].ok).toBe(true);
  });
});
