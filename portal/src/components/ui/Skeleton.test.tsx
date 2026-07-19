// @vitest-environment jsdom
// FLUX-1506: the shared skeleton primitive must degrade its shimmer to a static placeholder when
// motion is off (either the user's animationsEnabled=false or OS prefers-reduced-motion) — the same
// `instant` contract every other portal animation follows (see motion/tokens.test.ts).
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { appStore } from '../../store/appStore';
import { Skeleton, SkeletonRow } from './Skeleton';

const initialState = appStore.getState();

afterEach(() => {
  cleanup();
  appStore.setState(initialState);
});

describe('Skeleton (FLUX-1506)', () => {
  it('animates the shimmer when motion is enabled', () => {
    appStore.patch({ config: { animationsEnabled: true, animationSpeed: 'normal' } as never });
    const { container } = render(<Skeleton className="h-4 w-1/2" />);
    expect(container.firstElementChild!.className).toContain('animate-pulse');
  });

  it('degrades to a static placeholder when animationsEnabled is false', () => {
    appStore.patch({ config: { animationsEnabled: false, animationSpeed: 'normal' } as never });
    const { container } = render(<Skeleton className="h-4 w-1/2" />);
    expect(container.firstElementChild!.className).not.toContain('animate-pulse');
  });

  it('never pulses the card-variant frame itself, only bars/avatars composed inside it', () => {
    appStore.patch({ config: { animationsEnabled: true, animationSpeed: 'normal' } as never });
    const { container } = render(
      <Skeleton variant="card">
        <Skeleton variant="bar" className="h-4 w-1/2" />
      </Skeleton>,
    );
    const frame = container.firstElementChild!;
    expect(frame.className).not.toContain('animate-pulse');
    expect((frame.firstElementChild as HTMLElement).className).toContain('animate-pulse');
  });

  it('SkeletonRow composes an avatar dot + two bars', () => {
    const { container } = render(<SkeletonRow />);
    expect(container.querySelectorAll('.rounded-full').length).toBe(1);
    expect(container.querySelectorAll('.rounded').length).toBeGreaterThanOrEqual(2);
  });
});
