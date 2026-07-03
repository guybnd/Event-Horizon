import { describe, it, expect } from 'vitest';
import { buildAdditionalMcpConfigArgs } from './copilot.js';

// FLUX-984: Copilot CLI never auto-loads the workspace .mcp.json in non-interactive (-p) mode —
// confirmed live, no permission flag changes it — so the event-horizon MCP server must be
// injected explicitly via --additional-mcp-config. This test exercises the actual function both
// copilot.ts's per-ticket spawn paths and copilot-board.ts's board spec call, not just the
// CLI_CAPABILITIES.copilot.spawnTimeMcpConfig flag (which is asserted separately in
// adapter-contract.test.ts — that test alone wouldn't catch this injection being removed while
// the flag stays true).
//
// Co-located inside engine/src/agents/ rather than in the cross-adapter adapter-contract.test.ts:
// this file's own import of `./copilot.js` is a deep import of a concrete adapter file, which the
// adapter-boundary guard (check-adapter-boundary.mjs) forbids OUTSIDE agents/ — agents/ itself is
// the one sanctioned exception (adapters may freely reference their own siblings).
describe('buildAdditionalMcpConfigArgs (FLUX-984)', () => {
  it('injects a valid event-horizon MCP entry via --additional-mcp-config', () => {
    const args = buildAdditionalMcpConfigArgs();
    expect(args[0]).toBe('--additional-mcp-config');
    const parsed = JSON.parse(args[1]!);
    expect(parsed.mcpServers['event-horizon'].type).toBe('http');
    expect(parsed.mcpServers['event-horizon'].url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
  });
});
