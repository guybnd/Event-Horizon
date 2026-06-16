import { describe, it, expect } from 'vitest';
import { filterMcpServersByPhase } from './agents/claude-code.js';

const servers = {
  'event-horizon': { type: 'stdio', command: 'eh' },
  'basic-memory': { command: 'uvx', args: ['basic-memory', 'mcp'] },
  serena: { type: 'http', url: 'http://127.0.0.1:9122/mcp' },
  context7: { command: 'npx', args: ['-y', '@upstash/context7-mcp'] },
};

describe('filterMcpServersByPhase', () => {
  it('passes everything through when no profiles are configured', () => {
    expect(filterMcpServersByPhase(servers, undefined, 'grooming')).toEqual(servers);
    expect(filterMcpServersByPhase(servers, {}, 'grooming')).toEqual(servers);
  });

  it('drops a server scoped to other phases', () => {
    const out = filterMcpServersByPhase(servers, { 'basic-memory': ['implementation'] }, 'grooming');
    expect(out['basic-memory']).toBeUndefined();
    expect(out.serena).toBeDefined();
    expect(out.context7).toBeDefined();
  });

  it('keeps a scoped server for its own phase', () => {
    const out = filterMcpServersByPhase(servers, { 'basic-memory': ['implementation'] }, 'implementation');
    expect(out['basic-memory']).toBeDefined();
  });

  it('never drops event-horizon even if listed under other phases', () => {
    const out = filterMcpServersByPhase(servers, { 'event-horizon': ['release'] }, 'grooming');
    expect(out['event-horizon']).toBeDefined();
  });

  it('preserves transport shape of kept servers', () => {
    const out = filterMcpServersByPhase(servers, { 'basic-memory': ['implementation'] }, 'grooming');
    expect(out.serena).toEqual({ type: 'http', url: 'http://127.0.0.1:9122/mcp' });
  });
});
