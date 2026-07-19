import { describe, expect, it } from 'vitest';
import { isLaunchFailureNotification } from './notificationCategory';
import type { Notification } from '../api';

// FLUX-1486: guards the message-shape predicate that decides whether a `prompt` notification
// gets the focus-independent in-portal toast. The predicate is coupled to the literal
// "session failed to start" substring the engine emits in `raiseNeedsAction`
// (engine/src/routes/cli-session.ts) — this test is the cheapest tripwire if that string drifts.
function makeNotification(overrides: Partial<Notification>): Notification {
  return {
    id: 'n1',
    type: 'prompt',
    title: 'Needs action',
    message: 'something happened',
    actions: [],
    createdAt: new Date(0).toISOString(),
    read: false,
    dismissed: false,
    ...overrides,
  };
}

describe('isLaunchFailureNotification', () => {
  it('matches a prompt notification with the launch-failure message shape', () => {
    const n = makeNotification({
      type: 'prompt',
      message: 'Claude Code session failed to start: worktree already exists',
    });
    expect(isLaunchFailureNotification(n)).toBe(true);
  });

  it('does not match a plain prompt notification', () => {
    const n = makeNotification({ type: 'prompt', message: 'Ticket FLUX-1 needs your input' });
    expect(isLaunchFailureNotification(n)).toBe(false);
  });

  it('does not match a non-prompt notification even with the failure message', () => {
    const n = makeNotification({
      type: 'error',
      message: 'Claude Code session failed to start: pool full',
    });
    expect(isLaunchFailureNotification(n)).toBe(false);
  });
});
