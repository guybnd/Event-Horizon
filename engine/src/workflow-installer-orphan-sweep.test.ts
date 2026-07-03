import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { cleanOrphanedSkillFiles, detectWorkspaceFrameworks } from './workflow-installer.js';

/**
 * FLUX-882: the forced-reinstall hard-override deletes `event-horizon*` skill files an older install
 * left behind (a renamed/removed skill module that would otherwise shadow the new tool surface). It
 * is a DELETE path, so its safety rails — strictly EH-scoped dirs, `event-horizon*` prefix only,
 * regular files only (never recurse a dir), keep the current/expected files — are load-bearing and
 * must be tested directly (the review flagged this as the weakest coverage point).
 */
describe('cleanOrphanedSkillFiles (FLUX-882 orphan sweep, delete path)', () => {
  let root: string;

  async function write(rel: string, body = 'x'): Promise<string> {
    const full = path.join(root, rel);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, body, 'utf-8');
    return path.resolve(full);
  }

  const exists = (rel: string) => fs.access(path.join(root, rel)).then(() => true, () => false);

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'eh-orphan-sweep-'));
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true }).catch(() => {});
  });

  it('removes orphaned event-horizon* files but keeps the current expected install file', async () => {
    // For framework "claude" the only expected install file inside an EH dir is
    // .claude/rules/event-horizon.md (the instructions file .clauderc lives outside the swept dirs).
    const expected = await write('.claude/rules/event-horizon.md');
    const orphan = await write('.claude/rules/event-horizon-orchestrator.md'); // pre-refactor module → orphan

    const removed = await cleanOrphanedSkillFiles(root, 'claude');

    expect(removed).toContain(orphan);
    expect(removed).not.toContain(expected);
    expect(await exists('.claude/rules/event-horizon.md')).toBe(true);
    expect(await exists('.claude/rules/event-horizon-orchestrator.md')).toBe(false);
  });

  it("sweeps orphans only within the resolved framework's own dir — preserves OTHER frameworks' files (FLUX-942)", async () => {
    // Installing for "claude" sweeps ONLY .claude/rules. A stale per-module file there is an orphan,
    // but other frameworks' legitimate event-horizon* installs live in their own dirs and must be
    // left intact — a multi-framework workspace (e.g. Claude + Gemini) keeps every framework's file.
    const claudeOrphan = await write('.claude/rules/event-horizon-grooming.md'); // stale module in claude's OWN dir
    await write('.gemini/skills/event-horizon.md');        // legit Gemini install — different framework
    await write('.cline/skills/event-horizon-release.md'); // legit Cline install — different framework

    const removed = await cleanOrphanedSkillFiles(root, 'claude');

    expect(removed).toEqual([claudeOrphan]);
    expect(await exists('.claude/rules/event-horizon-grooming.md')).toBe(false);
    // NOT swept — they belong to other frameworks the workspace also uses:
    expect(await exists('.gemini/skills/event-horizon.md')).toBe(true);
    expect(await exists('.cline/skills/event-horizon-release.md')).toBe(true);
  });

  it('never touches non-event-horizon files in the EH dirs', async () => {
    await write('.claude/rules/my-house-rules.md');
    await write('.cursor/rules/team-conventions.mdc');

    const removed = await cleanOrphanedSkillFiles(root, 'claude');

    expect(removed).toEqual([]);
    expect(await exists('.claude/rules/my-house-rules.md')).toBe(true);
    expect(await exists('.cursor/rules/team-conventions.mdc')).toBe(true);
  });

  it('never recurses into or removes a directory (only unlinks regular files)', async () => {
    // An entry named like an orphan but which is actually a directory must be left intact.
    await write('.claude/rules/event-horizon-legacy.dir/inside.md');

    const removed = await cleanOrphanedSkillFiles(root, 'claude');

    expect(removed).toEqual([]);
    expect(await exists('.claude/rules/event-horizon-legacy.dir')).toBe(true);
    expect(await exists('.claude/rules/event-horizon-legacy.dir/inside.md')).toBe(true);
  });

  it('is strictly scoped to the EH dirs — never reaches an event-horizon* file elsewhere', async () => {
    await write('docs/event-horizon-notes.md'); // a user's own file outside the allow-list

    const removed = await cleanOrphanedSkillFiles(root, 'claude');

    expect(removed).toEqual([]);
    expect(await exists('docs/event-horizon-notes.md')).toBe(true);
  });

  it('is a no-op (no throw) when the EH dirs do not exist', async () => {
    await expect(cleanOrphanedSkillFiles(root, 'claude')).resolves.toEqual([]);
  });
});

describe('detectWorkspaceFrameworks (FLUX-942 multi-framework)', () => {
  let root: string;
  async function write(rel: string): Promise<void> {
    const full = path.join(root, rel);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, 'x', 'utf-8');
  }
  beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), 'eh-detect-fw-')); });
  afterEach(async () => { await fs.rm(root, { recursive: true, force: true }).catch(() => {}); });

  it('detects every framework that has an installed EH skill file (Claude + Gemini + Copilot)', async () => {
    await write('.claude/rules/event-horizon.md');               // claude — single concatenated file
    await write('.gemini/skills/event-horizon.md');              // gemini — single concatenated file
    await write('.github/skills/event-horizon/orchestrator.md'); // copilot — modular per-module file

    expect(new Set(detectWorkspaceFrameworks(root, 'claude'))).toEqual(new Set(['claude', 'gemini', 'copilot']));
  });

  it('does NOT treat a bare .github (CI only, no EH install) as Copilot; always includes the primary', async () => {
    await write('.github/workflows/ci.yml'); // a normal GitHub repo dir — not a Copilot skill install

    // primary 'claude' is always managed; .github without an EH skill file must not register copilot
    expect(detectWorkspaceFrameworks(root, 'claude')).toEqual(['claude']);
  });
});
