import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  installWorkspaceWorkflow,
  checkSkillVersionStaleness,
  extractSkillVersion,
} from './workflow-installer.js';
import { buildCoreSkillDocument, CORE_SKILL_VERSION } from './skill-core.js';

/**
 * FLUX-1377: the installer now writes the trimmed core (not the 6-module concatenation) for the
 * `claude` framework only. This exercises the real `installWorkspaceWorkflow` write branch against a
 * fixture source tree, mirroring workflow-installer-orphan-sweep.test.ts's temp-dir pattern.
 */
describe('installWorkspaceWorkflow — core vs. concatenation branching (FLUX-1377)', () => {
  let sourceRoot: string;
  let targetDir: string;

  const MODULES = ['orchestrator', 'grooming', 'implementation', 'review', 'release', 'mapping', 'tools'];

  beforeEach(async () => {
    sourceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'eh-core-install-src-'));
    targetDir = await fs.mkdtemp(path.join(os.tmpdir(), 'eh-core-install-dst-'));
    const skillsDir = path.join(sourceRoot, '.docs', 'skills');
    await fs.mkdir(skillsDir, { recursive: true });
    for (const m of MODULES) {
      const version = m === 'orchestrator' ? `Version: ${CORE_SKILL_VERSION}\n\n` : '';
      await fs.writeFile(path.join(skillsDir, `event-horizon-${m}.md`), `${version}# ${m} module fixture body\n`, 'utf-8');
    }
    const instructionsDir = path.join(sourceRoot, '.flux', 'skills');
    await fs.mkdir(instructionsDir, { recursive: true });
    await fs.writeFile(path.join(instructionsDir, 'event-horizon-copilot-instructions.md'), '# fixture instructions\n', 'utf-8');
  });

  afterEach(async () => {
    await fs.rm(sourceRoot, { recursive: true, force: true }).catch(() => {});
    await fs.rm(targetDir, { recursive: true, force: true }).catch(() => {});
  });

  it('claude gets the trimmed core doc, NOT the 6-module concatenation', async () => {
    await fs.mkdir(path.join(targetDir, '.claude'), { recursive: true });
    const result = await installWorkspaceWorkflow({ sourceRoot, targetDir, framework: 'claude' });
    const installed = await fs.readFile(result.skillInstalledPath, 'utf-8');
    expect(installed).toBe(buildCoreSkillDocument());
    expect(installed).not.toContain('module fixture body');
    expect(installed).not.toContain('<skill_module');
  });

  it('gemini still gets the six-module concatenation — but NEVER the pull-only tools module (FLUX-1468)', async () => {
    await fs.mkdir(path.join(targetDir, '.gemini'), { recursive: true });
    const result = await installWorkspaceWorkflow({ sourceRoot, targetDir, framework: 'gemini' });
    const installed = await fs.readFile(result.skillInstalledPath, 'utf-8');
    for (const m of MODULES.filter((m) => m !== 'tools')) {
      expect(installed).toContain(`<skill_module name="event-horizon-${m}">`);
      expect(installed).toContain('module fixture body');
    }
    // The tools module is pull-only (read_skill) — concatenating it back in would re-push the
    // exact lore the FLUX-1468 description diet removed from every always-on schema.
    expect(installed).not.toContain('<skill_module name="event-horizon-tools">');
  });

  it('copilot gets a discoverable SKILL.md directory skill and migrates obsolete module files', async () => {
    await fs.mkdir(path.join(targetDir, '.github'), { recursive: true });
    const stale = path.join(targetDir, '.github', 'skills', 'event-horizon', 'orchestrator.md');
    await fs.mkdir(path.dirname(stale), { recursive: true });
    await fs.writeFile(stale, 'stale modular skill\n', 'utf-8');

    const result = await installWorkspaceWorkflow({ sourceRoot, targetDir, framework: 'copilot' });
    expect(result.skillInstalledPath).toBe(path.join(targetDir, '.github', 'skills', 'event-horizon', 'SKILL.md'));
    const installed = await fs.readFile(result.skillInstalledPath, 'utf-8');
    expect(installed.startsWith('---\nname: event-horizon\n')).toBe(true);
    expect(installed).toContain('<skill_module name="event-horizon-orchestrator">');
    expect(installed).toContain('<skill_module name="event-horizon-implementation">');
    expect(installed).not.toContain('<skill_module name="event-horizon-tools">');
    await expect(fs.access(stale)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('bumping the orchestrator source version flags an existing (pre-FLUX-1377) claude install as stale, forcing a core refresh', async () => {
    await fs.mkdir(path.join(targetDir, '.claude', 'rules'), { recursive: true });
    // Simulate an old install: the full concatenation, old version.
    await fs.writeFile(
      path.join(targetDir, '.claude', 'rules', 'event-horizon.md'),
      '<skill_module name="event-horizon-orchestrator">\nVersion: 2.10.0\n\nold body\n</skill_module>',
      'utf-8',
    );
    const staleness = await checkSkillVersionStaleness({ sourceRoot, targetDir, framework: 'claude' });
    expect(staleness?.isStale).toBe(true);
    expect(staleness?.sourceVersion).toBe(CORE_SKILL_VERSION);
    expect(extractSkillVersion('<skill_module>\nVersion: 2.10.0\n</skill_module>')).toBe('2.10.0');
  });

  // FLUX-1749: staleness is content-based across EVERY installed file, not the orchestrator's
  // `Version:` line alone. Before, editing review/implementation/… (which by convention bump only
  // their own version line) never flagged a concatenated or modular install as stale.
  describe('content-based staleness (FLUX-1749)', () => {
    const reviewSource = () => path.join(sourceRoot, '.docs', 'skills', 'event-horizon-review.md');

    it('gemini (concatenated): editing ONLY the review module flags the install stale; reinstall clears it (no loop)', async () => {
      await fs.mkdir(path.join(targetDir, '.gemini'), { recursive: true });
      await installWorkspaceWorkflow({ sourceRoot, targetDir, framework: 'gemini' });
      const fresh = await checkSkillVersionStaleness({ sourceRoot, targetDir, framework: 'gemini' });
      expect(fresh?.isStale).toBe(false);
      expect(fresh?.staleFiles).toEqual([]);

      await fs.writeFile(reviewSource(), 'Version: 1.7.0\n\n# review module fixture body — edited\n', 'utf-8');
      const afterEdit = await checkSkillVersionStaleness({ sourceRoot, targetDir, framework: 'gemini' });
      expect(afterEdit?.isStale).toBe(true);
      // The display versions (orchestrator line) still agree — the notification must not rely on them.
      expect(afterEdit?.installedVersion).toBe(afterEdit?.sourceVersion);
      expect(afterEdit?.staleFiles).toEqual([path.join(targetDir, '.gemini', 'skills', 'event-horizon.md')]);

      await installWorkspaceWorkflow({ sourceRoot, targetDir, framework: 'gemini' });
      const refreshed = await checkSkillVersionStaleness({ sourceRoot, targetDir, framework: 'gemini' });
      expect(refreshed?.isStale).toBe(false);
    });

    it('cline (modular): editing ONLY the review module flags just that file stale; reinstall clears it', async () => {
      await fs.mkdir(path.join(targetDir, '.cline'), { recursive: true });
      await installWorkspaceWorkflow({ sourceRoot, targetDir, framework: 'cline' });
      expect((await checkSkillVersionStaleness({ sourceRoot, targetDir, framework: 'cline' }))?.isStale).toBe(false);

      await fs.writeFile(reviewSource(), 'Version: 1.7.0\n\n# review module fixture body — edited\n', 'utf-8');
      const afterEdit = await checkSkillVersionStaleness({ sourceRoot, targetDir, framework: 'cline' });
      expect(afterEdit?.isStale).toBe(true);
      expect(afterEdit?.staleFiles).toEqual([path.join(targetDir, '.cline', 'skills', 'event-horizon-review.md')]);

      await installWorkspaceWorkflow({ sourceRoot, targetDir, framework: 'cline' });
      expect((await checkSkillVersionStaleness({ sourceRoot, targetDir, framework: 'cline' }))?.isStale).toBe(false);
    });

    it('editing the pull-only tools module does NOT flag a concatenated install (it is never installed there)', async () => {
      await fs.mkdir(path.join(targetDir, '.gemini'), { recursive: true });
      await installWorkspaceWorkflow({ sourceRoot, targetDir, framework: 'gemini' });
      await fs.writeFile(path.join(sourceRoot, '.docs', 'skills', 'event-horizon-tools.md'), '# tools — edited\n', 'utf-8');
      expect((await checkSkillVersionStaleness({ sourceRoot, targetDir, framework: 'gemini' }))?.isStale).toBe(false);
    });

    it('claude (core): a fresh install is NOT stale even when the orchestrator source version differs from CORE_SKILL_VERSION', async () => {
      // The old check compared the orchestrator's `Version:` line against the core stamp, so any
      // drift between the two (as has happened on master) made every Claude install perpetually stale.
      await fs.writeFile(
        path.join(sourceRoot, '.docs', 'skills', 'event-horizon-orchestrator.md'),
        'Version: 99.0.0\n\n# orchestrator module fixture body\n',
        'utf-8',
      );
      await fs.mkdir(path.join(targetDir, '.claude'), { recursive: true });
      await installWorkspaceWorkflow({ sourceRoot, targetDir, framework: 'claude' });
      const result = await checkSkillVersionStaleness({ sourceRoot, targetDir, framework: 'claude' });
      expect(result?.isStale).toBe(false);
      expect(result?.sourceVersion).toBe(CORE_SKILL_VERSION);
      expect(result?.installedVersion).toBe(CORE_SKILL_VERSION);
    });

    it('an installed file re-checked-out with CRLF line endings is NOT stale', async () => {
      await fs.mkdir(path.join(targetDir, '.gemini'), { recursive: true });
      const { skillInstalledPath } = await installWorkspaceWorkflow({ sourceRoot, targetDir, framework: 'gemini' });
      const lf = await fs.readFile(skillInstalledPath, 'utf-8');
      await fs.writeFile(skillInstalledPath, `${lf.replace(/\n/g, '\r\n')}\r\n`, 'utf-8');
      expect((await checkSkillVersionStaleness({ sourceRoot, targetDir, framework: 'gemini' }))?.isStale).toBe(false);
    });

    it('a missing installed file is stale; a missing source module makes the check unavailable (null)', async () => {
      await fs.mkdir(path.join(targetDir, '.gemini'), { recursive: true });
      const missing = await checkSkillVersionStaleness({ sourceRoot, targetDir, framework: 'gemini' });
      expect(missing?.isStale).toBe(true);
      expect(missing?.installedVersion).toBeNull();

      await fs.rm(reviewSource());
      expect(await checkSkillVersionStaleness({ sourceRoot, targetDir, framework: 'gemini' })).toBeNull();
    });
  });

  it('grok gets a SKILL.md directory skill with frontmatter, not a flat .md (FLUX-1726)', async () => {
    const result = await installWorkspaceWorkflow({ sourceRoot, targetDir, framework: 'grok' });
    expect(result.skillInstalledPath).toBe(path.join(targetDir, '.grok', 'skills', 'event-horizon', 'SKILL.md'));
    const installed = await fs.readFile(result.skillInstalledPath, 'utf-8');
    expect(installed.startsWith('---\nname: event-horizon\n')).toBe(true);
    expect(installed).toContain('description: Event Horizon ticket workflow');
    expect(installed).toContain('<skill_module name="event-horizon-orchestrator">');
    expect(installed).toContain('<skill_module name="event-horizon-grooming">');
    expect(installed).not.toContain('<skill_module name="event-horizon-tools">');
    await expect(fs.access(path.join(targetDir, '.grok', 'skills', 'event-horizon.md'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('grok reinstall migrates the FLUX-1722 flat event-horizon.md to SKILL.md (FLUX-1726)', async () => {
    const stale = path.join(targetDir, '.grok', 'skills', 'event-horizon.md');
    await fs.mkdir(path.dirname(stale), { recursive: true });
    await fs.writeFile(stale, 'stale flat grok skill\n', 'utf-8');

    const result = await installWorkspaceWorkflow({ sourceRoot, targetDir, framework: 'grok' });

    expect(result.skillInstalledPath).toBe(path.join(targetDir, '.grok', 'skills', 'event-horizon', 'SKILL.md'));
    await expect(fs.access(result.skillInstalledPath)).resolves.toBeUndefined();
    await expect(fs.access(stale)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
