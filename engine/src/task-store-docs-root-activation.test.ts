import { getWorkspace } from './workspace-context.js';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';

const broadcastEvent = vi.fn();
vi.mock('./events.js', () => ({
  broadcastEvent: (...args: unknown[]) => broadcastEvent(...args),
  bumpTasksVersion: vi.fn(),
}));

import { initDir } from './task-store.js';
import { setWorkspaceRoot } from './workspace.js';

/**
 * FLUX-1660: `initDir` used to bootstrap the docs tree (mkdir/seed/load) BEFORE `loadConfig()`
 * ran, so `getDocsDir()`/`getConfig().projects` resolved to CONFIG_DEFAULTS (`.docs`/`FLUX`) for
 * any workspace with a custom `docsRoot` — seeding/caching a stub tree instead of the real one.
 * These tests drive the real `initDir()` end-to-end against a workspace whose config.json sets a
 * custom docsRoot, asserting the real tree loads and no stub is created.
 */
describe('initDir loads the configured docsRoot before bootstrapping docs (FLUX-1660)', () => {
  let root: string;
  let fluxDir: string;

  beforeEach(async () => {
    broadcastEvent.mockClear();
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'eh-docs-root-'));
    fluxDir = path.join(root, '.flux');
    await fs.mkdir(fluxDir, { recursive: true });
    setWorkspaceRoot(root);
    for (const k of Object.keys(getWorkspace().tasks)) delete getWorkspace().tasks[k];
    for (const k of Object.keys(getWorkspace().docs)) delete getWorkspace().docs[k];
    // Force a fresh getConfig() seed for every test — otherwise the previous test's merged
    // config (or a previous suite's) leaks in via the shared default Workspace singleton.
    getWorkspace().config = null;
  });

  afterEach(async () => {
    for (const k of Object.keys(getWorkspace().tasks)) delete getWorkspace().tasks[k];
    for (const k of Object.keys(getWorkspace().docs)) delete getWorkspace().docs[k];
    getWorkspace().config = null;
    await fs.rm(root, { recursive: true, force: true }).catch(() => {});
    vi.restoreAllMocks();
  });

  async function writeConfig(overrides: Record<string, unknown>) {
    await fs.writeFile(path.join(fluxDir, 'config.json'), JSON.stringify(overrides, null, 2));
  }

  it('loads the real configured docs tree on cold boot, without seeding a stub .docs', async () => {
    await writeConfig({ docsRoot: 'docs', projects: ['ACME'] });
    const docsDir = path.join(root, 'docs');
    await fs.mkdir(docsDir, { recursive: true });
    await fs.writeFile(path.join(docsDir, 'readme.md'), '# Real Docs\n\nThe actual project tree.');

    await initDir();

    expect(getWorkspace().docs['readme']?.body).toContain('The actual project tree.');
    expect(getWorkspace().docs['project-overview']).toBeUndefined();

    // No default '.docs' stub should have been created anywhere under the workspace root.
    await expect(fs.stat(path.join(root, '.docs'))).rejects.toThrow();
  });

  it('does not reseed or lose the real tree on a simulated re-activation (second initDir call)', async () => {
    await writeConfig({ docsRoot: 'docs', projects: ['ACME'] });
    const docsDir = path.join(root, 'docs');
    await fs.mkdir(docsDir, { recursive: true });
    await fs.writeFile(path.join(docsDir, 'readme.md'), '# Real Docs\n\nThe actual project tree.');

    await initDir();
    // Re-activation resets the in-memory docs cache before re-running initDir (doActivateWorkspace).
    for (const k of Object.keys(getWorkspace().docs)) delete getWorkspace().docs[k];

    await initDir();

    expect(getWorkspace().docs['readme']?.body).toContain('The actual project tree.');
    expect(getWorkspace().docs['project-overview']).toBeUndefined();
    await expect(fs.stat(path.join(root, '.docs'))).rejects.toThrow();
  });

  it('still seeds a fresh workspace with no config.json and an empty default docs dir', async () => {
    // Regression guard: the reorder must not disable first-run bootstrap for a genuinely
    // fresh workspace (no config.json yet, nothing in the default '.docs' dir).
    await initDir();

    const overview = await fs.readFile(path.join(root, '.docs', 'project-overview.md'), 'utf-8');
    expect(overview).toContain('FLUX');
    expect(getWorkspace().docs['project-overview']).toBeDefined();
  });
});
