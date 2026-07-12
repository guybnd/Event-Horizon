// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, renderHook } from '@testing-library/react';
import { triggerEscape, useEscapeKey } from './useEscapeKey';

function pressEscape() {
  fireEvent.keyDown(window, { key: 'Escape' });
}

function mountFocusable(tag: 'input' | 'textarea', type?: string): HTMLElement {
  const el = document.createElement(tag);
  if (tag === 'input' && type) (el as HTMLInputElement).type = type;
  document.body.appendChild(el);
  el.focus();
  return el;
}

afterEach(() => {
  cleanup();
  document.body.innerHTML = '';
});

describe('useEscapeKey', () => {
  it('fires onEscape on an Escape keydown', () => {
    const onEscape = vi.fn();
    renderHook(() => useEscapeKey(onEscape));

    pressEscape();

    expect(onEscape).toHaveBeenCalledTimes(1);
  });

  it('ignores non-Escape keys', () => {
    const onEscape = vi.fn();
    renderHook(() => useEscapeKey(onEscape));

    fireEvent.keyDown(window, { key: 'Enter' });

    expect(onEscape).not.toHaveBeenCalled();
  });

  describe('LIFO stack ordering', () => {
    it('fires only the most-recently-mounted handler when overlays are nested', () => {
      const outer = vi.fn();
      const inner = vi.fn();
      renderHook(() => useEscapeKey(outer));
      renderHook(() => useEscapeKey(inner));

      pressEscape();

      expect(inner).toHaveBeenCalledTimes(1);
      expect(outer).not.toHaveBeenCalled();
    });

    it('falls through to the next entry once the top one unmounts', () => {
      const outer = vi.fn();
      const inner = vi.fn();
      renderHook(() => useEscapeKey(outer));
      const { unmount: unmountInner } = renderHook(() => useEscapeKey(inner));

      unmountInner();
      pressEscape();

      expect(outer).toHaveBeenCalledTimes(1);
      expect(inner).not.toHaveBeenCalled();
    });

    it('keeps top-of-stack correct when a non-top entry unmounts', () => {
      const bottom = vi.fn();
      const middle = vi.fn();
      const top = vi.fn();
      renderHook(() => useEscapeKey(bottom));
      const { unmount: unmountMiddle } = renderHook(() => useEscapeKey(middle));
      renderHook(() => useEscapeKey(top));

      unmountMiddle();
      pressEscape();

      expect(top).toHaveBeenCalledTimes(1);
      expect(middle).not.toHaveBeenCalled();
      expect(bottom).not.toHaveBeenCalled();
    });
  });

  describe('ignoreWhenTyping guard', () => {
    it('defaults to suppressing Escape while a text input is focused', () => {
      const onEscape = vi.fn();
      mountFocusable('input', 'text');
      renderHook(() => useEscapeKey(onEscape));

      pressEscape();

      expect(onEscape).not.toHaveBeenCalled();
    });

    it('defaults to suppressing Escape while a textarea is focused', () => {
      const onEscape = vi.fn();
      mountFocusable('textarea');
      renderHook(() => useEscapeKey(onEscape));

      pressEscape();

      expect(onEscape).not.toHaveBeenCalled();
    });

    it('does not suppress Escape when focus is on a non-text input (e.g. radio)', () => {
      const onEscape = vi.fn();
      mountFocusable('input', 'radio');
      renderHook(() => useEscapeKey(onEscape));

      pressEscape();

      expect(onEscape).toHaveBeenCalledTimes(1);
    });

    it('fires even while typing when ignoreWhenTyping is explicitly false', () => {
      const onEscape = vi.fn();
      mountFocusable('input', 'text');
      renderHook(() => useEscapeKey(onEscape, { ignoreWhenTyping: false }));

      pressEscape();

      expect(onEscape).toHaveBeenCalledTimes(1);
    });

    it('fires once focus leaves the text field', () => {
      const onEscape = vi.fn();
      const input = mountFocusable('input', 'text');
      renderHook(() => useEscapeKey(onEscape));

      input.blur();
      pressEscape();

      expect(onEscape).toHaveBeenCalledTimes(1);
    });
  });

  describe('enabled toggling', () => {
    it('does not register on the stack while enabled is false', () => {
      const onEscape = vi.fn();
      renderHook(() => useEscapeKey(onEscape, { enabled: false }));

      pressEscape();

      expect(onEscape).not.toHaveBeenCalled();
    });

    it('registers and unregisters as enabled flips at runtime', () => {
      const onEscape = vi.fn();
      const { rerender } = renderHook(({ enabled }) => useEscapeKey(onEscape, { enabled }), {
        initialProps: { enabled: false },
      });

      pressEscape();
      expect(onEscape).not.toHaveBeenCalled();

      rerender({ enabled: true });
      pressEscape();
      expect(onEscape).toHaveBeenCalledTimes(1);

      rerender({ enabled: false });
      pressEscape();
      expect(onEscape).toHaveBeenCalledTimes(1); // unchanged — no longer registered
    });
  });

  it('always calls the latest onEscape callback without disturbing stack order on re-render', () => {
    const first = vi.fn();
    const second = vi.fn();
    const { rerender } = renderHook(({ cb }) => useEscapeKey(cb), {
      initialProps: { cb: first },
    });

    rerender({ cb: second });
    pressEscape();

    expect(second).toHaveBeenCalledTimes(1);
    expect(first).not.toHaveBeenCalled();
  });

  it('is a no-op (does not throw) once every consumer has unmounted', () => {
    const onEscape = vi.fn();
    const { unmount } = renderHook(() => useEscapeKey(onEscape));

    unmount();

    expect(() => pressEscape()).not.toThrow();
    expect(onEscape).not.toHaveBeenCalled();
  });

  // FLUX-1314: Escape presses that can't physically reach the window listener (e.g. keydowns inside
  // the sandboxed artifact iframe, forwarded to the host over postMessage) fire the stack via this
  // programmatic entry point — same semantics as a real keydown.
  describe('triggerEscape', () => {
    it('fires only the top-of-stack handler, same LIFO semantics as a real keydown', () => {
      const outer = vi.fn();
      const inner = vi.fn();
      renderHook(() => useEscapeKey(outer));
      renderHook(() => useEscapeKey(inner));

      triggerEscape();

      expect(inner).toHaveBeenCalledTimes(1);
      expect(outer).not.toHaveBeenCalled();
    });

    it('is a no-op (does not throw) when the stack is empty', () => {
      expect(() => triggerEscape()).not.toThrow();
    });

    it('respects the ignoreWhenTyping guard like a real keydown', () => {
      const onEscape = vi.fn();
      mountFocusable('input', 'text');
      renderHook(() => useEscapeKey(onEscape));

      triggerEscape();

      expect(onEscape).not.toHaveBeenCalled();
    });
  });
});
