import { describe, it, expect } from 'vitest';
import {
  BOARD_CONVERSATION_ID,
  FURNACE_CONVERSATION_ID,
  isVirtualConversationId,
  virtualConversationSessionKey,
  parseVirtualSessionKey,
} from './board.js';

// FLUX-1580: per-workspace session-store keying for the board orchestrator / Furnace chat. These
// helpers are the mechanism that lets N open workspaces each get their OWN `__board__`/`__furnace__`
// session instead of colliding on the bare literal id — see routes/cli-session.ts's virtual-
// conversation branches (start/input/stop) for the call sites.
describe('virtualConversationSessionKey / parseVirtualSessionKey (FLUX-1580)', () => {
  it('mints a distinct key per (id, workspaceRoot) pair', () => {
    const keyA = virtualConversationSessionKey(BOARD_CONVERSATION_ID, '/repo/a');
    const keyB = virtualConversationSessionKey(BOARD_CONVERSATION_ID, '/repo/b');
    expect(keyA).not.toBe(keyB);
    expect(keyA).not.toBe(BOARD_CONVERSATION_ID);
  });

  it('gives board and Furnace distinct keys within the SAME workspace', () => {
    const boardKey = virtualConversationSessionKey(BOARD_CONVERSATION_ID, '/repo/a');
    const furnaceKey = virtualConversationSessionKey(FURNACE_CONVERSATION_ID, '/repo/a');
    expect(boardKey).not.toBe(furnaceKey);
  });

  it('round-trips through parseVirtualSessionKey', () => {
    const key = virtualConversationSessionKey(FURNACE_CONVERSATION_ID, '/repo/a');
    expect(parseVirtualSessionKey(key)).toEqual({ id: FURNACE_CONVERSATION_ID, workspaceRoot: '/repo/a' });
  });

  it('returns null for a bare (non-namespaced) id', () => {
    expect(parseVirtualSessionKey(BOARD_CONVERSATION_ID)).toBeNull();
    expect(parseVirtualSessionKey('FLUX-123')).toBeNull();
  });

  it('returns null for a namespaced-looking string whose prefix is not a virtual conversation id', () => {
    expect(parseVirtualSessionKey('FLUX-123::/repo/a')).toBeNull();
  });
});

describe('isVirtualConversationId (FLUX-1580 widening)', () => {
  it('still recognizes the bare wire ids', () => {
    expect(isVirtualConversationId(BOARD_CONVERSATION_ID)).toBe(true);
    expect(isVirtualConversationId(FURNACE_CONVERSATION_ID)).toBe(true);
  });

  it('recognizes the namespaced internal session-store key too', () => {
    expect(isVirtualConversationId(virtualConversationSessionKey(BOARD_CONVERSATION_ID, '/repo/a'))).toBe(true);
    expect(isVirtualConversationId(virtualConversationSessionKey(FURNACE_CONVERSATION_ID, '/repo/a'))).toBe(true);
  });

  it('never misclassifies a real ticket id, namespaced-looking or not', () => {
    expect(isVirtualConversationId('FLUX-123')).toBe(false);
    expect(isVirtualConversationId('FLUX-123::/repo/a')).toBe(false);
  });
});
