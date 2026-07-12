import { useEffect, useRef } from 'react';

/**
 * FLUX-1022: shared Escape-key coordinator. Every overlay that wants "ESC closes/collapses me"
 * registers through this hook instead of adding its own `window` keydown listener. Registrations
 * live on a module-level LIFO stack (last-mounted wins), and a single shared `window` listener
 * (attached only while the stack is non-empty) fires ONLY the top entry per keypress — so a
 * dialog stacked inside a modal closes first, and a second ESC then closes the modal, instead of
 * every open listener eating the same press at once.
 *
 * `ignoreWhenTyping` (default true) makes the entry a no-op while focus is in a text input,
 * textarea, contenteditable, or the xterm terminal body — so typing ESC (clearing a field, vim in
 * the terminal) is never hijacked into a close. Surfaces with their own local ESC-in-input
 * behavior (find bar, inline rename) should keep handling it via their own `onKeyDown` +
 * `stopPropagation` and simply not register this hook.
 */

interface StackEntry {
  onEscape: () => void;
  ignoreWhenTyping: boolean;
}

const stack: StackEntry[] = [];
let listenerAttached = false;

// Input `type`s where the browser accepts free-form keystrokes; everything else (radio, checkbox,
// range, color, file, button, submit, etc.) should let ESC through even when focused.
const TEXT_ENTRY_INPUT_TYPES = new Set([
  'text',
  'search',
  'url',
  'tel',
  'email',
  'password',
  'number',
  'date',
  'datetime-local',
  'month',
  'week',
  'time',
]);

function isTypingElement(el: Element | null): boolean {
  if (!el) return false;
  const tag = el.tagName;
  if (tag === 'TEXTAREA') return true;
  if (tag === 'INPUT') {
    const type = (el as HTMLInputElement).type;
    return TEXT_ENTRY_INPUT_TYPES.has(type);
  }
  if ((el as HTMLElement).isContentEditable) return true;
  return !!el.closest('.xterm');
}

/**
 * FLUX-1314: fire the current top-of-stack handler programmatically, with the exact semantics of a
 * real Escape keydown on `window` (LIFO top-only, ignoreWhenTyping guard included). For Escape
 * presses that physically can't reach the shared window listener — e.g. keydowns inside the
 * sandboxed artifact iframe, which the injected annotator forwards to the host over postMessage.
 * No-op when the stack is empty.
 */
export function triggerEscape(): void {
  const top = stack[stack.length - 1];
  if (!top) return;
  if (top.ignoreWhenTyping && isTypingElement(document.activeElement)) return;
  top.onEscape();
}

function handleGlobalKeyDown(e: KeyboardEvent) {
  if (e.key !== 'Escape') return;
  triggerEscape();
}

function ensureListener() {
  if (listenerAttached) return;
  window.addEventListener('keydown', handleGlobalKeyDown);
  listenerAttached = true;
}

function releaseListenerIfEmpty() {
  if (listenerAttached && stack.length === 0) {
    window.removeEventListener('keydown', handleGlobalKeyDown);
    listenerAttached = false;
  }
}

export function useEscapeKey(
  onEscape: () => void,
  opts?: { enabled?: boolean; ignoreWhenTyping?: boolean },
): void {
  const enabled = opts?.enabled ?? true;
  const ignoreWhenTyping = opts?.ignoreWhenTyping ?? true;

  // Read the latest callback through a ref so the effect below doesn't need `onEscape` as a dep —
  // callers typically pass a fresh inline arrow every render, and re-running the effect on every
  // render would pop and re-push this entry, disturbing the LIFO order of everything above it.
  const onEscapeRef = useRef(onEscape);
  onEscapeRef.current = onEscape;

  useEffect(() => {
    if (!enabled) return;
    const entry: StackEntry = { onEscape: () => onEscapeRef.current(), ignoreWhenTyping };
    stack.push(entry);
    ensureListener();
    return () => {
      const idx = stack.indexOf(entry);
      if (idx !== -1) stack.splice(idx, 1);
      releaseListenerIfEmpty();
    };
  }, [enabled, ignoreWhenTyping]);
}
