import { describe, it, expect } from 'vitest';
import { probeMcpServer, probeModuleMcpSchemas } from './mcp-schema-probe.js';

describe('probeModuleMcpSchemas', () => {
  it('returns an empty, well-formed report when no module servers are active', async () => {
    const report = await probeModuleMcpSchemas();
    expect(Array.isArray(report.servers)).toBe(true);
    expect(report.servers.length).toBe(0);
    expect(report.totalTokensEst).toBe(0);
    expect(report.note).toMatch(/No module MCP servers/i);
  });
});

describe('probeMcpServer', () => {
  it('isolates failure when the server command does not exist', async () => {
    const r = await probeMcpServer('bogus', { command: 'eh-no-such-mcp-binary-xyz', args: [] }, 3000);
    expect(r.ok).toBe(false);
    expect(r.toolCount).toBe(0);
    expect(r.totalTokensEst).toBe(0);
    expect(r.error).toBeTruthy();
  }, 10000);
});
