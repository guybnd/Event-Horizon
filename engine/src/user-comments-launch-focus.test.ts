import { describe, it, expect } from 'vitest';
import { isAgentAuthor, extractRecentUserComments, extractLaunchFocus } from './history.js';

// FLUX-480: recent user comments must never fall out of the agent's view just
// because they aged past the history window, and the launch focus must persist
// across sessions.

describe('isAgentAuthor', () => {
  it('treats the canonical "Agent" marker as an agent', () => {
    expect(isAgentAuthor('Agent')).toBe(true);
  });

  it('treats model / framework display names as agents', () => {
    expect(isAgentAuthor('Claude (Opus 4.8)')).toBe(true);
    expect(isAgentAuthor('Claude Code')).toBe(true);
    expect(isAgentAuthor('Copilot')).toBe(true);
    expect(isAgentAuthor('Gemini')).toBe(true);
  });

  it('treats human author names as users', () => {
    expect(isAgentAuthor('guybnd')).toBe(false);
    expect(isAgentAuthor('Guy')).toBe(false);
  });

  it('biases unknown/empty authors toward user (never drop user intent)', () => {
    expect(isAgentAuthor('')).toBe(false);
    expect(isAgentAuthor(undefined)).toBe(false);
    expect(isAgentAuthor(null)).toBe(false);
  });
});

function userComment(text: string, n: number) {
  const date = `2026-06-01T10:${String(n).padStart(2, '0')}:00.000Z`;
  return { type: 'comment', user: 'guybnd', comment: text, date, id: `c-${date}` };
}
function agentComment(text: string, n: number) {
  const date = `2026-06-01T11:${String(n).padStart(2, '0')}:00.000Z`;
  return { type: 'comment', user: 'Agent', comment: text, date, id: `a-${date}` };
}

describe('extractRecentUserComments', () => {
  it('returns the last N user-authored comments', () => {
    const history = [userComment('first', 0), userComment('second', 1), userComment('third', 2)];
    const out = extractRecentUserComments(history, 2);
    expect(out.map((c) => c.comment)).toEqual(['second', 'third']);
  });

  it('surfaces a user comment that fell outside the 20-entry window', () => {
    // user comment at position 0, then 30 agent entries after it
    const history = [
      userComment('this did not work', 0),
      ...Array.from({ length: 30 }, (_, i) => agentComment(`agent note ${i}`, i)),
    ];
    const out = extractRecentUserComments(history, 3);
    expect(out).toHaveLength(1);
    expect(out[0]!.comment).toBe('this did not work');
  });

  it('excludes agent-authored comments', () => {
    const history = [userComment('real', 0), agentComment('noise', 0)];
    const out = extractRecentUserComments(history, 3);
    expect(out.map((c) => c.comment)).toEqual(['real']);
  });

  it('returns nothing when limit is 0', () => {
    expect(extractRecentUserComments([userComment('x', 0)], 0)).toEqual([]);
  });
});

describe('extractLaunchFocus', () => {
  it('returns the most recent persisted launch focus', () => {
    const history = [
      { type: 'activity', user: 'User', date: '2026-06-01T09:00:00.000Z', comment: '🎯 Launch focus: old', launchFocus: 'old' },
      { type: 'comment', user: 'guybnd', date: '2026-06-01T09:30:00.000Z', comment: 'unrelated' },
      { type: 'activity', user: 'User', date: '2026-06-01T10:00:00.000Z', comment: '🎯 Launch focus: newest', launchFocus: 'newest' },
    ];
    expect(extractLaunchFocus(history)).toEqual({ launchFocus: 'newest', date: '2026-06-01T10:00:00.000Z' });
  });

  it('returns undefined when no entry carries a launchFocus', () => {
    expect(extractLaunchFocus([userComment('x', 0)])).toBeUndefined();
  });

  it('ignores blank launchFocus values', () => {
    const history = [{ type: 'activity', user: 'User', date: 'd', comment: 'x', launchFocus: '   ' }];
    expect(extractLaunchFocus(history)).toBeUndefined();
  });
});
