import { describe, it, expect } from 'vitest';
import { describeEmptyTicketList } from './mcp-server.js';

/**
 * FLUX-878: AXI #5 definitive empty states. `describeEmptyTicketList` is factored out
 * of the `list_tickets` MCP handler so the filter-echoing zero-result note can be
 * exercised as a pure function (mirrors the `evaluateWorktreeReadyRefusal` idiom).
 */
describe('describeEmptyTicketList (FLUX-878 definitive empty states)', () => {
  it('reports an empty board when no filters are active', () => {
    expect(describeEmptyTicketList({})).toBe('No tickets on the board yet.');
  });

  it('echoes a single active filter', () => {
    expect(describeEmptyTicketList({ status: 'Done' })).toBe('No tickets match status=Done.');
  });

  it('echoes every active filter, in field order, comma-joined', () => {
    expect(
      describeEmptyTicketList({ status: 'Done', assignee: 'guy', tag: 'mcp', priority: 'High' }),
    ).toBe('No tickets match status=Done, assignee=guy, tag=mcp, priority=High.');
  });

  it('omits filters that were not supplied', () => {
    expect(describeEmptyTicketList({ tag: 'agent-experience' })).toBe(
      'No tickets match tag=agent-experience.',
    );
  });

  it('treats empty-string filters as inactive (not echoed)', () => {
    expect(describeEmptyTicketList({ status: '', priority: 'Low' })).toBe(
      'No tickets match priority=Low.',
    );
  });
});
