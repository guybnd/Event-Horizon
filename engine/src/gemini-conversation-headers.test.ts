import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { setWorkspaceRoot } from './workspace.js';
import { verifyConversation } from './session-binding.js';
import { buildGeminiMcpServerEntry, installMcpConfig } from './workflow-installer.js';
import { cleanChildEnv } from './agents/shared.js';

/**
 * FLUX-1222 (write side): Gemini has no `--mcp-config`-style per-spawn injection flag, so its
 * per-session HITL routing can't reuse FLUX-1213's spawn-time header override (Claude) or
 * `--additional-mcp-config` (Copilot). Instead the installer bakes `${EH_CONVERSATION_ID}`/
 * `${EH_CONVERSATION_TOKEN}` header PLACEHOLDERS into the static `.gemini/settings.json`, and each
 * Gemini CLI process resolves them from its own spawn env (set per session by `cleanChildEnv` —
 * covered by adapter-contract.test.ts A.6). These tests lock the two halves that make that work:
 * the Gemini-schema entry the installer writes, and the placeholder→env→verifying-token round trip.
 * See mcp-http-conversation-routing.test.ts for the engine read-side of the header channel.
 */

/** Gemini CLI's documented env-var resolution over settings.json strings: `$VAR` / `${VAR}`.
 *  Mirrors gemini-cli's resolveEnvVarsInString — an unset var is left as the literal match
 *  (older builds) — plus an `emptyWhenUnset` mode for the newer documented resolve-to-'' behavior.
 *  Both unset behaviors must degrade to "unrouted", so both are exercised below. */
function resolveLikeGeminiCli(value: string, env: NodeJS.ProcessEnv, emptyWhenUnset = false): string {
  return value.replace(/\$(?:(\w+)|\{([^}]+)\})/g, (match, bare, braced) => {
    const resolved = env[(bare || braced) as string];
    if (typeof resolved === 'string') return resolved;
    return emptyWhenUnset ? '' : match;
  });
}

describe('buildGeminiMcpServerEntry / installMcpConfig — Gemini HITL header routing (FLUX-1222)', () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'eh-gemini-headers-'));
    setWorkspaceRoot(root);
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true }).catch(() => {});
  });

  async function readJson(rel: string): Promise<{ mcpServers: Record<string, Record<string, unknown>> }> {
    return JSON.parse(await fs.readFile(path.join(root, rel), 'utf-8'));
  }

  it('builds a Gemini-schema entry: httpUrl (streamable HTTP) + env-placeholder headers, no Claude-isms', () => {
    const entry = buildGeminiMcpServerEntry();
    // `httpUrl` is Gemini CLI's key for the streamable-HTTP transport the engine's /mcp mount
    // speaks; a bare `url` would mean SSE to Gemini and fail to connect.
    expect(entry.httpUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
    expect(entry.headers).toEqual({
      'x-eh-conversation-id': '${EH_CONVERSATION_ID}',
      'x-eh-conversation-token': '${EH_CONVERSATION_TOKEN}',
    });
    // Claude-schema fields must NOT leak into the Gemini entry.
    expect(entry).not.toHaveProperty('type');
    expect(entry).not.toHaveProperty('url');
    expect(entry).not.toHaveProperty('alwaysLoad');
  });

  for (const framework of ['gemini', 'antigravity'] as const) {
    it(`installMcpConfig(${framework}) writes the Gemini-schema entry to .gemini/settings.json, preserving other servers`, async () => {
      const settingsPath = path.join(root, '.gemini', 'settings.json');
      await fs.mkdir(path.dirname(settingsPath), { recursive: true });
      await fs.writeFile(settingsPath, JSON.stringify({
        theme: 'Dracula',
        mcpServers: {
          'event-horizon': { type: 'http', url: 'http://127.0.0.1:3067/mcp', alwaysLoad: true }, // stale pre-FLUX-1222 shape
          'user-server': { command: 'my-mcp', args: ['--serve'] },
        },
      }));

      await installMcpConfig(root, root, framework);

      const written = await readJson('.gemini/settings.json');
      expect(written.mcpServers['event-horizon']).toEqual(buildGeminiMcpServerEntry());
      // A user's own server entry and non-mcpServers settings survive the rewrite.
      expect(written.mcpServers['user-server']).toEqual({ command: 'my-mcp', args: ['--serve'] });
      expect((written as Record<string, unknown>).theme).toBe('Dracula');
    });
  }

  it('installMcpConfig(claude) still writes the Claude schema to .mcp.json (no cross-contamination)', async () => {
    await installMcpConfig(root, root, 'claude');
    const written = await readJson('.mcp.json');
    const entry = written.mcpServers['event-horizon']!;
    expect(entry.type).toBe('http');
    expect(entry.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
    expect(entry.alwaysLoad).toBe(true);
    // No static placeholders on the Claude side — its per-session headers are injected at spawn
    // time with real values (FLUX-1213, claude-code-conversation-headers.test.ts).
    expect(entry).not.toHaveProperty('headers');
    expect(entry).not.toHaveProperty('httpUrl');
  });

  it('round trip: a Gemini spawn env resolves the placeholders to that session\'s own verifying binding', () => {
    const { headers } = buildGeminiMcpServerEntry();
    // What gemini.ts's spawnGemini sets on the child process for a ticket session.
    const env = cleanChildEnv('gemini', 'FLUX-1222');

    const id = resolveLikeGeminiCli(headers['x-eh-conversation-id'], env);
    const token = resolveLikeGeminiCli(headers['x-eh-conversation-token'], env);
    expect(id).toBe('FLUX-1222');
    expect(verifyConversation(id, token)).toBe(true);
    // The binding is per-conversation — a sibling ticket cannot be claimed with this token.
    expect(verifyConversation('FLUX-9999', token)).toBe(false);
  });

  it('round trip: a board session resolves to the __board__ sentinel', () => {
    const { headers } = buildGeminiMcpServerEntry();
    const env = cleanChildEnv('gemini', '__board__');
    const id = resolveLikeGeminiCli(headers['x-eh-conversation-id'], env);
    expect(id).toBe('__board__');
    expect(verifyConversation(id, resolveLikeGeminiCli(headers['x-eh-conversation-token'], env))).toBe(true);
  });

  it('degrades to unrouted when the env vars are unset (a gemini run outside the engine)', () => {
    const { headers } = buildGeminiMcpServerEntry();
    const bareEnv = cleanChildEnv('gemini'); // no conversationId — vars provably absent

    // Older gemini-cli builds leave the literal placeholder: garbage id + garbage token → the
    // HMAC check fails and the route drops the claim to unrouted (boundConversationId, index.ts).
    const literalId = resolveLikeGeminiCli(headers['x-eh-conversation-id'], bareEnv);
    const literalToken = resolveLikeGeminiCli(headers['x-eh-conversation-token'], bareEnv);
    expect(literalId).toBe('${EH_CONVERSATION_ID}');
    expect(verifyConversation(literalId, literalToken)).toBe(false);

    // Newer builds resolve an unset var to '' — a falsy header value, which the engine's
    // extractBoundConversationFromRequest already treats as unbound.
    expect(resolveLikeGeminiCli(headers['x-eh-conversation-id'], bareEnv, true)).toBe('');
  });
});
