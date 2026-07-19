import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs/promises';
import { realpathSync } from 'fs';
import path from 'path';
import os from 'os';
import matter from 'gray-matter';
import { activateWorkspace, openWorkspaceLive } from '../task-store.js';
import { listWorkspaces, closeWorkspace } from '../workspace-context.js';
import { enrichEntry } from './workspaces.js';

/**
 * FLUX-1455 review fix. Before this fix, `enrichEntry`'s `open`/`closable` were derived from
 * `getWorkspaceRoot()`, which moves to whatever board was most recently brought up via
 * `openWorkspaceLive` — so opening a second board made the boot/default board report
 * `open:false` (dropping it from the switcher's tab strip, AC2/AC5) and `closable:true`
 * (violating the "primary tab never closes" invariant). These tests exercise the real bootstrap
 * chain (`activateWorkspace` for the legacy default board, `openWorkspaceLive` for the S1-registry
 * board) against real temp directories, mirroring workspace-bootstrap.test.ts's precedent for why
 * no mocking is needed here.
 */

function ticketContent(id: string, title: string) {
  return matter.stringify('body', { id, title, status: 'Todo' });
}

async function makeBoard(prefix: string, ticketId: string, title: string): Promise<string> {
  let root = await fs.mkdtemp(path.join(os.tmpdir(), `eh-wsroute-${prefix}-`));
  try { root = realpathSync.native(root); } catch { /* keep as given */ }
  const fluxDir = path.join(root, '.flux');
  await fs.mkdir(fluxDir, { recursive: true });
  await fs.writeFile(path.join(fluxDir, `${ticketId}.md`), ticketContent(ticketId, title));
  return root;
}

describe('enrichEntry (GET /workspaces): default board stays open/non-closable after a second board opens (FLUX-1455)', () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(listWorkspaces().map((ws) => ws.root && closeWorkspace(ws.root)));
    await Promise.all(roots.splice(0).map((r) => fs.rm(r, { recursive: true, force: true }).catch(() => {})));
  }, 20_000);

  it('the boot/default board reports open:true and closable:false once openWorkspaceLive brings a second board up', async () => {
    const rootA = await makeBoard('a', 'FLUX-1', 'Board A ticket');
    roots.push(rootA);
    const rootB = await makeBoard('b', 'FLUX-2', 'Board B ticket');
    roots.push(rootB);

    await activateWorkspace(rootA);
    // Moves activeKey to B — this is exactly what broke A's `open` flag pre-fix.
    await openWorkspaceLive(rootB);

    const infoA = enrichEntry({ path: rootA }, new Map());
    const infoB = enrichEntry({ path: rootB }, new Map());

    expect(infoA.open).toBe(true);
    expect(infoA.closable).toBe(false);
    expect(infoB.open).toBe(true);
    expect(infoB.closable).toBe(true);
  }, 20_000);
});

describe('enrichEntry: registry-key casing must match the live board (FLUX-1571)', () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(listWorkspaces().map((ws) => ws.root && closeWorkspace(ws.root)));
    await Promise.all(roots.splice(0).map((r) => fs.rm(r, { recursive: true, force: true }).catch(() => {})));
  }, 20_000);

  it.skipIf(process.platform !== 'win32')(
    'a registry entry stored in a different case than the live root still reports active/open true',
    async () => {
      const root = await makeBoard('casing', 'FLUX-1', 'Board ticket');
      roots.push(root);
      await activateWorkspace(root);

      // Simulates an entry persisted before FLUX-1571 (or hand-typed) whose casing diverges from
      // the realpath-canonical form `getWorkspaceRoot()` returns — the exact mismatch that made
      // `active`/`open` silently read false even though the board really is live.
      const differentlyCased = root === root.toUpperCase() ? root.toLowerCase() : root.toUpperCase();
      const info = enrichEntry({ path: differentlyCased }, new Map());

      expect(info.active).toBe(true);
      expect(info.open).toBe(true);
    },
    20_000,
  );
});
