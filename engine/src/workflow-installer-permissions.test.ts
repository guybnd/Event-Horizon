import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { installWorkspaceWorkflow, buildGeminiMcpServerEntry } from './workflow-installer.js';
import { CORE_SKILL_VERSION } from './skill-core.js';

/**
 * A project's local Claude Code permission default can be `dontAsk` (or any other
 * mode with no interactive fallback) — an unattended/orchestrator session then gets ungranted
 * event-horizon MCP tool calls (create_ticket, change_status, ...) SILENTLY DENIED instead of
 * prompted, since there's no user to ask. installClaudeSettingsPermissions (Claude only, gated by
 * CliCapabilities.bakesPermissionAllowlist) bakes an explicit allow rule into the project's
 * committed `.claude/settings.json` at install time so this can't happen. Gemini's equivalent is a
 * `trust: true` field on the same mcpServers.event-horizon entry buildGeminiMcpServerEntry already
 * writes — no separate installer step. Copilot has no project-committable equivalent (confirmed
 * against GitHub Copilot CLI docs: approvals persist only to the user's own
 * ~/.copilot/permissions-config.json, which an installer must not write).
 */
describe('installWorkspaceWorkflow — event-horizon permission allowlist', () => {
  let sourceRoot: string;
  let targetDir: string;

  const MODULES = ['orchestrator', 'grooming', 'implementation', 'review', 'release', 'mapping', 'tools'];

  beforeEach(async () => {
    sourceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'eh-perm-install-src-'));
    targetDir = await fs.mkdtemp(path.join(os.tmpdir(), 'eh-perm-install-dst-'));
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

  async function readClaudeSettings(): Promise<Record<string, unknown>> {
    return JSON.parse(await fs.readFile(path.join(targetDir, '.claude', 'settings.json'), 'utf-8'));
  }

  it('claude: writes .claude/settings.json with the event-horizon allow rule on a fresh install', async () => {
    await fs.mkdir(path.join(targetDir, '.claude'), { recursive: true });
    await installWorkspaceWorkflow({ sourceRoot, targetDir, framework: 'claude' });

    const settings = await readClaudeSettings();
    expect((settings.permissions as { allow?: string[] }).allow).toContain('mcp__event-horizon');
  });

  it('claude: merges into an existing settings.json without clobbering the user\'s own rules', async () => {
    const settingsPath = path.join(targetDir, '.claude', 'settings.json');
    await fs.mkdir(path.dirname(settingsPath), { recursive: true });
    await fs.writeFile(settingsPath, JSON.stringify({
      theme: 'dark',
      permissions: { allow: ['Bash(git *)'], deny: ['Bash(rm -rf *)'] },
    }));

    await installWorkspaceWorkflow({ sourceRoot, targetDir, framework: 'claude' });

    const settings = await readClaudeSettings();
    expect(settings.theme).toBe('dark');
    const permissions = settings.permissions as { allow?: string[]; deny?: string[] };
    expect(permissions.allow).toEqual(expect.arrayContaining(['Bash(git *)', 'mcp__event-horizon']));
    expect(permissions.deny).toEqual(['Bash(rm -rf *)']);
  });

  it('claude: is idempotent — installing twice does not duplicate the rule', async () => {
    await fs.mkdir(path.join(targetDir, '.claude'), { recursive: true });
    await installWorkspaceWorkflow({ sourceRoot, targetDir, framework: 'claude' });
    await installWorkspaceWorkflow({ sourceRoot, targetDir, framework: 'claude' });

    const settings = await readClaudeSettings();
    const allow = (settings.permissions as { allow?: string[] }).allow ?? [];
    expect(allow.filter((r) => r === 'mcp__event-horizon')).toHaveLength(1);
  });

  it('claude: leaves an unparseable existing settings.json untouched instead of clobbering it', async () => {
    const settingsPath = path.join(targetDir, '.claude', 'settings.json');
    await fs.mkdir(path.dirname(settingsPath), { recursive: true });
    await fs.writeFile(settingsPath, '{ not valid json');

    await installWorkspaceWorkflow({ sourceRoot, targetDir, framework: 'claude' });

    expect(await fs.readFile(settingsPath, 'utf-8')).toBe('{ not valid json');
  });

  it('gemini: the installed mcpServers.event-horizon entry trusts the server (no confirmation prompt)', async () => {
    await fs.mkdir(path.join(targetDir, '.gemini'), { recursive: true });
    await installWorkspaceWorkflow({ sourceRoot, targetDir, framework: 'gemini' });

    const written = JSON.parse(await fs.readFile(path.join(targetDir, '.gemini', 'settings.json'), 'utf-8'));
    expect(written.mcpServers['event-horizon']).toEqual(buildGeminiMcpServerEntry());
    expect(written.mcpServers['event-horizon'].trust).toBe(true);
  });

  it('copilot: does NOT write a .claude/settings.json permission file (no equivalent capability)', async () => {
    await fs.mkdir(path.join(targetDir, '.github'), { recursive: true });
    await installWorkspaceWorkflow({ sourceRoot, targetDir, framework: 'copilot' });

    await expect(fs.readFile(path.join(targetDir, '.claude', 'settings.json'), 'utf-8')).rejects.toThrow();
  });
});
