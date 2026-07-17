import { describe, it, expect, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

/**
 * FLUX-1331 (AC5 of FLUX-951): a missing/unreadable skill module must degrade to
 * `skillModuleFallback(...)` instead of crashing the server or the connection, and
 * the failure must not be memoized — a later call re-reads the file.
 *
 * Deliberately its own file: `skillModuleBodyMemo` in mcp-server.ts is module-scope,
 * and mcp-prompts.test.ts already drives every prompt module through the happy path
 * (memoizing all of them). A fresh test file gets a fresh module graph (vitest
 * isolates per file by default), so `readFile` is guaranteed to be hit here.
 */
const state = vi.hoisted(() => ({ failRelease: true }));

vi.mock('fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs/promises')>();
  return {
    ...actual,
    default: {
      ...actual,
      readFile: vi.fn((...args: Parameters<typeof actual.readFile>) => {
        const target = String(args[0]);
        if (state.failRelease && target.includes('event-horizon-release.md')) {
          return Promise.reject(new Error('ENOENT: simulated unreadable skill module'));
        }
        return actual.readFile(...args);
      }),
    },
  };
});

describe('MCP prompt skill-module fallback path (FLUX-1331, AC5 of FLUX-951)', () => {
  it('an unreadable skill module falls back to skillModuleFallback text instead of erroring the connection, and is not memoized', async () => {
    const { buildMcpServer } = await import('./mcp-server.js');
    const server = buildMcpServer();
    const client = new Client({ name: 'eh-prompts-fallback-test', version: '1.0.0' }, { capabilities: {} });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    try {
      const failed = await client.getPrompt({ name: 'release', arguments: { version: 'v9.9.9' } });
      expect(failed.messages).toHaveLength(1);
      const failedMsg = failed.messages[0];
      if (!failedMsg || failedMsg.content.type !== 'text') throw new Error('expected one text message');
      expect(failedMsg.content.text).toContain('could not be read on this install');
      expect(failedMsg.content.text).not.toContain('Release Workflow');

      // Repair the "install" and confirm the failure was not memoized: the next
      // call re-reads the file and returns the real module body.
      state.failRelease = false;
      const recovered = await client.getPrompt({ name: 'release', arguments: { version: 'v9.9.9' } });
      const recoveredMsg = recovered.messages[0];
      if (!recoveredMsg || recoveredMsg.content.type !== 'text') throw new Error('expected one text message');
      expect(recoveredMsg.content.text).toContain('Release Workflow');
      expect(recoveredMsg.content.text).toContain('v9.9.9');
      expect(recoveredMsg.content.text).not.toContain('could not be read on this install');
    } finally {
      await client.close().catch(() => {});
      await server.close().catch(() => {});
    }
  });
});
