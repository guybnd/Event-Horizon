// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ToastProvider, useNotify } from './useNotify';

afterEach(cleanup);

function Harness() {
  const notify = useNotify();
  return (
    <div>
      <button onClick={() => notify.success('Saved')}>Success</button>
      <button onClick={() => notify.error('Failed')}>Error</button>
      <button onClick={() => notify.info('Heads up')}>Info</button>
    </div>
  );
}

function renderHarness() {
  return render(
    <ToastProvider>
      <Harness />
    </ToastProvider>,
  );
}

describe('useNotify', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('renders a toast for success/error/info', () => {
    renderHarness();
    fireEvent.click(screen.getByText('Success'));
    expect(screen.getByText('Saved')).toBeTruthy();
    fireEvent.click(screen.getByText('Error'));
    expect(screen.getByText('Failed')).toBeTruthy();
    fireEvent.click(screen.getByText('Info'));
    expect(screen.getByText('Heads up')).toBeTruthy();
  });

  it('stacks multiple toasts at once', () => {
    renderHarness();
    fireEvent.click(screen.getByText('Success'));
    fireEvent.click(screen.getByText('Error'));
    expect(screen.getByText('Saved')).toBeTruthy();
    expect(screen.getByText('Failed')).toBeTruthy();
  });

  it('auto-dismisses after ~3s', () => {
    renderHarness();
    fireEvent.click(screen.getByText('Success'));
    expect(screen.getByText('Saved')).toBeTruthy();
    act(() => { vi.advanceTimersByTime(3000); });
    expect(screen.queryByText('Saved')).toBeNull();
  });

  it('dismisses on manual close click', () => {
    renderHarness();
    fireEvent.click(screen.getByText('Success'));
    expect(screen.getByText('Saved')).toBeTruthy();
    fireEvent.click(screen.getByLabelText('Dismiss'));
    expect(screen.queryByText('Saved')).toBeNull();
  });

  it('throws when used outside a ToastProvider', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => render(<Harness />)).toThrow(/ToastProvider/);
    consoleError.mockRestore();
  });
});
