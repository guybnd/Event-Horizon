import * as fs from 'fs';
import { describe, it, expect } from 'vitest';
import { assertCodexModelAvailable, buildCodexMcpConfigArgs, readCodexModelSlugs } from './codex.js';
import { signConversation } from '../session-binding.js';

// FLUX-1625: codex's per-spawn MCP override is `-c mcp_servers.<name>.<key>=<value>` (a per-key
// TOML config override, not a JSON blob like Claude/Copilot) — live-verified against codex-cli
// 0.146.0 (`codex mcp list -c '…' --json` echoed the override back). Also carries the FLUX-1213
// per-conversation header binding via a nested `http_headers.<key>` path (also live-verified).
//
// Co-located inside engine/src/agents/ (same rationale as copilot-mcp-config.test.ts): this file's
// import of `./codex.js` is a deep import of a concrete adapter file, which the adapter-boundary
// guard forbids OUTSIDE agents/ — agents/ itself is the one sanctioned exception.
describe('buildCodexMcpConfigArgs (FLUX-1625)', () => {
  it('injects the event-horizon MCP url via a -c override', () => {
    const args = buildCodexMcpConfigArgs();
    expect(args).toEqual(['-c', expect.stringMatching(/^mcp_servers\.event_horizon\.url="http:\/\/127\.0\.0\.1:\d+\/mcp"$/)]);
  });

  it('adds the FLUX-1213 conversation-id/token headers when a conversationId is given', () => {
    const args = buildCodexMcpConfigArgs('FLUX-903');
    // Flattened -c pairs: [flag, value, flag, value, ...]
    const values = args.filter((_, i) => i % 2 === 1);
    expect(values.some((v) => v.includes('http_headers.x-eh-conversation-id="FLUX-903"'))).toBe(true);
    const expectedToken = signConversation('FLUX-903');
    expect(values.some((v) => v.includes(`http_headers.x-eh-conversation-token="${expectedToken}"`))).toBe(true);
  });

  it('adds the x-eh-workspace header when a workspaceRoot is given, escaping backslashes for valid TOML', () => {
    const args = buildCodexMcpConfigArgs('FLUX-903', 'E:\\Git\\SomeRepo');
    const values = args.filter((_, i) => i % 2 === 1);
    expect(values.some((v) => v.includes('http_headers.x-eh-workspace="E:\\\\Git\\\\SomeRepo"'))).toBe(true);
  });

  it('omits header overrides entirely when no conversationId/workspaceRoot is given', () => {
    const args = buildCodexMcpConfigArgs();
    expect(args.length).toBe(2); // just the one -c url override
  });
});

describe('Codex model-cache diagnostics (FLUX-1629)', () => {
  it('reads unique model slugs from the account-scoped cache', () => {
    const cachePath = `${process.cwd()}/codex-models-cache-test.json`;
    fs.writeFileSync(cachePath, JSON.stringify({ models: [{ slug: 'gpt-5.6-terra' }, { slug: 'gpt-5.5' }, { slug: 'gpt-5.6-terra' }, {}] }));
    try {
      expect(readCodexModelSlugs(cachePath)).toEqual(['gpt-5.6-terra', 'gpt-5.5']);
    } finally {
      fs.unlinkSync(cachePath);
    }
  });

  it('names the available account models before an unsupported configured model can reach Codex', () => {
    expect(() => assertCodexModelAvailable('gpt-fictional', ['gpt-5.6-terra', 'gpt-5.5']))
      .toThrow('Available models: gpt-5.6-terra, gpt-5.5');
  });
});
