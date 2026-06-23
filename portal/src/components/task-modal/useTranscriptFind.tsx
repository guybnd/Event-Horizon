// FLUX-686: in-transcript find. Kept in its own module (rather than inline in the already-large,
// high-contention ChatView) so the chat surface only has to import a hook + a bar.
//
// Highlighting uses the **CSS Custom Highlight API** (`CSS.highlights` + the `::highlight()` rules
// in index.css): we compute Ranges from the live DOM text nodes under the scroll container and
// register them as highlights, with **zero DOM mutation**. That's the key property — it never
// fights React's render of the markdown turns, and costs nothing on the render path. Recompute is
// debounced and the match count is capped so a 1-char query over a giant transcript stays cheap.
// On browsers without the API (older / jsdom) highlighting silently no-ops but next/prev scroll
// navigation still works.

import { useCallback, useEffect, useRef, useState } from 'react';
import type { TranscriptMessage } from '../../api';

const HIGHLIGHT_ALL = 'eh-find';
const HIGHLIGHT_ACTIVE = 'eh-find-active';
/** Cap matches so a pathological short query (e.g. a single letter) can't build tens of thousands
 *  of Ranges. The bar shows the cap as the count; navigation cycles within it. */
const MAX_MATCHES = 500;
/** Debounce the (DOM-walking) recompute so a fast typist doesn't re-walk per keystroke. */
const RECOMPUTE_MS = 120;

const highlightsSupported = (): boolean => typeof CSS !== 'undefined' && 'highlights' in CSS;

function clearHighlights() {
  if (!highlightsSupported()) return;
  CSS.highlights.delete(HIGHLIGHT_ALL);
  CSS.highlights.delete(HIGHLIGHT_ACTIVE);
}

/**
 * Walk visible text nodes under `root` and return a Range for every case-insensitive occurrence
 * of `query` (matches don't span node boundaries — good enough for transcript prose). Stops at
 * MAX_MATCHES. Whitespace-only text nodes are skipped.
 */
function collectRanges(root: HTMLElement, query: string): Range[] {
  const needle = query.toLowerCase();
  if (!needle) return [];
  const ranges: Range[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) =>
      node.nodeValue && node.nodeValue.trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT,
  });
  let node = walker.nextNode();
  while (node && ranges.length < MAX_MATCHES) {
    const hay = node.nodeValue!.toLowerCase();
    let from = hay.indexOf(needle);
    while (from !== -1 && ranges.length < MAX_MATCHES) {
      const range = document.createRange();
      range.setStart(node, from);
      range.setEnd(node, from + needle.length);
      ranges.push(range);
      from = hay.indexOf(needle, from + needle.length);
    }
    node = walker.nextNode();
  }
  return ranges;
}

export interface TranscriptFind {
  open: boolean;
  setOpen: (v: boolean) => void;
  query: string;
  setQuery: (v: string) => void;
  count: number;
  /** 0-based index of the focused match (display as `active + 1`). */
  active: number;
  close: () => void;
  next: () => void;
  prev: () => void;
}

/**
 * Find state machine for a single scroll container. `messages` is a dependency so matches recompute
 * as the transcript streams/changes while find is open.
 *
 * Caveat: highlight registry names are document-global, so two find bars open at once (modal chat +
 * a dock window) would share `eh-find` — an extreme edge; opening one recomputes/clears the shared
 * highlight. One bar at a time is the norm.
 */
export function useTranscriptFind(
  scrollRef: React.RefObject<HTMLDivElement | null>,
  messages: TranscriptMessage[],
): TranscriptFind {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [count, setCount] = useState(0);
  const [active, setActive] = useState(0);
  // Bumped on every recompute so the "paint + scroll active match" effect re-runs even when the
  // match count is unchanged but the underlying Ranges are fresh objects.
  const [version, setVersion] = useState(0);
  const rangesRef = useRef<Range[]>([]);

  // (Re)compute matches — debounced — whenever the query, open state, or transcript changes.
  useEffect(() => {
    if (!open || !query) {
      rangesRef.current = [];
      setCount(0);
      setActive(0);
      clearHighlights();
      return;
    }
    const handle = window.setTimeout(() => {
      const container = scrollRef.current;
      if (!container) return;
      const ranges = collectRanges(container, query);
      rangesRef.current = ranges;
      setCount(ranges.length);
      setActive((prev) => (ranges.length ? Math.min(prev, ranges.length - 1) : 0));
      if (highlightsSupported()) {
        if (ranges.length) CSS.highlights.set(HIGHLIGHT_ALL, new Highlight(...ranges));
        else CSS.highlights.delete(HIGHLIGHT_ALL);
      }
      setVersion((v) => v + 1);
    }, RECOMPUTE_MS);
    return () => window.clearTimeout(handle);
  }, [open, query, messages, scrollRef]);

  // Paint the focused match distinctly and scroll it to the middle of the scroll container (which
  // reuses the FLUX-644 scroll region — the existing onScroll keeps jump-to-bottom state honest).
  useEffect(() => {
    if (!open) return;
    const ranges = rangesRef.current;
    const range = ranges[Math.min(active, ranges.length - 1)];
    if (!range) {
      if (highlightsSupported()) CSS.highlights.delete(HIGHLIGHT_ACTIVE);
      return;
    }
    if (highlightsSupported()) CSS.highlights.set(HIGHLIGHT_ACTIVE, new Highlight(range));
    const container = scrollRef.current;
    if (container) {
      const r = range.getBoundingClientRect();
      const c = container.getBoundingClientRect();
      if (r.height || r.width) {
        container.scrollTop += r.top - c.top - container.clientHeight / 2 + r.height / 2;
      }
    }
  }, [active, version, open, scrollRef]);

  // Tidy the document-global highlights when the bar unmounts.
  useEffect(() => () => clearHighlights(), []);

  const close = useCallback(() => {
    setOpen(false);
    setQuery('');
  }, []);

  const step = useCallback((dir: 1 | -1) => {
    setActive((prev) => {
      const n = rangesRef.current.length;
      return n ? (prev + dir + n) % n : 0;
    });
  }, []);

  const next = useCallback(() => step(1), [step]);
  const prev = useCallback(() => step(-1), [step]);

  return { open, setOpen, query, setQuery, count, active, close, next, prev };
}
