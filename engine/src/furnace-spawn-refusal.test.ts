// The Furnace — dispatch-refusal classification (FLUX-1235).
//
// A ticket that merely has a session on it used to spin `MAX_SPAWN_ATTEMPTS` (6) pointless retries and
// then park with the misleading "the environment may be broken" — the park itself killing the chat
// session (FLUX-1071). `classifySpawnRefusal` is the fix's decision core: a DETERMINISTIC refusal parks
// immediately with the real reason (retrying can't help), while a transient/unknown failure returns null
// so `spawnOrCount` keeps counting toward the ceiling. These tests pin that split and, critically, that a
// live-session refusal is classified `needs-input` (must NOT trip the circuit breaker) and never kills
// the live session it is refusing to clobber.

import { describe, it, expect } from 'vitest';
import { classifySpawnRefusal, countsTowardBreaker } from './furnace-stoker.js';

describe('classifySpawnRefusal (FLUX-1235)', () => {
  it('409 → a live session: needs-input, accurate reason, never kills the session', () => {
    const c = classifySpawnRefusal('implementation', {
      sid: null,
      status: 409,
      error: 'Task already has a live CLI session. Use role/pattern params for multi-session.',
      sessionLabel: 'Temper naming',
      sessionStatus: 'running',
    });
    expect(c).not.toBeNull();
    expect(c!.failureClass).toBe('needs-input');
    expect(c!.stopSessions).toBe(false);
    expect(c!.reason).toMatch(/live session/);
    expect(c!.reason).toMatch(/resolve it before burning/);
    // Names the blocking session so the drawer/report is actionable.
    expect(c!.reason).toContain('Temper naming');
    expect(c!.reason).toContain('running');
    // A legitimate human question must not feed the "environment may be broken" breaker.
    expect(countsTowardBreaker(c!.failureClass)).toBe(false);
  });

  it('a 409 with no session detail still classifies as a live-session needs-input park', () => {
    const c = classifySpawnRefusal('review', { sid: null, status: 409, error: 'conflict' });
    expect(c!.failureClass).toBe('needs-input');
    expect(c!.stopSessions).toBe(false);
    expect(c!.reason).toMatch(/live session — resolve it before burning/);
  });

  it('400/404 → a deterministic bad state: hard-fail with the real reason, immediate park', () => {
    for (const status of [400, 404] as const) {
      const c = classifySpawnRefusal('implementation', { sid: null, status, error: 'Unknown personaId: nope' });
      expect(c).not.toBeNull();
      expect(c!.failureClass).toBe('hard-fail');
      expect(c!.stopSessions).toBe(true);
      expect(c!.reason).toContain('Unknown personaId: nope');
      expect(c!.reason).not.toMatch(/environment may be broken/);
    }
  });

  it('5xx / transport / unknown → null (transient — keep counting toward MAX_SPAWN_ATTEMPTS)', () => {
    expect(classifySpawnRefusal('implementation', { sid: null, status: 500, error: 'boom' })).toBeNull();
    expect(classifySpawnRefusal('implementation', { sid: null, status: 503 })).toBeNull();
    // Transport-level failure (engine unreachable) — no HTTP status at all.
    expect(classifySpawnRefusal('implementation', { sid: null, error: 'ECONNREFUSED' })).toBeNull();
  });
});
