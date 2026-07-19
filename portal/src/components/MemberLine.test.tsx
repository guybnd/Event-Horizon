// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { MemberStateStrip, MemberLine } from './MemberLine';
import type { Task } from '../types';

// FLUX-1503 review fix: `CardSubtaskProgress` and `EpicGhostCard` render `MemberStateStrip`
// INSIDE their own parent <button>, never passing `onSegmentClick` — a strip segment that is
// itself a <button> there produces invalid `<button>`-in-`<button>` HTML (a React hydration
// warning) plus empty focusable tab stops. Guards that segments degrade to a non-interactive
// element when no click handler is supplied, and stay a real <button> when one is (PrDeckCard).

afterEach(() => cleanup());

function makeTask(id: string): Task {
  return { id, title: id, status: 'In Progress' } as Task;
}

describe('MemberStateStrip segment nesting', () => {
  it('renders non-button segments when onSegmentClick is omitted, even nested in a parent <button>', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { container } = render(
      <button type="button">
        <MemberStateStrip members={[{ task: makeTask('FLUX-1') }, { task: makeTask('FLUX-2') }]} />
      </button>,
    );

    expect(container.querySelectorAll('button')).toHaveLength(1);
    expect(container.querySelectorAll('button button')).toHaveLength(0);
    const nestingWarning = errorSpy.mock.calls.some((args) =>
      String(args[0]).includes('cannot be a descendant of'),
    );
    expect(nestingWarning).toBe(false);
    errorSpy.mockRestore();
  });

  it('renders interactive <button> segments when onSegmentClick is supplied', () => {
    const onSegmentClick = vi.fn();
    const { container } = render(
      <div>
        <MemberStateStrip members={[{ task: makeTask('FLUX-1') }]} onSegmentClick={onSegmentClick} />
      </div>,
    );
    expect(container.querySelectorAll('button')).toHaveLength(1);
  });
});

// FLUX-1532: the collapsed line must always show the ticket's real title — never the bare harness
// spinner verb (`currentActivity`, e.g. "Thinking"/"Working") that used to replace it.
describe('MemberLine collapsed line text (FLUX-1532)', () => {
  function makeLiveTask(overrides: Partial<Task> & { id: string; status: string }): Task {
    return { title: `${overrides.id} real title`, ...overrides } as Task;
  }

  it('shows the ticket title, not the persisted cliSession activity verb', () => {
    const task = makeLiveTask({
      id: 'FLUX-1',
      status: 'In Progress',
      cliSession: { status: 'running', currentActivity: 'Working' } as Task['cliSession'],
    });
    render(<MemberLine task={task} />);
    expect(screen.getByText('FLUX-1 real title')).toBeTruthy();
    expect(screen.queryByText('Working')).toBeNull();
  });

  it('puts the live activity in the tooltip alongside the title while a session is live', () => {
    const task = makeLiveTask({
      id: 'FLUX-1',
      status: 'In Progress',
      cliSession: { status: 'running', currentActivity: 'Working', phase: 'implementation' } as Task['cliSession'],
    });
    const { container } = render(<MemberLine task={task} />);
    const button = container.querySelector('button')!;
    expect(button.getAttribute('title')).toContain('FLUX-1 real title');
    expect(button.getAttribute('title')).toContain('Working');
  });

  it('never leaks a finished session activity into the tooltip once the ticket is done', () => {
    const task = makeLiveTask({
      id: 'FLUX-1',
      status: 'Done',
      cliSession: { status: 'completed', currentActivity: 'Working' } as Task['cliSession'],
    });
    render(<MemberLine task={task} />);
    const button = screen.getByTitle(/FLUX-1 real title/);
    expect(button.getAttribute('title')).not.toContain('Working');
  });
});
