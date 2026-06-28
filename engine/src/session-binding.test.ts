import { describe, it, expect } from 'vitest';
import { signConversation, verifyConversation } from './session-binding.js';

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
