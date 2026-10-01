import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { installGlobalMcpConfig, globalMcpConfigPathFor, buildMcpServerEntry, buildGeminiMcpServerEntry } from './workflow-installer.js';

/**
 * FLUX-1616: installGlobalMcpConfig writes the event-horizon MCP entry into a CLI's user-scoped
 * GLOBAL config file (~/.claude.json, ~/.gemini/settings.json, ~/.cursor/mcp.json) rather than a
 * project-local one, so the board's tools are available from any repo the CLI opens. It reuses
 * writeMcpEntryToConfig's merge-safe contract (never clobbers unrelated entries, never writes to
 * an unparseable file) but skips the FLUX-1572 sibling probe and module-server merge, which are
 * workspace-scoped concepts that don't apply to a single shared global file.
 */
describe('installGlobalMcpConfig', () => {
  let homeDir: string;
  let homedirSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'eh-global-mcp-home-'));
    homedirSpy = vi.spyOn(os, 'homedir').mockReturnValue(homeDir);
  });

  afterEach(async () => {
    homedirSpy.mockRestore();
    await fs.rm(homeDir, { recursive: true, force: true }).catch(() => {});
  });

  it('claude: creates a fresh ~/.claude.json with only the event-horizon entry', async () => {
    const result = await installGlobalMcpConfig('claude');

    expect(result.installedPath).toBe(path.join(homeDir, '.claude.json'));
    const written = JSON.parse(await fs.readFile(result.installedPath, 'utf-8'));
    expect(Object.keys(written.mcpServers)).toEqual(['event-horizon']);
    expect(written.mcpServers['event-horizon']).toEqual(buildMcpServerEntry());
  });

  it('gemini: creates a fresh ~/.gemini/settings.json with only the event-horizon entry', async () => {
    const result = await installGlobalMcpConfig('gemini');

    expect(result.installedPath).toBe(path.join(homeDir, '.gemini', 'settings.json'));
    const written = JSON.parse(await fs.readFile(result.installedPath, 'utf-8'));
    expect(Object.keys(written.mcpServers)).toEqual(['event-horizon']);
    expect(written.mcpServers['event-horizon']).toEqual(buildGeminiMcpServerEntry());
  });

  it('cursor: creates a fresh ~/.cursor/mcp.json with only the event-horizon entry', async () => {
    const result = await installGlobalMcpConfig('cursor');

    expect(result.installedPath).toBe(path.join(homeDir, '.cursor', 'mcp.json'));
    const written = JSON.parse(await fs.readFile(result.installedPath, 'utf-8'));
    expect(Object.keys(written.mcpServers)).toEqual(['event-horizon']);
    expect(written.mcpServers['event-horizon']).toEqual(buildMcpServerEntry());
  });

  it('copilot: creates a fresh ~/.copilot/mcp-config.json with the event-horizon entry', async () => {
    const result = await installGlobalMcpConfig('copilot');

    expect(result.installedPath).toBe(path.join(homeDir, '.copilot', 'mcp-config.json'));
    expect(result.permissionsPath).toBeUndefined();
    const written = JSON.parse(await fs.readFile(result.installedPath, 'utf-8'));
    expect(Object.keys(written.mcpServers)).toEqual(['event-horizon']);
    expect(written.mcpServers['event-horizon']).toEqual(buildMcpServerEntry());
  });

  it('keeps an unrelated existing mcpServers entry and adds event-horizon alongside it', async () => {
    const configPath = path.join(homeDir, '.claude.json');
    await fs.writeFile(configPath, JSON.stringify({
      mcpServers: { 'some-other-server': { type: 'stdio', command: 'foo' } },
    }));

    await installGlobalMcpConfig('claude');

    const written = JSON.parse(await fs.readFile(configPath, 'utf-8'));
    expect(written.mcpServers['some-other-server']).toEqual({ type: 'stdio', command: 'foo' });
    expect(written.mcpServers['event-horizon']).toEqual(buildMcpServerEntry());
  });

  it('leaves a malformed existing global file untouched and bails without writing', async () => {
    const configPath = path.join(homeDir, '.claude.json');
    await fs.writeFile(configPath, '{ not valid json');

    await installGlobalMcpConfig('claude');

    expect(await fs.readFile(configPath, 'utf-8')).toBe('{ not valid json');
  });

  it('claude: also writes the mcp__event-horizon allow rule into the global ~/.claude/settings.json', async () => {
    const result = await installGlobalMcpConfig('claude');

    expect(result.permissionsPath).toBe(path.join(homeDir, '.claude', 'settings.json'));
    const settings = JSON.parse(await fs.readFile(result.permissionsPath!, 'utf-8'));
    expect(settings.permissions.allow).toContain('mcp__event-horizon');
  });

  it('gemini/cursor: does not return a permissionsPath or write a settings.json', async () => {
    const result = await installGlobalMcpConfig('gemini');

    expect(result.permissionsPath).toBeUndefined();
    await expect(fs.readFile(path.join(homeDir, '.claude', 'settings.json'), 'utf-8')).rejects.toThrow();
  });

  it('grok: writes TOML into ~/.grok/config.toml and keeps an unrelated server', async () => {
    const configPath = path.join(homeDir, '.grok', 'config.toml');
    await fs.mkdir(path.dirname(configPath), { recursive: true });
    await fs.writeFile(configPath, '[mcp_servers.other]\ncommand = "foo"\n', 'utf-8');

    const result = await installGlobalMcpConfig('grok');

    expect(result.installedPath).toBe(configPath);
    expect(result.permissionsPath).toBeUndefined();
    const written = await fs.readFile(configPath, 'utf-8');
    expect(written).toContain('[mcp_servers.other]');
    expect(written).toContain('command = "foo"');
    expect(written).toContain('[mcp_servers.event-horizon]');
    expect(written).toContain('${EH_SESSION_ID}');
  });

  it('globalMcpConfigPathFor returns null for unsupported frameworks', () => {
    expect(globalMcpConfigPathFor('copilot')).toBe(path.join(homeDir, '.copilot', 'mcp-config.json'));
    expect(globalMcpConfigPathFor('cline')).toBeNull();
    expect(globalMcpConfigPathFor('windsurf')).toBeNull();
    expect(globalMcpConfigPathFor('generic')).toBeNull();
    // FLUX-1738: antigravity is no longer unsupported here — `agy` has a real, user-writable
    // global MCP config (verified by driving `agy mcp add` and reading back what it wrote).
    expect(globalMcpConfigPathFor('antigravity')).toBe(path.join(homeDir, '.gemini', 'config', 'mcp_config.json'));
  });
});
