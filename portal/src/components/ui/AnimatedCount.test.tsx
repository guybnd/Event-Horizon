// @vitest-environment jsdom
// FLUX-1520: the count roll must land exactly on the target after ~400ms, retarget cleanly on a
// mid-roll value change (no stale timer fighting the new one), and snap instantly under the same
// `instant` contract every other portal animation follows (see motion/tokens.test.ts).
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import { appStore } from '../../store/appStore';
import { AnimatedCount } from './AnimatedCount';

const initialState = appStore.getState();

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  appStore.setState(initialState);
});

describe('AnimatedCount (FLUX-1520)', () => {
  it('renders the initial value immediately with no roll', () => {
    appStore.patch({ config: { animationsEnabled: true, animationSpeed: 'normal' } as never });
    const { container } = render(<AnimatedCount value={5} />);
    expect(container.textContent).toBe('5');
  });

  it('rolls through intermediate integers and lands exactly on the target after ~400ms', () => {
    appStore.patch({ config: { animationsEnabled: true, animationSpeed: 'normal' } as never });
    vi.useFakeTimers();
    const { container, rerender } = render(<AnimatedCount value={0} />);
    act(() => rerender(<AnimatedCount value={10} />));

    act(() => vi.advanceTimersByTime(120));
    const mid = Number(container.textContent);
    expect(mid).toBeGreaterThan(0);
    expect(mid).toBeLessThan(10);

    act(() => vi.advanceTimersByTime(400));
    expect(container.textContent).toBe('10');
  });

  it('retargets mid-roll without leaving a stale timer', () => {
    appStore.patch({ config: { animationsEnabled: true, animationSpeed: 'normal' } as never });
    vi.useFakeTimers();
    const { container, rerender } = render(<AnimatedCount value={0} />);
    act(() => rerender(<AnimatedCount value={100} />));
    act(() => vi.advanceTimersByTime(120));

    act(() => rerender(<AnimatedCount value={3} />));
    act(() => vi.advanceTimersByTime(400));
    expect(container.textContent).toBe('3');

    // No leftover timer still pushing toward the abandoned target of 100.
    act(() => vi.advanceTimersByTime(400));
    expect(container.textContent).toBe('3');
  });

  it('snaps instantly with no roll when animationsEnabled is false', () => {
    appStore.patch({ config: { animationsEnabled: false, animationSpeed: 'normal' } as never });
    vi.useFakeTimers();
    const { container, rerender } = render(<AnimatedCount value={0} />);
    act(() => rerender(<AnimatedCount value={42} />));

    expect(container.textContent).toBe('42');
    act(() => vi.advanceTimersByTime(400));
    expect(container.textContent).toBe('42');
  });
});
