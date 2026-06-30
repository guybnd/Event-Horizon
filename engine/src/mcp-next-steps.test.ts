import { describe, it, expect } from 'vitest';
import { nextStepForStatus } from './mcp-server.js';

/**
 * FLUX-877: AXI #9 contextual disclosure. `nextStepForStatus` is factored out of the
 * `change_status` MCP handler so the status-aware next-step hint can be exercised as a
 * pure function (mirrors the `evaluateWorktreeReadyRefusal` / `describeEmptyTicketList` idiom).
 */
describe('nextStepForStatus (FLUX-877 contextual next-step hints)', () => {
  const opts = { readyStatus: 'Ready', requireInputStatus: 'Require Input' };

  it('points Ready at finish_ticket', () => {
    const h = nextStepForStatus('Ready', opts);
    expect(h).toContain('finish_ticket');
  });

  it('points In Progress at log_progress and names the configured Ready/Require-Input labels', () => {
    const h = nextStepForStatus('In Progress', opts);
    expect(h).toContain('log_progress');
    expect(h).toContain('Ready');
    expect(h).toContain('Require Input');
  });

  it('points Todo at start_session', () => {
    expect(nextStepForStatus('Todo', opts)).toContain('start_session');
  });

  it('points Grooming at update_ticket', () => {
    expect(nextStepForStatus('Grooming', opts)).toContain('update_ticket');
  });

  it('matches status case-insensitively', () => {
    expect(nextStepForStatus('in progress', opts)).toContain('log_progress');
  });

  it('returns no hint for terminal/unknown statuses', () => {
    expect(nextStepForStatus('Done', opts)).toBe('');
    expect(nextStepForStatus('Archived', opts)).toBe('');
    expect(nextStepForStatus('Backlog', opts)).toBe('');
  });

  it('honors a custom Ready label (config-driven)', () => {
    const h = nextStepForStatus('Shipped', { readyStatus: 'Shipped', requireInputStatus: 'Blocked' });
    expect(h).toContain('finish_ticket');
  });

  // FLUX-889: the Ready compare is case-insensitive like the switch below it, so a
  // lowercase 'ready' yields the finish_ticket hint instead of falling through to ''.
  it('matches the Ready label case-insensitively', () => {
    const h = nextStepForStatus('ready', opts);
    expect(h).toContain('finish_ticket');
  });

  // FLUX-889: the Todo / Grooming hints interpolate the configured target labels rather
  // than hardcoding 'In Progress' / 'Todo', so a renamed board never names a dead status.
  it('names the configured In-Progress target in the Todo hint', () => {
    const h = nextStepForStatus('Todo', { ...opts, inProgressStatus: 'Doing' });
    expect(h).toContain('Doing');
    expect(h).not.toContain('In Progress');
  });

  it('names the configured Todo target in the Grooming hint', () => {
    const h = nextStepForStatus('Grooming', { ...opts, todoStatus: 'Backlog' });
    expect(h).toContain('Backlog');
  });

  it('defaults the In-Progress / Todo targets to canonical names when unset', () => {
    expect(nextStepForStatus('Todo', opts)).toContain('In Progress');
    expect(nextStepForStatus('Grooming', opts)).toContain('Todo');
  });
});
