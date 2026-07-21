// FLUX-1579: `upsertManagedTicket` resolved a brand-new managed ticket's file path via the
// AMBIENT `getActiveFluxDir()` instead of the `ws` it was handed — so a background board's PR
// reconcile tick (unbound, per the historical `syncPrTickets(workspaceRoot, ws)` fan-out in
// index.ts) created its new PR-<n> card inside whichever board happened to be ambiently active,
// not its own store. On 2026-07-19 this let HomeUp's reconcile tick overwrite EventHorizon's own
// `PR-90.md` (a Released historical card) wholesale. These tests lock the fix: the create-path is
// always derived from `ws`, and a resolved path that already exists on disk with no matching
// `ws.tasks` entry refuses rather than blind-overwrites.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';

import { getDefaultWorkspace, openWorkspace, closeWorkspace, type Workspace } from './workspace-context.js';
import { setWorkspaceRoot } from './workspace.js';
import { upsertManagedTicket } from './task-store.js';

describe('upsertManagedTicket — multi-workspace create-path scoping (FLUX-1579)', () => {
  let defaultWs: Workspace;
  let otherWs: Workspace;
  let defaultRoot: string;
  let otherRoot: string;

  beforeEach(async () => {
    // `defaultWs` stands in for EH: the ambiently-active board when a call has no explicit
    // runWithWorkspace binding (FLUX-1557's deterministic unbound fallback).
    defaultRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'eh-prcreate-default-'));
    setWorkspaceRoot(defaultRoot);
    defaultWs = getDefaultWorkspace();
    defaultWs.tasks = {};
    await fs.mkdir(path.join(defaultRoot, '.flux'), { recursive: true });

    // `otherWs` stands in for HomeUp: a second, background board — registered but NOT the
    // ambiently-active one for unbound calls.
    otherRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'eh-prcreate-other-'));
    otherWs = openWorkspace(otherRoot);
    otherRoot = otherWs.root ?? otherRoot; // realpath-canonicalized by openWorkspace
    otherWs.tasks = {};
    await fs.mkdir(path.join(otherRoot, '.flux'), { recursive: true });
  });

  afterEach(async () => {
    await closeWorkspace(otherRoot);
    await fs.rm(defaultRoot, { recursive: true, force: true }).catch(() => {});
    await fs.rm(otherRoot, { recursive: true, force: true }).catch(() => {});
  });

  it('a NEW ticket created for board B lands in board B\'s store even while board A is ambiently active, and never touches board A\'s same-named file', async () => {
    // EH already has its own historical PR-90.md on disk (Released card) — NOT wrapped in
    // otherWs.tasks, since these are two entirely separate stores.
    const ehPr90Path = path.join(defaultRoot, '.flux', 'PR-90.md');
    const ehOriginal = '---\ntitle: \'PR #90: FLUX-784: add error listeners to all chokidar watchers\'\nstatus: Released\nversion: 1.0.0\n---\nEH\'s own PR body.\n';
    await fs.writeFile(ehPr90Path, ehOriginal, 'utf-8');
    defaultWs.tasks['PR-90'] = { id: 'PR-90', title: 'EH PR #90', status: 'Released' };

    // Mirrors the real incident: syncPrTickets(workspaceRoot, otherWs) calling upsertManagedTicket
    // with NO runWithWorkspace(otherWs, …) binding around it — ambient context stays on defaultWs.
    const result = await upsertManagedTicket(
      'PR-90',
      { kind: 'pr', status: 'Ready', branch: 'flux/furnace-herth', implementationLink: 'https://github.com/guybnd/HomeUp/pull/90' },
      'HomeUp PR body.',
      otherWs,
    );

    expect(result.created).toBe(true);

    // Lands under board B's own store...
    const otherPr90Path = path.join(otherRoot, '.flux', 'PR-90.md');
    const otherContent = await fs.readFile(otherPr90Path, 'utf-8');
    expect(otherContent).toContain('HomeUp PR body.');
    expect(otherWs.tasks['PR-90']?._path).toBe(otherPr90Path);

    // ...and EH's file on disk + in-memory record are byte-for-byte untouched.
    const ehContentAfter = await fs.readFile(ehPr90Path, 'utf-8');
    expect(ehContentAfter).toBe(ehOriginal);
    expect(defaultWs.tasks['PR-90']?.status).toBe('Released');
  });

  it('refuses to create a ticket whose resolved path already exists on disk with no matching ws.tasks entry (store/memory mismatch)', async () => {
    // Simulate the disk and in-memory cache disagreeing WITHIN one board: a file is present but
    // the workspace's cache doesn't know about it (e.g. a stale/partial rescan).
    const staleId = 'PR-77';
    const stalePath = path.join(otherRoot, '.flux', `${staleId}.md`);
    await fs.writeFile(stalePath, '---\ntitle: Untracked pre-existing file\n---\nBody.\n', 'utf-8');
    // otherWs.tasks intentionally has NO entry for PR-77.

    await expect(
      upsertManagedTicket(staleId, { kind: 'pr', status: 'Ready' }, 'New body.', otherWs),
    ).rejects.toThrow();

    // The pre-existing file must survive unmodified.
    const contentAfter = await fs.readFile(stalePath, 'utf-8');
    expect(contentAfter).toContain('Untracked pre-existing file');
  });
});
