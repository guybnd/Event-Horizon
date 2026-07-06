import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { setWorkspaceRoot } from '../workspace.js';
import { configCache } from '../config.js';
import { signConversation } from '../session-binding.js';
import { buildSpawnMcpConfigArgs } from './claude-code.js';

/**
 * FLUX-1213 (write side): `buildSpawnMcpConfigArgs` is the spawn-time builder that gives each
 * per-session `event-horizon` HTTP MCP client its own `x-eh-conversation-id`/`x-eh-conversation-token`
 * headers — the ONLY way to route `ask_user_question`/`permission_prompt` to the right ticket
 * now that every session shares one `/mcp` HTTP mount (FLUX-645) with no per-session env. See
 * mcp-http-conversation-routing.test.ts for the read-side (engine) half of this fix.
 */
describe('buildSpawnMcpConfigArgs event-horizon header injection (FLUX-1213)', () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'eh-mcp-headers-'));
    setWorkspaceRoot(root);
  });

  afterEach(async () => {
    delete configCache.mcpServerPhases;
    await fs.rm(root, { recursive: true, force: true }).catch(() => {});
  });

  function parseMcpConfig(args: string[]): { mcpServers: Record<string, Record<string, unknown>> } {
    const idx = args.indexOf('--mcp-config');
    expect(idx).toBeGreaterThanOrEqual(0);
    return JSON.parse(args[idx + 1]!);
  }

  it('merge mode (no mcpServerPhases): a bound conversationId gets HTTP headers on event-horizon', async () => {
    await fs.writeFile(path.join(root, '.mcp.json'), JSON.stringify({
      mcpServers: { 'event-horizon': { type: 'http', url: 'http://127.0.0.1:3067/mcp', alwaysLoad: true } },
    }));

    const args = buildSpawnMcpConfigArgs(undefined, undefined, root, 'FLUX-999');
    const config = parseMcpConfig(args);
    expect(config.mcpServers['event-horizon']!.headers).toEqual({
      'x-eh-conversation-id': 'FLUX-999',
      'x-eh-conversation-token': signConversation('FLUX-999'),
    });
  });

  it('merge mode: no conversationId → nothing injected (unchanged pre-FLUX-1213 behavior)', async () => {
    await fs.writeFile(path.join(root, '.mcp.json'), JSON.stringify({
      mcpServers: { 'event-horizon': { type: 'http', url: 'http://127.0.0.1:3067/mcp' } },
    }));
    // No conversationId and no active modules configured → nothing for merge mode to inject.
    const args = buildSpawnMcpConfigArgs(undefined, undefined, root);
    expect(args).toEqual([]);
  });

  it('a stdio workspace event-horizon entry is left untouched — already correctly routed via child-process env inheritance', async () => {
    await fs.writeFile(path.join(root, '.mcp.json'), JSON.stringify({
      mcpServers: { 'event-horizon': { command: 'npx', args: ['tsx', 'engine/src/index.ts', '--mcp'] } },
    }));
    const args = buildSpawnMcpConfigArgs(undefined, undefined, root, 'FLUX-999');
    expect(args).toEqual([]);
  });

  it('strict-profile mode (mcpServerPhases configured): headers are added alongside the existing alwaysLoad override', async () => {
    await fs.writeFile(path.join(root, '.mcp.json'), JSON.stringify({
      mcpServers: { 'event-horizon': { type: 'http', url: 'http://127.0.0.1:3067/mcp' } },
    }));
    configCache.mcpServerPhases = { 'event-horizon': ['implementation'] };

    const args = buildSpawnMcpConfigArgs('implementation', undefined, root, 'FLUX-888');
    expect(args[0]).toBe('--strict-mcp-config');
    const config = parseMcpConfig(args);
    expect(config.mcpServers['event-horizon']!.alwaysLoad).toBe(true);
    expect(config.mcpServers['event-horizon']!.headers).toEqual({
      'x-eh-conversation-id': 'FLUX-888',
      'x-eh-conversation-token': signConversation('FLUX-888'),
    });
  });

  it('two different ticket ids produce two different, independently-verifying tokens', async () => {
    await fs.writeFile(path.join(root, '.mcp.json'), JSON.stringify({
      mcpServers: { 'event-horizon': { type: 'http', url: 'http://127.0.0.1:3067/mcp' } },
    }));
    const configA = parseMcpConfig(buildSpawnMcpConfigArgs(undefined, undefined, root, 'FLUX-AAA'));
    const configB = parseMcpConfig(buildSpawnMcpConfigArgs(undefined, undefined, root, 'FLUX-BBB'));
    const tokenA = configA.mcpServers['event-horizon']!.headers as Record<string, string>;
    const tokenB = configB.mcpServers['event-horizon']!.headers as Record<string, string>;
    expect(tokenA['x-eh-conversation-token']).not.toBe(tokenB['x-eh-conversation-token']);
  });
});
