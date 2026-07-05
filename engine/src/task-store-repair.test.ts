import { describe, it, expect } from 'vitest';
import { repairTicket } from './task-store.js';
import { validateTicketFrontmatter } from './schema.js';

/**
 * FLUX-1076 regression guard. A conflicted flux-data merge left tickets with corrupt
 * frontmatter; repairTicket recovered a title from the filename but had no equivalent
 * for a missing/invalid status, and validateTicketFrontmatter didn't even flag a missing
 * status as an error — so the ticket landed in tasksCache with status: undefined, which
 * crashed the portal's column lookup. Both gaps are pinned here.
 */
describe('validateTicketFrontmatter requires a status (FLUX-1076)', () => {
  it('flags a completely missing status', () => {
    const errors = validateTicketFrontmatter({ title: 'A ticket' });
    expect(errors.some((e) => e.path === 'status')).toBe(true);
  });

  it('flags an empty-string status', () => {
    const errors = validateTicketFrontmatter({ title: 'A ticket', status: '' });
    expect(errors.some((e) => e.path === 'status')).toBe(true);
  });

  it('accepts a non-empty status', () => {
    const errors = validateTicketFrontmatter({ title: 'A ticket', status: 'Todo' });
    expect(errors.some((e) => e.path === 'status')).toBe(false);
  });
});

describe('repairTicket recovers a missing/invalid status (FLUX-1076)', () => {
  it('defaults a missing status to "Todo" and reports the repair', () => {
    const frontmatter: Record<string, unknown> = { title: 'A ticket' };
    const repairs = repairTicket(frontmatter, '/store/FLUX-1.md');

    expect(frontmatter.status).toBe('Todo');
    expect(repairs.some((r) => r.includes('status'))).toBe(true);
  });

  it('defaults a blank status to "Todo"', () => {
    const frontmatter: Record<string, unknown> = { title: 'A ticket', status: '   ' };
    repairTicket(frontmatter, '/store/FLUX-1.md');

    expect(frontmatter.status).toBe('Todo');
  });

  it('recovers both a missing title and a missing status together (the FLUX-1076 incident shape)', () => {
    const frontmatter: Record<string, unknown> = {};
    const repairs = repairTicket(frontmatter, '/store/FLUX-42.md');

    expect(frontmatter.title).toBe('FLUX-42 (recovered)');
    expect(frontmatter.status).toBe('Todo');
    // The repaired frontmatter must pass validation — no more status: undefined stubs.
    expect(validateTicketFrontmatter(frontmatter)).toEqual([]);
    expect(repairs.length).toBeGreaterThanOrEqual(2);
  });

  it('leaves a valid status untouched', () => {
    const frontmatter: Record<string, unknown> = { title: 'A ticket', status: 'In Progress' };
    const repairs = repairTicket(frontmatter, '/store/FLUX-1.md');

    expect(frontmatter.status).toBe('In Progress');
    expect(repairs.some((r) => r.includes('status'))).toBe(false);
  });
});
