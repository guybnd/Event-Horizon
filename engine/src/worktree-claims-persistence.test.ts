// FLUX-1771: restart-durability for worktree claims — without this, every engine restart re-opens
// the bug the claim exists to close (the post-restart session-store grace covers only the
// immediate window, and nothing re-creates a claim afterwards; see worktree-claims.ts's header).
//
// Real temp workspace + the real workspace.js/workspace-context.ts (mirrors
// background-process-holds.test.ts's own persistence fixture) so syncClaimStubs/rehydrateClaimStubs
// genuinely touch disk under the board's own `.flux/worktree-claims/` dir.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fsp from 'fs/promises';
import path from 'path';
import os from 'os';
import {
  claimWorktree,
  releaseClaim,
  getClaim,
  syncClaimStubs,
  rehydrateClaimStubs,
  __resetWorktreeClaimsForTest,
} from './worktree-claims.js';
import { getDefaultWorkspace, runWithWorkspace, type Workspace } from './workspace-context.js';
import { setWorkspaceRoot } from './workspace.js';

describe('worktree-claims persistence', () => {
  let root: string;
  let ws: Workspace;

  function claimsDirFor(r: string): string {
    return path.join(r, '.flux', 'worktree-claims');
  }
  async function readClaimFiles(r: string): Promise<string[]> {
    return (await fsp.readdir(claimsDirFor(r)).catch(() => [] as string[])).sort();
  }

  beforeEach(async () => {
    root = await fsp.mkdtemp(path.join(os.tmpdir(), 'eh-wtclaim-'));
    setWorkspaceRoot(root);
    ws = getDefaultWorkspace();
    root = ws.root ?? root; // realpath-canonicalized form, mirrors background-process-holds.test.ts
    __resetWorktreeClaimsForTest();
  });

  afterEach(async () => {
    __resetWorktreeClaimsForTest();
    await fsp.rm(root, { recursive: true, force: true }).catch(() => {});
  });

  it('writes a claim to disk, then restores it on rehydrate (a fresh module-state stand-in for a restart)', async () => {
    claimWorktree({ workspaceRoot: root, ticketId: 'FLUX-1', branch: 'flux/FLUX-1-thing', worktreePath: '/wt/FLUX-1', ownerId: 'unbound' });
    await runWithWorkspace(ws, () => rehydrateClaimStubs(ws)); // arms the sync-guard, same as production boot
    await runWithWorkspace(ws, () => syncClaimStubs(root));
    expect(await readClaimFiles(root)).toHaveLength(1);

    // Simulate a restart: wipe in-memory state, then rehydrate from the stub just written.
    __resetWorktreeClaimsForTest();
    expect(getClaim(root, 'FLUX-1')).toBeUndefined();
    const count = await runWithWorkspace(ws, () => rehydrateClaimStubs(ws));
    expect(count).toBe(1);
    expect(getClaim(root, 'FLUX-1')?.branch).toBe('flux/FLUX-1-thing');
  });

  it('drops an already-expired stub on rehydrate instead of resuming it', async () => {
    await fsp.mkdir(claimsDirFor(root), { recursive: true });
    await fsp.writeFile(
      path.join(claimsDirFor(root), 'FLUX-1.json'),
      JSON.stringify({
        ticketId: 'FLUX-1',
        branch: 'flux/FLUX-1-thing',
        worktreePath: '/wt/FLUX-1',
        ownerId: 'unbound',
        createdAt: new Date(Date.now() - 3 * 60 * 60_000).toISOString(),
        expiresAt: new Date(Date.now() - 60 * 60_000).toISOString(), // 1h overdue
        workspaceRoot: root,
      }),
      'utf-8',
    );

    const count = await runWithWorkspace(ws, () => rehydrateClaimStubs(ws));
    expect(count).toBe(0);
    expect(getClaim(root, 'FLUX-1')).toBeUndefined();
    expect(await readClaimFiles(root)).toHaveLength(0); // the overdue stub is pruned, not left behind
  });

  it('prunes a stub tagged for a DIFFERENT workspace root — foreign residue never adopted', async () => {
    const other = await fsp.mkdtemp(path.join(os.tmpdir(), 'eh-wtclaim-other-'));
    try {
      await fsp.mkdir(claimsDirFor(root), { recursive: true });
      await fsp.writeFile(
        path.join(claimsDirFor(root), 'FLUX-1.json'),
        JSON.stringify({
          ticketId: 'FLUX-1',
          branch: 'flux/FLUX-1-thing',
          worktreePath: '/wt/FLUX-1',
          ownerId: 'unbound',
          createdAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
          workspaceRoot: other, // tagged for a DIFFERENT board
        }),
        'utf-8',
      );

      const count = await runWithWorkspace(ws, () => rehydrateClaimStubs(ws));
      expect(count).toBe(0);
      expect(await readClaimFiles(root)).toHaveLength(0); // pruned, not adopted
    } finally {
      await fsp.rm(other, { recursive: true, force: true }).catch(() => {});
    }
  });

  it('syncClaimStubs is a no-op before rehydrate has run for this root (boot-ordering guard)', async () => {
    claimWorktree({ workspaceRoot: root, ticketId: 'FLUX-1', branch: 'flux/FLUX-1-thing', worktreePath: '/wt/FLUX-1', ownerId: 'unbound' });
    // Deliberately skip rehydrateClaimStubs — sync before rehydrate must delete nothing (there is
    // nothing on disk yet, but more importantly it must not treat the empty in-memory registry as
    // authoritative and wipe an on-disk stub a concurrent tick may be mid-write on).
    await runWithWorkspace(ws, () => syncClaimStubs(root));
    expect(await readClaimFiles(root)).toHaveLength(0);
  });

  it('syncClaimStubs prunes a stale on-disk stub for a claim that has since been released', async () => {
    claimWorktree({ workspaceRoot: root, ticketId: 'FLUX-1', branch: 'flux/FLUX-1-thing', worktreePath: '/wt/FLUX-1', ownerId: 'unbound' });
    await runWithWorkspace(ws, () => rehydrateClaimStubs(ws));
    await runWithWorkspace(ws, () => syncClaimStubs(root));
    expect(await readClaimFiles(root)).toHaveLength(1);

    releaseClaim(root, 'FLUX-1');
    await runWithWorkspace(ws, () => syncClaimStubs(root));
    expect(await readClaimFiles(root)).toHaveLength(0);
  });
});
