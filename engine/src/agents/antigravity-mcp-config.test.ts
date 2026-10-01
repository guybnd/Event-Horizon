import { describe, it, expect } from 'vitest';
import {
  buildAntigravityMcpServerEntry,
  isEhOwnedAntigravityEntry,
  upsertAntigravityEventHorizonEntry,
} from './antigravity-mcp-config.js';

describe('antigravity MCP config helpers (FLUX-1738)', () => {
  it('emits agy\'s own schema — serverUrl + disabled, never gemini-cli\'s httpUrl', () => {
    const entry = buildAntigravityMcpServerEntry(3067);
    expect(entry.serverUrl).toBe('http://127.0.0.1:3067/mcp');
    expect(entry.disabled).toBe(false);
    // The whole point of not reusing buildGeminiMcpServerEntry: `agy` ignores these keys, and an
    // entry carrying them registers a server with no URL that fails at CONNECT time rather than at
    // install time — the silent-failure shape this assertion exists to prevent regressing to.
    expect(entry).not.toHaveProperty('httpUrl');
    expect(entry).not.toHaveProperty('url');
    expect(entry).not.toHaveProperty('type');
  });

  it('carries conversation-binding header PLACEHOLDERS, not resolved values', () => {
    const entry = buildAntigravityMcpServerEntry(3067);
    expect(entry.headers['x-eh-conversation-id']).toBe('${EH_CONVERSATION_ID}');
    expect(entry.headers['x-eh-conversation-token']).toBe('${EH_CONVERSATION_TOKEN}');
  });

  it('renders whatever engine port it is given', () => {
    expect(buildAntigravityMcpServerEntry(41234).serverUrl).toBe('http://127.0.0.1:41234/mcp');
  });

  it('upserts event-horizon without clobbering another server', () => {
    const existing = {
      mcpServers: {
        other: { serverUrl: 'http://example.test/mcp', headers: {}, disabled: false },
      },
    };
    const next = upsertAntigravityEventHorizonEntry(existing, buildAntigravityMcpServerEntry(3067));
    expect(Object.keys(next.mcpServers!).sort()).toEqual(['event-horizon', 'other']);
    expect(next.mcpServers!.other).toEqual(existing.mcpServers.other);
    // Must not mutate the input — the caller re-reads and re-writes the user's real config file.
    expect(Object.keys(existing.mcpServers)).toEqual(['other']);
  });

  it('replaces a stale event-horizon entry rather than merging into it', () => {
    const existing = {
      mcpServers: {
        'event-horizon': { serverUrl: 'http://127.0.0.1:9999/mcp', headers: {}, disabled: true },
      },
    };
    const next = upsertAntigravityEventHorizonEntry(existing, buildAntigravityMcpServerEntry(3067));
    const entry = next.mcpServers!['event-horizon'] as { serverUrl: string; disabled: boolean };
    expect(entry.serverUrl).toBe('http://127.0.0.1:3067/mcp');
    // A stale `disabled: true` must not survive a reinstall, or the server stays silently off.
    expect(entry.disabled).toBe(false);
  });

  it('preserves sibling top-level keys in the config file', () => {
    const existing = { mcpServers: {}, someOtherSetting: 'keep me' } as Record<string, unknown>;
    const next = upsertAntigravityEventHorizonEntry(existing) as Record<string, unknown>;
    expect(next.someOtherSetting).toBe('keep me');
  });

  describe('isEhOwnedAntigravityEntry', () => {
    it('recognises EH\'s own loopback entry on any port', () => {
      expect(isEhOwnedAntigravityEntry(buildAntigravityMcpServerEntry(3067))).toBe(true);
      expect(isEhOwnedAntigravityEntry(buildAntigravityMcpServerEntry(51000))).toBe(true);
    });

    it('rejects a foreign or malformed entry', () => {
      expect(isEhOwnedAntigravityEntry({ serverUrl: 'https://example.test/mcp' })).toBe(false);
      // A gemini-shaped entry is NOT EH-owned here: it has no serverUrl at all.
      expect(isEhOwnedAntigravityEntry({ httpUrl: 'http://127.0.0.1:3067/mcp' })).toBe(false);
      expect(isEhOwnedAntigravityEntry({})).toBe(false);
      expect(isEhOwnedAntigravityEntry(null)).toBe(false);
      expect(isEhOwnedAntigravityEntry('http://127.0.0.1:3067/mcp')).toBe(false);
    });
  });
});
