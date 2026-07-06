// @vitest-environment jsdom
import { useRef } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, fireEvent } from '@testing-library/react';
import { useFocusTrap } from './useFocusTrap';

afterEach(cleanup);

function Trap({ onClose, active = true }: { onClose: () => void; active?: boolean }) {
  const ref = useRef<HTMLDivElement | null>(null);
  useFocusTrap(ref, { onClose, active });
  return (
    <div ref={ref} data-testid="trap">
      <button type="button">inside</button>
    </div>
  );
}

// FLUX-1118: FloatingPanel has no backdrop, so a user can click plain page content while it's
// open, moving focus outside its trap container without any other trap taking over. Escape
// should still close it in that case — only a genuinely different, concurrently-mounted trap
// holding focus should withhold onClose.
describe('useFocusTrap Escape scoping (FLUX-1118)', () => {
  it('closes when focus is inside the trap container', () => {
    const onClose = vi.fn();
    const { getByText } = render(<Trap onClose={onClose} />);
    getByText('inside').focus();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('still closes when focus has drifted to plain page content outside the container', () => {
    const onClose = vi.fn();
    const outside = document.createElement('button');
    outside.textContent = 'outside';
    document.body.appendChild(outside);
    render(<Trap onClose={onClose} />);

    outside.focus();
    expect(document.activeElement).toBe(outside);

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);

    outside.remove();
  });

  it('withholds onClose when a different, concurrently-mounted trap currently owns focus', () => {
    const onCloseA = vi.fn();
    const onCloseB = vi.fn();

    function TwoTraps() {
      const refA = useRef<HTMLDivElement | null>(null);
      const refB = useRef<HTMLDivElement | null>(null);
      useFocusTrap(refA, { onClose: onCloseA });
      useFocusTrap(refB, { onClose: onCloseB });
      return (
        <>
          <div ref={refA} data-testid="a">
            <button type="button">a-inside</button>
          </div>
          <div ref={refB} data-testid="b">
            <button type="button">b-inside</button>
          </div>
        </>
      );
    }

    const { getByText } = render(<TwoTraps />);
    // Trap B mounted last, so it's on top of the shared Escape stack — but focus is inside A.
    getByText('a-inside').focus();
    fireEvent.keyDown(window, { key: 'Escape' });

    expect(onCloseB).not.toHaveBeenCalled();
    expect(onCloseA).not.toHaveBeenCalled();
  });
});
