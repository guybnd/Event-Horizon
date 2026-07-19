// FLUX-1261: the one-time migration of Temper's board-wide `temperEnabled` boolean into
// `gatePolicy.boardDefault.review`, run once from `loadConfig()`. Everything else `loadConfig` does
// (column/tag/priority normalization, the chat-open-default migration) is out of scope here.

import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { setWorkspaceRoot, getConfigFile } from './workspace.js';
import {
  loadConfig, getConfig, INTEGRATION_TIER_DEFAULTS, MODEL_POLICY_PRESETS,
  patchConfig, autoRegisterUnknownTags, GET_COMPUTED_CONFIG_KEYS,
} from './config.js';
import { UNMIGRATED_GATE_POLICY_DEFAULT } from './models/gate-policy.js';

describe('loadConfig — gatePolicy migration (FLUX-1261, expanded scope FLUX-1292)', () => {
  beforeEach(async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'eh-config-'));
    await fs.mkdir(path.join(root, '.flux'), { recursive: true });
    setWorkspaceRoot(root);
    // Reset migration-relevant state — `configCache` is a module-level singleton that can carry a
    // prior test's (or prior run's) migrated shape forward otherwise. `gatePolicy` is reset to the
    // module's own seed value (NOT deleted) — since FLUX-1292 that seed (UNMIGRATED_GATE_POLICY_DEFAULT,
    // auto-then-you/auto since FLUX-1497) differs from the migration block's `?? DEFAULT_GATE_POLICY` fallback (you/you), so
    // deleting the key here would exercise a state (an undefined boardDefault reaching that fallback)
    // that never actually occurs on a real process start — the module literal always seeds it first.
    delete getConfig().gatePolicyMigrated;
    getConfig().gatePolicy = { boardDefault: { ...UNMIGRATED_GATE_POLICY_DEFAULT.boardDefault } };
    delete getConfig().temperEnabled;
  });

  it('migrates a fresh workspace with no config.json at all into gatePolicy.boardDefault = auto-then-you/auto (FLUX-1292, FLUX-1497)', async () => {
    // No file written — loadConfig() must hit the ENOENT branch, not the parsed-JSON path.
    await loadConfig();

    expect(getConfig().gatePolicy.boardDefault).toEqual({ plan: 'auto-then-you', review: 'auto' });
    expect(getConfig().gatePolicyMigrated).toBe(true);

    const onDisk = JSON.parse(await fs.readFile(getConfigFile(), 'utf-8'));
    expect(onDisk.gatePolicy.boardDefault).toEqual({ plan: 'auto-then-you', review: 'auto' });
    expect(onDisk.gatePolicyMigrated).toBe(true);
  });

  it('migrates a persisted temperEnabled:true into gatePolicy.boardDefault = auto-then-you/auto, with no behavior change to review at cutover', async () => {
    await fs.writeFile(getConfigFile(), JSON.stringify({ temperEnabled: true }), 'utf-8');
    await loadConfig();

    expect(getConfig().gatePolicy.boardDefault.review).toBe('auto');
    expect(getConfig().gatePolicy.boardDefault.plan).toBe('auto-then-you'); // never configured — FLUX-1292/FLUX-1497 default
    expect(getConfig().temperEnabled).toBeUndefined();
    expect(getConfig().gatePolicyMigrated).toBe(true);

    // Persisted, not just in-memory — a restart must not re-derive from a resurrected temperEnabled.
    const onDisk = JSON.parse(await fs.readFile(getConfigFile(), 'utf-8'));
    expect(onDisk.gatePolicy.boardDefault.review).toBe('auto');
    expect(onDisk.temperEnabled).toBeUndefined();
  });

  it('migrates a persisted temperEnabled:false into gatePolicy.boardDefault.review = "auto" (never configured, not a deliberate opt-out — FLUX-1292)', async () => {
    await fs.writeFile(getConfigFile(), JSON.stringify({ temperEnabled: false }), 'utf-8');
    await loadConfig();
    expect(getConfig().gatePolicy.boardDefault.review).toBe('auto');
  });

  it('migrates a board with no temperEnabled key at all into "auto" (never touched gate policy — FLUX-1292)', async () => {
    await fs.writeFile(getConfigFile(), JSON.stringify({}), 'utf-8');
    await loadConfig();
    expect(getConfig().gatePolicy.boardDefault.review).toBe('auto');
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
    expect(getConfig().gatePolicy.boardDefault.review).toBe('you');
  });
});

// FLUX-1373: the one-time migration seeding integrations.<cli>.tiers + top-level modelPolicy,
// retiring groomingModel/implementationModel/delegateModel.
describe('loadConfig — model-policy migration (FLUX-1373)', () => {
  beforeEach(async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'eh-config-'));
    await fs.mkdir(path.join(root, '.flux'), { recursive: true });
    setWorkspaceRoot(root);
    delete getConfig().modelPolicyMigrated;
    delete getConfig().modelPolicy;
    delete getConfig().integrations;
  });

  it('migrates a fresh workspace with no config.json at all into shipped tier defaults + Balanced policy', async () => {
    await loadConfig();

    expect(getConfig().integrations.claudeCode.tiers).toEqual(INTEGRATION_TIER_DEFAULTS.claudeCode);
    expect(getConfig().integrations.geminiCli.tiers).toEqual(INTEGRATION_TIER_DEFAULTS.geminiCli);
    expect(getConfig().integrations.copilotCli.tiers).toEqual(INTEGRATION_TIER_DEFAULTS.copilotCli);
    expect(getConfig().modelPolicy).toEqual({ preset: 'balanced', assignments: MODEL_POLICY_PRESETS.balanced });
    expect(getConfig().modelPolicyMigrated).toBe(true);

    const onDisk = JSON.parse(await fs.readFile(getConfigFile(), 'utf-8'));
    expect(onDisk.integrations.claudeCode.tiers).toEqual(INTEGRATION_TIER_DEFAULTS.claudeCode);
    expect(onDisk.modelPolicyMigrated).toBe(true);
  });

  it('seeds tier defaults from non-empty legacy fields per the pinned mapping (grooming->smart, implementation->efficient, delegate->cheap)', async () => {
    await fs.writeFile(getConfigFile(), JSON.stringify({
      integrations: {
        claudeCode: { groomingModel: 'opus', implementationModel: 'sonnet', delegateModel: 'haiku' },
        geminiCli: { groomingModel: '', implementationModel: '', delegateModel: '' },
        copilotCli: {},
      },
    }), 'utf-8');
    await loadConfig();

    expect(getConfig().integrations.claudeCode.tiers).toEqual({ smart: 'opus', efficient: 'sonnet', cheap: 'haiku' });
    // Empty legacy fields fall back to the shipped defaults, not empty strings.
    expect(getConfig().integrations.geminiCli.tiers).toEqual(INTEGRATION_TIER_DEFAULTS.geminiCli);
    expect(getConfig().integrations.copilotCli.tiers).toEqual(INTEGRATION_TIER_DEFAULTS.copilotCli);
    // Legacy fields are dropped from the persisted shape going forward.
    expect(getConfig().integrations.claudeCode.groomingModel).toBeUndefined();
    expect(getConfig().integrations.claudeCode.implementationModel).toBeUndefined();
    expect(getConfig().integrations.claudeCode.delegateModel).toBeUndefined();
  });

  it('is idempotent on re-load — does not re-clobber a deliberate later policy edit', async () => {
    const customAssignments = { ...MODEL_POLICY_PRESETS.frugal };
    await fs.writeFile(getConfigFile(), JSON.stringify({
      modelPolicyMigrated: true,
      modelPolicy: { preset: 'frugal', assignments: customAssignments },
      integrations: { claudeCode: { tiers: { smart: 'opus', efficient: 'sonnet', cheap: 'haiku' } } },
    }), 'utf-8');
    await loadConfig();

    expect(getConfig().modelPolicy).toEqual({ preset: 'frugal', assignments: customAssignments });
  });
});

// FLUX-1492: saveConfig used to write the WHOLE in-memory config over config.json, so any
// incidental save from a process holding a stale copy (a missed config-watcher reload, or a
// second engine bound to the same store) silently reverted every key changed since it loaded.
// patchConfig fixes this by merging the caller's patch over a FRESH disk read, not the
// possibly-stale in-memory getConfig().
describe('patchConfig — merge-on-save over a fresh disk read (FLUX-1492)', () => {
  beforeEach(async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'eh-config-'));
    await fs.mkdir(path.join(root, '.flux'), { recursive: true });
    setWorkspaceRoot(root);
  });

  it('does not revert a key an external writer changed on disk after this process loaded', async () => {
    await fs.writeFile(getConfigFile(), JSON.stringify({
      gatePolicy: { boardDefault: { plan: 'you', review: 'you' } },
      gatePolicyMigrated: true,
      modelPolicyMigrated: true,
      chatOpenDefaultMigrated: true,
    }), 'utf-8');
    await loadConfig();
    expect(getConfig().gatePolicy.boardDefault).toEqual({ plan: 'you', review: 'you' });

    // Simulate a second process (or a watcher-missed reload) writing an unrelated change —
    // THIS process's in-memory getConfig() still thinks gatePolicy is plan/review: 'you'.
    const onDisk = JSON.parse(await fs.readFile(getConfigFile(), 'utf-8'));
    onDisk.gatePolicy = { boardDefault: { plan: 'auto-then-you', review: 'auto' } };
    await fs.writeFile(getConfigFile(), JSON.stringify(onDisk), 'utf-8');

    // This process now patches an unrelated key, e.g. mcpServerPhases — must not revert gatePolicy.
    await patchConfig({ mcpServerPhases: { foo: ['grooming'] } });

    const written = JSON.parse(await fs.readFile(getConfigFile(), 'utf-8'));
    expect(written.gatePolicy.boardDefault).toEqual({ plan: 'auto-then-you', review: 'auto' });
    expect(written.mcpServerPhases).toEqual({ foo: ['grooming'] });
    // The writing process's own in-memory view heals to match disk.
    expect(getConfig().gatePolicy.boardDefault).toEqual({ plan: 'auto-then-you', review: 'auto' });
  });

  it('deletes a key when the patch value is undefined', async () => {
    await fs.writeFile(getConfigFile(), JSON.stringify({ temperEnabled: true, gatePolicyMigrated: true }), 'utf-8');
    await loadConfig();

    await patchConfig({ temperEnabled: undefined });

    const written = JSON.parse(await fs.readFile(getConfigFile(), 'utf-8'));
    expect('temperEnabled' in written).toBe(false);
    expect('temperEnabled' in getConfig()).toBe(false);
  });

  // FLUX-1534: two concurrent in-process patchConfig calls to DIFFERENT keys used to both read the
  // same disk snapshot before either wrote — the later save won and silently dropped the earlier
  // patch's key. patchConfig now serializes its own read-modify-write behind a promise chain so
  // overlapping calls apply sequentially, each over the previous one's result.
  it('does not drop an overlapping in-process patch to a different key', async () => {
    await fs.writeFile(getConfigFile(), JSON.stringify({ gatePolicyMigrated: true }), 'utf-8');
    await loadConfig();

    await Promise.all([
      patchConfig({ mcpServerPhases: { foo: ['grooming'] } }),
      patchConfig({ tags: [{ name: 'urgent', color: 'red' }] }),
    ]);

    const written = JSON.parse(await fs.readFile(getConfigFile(), 'utf-8'));
    expect(written.mcpServerPhases).toEqual({ foo: ['grooming'] });
    expect(written.tags).toEqual([{ name: 'urgent', color: 'red' }]);
  });
});

describe('autoRegisterUnknownTags — scoped write does not revert unrelated keys (FLUX-1492)', () => {
  beforeEach(async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'eh-config-'));
    await fs.mkdir(path.join(root, '.flux'), { recursive: true });
    setWorkspaceRoot(root);
  });

  it('adds a new tag without reverting a gatePolicy change made by another writer since load', async () => {
    await fs.writeFile(getConfigFile(), JSON.stringify({
      tags: [{ name: 'bug', color: 'red' }],
      gatePolicy: { boardDefault: { plan: 'you', review: 'you' } },
      gatePolicyMigrated: true,
      modelPolicyMigrated: true,
      chatOpenDefaultMigrated: true,
    }), 'utf-8');
    await loadConfig();

    // Another process/writer changes gatePolicy on disk; this process's in-memory copy is now stale.
    const onDisk = JSON.parse(await fs.readFile(getConfigFile(), 'utf-8'));
    onDisk.gatePolicy = { boardDefault: { plan: 'auto-then-you', review: 'auto' } };
    await fs.writeFile(getConfigFile(), JSON.stringify(onDisk), 'utf-8');

    await autoRegisterUnknownTags(['feature']);

    const written = JSON.parse(await fs.readFile(getConfigFile(), 'utf-8'));
    expect(written.gatePolicy.boardDefault).toEqual({ plan: 'auto-then-you', review: 'auto' });
    expect(written.tags.map((t: { name: string }) => t.name)).toEqual(['bug', 'feature']);
  });

  it('is a no-op (no write) when every tag is already registered', async () => {
    await fs.writeFile(getConfigFile(), JSON.stringify({ tags: [{ name: 'bug', color: 'red' }] }), 'utf-8');
    await loadConfig();
    const before = await fs.stat(getConfigFile());

    await autoRegisterUnknownTags(['bug']);

    const after = await fs.stat(getConfigFile());
    expect(after.mtimeMs).toBe(before.mtimeMs);
  });
});

describe('loadConfig — sweeps GET-computed keys off an already-polluted config.json (FLUX-1492)', () => {
  beforeEach(async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'eh-config-'));
    await fs.mkdir(path.join(root, '.flux'), { recursive: true });
    setWorkspaceRoot(root);
  });

  it('strips cliCapabilities/defaultFramework/boardConversationId/furnaceConversationId/runtimeFrameworks on load', async () => {
    await fs.writeFile(getConfigFile(), JSON.stringify({
      gatePolicy: { boardDefault: { plan: 'you', review: 'you' } },
      gatePolicyMigrated: true,
      modelPolicyMigrated: true,
      chatOpenDefaultMigrated: true,
      cliCapabilities: { claude: {} },
      defaultFramework: 'claude',
      boardConversationId: '__board__',
      furnaceConversationId: '__furnace__',
      runtimeFrameworks: ['claude'],
    }), 'utf-8');
    await loadConfig();

    for (const key of GET_COMPUTED_CONFIG_KEYS) {
      expect(getConfig()[key]).toBeUndefined();
    }
    const written = JSON.parse(await fs.readFile(getConfigFile(), 'utf-8'));
    for (const key of GET_COMPUTED_CONFIG_KEYS) {
      expect(key in written).toBe(false);
    }
    // Real config is untouched.
    expect(written.gatePolicy.boardDefault).toEqual({ plan: 'you', review: 'you' });
  });
});
