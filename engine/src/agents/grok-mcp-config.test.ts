import { describe, it, expect } from 'vitest';
import {
  extractEnginePortFromGrokToml,
  grokMcpConfigToml,
  isEhOwnedGrokMcpToml,
  upsertGrokEventHorizonToml,
} from './grok-mcp-config.js';

describe('grok MCP TOML helpers', () => {
  it('emits placeholder headers and the engine port', () => {
    const toml = grokMcpConfigToml(3067);
    expect(toml).toContain('[mcp_servers.event-horizon]');
    expect(toml).toContain('url = "http://127.0.0.1:3067/mcp"');
    expect(toml).toContain('X-EH-Session-Id = "${EH_SESSION_ID}"');
    expect(isEhOwnedGrokMcpToml(toml)).toBe(true);
    expect(extractEnginePortFromGrokToml(toml)).toBe(3067);
  });

  it('does not treat a foreign event-horizon URL as EH-owned', () => {
    const foreign = '[mcp_servers.event-horizon]\nurl = "http://127.0.0.1:9999/mcp"\n';
    expect(isEhOwnedGrokMcpToml(foreign)).toBe(false);
    expect(extractEnginePortFromGrokToml(foreign)).toBe(9999);
  });

  it('upserts event-horizon without clobbering another server', () => {
    const existing = [
      '[mcp_servers.other]',
      'command = "foo"',
      '',
      '[mcp_servers.event-horizon]',
      'url = "http://127.0.0.1:1/mcp"',
      '',
      '[mcp_servers.event-horizon.headers]',
      'X-EH-Session-Id = "stale"',
    ].join('\n');
    const next = upsertGrokEventHorizonToml(existing, grokMcpConfigToml(3067));
    expect(next).toContain('[mcp_servers.other]');
    expect(next).toContain('command = "foo"');
    expect(next).toContain('url = "http://127.0.0.1:3067/mcp"');
    expect(next).toContain('${EH_SESSION_ID}');
    expect(next).not.toContain('url = "http://127.0.0.1:1/mcp"');
    expect(next).not.toContain('X-EH-Session-Id = "stale"');
  });
});
