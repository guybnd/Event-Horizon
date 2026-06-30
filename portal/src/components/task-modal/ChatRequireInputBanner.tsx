// FLUX-752: a compact, informational "Awaiting your input" strip for the shared chat surface
// (dock + in-modal pane). Mirrors the full-modal RequireInputPrompt header styling but is
// display-only — the reply flows through the existing composer / FLUX-643 quick-reply chips
// below, so there is no textarea, routing dropdown, or send button here. Renders nothing when
// there is no agent question to surface.

import { AlertCircle, ChevronDown, ChevronUp } from 'lucide-react';
import { useLayoutEffect, useRef, useState } from 'react';
import type { Task } from '../../types';
import { latestQuestionText } from './chatQuickReplies';
import { TaskMarkdown } from '../TaskMarkdown';

interface ChatRequireInputBannerProps {
  task: Task;
}

export function ChatRequireInputBanner({ task }: ChatRequireInputBannerProps) {
  const question = latestQuestionText(task);

  // FLUX-896/897: in-place expand/collapse for the question region on the chat surface. Collapsed
  // keeps the compact max-h-40 preview; clicking anywhere in the question (FLUX-897 user request)
  // maximizes it. The maximized view is an OUT-OF-FLOW overlay anchored to the BOTTOM of the
  // question region and grown UPWARD over the transcript — so it can never push down or draw under
  // the composer ("the comment box"): its bottom is fixed above the composer, and its height is
  // measured and capped to the visible chat area above (clip-ancestor top). Collapse is the chevron
  // only — there is deliberately no click-outside-to-collapse, so clicking the composer to type an
  // answer never re-minimizes the question (FLUX-897 follow-up).
  const [expanded, setExpanded] = useState(false);
  const questionRegionRef = useRef<HTMLDivElement>(null);
  const [overlayMaxH, setOverlayMaxH] = useState<number | undefined>(undefined);

  // While expanded, cap the overlay's height to the space between the question region's bottom and
  // the top of its nearest clipping ancestor (the dock chat column / the modal scroll body), so the
  // overlay fills the area above without ever escaping the surface or reaching the composer below.
  useLayoutEffect(() => {
    if (!expanded) {
      setOverlayMaxH(undefined);
      return;
    }
    const region = questionRegionRef.current;
    if (!region) return;

    // Resolve the nearest scroll/clip ancestor once; its top edge is the upward bound.
    let clip: HTMLElement | null = region.parentElement;
    while (clip) {
      const overflowY = getComputedStyle(clip).overflowY;
      if (overflowY === 'auto' || overflowY === 'scroll' || overflowY === 'hidden') break;
      clip = clip.parentElement;
    }

    const measure = () => {
      const node = questionRegionRef.current;
      if (!node) return;
      const rect = node.getBoundingClientRect();
      const clipTop = clip ? clip.getBoundingClientRect().top : 0;
      // 8px breathing room below the clip top; never collapse below a readable minimum.
      setOverlayMaxH(Math.max(140, rect.bottom - clipTop - 8));
    };

    measure();
    window.addEventListener('resize', measure);
    const observer = clip ? new ResizeObserver(measure) : null;
    observer?.observe(clip!);
    return () => {
      window.removeEventListener('resize', measure);
      observer?.disconnect();
    };
  }, [expanded]);

  if (!question) return null;

  return (
    // FLUX-923: this banner is its OWN arrival treatment — it only mounts when the chat enters Require
    // Input, and its bold always-on amber gradient + icon already make a "needs your input" noticeable
    // inline. (Deliberately NOT the violet `eh-prompt-arrival` pulse used by the question picker — a
    // violet ring on the amber banner clashed; the amber prominence is the consistent "new" cue here.)
    <div className="flex items-start gap-3 rounded-xl border border-amber-200 bg-gradient-to-br from-amber-50 to-white p-3 dark:border-amber-500/30 dark:from-amber-900/20 dark:to-[#1a1b23]">
      <div className="rounded-lg bg-amber-100 p-1.5 text-amber-600 dark:bg-amber-500/10 dark:text-amber-300">
        <AlertCircle className="h-4 w-4" />
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-amber-600 dark:text-amber-300">
          Awaiting your input
        </p>
        <div ref={questionRegionRef} className="relative">
          {/* Collapsed preview — also the click target that maximizes the question (FLUX-897). A
              click on a markdown link or while text is selected is ignored, so links and select/copy
              keep working. Stays mounted while expanded as the stable bottom anchor for the overlay
              (it's visually covered by the opaque overlay), so the composer never shifts. */}
          {!expanded && (
            <button
              type="button"
              onClick={() => setExpanded(true)}
              aria-label="Expand question"
              title="Expand question"
              className="absolute right-0 top-0 z-10 rounded-md border border-amber-200 bg-white/90 p-0.5 text-amber-600 shadow-sm transition-colors hover:bg-amber-50 dark:border-amber-500/20 dark:bg-black/40 dark:text-amber-300 dark:hover:bg-white/5"
            >
              <ChevronDown className="h-3.5 w-3.5" />
            </button>
          )}
          <div
            onClick={(event) => {
              if (expanded) return;
              if ((event.target as HTMLElement).closest('a')) return;
              if (window.getSelection()?.toString()) return;
              setExpanded(true);
            }}
            className="mt-1 max-h-40 cursor-pointer overflow-y-auto break-words pr-7 text-sm text-gray-700 dark:text-gray-300"
          >
            <TaskMarkdown body={question} compact imageMode="comment" />
          </div>

          {/* Maximized overlay — anchored to the region's bottom, grown upward, opaque so it covers
              the transcript behind it. Height capped (overlayMaxH) to the visible area above, so it
              is bounded to the comment box: it never extends below this region (above the composer)
              and never escapes the surface top. */}
          {expanded && (
            <div
              className="absolute inset-x-0 bottom-0 z-20 flex flex-col overflow-hidden rounded-lg border border-amber-200 bg-white shadow-xl dark:border-amber-500/30 dark:bg-[#15161d]"
              style={{ maxHeight: overlayMaxH }}
            >
              <button
                type="button"
                onClick={() => setExpanded(false)}
                aria-label="Collapse question"
                title="Collapse question"
                className="absolute right-1 top-1 z-10 rounded-md border border-amber-200 bg-white/90 p-0.5 text-amber-600 shadow-sm transition-colors hover:bg-amber-50 dark:border-amber-500/20 dark:bg-black/40 dark:text-amber-300 dark:hover:bg-white/5"
              >
                <ChevronUp className="h-3.5 w-3.5" />
              </button>
              <div className="overflow-y-auto break-words p-2.5 pr-8 text-sm text-gray-700 dark:text-gray-300">
                <TaskMarkdown body={question} compact imageMode="comment" />
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
