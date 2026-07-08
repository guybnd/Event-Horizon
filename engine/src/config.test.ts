// FLUX-1261: the one-time migration of Temper's board-wide `temperEnabled` boolean into
// `gatePolicy.boardDefault.review`, run once from `loadConfig()`. Everything else `loadConfig` does
// (column/tag/priority normalization, the chat-open-default migration) is out of scope here.

import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { setWorkspaceRoot, getConfigFile } from './workspace.js';
import { configCache, loadConfig } from './config.js';
import { UNMIGRATED_GATE_POLICY_DEFAULT } from './models/gate-policy.js';

describe('loadConfig — gatePolicy migration (FLUX-1261, expanded scope FLUX-1292)', () => {
  beforeEach(async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'eh-config-'));
    await fs.mkdir(path.join(root, '.flux'), { recursive: true });
    setWorkspaceRoot(root);
    // Reset migration-relevant state — `configCache` is a module-level singleton that can carry a
    // prior test's (or prior run's) migrated shape forward otherwise. `gatePolicy` is reset to the
    // module's own seed value (NOT deleted) — since FLUX-1292 that seed (UNMIGRATED_GATE_POLICY_DEFAULT,
    // auto/auto) differs from the migration block's `?? DEFAULT_GATE_POLICY` fallback (you/you), so
    // deleting the key here would exercise a state (an undefined boardDefault reaching that fallback)
    // that never actually occurs on a real process start — the module literal always seeds it first.
    delete configCache.gatePolicyMigrated;
    configCache.gatePolicy = { boardDefault: { ...UNMIGRATED_GATE_POLICY_DEFAULT.boardDefault } };
    delete configCache.temperEnabled;
  });

  it('migrates a fresh workspace with no config.json at all into gatePolicy.boardDefault = auto/auto (FLUX-1292)', async () => {
    // No file written — loadConfig() must hit the ENOENT branch, not the parsed-JSON path.
    await loadConfig();

    expect(configCache.gatePolicy.boardDefault).toEqual({ plan: 'auto', review: 'auto' });
    expect(configCache.gatePolicyMigrated).toBe(true);

    const onDisk = JSON.parse(await fs.readFile(getConfigFile(), 'utf-8'));
    expect(onDisk.gatePolicy.boardDefault).toEqual({ plan: 'auto', review: 'auto' });
    expect(onDisk.gatePolicyMigrated).toBe(true);
  });

  it('migrates a persisted temperEnabled:true into gatePolicy.boardDefault = auto/auto, with no behavior change to review at cutover', async () => {
    await fs.writeFile(getConfigFile(), JSON.stringify({ temperEnabled: true }), 'utf-8');
    await loadConfig();

    expect(configCache.gatePolicy.boardDefault.review).toBe('auto');
    expect(configCache.gatePolicy.boardDefault.plan).toBe('auto'); // never configured — FLUX-1292 default
    expect(configCache.temperEnabled).toBeUndefined();
    expect(configCache.gatePolicyMigrated).toBe(true);

    // Persisted, not just in-memory — a restart must not re-derive from a resurrected temperEnabled.
    const onDisk = JSON.parse(await fs.readFile(getConfigFile(), 'utf-8'));
    expect(onDisk.gatePolicy.boardDefault.review).toBe('auto');
    expect(onDisk.temperEnabled).toBeUndefined();
  });

  it('migrates a persisted temperEnabled:false into gatePolicy.boardDefault.review = "auto" (never configured, not a deliberate opt-out — FLUX-1292)', async () => {
    await fs.writeFile(getConfigFile(), JSON.stringify({ temperEnabled: false }), 'utf-8');
    await loadConfig();
    expect(configCache.gatePolicy.boardDefault.review).toBe('auto');
  });

  it('migrates a board with no temperEnabled key at all into "auto" (never touched gate policy — FLUX-1292)', async () => {
    await fs.writeFile(getConfigFile(), JSON.stringify({}), 'utf-8');
    await loadConfig();
    expect(configCache.gatePolicy.boardDefault.review).toBe('auto');
  });

  it('never re-derives from a stale temperEnabled once already migrated (idempotent, respects a later deliberate dial change)', async () => {
    // Simulates a restart reading a config.json that somehow still carries an old temperEnabled
    // alongside an already-migrated gatePolicy that a human later dialed back to 'you' by hand.
    await fs.writeFile(getConfigFile(), JSON.stringify({
      temperEnabled: true,
      gatePolicyMigrated: true,
      gatePolicy: { boardDefault: { plan: 'you', review: 'you' } },
    }), 'utf-8');
    await loadConfig();
    expect(configCache.gatePolicy.boardDefault.review).toBe('you');
  });
});
