import { describe, it, expect, afterEach, vi } from 'vitest';
import fs from 'fs/promises';
import { realpathSync } from 'fs';
import path from 'path';
import os from 'os';
import { execFile } from 'child_process';
import { promisify } from 'util';
import matter from 'gray-matter';
import { activateWorkspace, openWorkspaceLive } from './task-store.js';
import { getWorkspace, getWorkspaceByRoot, listWorkspaces, closeWorkspace } from './workspace-context.js';

const execFileAsync = promisify(execFile);

// FLUX-1558's member-binding test needs `getWorkspacesList()` to report our temp parent root as
// registered — the real implementation reads the machine's actual global settings.json, which
// must not be touched by a test. Keep everything else in workspace.js real via importOriginal;
// only getWorkspacesList is swapped, and only when a test opts in by setting the override below.
let registeredRootsOverride: string[] | null = null;
vi.mock('./workspace.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./workspace.js')>();
  return {
    ...actual,
    getWorkspacesList: async () => {
      if (registeredRootsOverride) return registeredRootsOverride.map((p) => ({ path: p }));
      return actual.getWorkspacesList();
    },
  };
});

/**
 * FLUX-1529 (epic FLUX-1230 S11). Before this ticket, only `doActivateWorkspace` could bring a
 * board live, and it did so by clearing + reloading the ONE shared `Workspace` in place —
 * structurally impossible to have two live boards. These tests exercise the real bootstrap chain
 * (`activateWorkspace` for the legacy single-active path, `openWorkspaceLive` for the new registry
 * path added by this ticket) against real temp directories with no `.git`, so the git-touching
 * steps inside the shared `hydrateWorkspace` body — `attachWorktreeIfPresent`'s background pull,
 * `pruneTaskWorktrees`, `migrateStrandedFluxTickets` — all no-op or fail-fast cleanly (same
 * precedent as task-store-watcher.test.ts/task-store-perf.test.ts) rather than mocking the routine
 * under test.
 */

function ticketContent(id: string, title: string) {
  return matter.stringify('body', { id, title, status: 'Todo' });
}

async function makeBoard(prefix: string, ticketId: string, title: string): Promise<string> {
  let root = await fs.mkdtemp(path.join(os.tmpdir(), `eh-bootstrap-${prefix}-`));
  // Mirrors activateWorkspace()'s own realpath normalization (FLUX-711): an 8.3 short-name path
  // handed to chokidar aborts the whole process instead of throwing a catchable JS error.
  try { root = realpathSync.native(root); } catch { /* keep as given */ }
  const fluxDir = path.join(root, '.flux');
  await fs.mkdir(fluxDir, { recursive: true });
  await fs.writeFile(path.join(fluxDir, `${ticketId}.md`), ticketContent(ticketId, title));
  return root;
}

/** A board that is itself a group parent — carries a `group.json` listing one member remote. */
async function makeGroupParentBoard(prefix: string, ticketId: string, title: string, memberRemote: string): Promise<string> {
  const root = await makeBoard(prefix, ticketId, title);
  await fs.writeFile(
    path.join(root, 'group.json'),
    JSON.stringify({ name: 'prod', members: [{ name: 'engine', role: 'api', remote: memberRemote }] }),
    'utf-8',
  );
  return root;
}

async function gitInitWithRemote(repoRoot: string, remote: string): Promise<void> {
  await execFileAsync('git', ['-C', repoRoot, 'init'], { windowsHide: true });
  await execFileAsync('git', ['-C', repoRoot, 'remote', 'add', 'origin', remote], { windowsHide: true });
}

describe('workspace bootstrap: hydrateWorkspace via activateWorkspace / openWorkspaceLive (FLUX-1529)', () => {
  const roots: string[] = [];

  afterEach(async () => {
    // Close every registry entry opened via openWorkspaceLive so `activeKey` falls back to
    // defaultWorkspace (null) before the next test — mirrors workspace-context.test.ts's own
    // per-test registry cleanup.
    await Promise.all(listWorkspaces().map((ws) => ws.root && closeWorkspace(ws.root)));
    await Promise.all(roots.splice(0).map((r) => fs.rm(r, { recursive: true, force: true }).catch(() => {})));
  }, 20_000);

  it('a second board loads live via openWorkspaceLive without touching the already-active board', async () => {
    const rootA = await makeBoard('a', 'FLUX-1', 'Board A ticket');
    roots.push(rootA);
    const rootB = await makeBoard('b', 'FLUX-2', 'Board B ticket');
    roots.push(rootB);

    await activateWorkspace(rootA);
    const wsA = getWorkspace(); // legacy path — resolves via the bare global, registry still empty

    const wsB = await openWorkspaceLive(rootB);

    expect(wsB).not.toBe(wsA);
    expect(Object.keys(wsB.tasks)).toEqual(['FLUX-2']);
    expect(wsB.tasks['FLUX-2']?.title).toBe('Board B ticket');
    expect(wsB.fluxWatcher).not.toBeNull();

    // A's Workspace object is untouched — still holds its own ticket and its own live watcher,
    // not wiped/reloaded by B's load. That's the regression this ticket fixes.
    expect(Object.keys(wsA.tasks)).toEqual(['FLUX-1']);
    expect(wsA.tasks['FLUX-1']?.title).toBe('Board A ticket');
    expect(wsA.fluxWatcher).not.toBeNull();

    expect(getWorkspaceByRoot(rootB)).toBe(wsB);
  }, 20_000);

  it('a second openWorkspaceLive call for an already-live board is idempotent — no reload, same watcher', async () => {
    const rootB = await makeBoard('b-idem', 'FLUX-3', 'Idempotency ticket');
    roots.push(rootB);

    const first = await openWorkspaceLive(rootB);
    const watcherBefore = first.fluxWatcher;

    const second = await openWorkspaceLive(rootB);

    expect(second).toBe(first);
    expect(second.fluxWatcher).toBe(watcherBefore); // same watcher instance — not re-created
    expect(Object.keys(second.tasks)).toEqual(['FLUX-3']); // not reloaded/duplicated
  }, 20_000);

  it('closeWorkspace tears down the second board and leaves the first board live', async () => {
    const rootA = await makeBoard('a-close', 'FLUX-4', 'Board A ticket');
    roots.push(rootA);
    const rootB = await makeBoard('b-close', 'FLUX-5', 'Board B ticket');
    roots.push(rootB);

    await activateWorkspace(rootA);
    const wsA = getWorkspace();
    const wsB = await openWorkspaceLive(rootB);
    expect(wsB.fluxWatcher).not.toBeNull();

    await closeWorkspace(rootB);

    expect(wsB.fluxWatcher).toBeNull();
    expect(wsB.docsWatcher).toBeNull();
    expect(getWorkspaceByRoot(rootB)).toBeUndefined();

    // A was never registered via openWorkspace, so it survives untouched.
    expect(wsA.fluxWatcher).not.toBeNull();
    expect(Object.keys(wsA.tasks)).toEqual(['FLUX-4']);
  }, 20_000);
});

/**
 * FLUX-1558: `get_project_group` / `group_doc` used to resolve the multi-repo group via
 * process-global singletons in group.ts (whichever workspace activated last), so a second live
 * board could see — and write group docs through — a different board's group. `hydrateWorkspace`
 * now also records the result on the `Workspace` object itself (`groupContext`/`memberBinding`);
 * these tests assert at that field level that each board's own result is independent of which
 * board activated first.
 */
describe('workspace bootstrap: group context recorded per workspace (FLUX-1558)', () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(listWorkspaces().map((ws) => ws.root && closeWorkspace(ws.root)));
    await Promise.all(roots.splice(0).map((r) => fs.rm(r, { recursive: true, force: true }).catch(() => {})));
    registeredRootsOverride = null;
  }, 20_000);

  it('a group-parent board and a non-group board each report their own group', async () => {
    const remote = 'git@github.com:acme/member-engine-1.git';
    const rootA = await makeGroupParentBoard('group-a', 'FLUX-10', 'Parent board ticket', remote);
    roots.push(rootA);
    const rootB = await makeBoard('nongroup-b', 'FLUX-11', 'Non-group board ticket');
    roots.push(rootB);

    await activateWorkspace(rootA);
    const wsA = getWorkspace();
    const wsB = await openWorkspaceLive(rootB);

    expect(wsA.groupContext?.config.name).toBe('prod');
    expect(wsA.memberBinding).toBeNull();
    expect(wsB.groupContext).toBeNull();
    expect(wsB.memberBinding).toBeNull();
  }, 20_000);

  it('order-independence: activating the non-group board first yields the same per-workspace result', async () => {
    const remote = 'git@github.com:acme/member-engine-2.git';
    const rootB = await makeBoard('nongroup-b2', 'FLUX-12', 'Non-group board ticket');
    roots.push(rootB);
    const rootA = await makeGroupParentBoard('group-a2', 'FLUX-13', 'Parent board ticket', remote);
    roots.push(rootA);

    // Reverse order vs. the test above — activate the non-group board first.
    await activateWorkspace(rootB);
    const wsB = getWorkspace();
    const wsA = await openWorkspaceLive(rootA);

    expect(wsA.groupContext?.config.name).toBe('prod');
    expect(wsA.memberBinding).toBeNull();
    expect(wsB.groupContext).toBeNull();
    expect(wsB.memberBinding).toBeNull();
  }, 20_000);

  it('a member board populates memberBinding while groupContext stays null', async () => {
    const remote = 'git@github.com:acme/member-engine-3.git';
    const rootA = await makeGroupParentBoard('group-a3', 'FLUX-14', 'Parent board ticket', remote);
    roots.push(rootA);
    const rootMember = await makeBoard('member-3', 'FLUX-15', 'Member board ticket');
    roots.push(rootMember);
    await gitInitWithRemote(rootMember, remote);

    // activateMemberBinding's reverse-lookup scans getWorkspacesList() for a parent — point it at
    // our temp parent root instead of touching the real global settings.json (see the vi.mock above).
    registeredRootsOverride = [rootA, rootMember];
    const wsMember = await openWorkspaceLive(rootMember);

    expect(wsMember.groupContext).toBeNull();
    expect(wsMember.memberBinding).not.toBeNull();
    expect(wsMember.memberBinding?.parentGroup.config.name).toBe('prod');
    expect(wsMember.memberBinding?.memberName).toBe('engine');
  }, 20_000);
});
