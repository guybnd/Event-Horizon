import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./config.js', () => ({
  configCache: {} as Record<string, unknown>,
}));

vi.mock('./workspace.js', () => ({
  getActiveFluxDir: vi.fn(() => '/project/.flux-store'),
}));

import { configCache } from './config.js';
import { getActiveFluxDir } from './workspace.js';
import {
  getActiveModules,
  getModuleMcpServers,
  getModulePromptFragments,
  loadModules,
  BUILTIN_MODULES,
} from './modules.js';

// ── Fixtures ─────────────────────────────────────────────────────────────────

const FIXTURE_PHASE_GATED = {
  id: 'test-phase',
  name: 'Phase Gated Module',
  description: 'A test module with phase gating',
  enabled: true,
  mcpServer: { command: 'npx', args: ['-y', 'test-mcp'] },
  promptFragment: 'Use this module for phase-gated tasks.',
  phases: ['implementation', 'review'],
};

const FIXTURE_DISABLED = {
  id: 'test-disabled',
  name: 'Disabled Module',
  description: 'A disabled module',
  enabled: false,
  phases: ['implementation'],
};

const FIXTURE_TAG_GATED = {
  id: 'test-tag',
  name: 'Tag Gated Module',
  description: 'A module requiring specific tags',
  enabled: true,
  promptFragment: 'Use this for backend tasks.',
  conditions: { requireTags: ['backend'] },
};

beforeEach(() => {
  (configCache as any).modules = [FIXTURE_PHASE_GATED, FIXTURE_DISABLED, FIXTURE_TAG_GATED];
});

// ── Phase gating ──────────────────────────────────────────────────────────────

describe('getActiveModules — phase gating', () => {
  it('returns enabled module for a matching phase', () => {
    expect(getActiveModules('implementation').map(m => m.id)).toContain('test-phase');
  });

  it('returns enabled module for second matching phase', () => {
    expect(getActiveModules('review').map(m => m.id)).toContain('test-phase');
  });

  it('excludes module when phase does not match', () => {
    expect(getActiveModules('grooming').map(m => m.id)).not.toContain('test-phase');
  });

  it('excludes disabled modules regardless of phase', () => {
    expect(getActiveModules('implementation').map(m => m.id)).not.toContain('test-disabled');
  });

  it('includes module with no phases restriction for any phase', () => {
    // FIXTURE_TAG_GATED has no phases — active for all phases when tags match
    expect(getActiveModules('grooming', ['backend']).map(m => m.id)).toContain('test-tag');
  });
});

// ── Tag gating ────────────────────────────────────────────────────────────────

describe('getActiveModules — tag gating', () => {
  it('excludes module when required tag is absent', () => {
    expect(getActiveModules('implementation', []).map(m => m.id)).not.toContain('test-tag');
  });

  it('excludes module when tags array is undefined', () => {
    expect(getActiveModules('implementation').map(m => m.id)).not.toContain('test-tag');
  });

  it('includes module when all required tags are present', () => {
    expect(getActiveModules('implementation', ['backend']).map(m => m.id)).toContain('test-tag');
  });

  it('excludes module when only some required tags match (multiple requireTags)', () => {
    (configCache as any).modules = [{
      ...FIXTURE_TAG_GATED,
      conditions: { requireTags: ['backend', 'api'] },
    }];
    expect(getActiveModules('implementation', ['backend']).map(m => m.id)).not.toContain('test-tag');
  });
});

// ── MCP server map ────────────────────────────────────────────────────────────

describe('getModuleMcpServers', () => {
  it('returns server keyed by module id for active modules', () => {
    const servers = getModuleMcpServers('implementation');
    expect(servers).toHaveProperty('test-phase');
    expect(servers['test-phase']).toEqual({ command: 'npx', args: ['-y', 'test-mcp'] });
  });

  it('excludes modules without an mcpServer', () => {
    // FIXTURE_TAG_GATED has no mcpServer
    const servers = getModuleMcpServers('implementation', ['backend']);
    expect(servers).not.toHaveProperty('test-tag');
  });

  it('excludes disabled modules', () => {
    const servers = getModuleMcpServers('implementation');
    expect(servers).not.toHaveProperty('test-disabled');
  });

  it('returns empty object when no active modules', () => {
    (configCache as any).modules = [];
    expect(getModuleMcpServers('implementation')).toEqual({});
  });

  it('resolves ${ACTIVE_FLUX_DIR} in mcpServer env values', () => {
    (configCache as any).modules = [{
      id: 'mem',
      name: 'Memory',
      description: 'test',
      enabled: true,
      mcpServer: {
        command: 'uvx',
        args: ['basic-memory', 'mcp'],
        env: { BASIC_MEMORY_HOME: '${ACTIVE_FLUX_DIR}/memory' },
      },
    }];
    const servers = getModuleMcpServers('implementation');
    expect(servers['mem']?.env?.BASIC_MEMORY_HOME).toBe('/project/.flux-store/memory');
  });

  it('leaves unrecognised template vars unchanged', () => {
    (configCache as any).modules = [{
      id: 'mem',
      name: 'Memory',
      description: 'test',
      enabled: true,
      mcpServer: {
        command: 'uvx',
        args: ['basic-memory', 'mcp'],
        env: { SOME_KEY: '${UNKNOWN_VAR}/path' },
      },
    }];
    const servers = getModuleMcpServers('implementation');
    expect(servers['mem']?.env?.SOME_KEY).toBe('${UNKNOWN_VAR}/path');
  });
});

// ── Prompt fragment ───────────────────────────────────────────────────────────

describe('getModulePromptFragments', () => {
  it('wraps fragment under ## Active Modules heading with <module> tags', () => {
    const result = getModulePromptFragments('implementation');
    expect(result).toContain('## Active Modules');
    expect(result).toContain('<module name="Phase Gated Module">');
    expect(result).toContain('</module>');
    expect(result).toContain('Use this module for phase-gated tasks.');
  });

  it('returns empty string when no modules are active', () => {
    (configCache as any).modules = [];
    expect(getModulePromptFragments('implementation')).toBe('');
  });

  it('returns empty string when active modules have no promptFragment', () => {
    (configCache as any).modules = [{
      id: 'no-frag',
      name: 'No Fragment',
      description: 'desc',
      enabled: true,
    }];
    expect(getModulePromptFragments('implementation')).toBe('');
  });

  it('truncates promptFragment at 2000 characters', () => {
    (configCache as any).modules = [{
      id: 'long',
      name: 'Long',
      description: 'desc',
      enabled: true,
      promptFragment: 'x'.repeat(2500),
    }];
    const result = getModulePromptFragments('implementation');
    const match = result.match(/<module name="Long">\n([\s\S]*?)\n<\/module>/);
    expect(match).not.toBeNull();
    expect(match![1]!.length).toBe(2000);
  });
});

// ── BUILTIN_MODULES: serena shape ─────────────────────────────────────────────

describe('BUILTIN_MODULES — serena entry', () => {
  const serena = BUILTIN_MODULES.find(m => m.id === 'serena');

  it('contains a serena entry', () => {
    expect(serena).toBeDefined();
  });

  it('serena has an mcpServer using the serena binary', () => {
    expect(serena!.mcpServer).toBeDefined();
    expect(serena!.mcpServer!.command).toBe('serena');
    expect(serena!.mcpServer!.args).toContain('start-mcp-server');
  });

  it('serena has a non-empty promptFragment', () => {
    expect(typeof serena!.promptFragment).toBe('string');
    expect(serena!.promptFragment!.trim().length).toBeGreaterThan(0);
  });

  it('serena is disabled by default', () => {
    expect(serena!.enabled).toBe(false);
  });

  it('serena has no phase restriction (active for all phases when enabled)', () => {
    // phases undefined means the module is not restricted to specific phases
    expect(serena!.phases).toBeUndefined();
  });

  it('serena promptFragment tells agents to call initial_instructions and prefer symbol tools', () => {
    const frag = serena!.promptFragment!;
    expect(frag).toContain('initial_instructions');
    expect(frag).toMatch(/find_symbol|get_symbols_overview/);
    expect(frag.length).toBeLessThanOrEqual(2000);
  });

  it('serena declares a sharedHttp launch with PROJECT and PORT placeholders', () => {
    expect(serena!.sharedHttp).toBeDefined();
    expect(serena!.sharedHttp!.command).toBe('serena');
    const args = serena!.sharedHttp!.args;
    expect(args).toContain('--transport');
    expect(args).toContain('streamable-http');
    expect(args).toContain('${PROJECT}');
    expect(args).toContain('${PORT}');
    // Must still keep an stdio mcpServer for the fallback path.
    expect(serena!.mcpServer).toBeDefined();
  });
});

// ── BUILTIN_MODULES: basic-memory shape ──────────────────────────────────────

describe('BUILTIN_MODULES — basic-memory entry', () => {
  const bm = BUILTIN_MODULES.find(m => m.id === 'basic-memory');

  it('contains a basic-memory entry', () => {
    expect(bm).toBeDefined();
  });

  it('basic-memory uses uvx command', () => {
    expect(bm!.mcpServer?.command).toBe('uvx');
    expect(bm!.mcpServer?.args).toContain('basic-memory');
  });

  it('basic-memory has BASIC_MEMORY_HOME env var with ACTIVE_FLUX_DIR template', () => {
    expect(bm!.mcpServer?.env?.BASIC_MEMORY_HOME).toBe('${ACTIVE_FLUX_DIR}/memory');
  });

  it('basic-memory is disabled by default', () => {
    expect(bm!.enabled).toBe(false);
  });

  it('basic-memory has a non-empty promptFragment', () => {
    expect(bm!.promptFragment?.trim().length).toBeGreaterThan(0);
  });
});

// ── BUILTIN_MODULES: mem0 shape ───────────────────────────────────────────────

describe('BUILTIN_MODULES — mem0 entry', () => {
  const mem0 = BUILTIN_MODULES.find(m => m.id === 'mem0');

  it('contains a mem0 entry', () => {
    expect(mem0).toBeDefined();
  });

  it('mem0 uses npx command with @mem0/mcp-server', () => {
    expect(mem0!.mcpServer?.command).toBe('npx');
    expect(mem0!.mcpServer?.args).toContain('@mem0/mcp-server');
  });

  it('mem0 has MEM0_API_KEY env var as a passthrough placeholder', () => {
    expect(mem0!.mcpServer?.env?.MEM0_API_KEY).toBe('${MEM0_API_KEY}');
  });

  it('mem0 is disabled by default', () => {
    expect(mem0!.enabled).toBe(false);
  });

  it('mem0 has a non-empty promptFragment', () => {
    expect(mem0!.promptFragment?.trim().length).toBeGreaterThan(0);
  });
});

// ── FLUX-447: mcpServer shape validation ──────────────────────────────────────

describe('loadModules — mcpServer shape validation (FLUX-447)', () => {
  it('keeps a module with a well-formed mcpServer', () => {
    (configCache as any).modules = [{
      id: 'good', name: 'Good', description: 'd', enabled: true,
      mcpServer: { command: 'npx', args: ['-y', 'x'] },
    }];
    expect(loadModules().map(m => m.id)).toContain('good');
  });

  it('drops a module whose mcpServer is missing command', () => {
    (configCache as any).modules = [{
      id: 'bad', name: 'Bad', description: 'd', enabled: true,
      mcpServer: { args: ['-y', 'x'] },
    }];
    expect(loadModules().map(m => m.id)).not.toContain('bad');
  });

  it('drops a module whose mcpServer args are not all strings', () => {
    (configCache as any).modules = [{
      id: 'bad2', name: 'Bad2', description: 'd', enabled: true,
      mcpServer: { command: 'npx', args: ['ok', 3] },
    }];
    expect(loadModules().map(m => m.id)).not.toContain('bad2');
  });

  it('keeps a prompt-only module with no mcpServer', () => {
    (configCache as any).modules = [{
      id: 'frag-only', name: 'Frag', description: 'd', enabled: true,
      promptFragment: 'hi',
    }];
    expect(loadModules().map(m => m.id)).toContain('frag-only');
  });

  it('drops a module whose sharedHttp is malformed', () => {
    (configCache as any).modules = [{
      id: 'bad-http', name: 'BadHttp', description: 'd', enabled: true,
      mcpServer: { command: 'serena', args: [] },
      sharedHttp: { command: '', args: [] },
    }];
    expect(loadModules().map(m => m.id)).not.toContain('bad-http');
  });
});

// ── FLUX-447: prompt-fragment dedupe by id ────────────────────────────────────

describe('getModulePromptFragments — dedupe by id (FLUX-447)', () => {
  it('injects a duplicate-id module fragment only once', () => {
    (configCache as any).modules = [
      { id: 'dup', name: 'Dup', description: 'd', enabled: true, promptFragment: 'FRAGMENT_X' },
      { id: 'dup', name: 'Dup', description: 'd', enabled: true, promptFragment: 'FRAGMENT_X' },
    ];
    const result = getModulePromptFragments('implementation');
    expect(result.split('FRAGMENT_X').length - 1).toBe(1);
  });
});

// ── getModuleMcpServers: uninitialised workspace ───────────────────────────────

describe('getModuleMcpServers — uninitialised workspace', () => {
  it('preserves ${ACTIVE_FLUX_DIR} template verbatim when workspace is not initialised', () => {
    vi.mocked(getActiveFluxDir).mockImplementationOnce(() => { throw new Error('no workspace'); });
    (configCache as any).modules = [{
      id: 'mem',
      name: 'Memory',
      description: 'test',
      enabled: true,
      mcpServer: {
        command: 'uvx',
        args: ['basic-memory', 'mcp'],
        env: { BASIC_MEMORY_HOME: '${ACTIVE_FLUX_DIR}/memory' },
      },
    }];
    const servers = getModuleMcpServers('implementation');
    expect(servers['mem']?.env?.BASIC_MEMORY_HOME).toBe('${ACTIVE_FLUX_DIR}/memory');
  });
});
