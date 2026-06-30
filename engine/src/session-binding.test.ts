import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import os from 'os';
import { setWorkspaceRoot, getActiveFluxDir } from './workspace.js';
import { signConversation, verifyConversation, __resetBindingSecretForTest } from './session-binding.js';

/**
 * FLUX-841: the binding token closes same-shape cross-ticket transcript injection. A session is
 * launched with EH_CONVERSATION_TOKEN = signConversation(its OWN conversationId); the HITL route
 * only routes to a conversationId whose forwarded token verifies. The security property under test:
 * a token minted for ticket A must NOT verify for any sibling ticket B.
 */
describe('session-binding (FLUX-841 session→ticket token)', () => {
  it('verifies a token against the conversationId it was signed for', () => {
    for (const id of ['FLUX-841', 'PR-141', '__board__', 'ABC-1']) {
      expect(verifyConversation(id, signConversation(id))).toBe(true);
    }
  });

  it('rejects a token minted for a different (sibling) conversationId — the core injection guard', () => {
    const tokenForA = signConversation('FLUX-841');
    expect(verifyConversation('FLUX-999', tokenForA)).toBe(false);
    expect(verifyConversation('PR-141', tokenForA)).toBe(false);
  });

  it('rejects a missing, empty, or non-string token', () => {
    expect(verifyConversation('FLUX-841', null)).toBe(false);
    expect(verifyConversation('FLUX-841', undefined)).toBe(false);
    expect(verifyConversation('FLUX-841', '')).toBe(false);
    expect(verifyConversation('FLUX-841', undefined as any)).toBe(false);
  });

  it('rejects a tampered token (wrong value, wrong length)', () => {
    const good = signConversation('FLUX-841');
    expect(verifyConversation('FLUX-841', good.slice(0, -1) + (good.endsWith('a') ? 'b' : 'a'))).toBe(false);
    expect(verifyConversation('FLUX-841', good.slice(0, 10))).toBe(false);
    expect(verifyConversation('FLUX-841', good + 'ff')).toBe(false);
    expect(verifyConversation('FLUX-841', 'not-hex-garbage')).toBe(false);
  });

  it('is deterministic within a process (re-signing the same id matches)', () => {
    expect(signConversation('FLUX-841')).toBe(signConversation('FLUX-841'));
    expect(signConversation('FLUX-841')).not.toBe(signConversation('FLUX-842'));
  });
});

/**
 * FLUX-894 — the binding secret is now PERSISTED to the active flux dir, so a token signed by a
 * pre-restart session still verifies after the engine restarts. Without this, the secret was
 * minted fresh per process: a prompt raised by a surviving/rehydrated ticket session forwarded a
 * token signed by the OLD secret, the new process rejected it, the conversationId dropped to null,
 * and the prompt (question + answer) silently echoed to the `__board__` thread instead of its
 * ticket. `__resetBindingSecretForTest()` clears the in-memory cache to simulate the new process
 * re-reading the SAME on-disk secret.
 */
describe('session-binding secret persistence across restart (FLUX-894)', () => {
  let root: string;

  beforeEach(async () => {
    root = await fsp.mkdtemp(path.join(os.tmpdir(), 'eh-binding-'));
    setWorkspaceRoot(root);
    __resetBindingSecretForTest(); // start from a clean cache so the first sign loads/mints from disk
  });

  afterEach(async () => {
    __resetBindingSecretForTest();
    await fsp.rm(root, { recursive: true, force: true }).catch(() => {});
  });

  it('persists the secret to a file in the active flux dir on first use', () => {
    signConversation('FLUX-890');
    const secretFile = path.join(getActiveFluxDir(), 'session-binding-secret');
    expect(fs.existsSync(secretFile)).toBe(true);
    // 32 random bytes, hex-encoded → 64 chars.
    expect(fs.readFileSync(secretFile, 'utf-8').trim()).toMatch(/^[0-9a-f]{64}$/);
  });

  it('a token signed before a restart still verifies after (the FLUX-894 fix)', () => {
    const token = signConversation('FLUX-890'); // pre-restart process: mints + persists the secret
    __resetBindingSecretForTest();              // engine restarts → new process, in-memory cache gone
    // Post-restart process re-reads the SAME secret from disk, so the stale token verifies.
    expect(verifyConversation('FLUX-890', token)).toBe(true);
    // FLUX-841 preserved: a token bound to one ticket still cannot route into a sibling post-restart.
    expect(verifyConversation('FLUX-999', token)).toBe(false);
  });

  it('re-mints (so an old token no longer verifies) if the persisted secret is lost', async () => {
    const token = signConversation('FLUX-1');
    await fsp.rm(path.join(getActiveFluxDir(), 'session-binding-secret'));
    __resetBindingSecretForTest();
    // No secret on disk → a fresh one is minted, so the pre-loss token is correctly rejected.
    expect(verifyConversation('FLUX-1', token)).toBe(false);
  });

  it('falls back to an in-memory secret (sign/verify still consistent) when no workspace is bound', () => {
    setWorkspaceRoot(null as any); // getActiveFluxDir throws → best-effort path, ephemeral secret
    __resetBindingSecretForTest();
    expect(verifyConversation('FLUX-1', signConversation('FLUX-1'))).toBe(true);
    expect(verifyConversation('FLUX-2', signConversation('FLUX-1'))).toBe(false);
  });
});
