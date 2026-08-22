import { describe, it, expect, afterEach } from 'vitest';
import {
  mutatingToolsForServer,
  resolveReadOnlyDisallowedTools,
  allReadOnlyDisallowedTools,
  setCachedToolNames,
  clearToolNameCache,
  type McpServerReadOnlyConfig,
} from './mcp-readonly.js';
import { getConfig } from './config.js';

// FLUX-1657: per-connector read/write scoping. `mutatingToolsForServer` is the pure decision
// function (no I/O) — the tests below drive it directly with hand-built tool-name lists, matching
// the ticket's own recommended-tests note that override lists reference external tool names not
// statically known to this repo.
describe('mutatingToolsForServer', () => {
  const TOOLS = ['listIssues', 'createIssue', 'updateIssue', 'deleteIssue', 'getIssue', 'weirdWriteAction'];

  it('AC1: a read-only server hides its mutating tools', () => {
    const cfg: McpServerReadOnlyConfig = { jira: true };
    const denied = mutatingToolsForServer('jira', TOOLS, cfg, 'grooming');
    expect(new Set(denied)).toEqual(new Set(['createIssue', 'updateIssue', 'deleteIssue', 'weirdWriteAction']));
    expect(denied).not.toContain('listIssues');
    expect(denied).not.toContain('getIssue');
  });

  it('a server absent from config is never scoped', () => {
    const cfg: McpServerReadOnlyConfig = { jira: true };
    expect(mutatingToolsForServer('doc360', TOOLS, cfg, 'grooming')).toEqual([]);
  });

  it('AC2: exceptPhases reveals write tools only in the excepted phase', () => {
    const cfg: McpServerReadOnlyConfig = { doc360: { exceptPhases: ['finalize'] } };
    expect(mutatingToolsForServer('doc360', TOOLS, cfg, 'finalize')).toEqual([]);
    const denied = mutatingToolsForServer('doc360', TOOLS, cfg, 'grooming');
    expect(denied).toContain('createIssue');
  });

  it('AC3: per-server allow override force-allows a matching tool', () => {
    const cfg: McpServerReadOnlyConfig = { jira: { allow: ['createIssue'] } };
    const denied = mutatingToolsForServer('jira', TOOLS, cfg, 'grooming');
    expect(denied).not.toContain('createIssue');
    expect(denied).toContain('updateIssue');
  });

  it('AC3: per-server deny override force-denies a tool the pattern would otherwise miss', () => {
    const cfg: McpServerReadOnlyConfig = { jira: { deny: ['getIssue'] } };
    const denied = mutatingToolsForServer('jira', TOOLS, cfg, 'grooming');
    expect(denied).toContain('getIssue');
    expect(denied).toContain('createIssue');
  });

  it('AC5: an empty/unresolved tool list fails open regardless of the readOnly flag', () => {
    const cfg: McpServerReadOnlyConfig = { jira: true };
    expect(mutatingToolsForServer('jira', [], cfg, 'grooming')).toEqual([]);
  });

  it('no phase (undefined effectivePhase) still denies for a plain readOnly:true rule', () => {
    const cfg: McpServerReadOnlyConfig = { jira: true };
    expect(mutatingToolsForServer('jira', TOOLS, cfg, undefined)).toContain('createIssue');
  });
});

describe('resolveReadOnlyDisallowedTools / allReadOnlyDisallowedTools (cache-backed resolvers)', () => {
  afterEach(() => {
    clearToolNameCache();
    delete getConfig().mcpServerReadOnly;
  });

  it('AC5: fails open (empty) when the server has no cached tool names, even if configured read-only', () => {
    getConfig().mcpServerReadOnly = { jira: true };
    expect(resolveReadOnlyDisallowedTools('jira', 'grooming')).toEqual([]);
  });

  it('prefixes denied tool names with mcp__<serverId>__ for the CLI --disallowed-tools flag', () => {
    getConfig().mcpServerReadOnly = { jira: true };
    setCachedToolNames('jira', ['createIssue', 'getIssue']);
    expect(resolveReadOnlyDisallowedTools('jira', 'grooming')).toEqual(['mcp__jira__createIssue']);
  });

  it('AC2: reveals the write tool in the excepted phase via the full resolver', () => {
    getConfig().mcpServerReadOnly = { doc360: { exceptPhases: ['finalize'] } };
    setCachedToolNames('doc360', ['publishPage', 'getPage']);
    expect(resolveReadOnlyDisallowedTools('doc360', 'finalize')).toEqual([]);
    expect(resolveReadOnlyDisallowedTools('doc360', 'implementation')).toEqual(['mcp__doc360__publishPage']);
  });

  it('allReadOnlyDisallowedTools aggregates across every configured server', () => {
    getConfig().mcpServerReadOnly = { jira: true, doc360: { exceptPhases: ['finalize'] } };
    setCachedToolNames('jira', ['createIssue']);
    setCachedToolNames('doc360', ['publishPage']);
    const denied = allReadOnlyDisallowedTools('grooming');
    expect(new Set(denied)).toEqual(new Set(['mcp__jira__createIssue', 'mcp__doc360__publishPage']));
  });

  it('AC4-adjacent: no config at all means no restriction from this layer', () => {
    expect(allReadOnlyDisallowedTools('grooming')).toEqual([]);
  });
});
