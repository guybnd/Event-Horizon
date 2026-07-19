// FLUX-1492: config.json last-writer-wins. Two things used to make `saveConfig` a whole-file
// clobber over the network boundary too: (1) `PUT /api/config` persisted the portal's cached
// GET response wholesale, including GET-computed keys (cliCapabilities, defaultFramework, ...)
// that were never real config; (2) the merge base was the in-memory `getConfig()`, which can be
// stale (missed config-watcher reload, or a second engine bound to the same store), so a save
// could silently revert a key that a different writer changed on disk since this process loaded.
// These guard the route-level fix: strip-on-PUT, merge-over-fresh-disk-read, and the FLUX-1460
// -style activation 503 guard extended to the config router.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import http from 'http';
import type { AddressInfo } from 'net';
import express from 'express';
import { setWorkspaceRoot, getConfigFile } from '../workspace.js';
import { requireWorkspace } from '../middleware.js';
import { getWorkspace } from '../workspace-context.js';
import { loadConfig, GET_COMPUTED_CONFIG_KEYS } from '../config.js';

describe('config routes (FLUX-1492)', () => {
  let root: string;
  let server: http.Server;
  let baseUrl: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'eh-config-routes-'));
    await fs.mkdir(path.join(root, '.flux'), { recursive: true });
    setWorkspaceRoot(root);
    await fs.writeFile(getConfigFile(), JSON.stringify({
      gatePolicy: { boardDefault: { plan: 'you', review: 'you' } },
      gatePolicyMigrated: true,
      modelPolicyMigrated: true,
      chatOpenDefaultMigrated: true,
      mcpServerPhases: { existingServer: ['grooming'] },
    }), 'utf-8');
    await loadConfig();

    const { default: configRouter } = await import('./config.js');
    const app = express();
    app.use(express.json());
    app.use('/api/config', requireWorkspace, configRouter);
    server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const addr = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterEach(async () => {
    getWorkspace().isActivating = false;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await fs.rm(root, { recursive: true, force: true }).catch(() => {});
  });

  it('PUT / strips GET-computed keys before persisting, but GET still serves them freshly computed', async () => {
    const getRes = await fetch(`${baseUrl}/api/config`);
    const served = await getRes.json();
    for (const key of GET_COMPUTED_CONFIG_KEYS) {
      expect(served[key]).toBeDefined();
    }

    // Portal echoes the full GET response back on save (including the computed keys).
    const putRes = await fetch(`${baseUrl}/api/config`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...served, planLint: false }),
    });
    expect(putRes.status).toBe(200);

    // The PUT response must mirror GET's shape — the portal replaces its live config with this
    // response wholesale (AppContext.tsx saveConfig), not merge — so it must still carry the
    // computed keys even though they're never written to disk.
    const putBody = await putRes.json();
    for (const key of GET_COMPUTED_CONFIG_KEYS) {
      expect(putBody[key]).toBeDefined();
    }

    const onDisk = JSON.parse(await fs.readFile(getConfigFile(), 'utf-8'));
    expect(onDisk.planLint).toBe(false);
    for (const key of GET_COMPUTED_CONFIG_KEYS) {
      expect(key in onDisk).toBe(false);
    }
  });

  it('PUT / merges over a fresh disk read, not a stale in-memory copy — preserves a key this process never saw', async () => {
    // Simulate a second writer changing mcpServerPhases on disk after this process's loadConfig().
    const onDiskBefore = JSON.parse(await fs.readFile(getConfigFile(), 'utf-8'));
    onDiskBefore.mcpServerPhases = { otherServer: ['implementation'] };
    await fs.writeFile(getConfigFile(), JSON.stringify(onDiskBefore), 'utf-8');

    // This process's PUT body (what the portal owns) never mentions mcpServerPhases at all.
    const putRes = await fetch(`${baseUrl}/api/config`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ planLint: false }),
    });
    expect(putRes.status).toBe(200);

    const onDisk = JSON.parse(await fs.readFile(getConfigFile(), 'utf-8'));
    expect(onDisk.mcpServerPhases).toEqual({ otherServer: ['implementation'] });
    expect(onDisk.planLint).toBe(false);
    // gatePolicy (engine-managed, not sent by the portal here) survives too.
    expect(onDisk.gatePolicy.boardDefault).toEqual({ plan: 'you', review: 'you' });
  });

  it('PUT /mcp-phases patches only mcpServerPhases, preserving a gatePolicy change made since load', async () => {
    const onDiskBefore = JSON.parse(await fs.readFile(getConfigFile(), 'utf-8'));
    onDiskBefore.gatePolicy = { boardDefault: { plan: 'auto-then-you', review: 'auto' } };
    await fs.writeFile(getConfigFile(), JSON.stringify(onDiskBefore), 'utf-8');

    const putRes = await fetch(`${baseUrl}/api/config/mcp-phases`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mcpServerPhases: { newServer: ['review'] } }),
    });
    expect(putRes.status).toBe(200);
    expect(await putRes.json()).toEqual({ mcpServerPhases: { newServer: ['review'] } });

    const onDisk = JSON.parse(await fs.readFile(getConfigFile(), 'utf-8'));
    expect(onDisk.mcpServerPhases).toEqual({ newServer: ['review'] });
    expect(onDisk.gatePolicy.boardDefault).toEqual({ plan: 'auto-then-you', review: 'auto' });
  });

  it('returns 503 with no write on GET/PUT / and GET/PUT /mcp-phases while the workspace is activating', async () => {
    const rawBefore = await fs.readFile(getConfigFile(), 'utf-8');
    getWorkspace().isActivating = true;
    try {
      const getConfigRes = await fetch(`${baseUrl}/api/config`);
      expect(getConfigRes.status).toBe(503);
      await getConfigRes.text();

      const putConfigRes = await fetch(`${baseUrl}/api/config`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ planLint: false }),
      });
      expect(putConfigRes.status).toBe(503);
      await putConfigRes.text();

      const getPhasesRes = await fetch(`${baseUrl}/api/config/mcp-phases`);
      expect(getPhasesRes.status).toBe(503);
      await getPhasesRes.text();

      const putPhasesRes = await fetch(`${baseUrl}/api/config/mcp-phases`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mcpServerPhases: {} }),
      });
      expect(putPhasesRes.status).toBe(503);
      await putPhasesRes.text();

      // No path serves or persists CONFIG_DEFAULTS values for a board with a readable config.json —
      // config.json is untouched by any of the four 503'd requests above.
      const rawAfter = await fs.readFile(getConfigFile(), 'utf-8');
      expect(rawAfter).toBe(rawBefore);
    } finally {
      getWorkspace().isActivating = false;
    }
  });
});
