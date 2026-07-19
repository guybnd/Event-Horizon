// @vitest-environment jsdom
import { useState } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { appStore } from '../store/appStore';
import { KeepAliveView } from './KeepAliveView';

// FLUX-1524: KeepAliveView must keep children mounted (not remount them) across an
// active -> inactive -> active round-trip, so a wrapped view's scroll/selection state
// survives switching away and back — and it must render nothing before first activation.

function Counter() {
  const [count] = useState(() => Math.random());
  return <div data-testid="counter">{count}</div>;
}

describe('KeepAliveView', () => {
  afterEach(() => {
    cleanup();
  });

  it('renders nothing before the first activation', () => {
    const { container } = render(
      <KeepAliveView active={false}>
        <Counter />
      </KeepAliveView>,
    );
    expect(container.querySelector('[data-testid="counter"]')).toBeNull();
  });

  it('keeps the child mounted (no state reset) across active -> inactive -> active', () => {
    appStore.patch({ config: undefined });

    const { rerender } = render(
      <KeepAliveView active={true}>
        <Counter />
      </KeepAliveView>,
    );
    const initialValue = screen.getByTestId('counter').textContent;
    expect(initialValue).toBeTruthy();

    rerender(
      <KeepAliveView active={false}>
        <Counter />
      </KeepAliveView>,
    );
    // Still mounted (hidden via CSS, not unmounted) — same value as before.
    expect(screen.getByTestId('counter').textContent).toBe(initialValue);

    rerender(
      <KeepAliveView active={true}>
        <Counter />
      </KeepAliveView>,
    );
    expect(screen.getByTestId('counter').textContent).toBe(initialValue);
  });
});
