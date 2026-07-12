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
 * `claude` framework only — copilot/cline (Option B) and gemini (Option A concatenation) must stay
 * exactly as before. This exercises the real `installWorkspaceWorkflow` write branch against a
 * fixture source tree, mirroring workflow-installer-orphan-sweep.test.ts's temp-dir pattern.
 */
describe('installWorkspaceWorkflow — core vs. concatenation branching (FLUX-1377)', () => {
  let sourceRoot: string;
  let targetDir: string;

  const MODULES = ['orchestrator', 'grooming', 'implementation', 'review', 'release', 'mapping'];

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

  it('gemini still gets the full 6-module concatenation (unchanged)', async () => {
    await fs.mkdir(path.join(targetDir, '.gemini'), { recursive: true });
    const result = await installWorkspaceWorkflow({ sourceRoot, targetDir, framework: 'gemini' });
    const installed = await fs.readFile(result.skillInstalledPath, 'utf-8');
    for (const m of MODULES) {
      expect(installed).toContain(`<skill_module name="event-horizon-${m}">`);
      expect(installed).toContain('module fixture body');
    }
  });

  it('copilot still gets one file per module (Option B, unchanged)', async () => {
    await fs.mkdir(path.join(targetDir, '.github'), { recursive: true });
    await installWorkspaceWorkflow({ sourceRoot, targetDir, framework: 'copilot' });
    for (const m of MODULES) {
      const installed = await fs.readFile(path.join(targetDir, '.github', 'skills', 'event-horizon', `${m}.md`), 'utf-8');
      expect(installed).toContain('module fixture body');
    }
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
});
