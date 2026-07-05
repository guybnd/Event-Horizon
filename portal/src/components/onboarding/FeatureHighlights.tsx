import { useState, useEffect, useRef } from 'react';
import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { motion, AnimatePresence, useMotionValue, useMotionTemplate } from 'framer-motion';
import { Maximize2, Play, X } from 'lucide-react';
import type { FeaturePanel } from '../../config/onboardingFeatures';
import { resolveFeatureIcon } from '../../config/featureIcons';
import { OnboardingMedia } from './OnboardingMedia';
import { prefersReducedMotion, VIDEO_EXTS } from './onboardingMediaUtils';
import { useFocusTrap } from '../../hooks/useFocusTrap';

/**
 * Sole renderer of the onboarding "What you can do" feature-card grid — used by
 * both the real wizard step and the Studio preview, so they stay identical.
 *
 * FLUX-764 made the grid premium (one card active at a time: lift + accent glow +
 * cursor spotlight, others recede). FLUX-780 changes how the demo OPENS: instead of
 * a hover popover, a card is CLICKED to open a large (~90% of viewport) lightbox with
 * the video dominant + a readable caption, and a further click (or Esc) dismisses it.
 * The hover lift/glow stays as the "click me" affordance.
 *
 * All motion is reduced-motion aware, dark-mode aware, keyboard-accessible (the card
 * is a role=button; Enter/Space opens; Esc closes the lightbox), and uses the theme
 * accent (var(--eh-accent)) via motion values so the spotlight never re-renders per frame.
 */

const VIDEO_RE = /\.(mp4|webm|mov)(?:[?#]|$)/i;
const EASE = [0.16, 1, 0.3, 1] as const;

export function FeatureHighlights({ features }: { features: FeaturePanel[] }) {
  const [activeId, setActiveId] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const reduce = prefersReducedMotion();
  const openFeature = features.find((f) => f.id === openId) ?? null;

  return (
    <div
      className="grid grid-cols-1 gap-3 mb-6 sm:grid-cols-2"
      onMouseLeave={() => setActiveId(null)}
    >
      {features.map((feature, i) => (
        <FeatureCard
          key={feature.id}
          feature={feature}
          index={i}
          reduce={reduce}
          isActive={activeId === feature.id}
          dimmed={activeId !== null && activeId !== feature.id}
          onActivate={() => setActiveId(feature.id)}
          onDeactivate={() => setActiveId((prev) => (prev === feature.id ? null : prev))}
          onOpen={() => setOpenId(feature.id)}
        />
      ))}

      <AnimatePresence>
        {openFeature && <FeatureLightbox feature={openFeature} reduce={reduce} onClose={() => setOpenId(null)} />}
      </AnimatePresence>
    </div>
  );
}

function FeatureCard({
  feature,
  index,
  reduce,
  isActive,
  dimmed,
  onActivate,
  onDeactivate,
  onOpen,
}: {
  feature: FeaturePanel;
  index: number;
  reduce: boolean;
  isActive: boolean;
  dimmed: boolean;
  onActivate: () => void;
  onDeactivate: () => void;
  onOpen: () => void;
}) {
  const Icon = resolveFeatureIcon(feature.icon);
  const hasImage = !!feature.image?.src;
  const isVideo = hasImage && VIDEO_RE.test(feature.image!.src);
  // "Openable" = there's something worth a full view (media or longer details).
  const canOpen = !!feature.image?.src || !!feature.details;

  // Cursor-following spotlight — motion values, so pointer moves never re-render React.
  const mx = useMotionValue(-300);
  const my = useMotionValue(-300);
  const spotlight = useMotionTemplate`radial-gradient(340px circle at ${mx}px ${my}px, color-mix(in srgb, var(--eh-accent) 16%, transparent), transparent 62%)`;
  const onMove = (e: React.MouseEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    mx.set(e.clientX - r.left);
    my.set(e.clientY - r.top);
  };

  const surface = `group relative flex h-full flex-col overflow-hidden rounded-2xl border bg-white text-left transition-colors duration-200 dark:bg-white/5 ${
    isActive ? 'border-primary/60 dark:border-primary/50' : 'border-gray-200 dark:border-white/10'
  } ${canOpen ? 'cursor-pointer' : ''}`;

  const Affordance = isVideo ? Play : Maximize2;
  const affordance = canOpen ? (
    <div
      aria-hidden
      className={`pointer-events-none absolute right-2 top-2 z-20 flex items-center justify-center rounded-full border p-1 backdrop-blur-sm transition-all duration-200 ${
        isActive
          ? 'border-primary/40 bg-primary/15 text-primary'
          : 'border-gray-200/70 bg-white/70 text-gray-400 dark:border-white/10 dark:bg-black/30 dark:text-gray-400'
      }`}
    >
      <Affordance className="h-3 w-3" {...(isVideo ? { fill: 'currentColor' } : {})} />
    </div>
  ) : null;

  const body: ReactNode = (
    <>
      {hasImage && (
        <div className="relative border-b border-gray-200 bg-gray-50 dark:border-white/10 dark:bg-white/[0.03]">
          <OnboardingMedia image={feature.image} className="h-28 w-full object-contain" />
        </div>
      )}
      <div className="p-4">
        <div className="mb-2 flex items-center gap-2">
          <div
            className={`flex items-center justify-center rounded-xl p-2 transition-colors duration-200 ${
              isActive ? 'bg-primary/20' : 'bg-primary/10'
            }`}
          >
            <Icon className="h-4 w-4 text-primary" />
          </div>
          <span className="text-sm font-semibold text-gray-900 dark:text-white">{feature.title}</span>
        </div>
        <p className="text-xs leading-relaxed text-gray-500 dark:text-gray-400">{feature.desc}</p>
      </div>
    </>
  );

  return (
    // Outer: staggered entrance + interaction handlers (hover glow + click-to-open).
    <motion.div
      role={canOpen ? 'button' : undefined}
      tabIndex={canOpen ? 0 : undefined}
      aria-label={canOpen ? `Open ${feature.title} demo` : undefined}
      onMouseMove={canOpen ? onMove : undefined}
      onMouseEnter={onActivate}
      onMouseLeave={onDeactivate}
      onFocus={onActivate}
      onBlur={onDeactivate}
      onClick={canOpen ? onOpen : undefined}
      onKeyDown={canOpen ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen(); } } : undefined}
      initial={reduce ? false : { opacity: 0, y: 14 }}
      whileInView={reduce ? undefined : { opacity: 1, y: 0 }}
      viewport={{ once: true, margin: '-8%' }}
      transition={{ delay: reduce ? 0 : index * 0.05, duration: 0.45, ease: EASE }}
      className="relative h-full rounded-2xl outline-none"
      style={{ zIndex: isActive ? 2 : 0 }}
    >
      {/* Inner: the interactive surface (lift / scale / dim / glow). Split from the
          outer so the one-time entrance never fights the ongoing hover state. */}
      <motion.div
        animate={{
          scale: reduce ? 1 : isActive ? 1.015 : dimmed ? 0.99 : 1,
          opacity: dimmed ? 0.6 : 1,
          y: reduce ? 0 : isActive ? -4 : 0,
        }}
        transition={reduce ? { duration: 0 } : { type: 'spring', stiffness: 320, damping: 26 }}
        style={{
          boxShadow:
            isActive && !reduce
              ? '0 16px 44px -14px color-mix(in srgb, var(--eh-accent) 48%, transparent)'
              : undefined,
        }}
        className={surface}
      >
        {canOpen && !reduce && (
          <motion.div
            aria-hidden
            className="pointer-events-none absolute inset-0 z-0"
            style={{ background: spotlight }}
            animate={{ opacity: isActive ? 1 : 0 }}
            transition={{ duration: 0.2 }}
          />
        )}
        {affordance}
        <div className="relative z-10 flex h-full flex-col">{body}</div>
      </motion.div>
    </motion.div>
  );
}

/** px reserved under the media for the caption block (title + 2 lines + padding + border). */
const CAPTION_RESERVE = 132;
const PANEL_MAX_W = 1500;

/**
 * Compute the largest box of the media's natural aspect ratio that fits the viewport
 * (clamped to a max, floored to a min), recomputed on resize. Returns null until the
 * media's intrinsic dimensions are known, so the panel can show a 16/9 placeholder first.
 */
function useFittedDims(natural: { w: number; h: number } | null) {
  const [dims, setDims] = useState<{ w: number; h: number } | null>(null);
  useEffect(() => {
    if (!natural || natural.w <= 0 || natural.h <= 0) return;
    const compute = () => {
      const maxW = Math.min(window.innerWidth * 0.92, PANEL_MAX_W);
      const maxH = window.innerHeight * 0.92 - CAPTION_RESERVE;
      const minW = Math.min(340, maxW);
      const minH = Math.min(200, maxH);
      // Largest fit preserving ratio, then floor up to the minimum (never past the max).
      const fit = Math.min(maxW / natural.w, maxH / natural.h);
      let w = natural.w * fit;
      let h = natural.h * fit;
      const floor = Math.min(maxW / w, maxH / h, Math.max(minW / w, minH / h));
      if (floor > 1) { w *= floor; h *= floor; }
      setDims({ w: Math.round(w), h: Math.round(h) });
    };
    compute();
    window.addEventListener('resize', compute);
    return () => window.removeEventListener('resize', compute);
  }, [natural]);
  return dims;
}

/**
 * FLUX-780: the click-to-open demo lightbox. Portaled to <body> so a transformed wizard
 * step can't clip it. The panel sizes to the media's own aspect ratio (clamped to a
 * viewport-relative min/max) so there are no letterbox bezels, and animates smoothly to
 * that size once the media reports its dimensions. A readable caption sits beneath the
 * media; a click anywhere, the close button, or Esc dismisses it.
 */
function FeatureLightbox({ feature, reduce, onClose }: { feature: FeaturePanel; reduce: boolean; onClose: () => void }) {
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null);
  const dims = useFittedDims(natural);

  // FLUX-792: trap focus inside the dialog (Esc to close, Tab cycles, focus restored on close)
  // so a keyboard user can't tab onto the dimmed cards behind the lightbox.
  const panelRef = useRef<HTMLDivElement>(null);
  useFocusTrap(panelRef, { onClose });

  const src = feature.image?.src;
  const path = src ? src.split(/[?#]/)[0]! : '';
  const ext = path.slice(path.lastIndexOf('.')).toLowerCase();
  const isVideo = !!src && VIDEO_EXTS.has(ext);

  // Before the media reports its size, fall back to a 16/9 placeholder so the panel
  // doesn't flash at the <video> default of 300×150.
  const panelStyle = dims ? { width: dims.w } : { width: 'min(92vw, 880px)' };
  const mediaStyle = dims ? { height: dims.h } : { aspectRatio: '16 / 9' as const };

  return createPortal(
    <motion.div
      role="dialog"
      aria-modal="true"
      aria-label={feature.title}
      initial={reduce ? false : { opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.18 }}
      onClick={onClose}
      className="fixed inset-0 z-[200] flex items-center justify-center bg-black/85 p-4 backdrop-blur-sm"
    >
      <motion.div
        ref={panelRef}
        layout={!reduce}
        initial={reduce ? false : { scale: 0.96, opacity: 0, y: 10 }}
        animate={{ scale: 1, opacity: 1, y: 0 }}
        exit={{ scale: 0.97, opacity: 0, transition: { duration: 0.14 } }}
        transition={reduce ? { duration: 0 } : { type: 'spring', stiffness: 280, damping: 30 }}
        style={panelStyle}
        className="relative flex max-h-[92vh] max-w-[92vw] flex-col overflow-hidden rounded-2xl border border-white/10 bg-[#15161d] shadow-2xl"
      >
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="absolute right-3 top-3 z-10 rounded-full bg-black/40 p-2 text-white/70 backdrop-blur transition-colors hover:bg-black/60 hover:text-white"
        >
          <X className="h-5 w-5" />
        </button>

        {/* Media — sized to its own ratio, so it fills edge-to-edge with no bezels. */}
        <motion.div layout={!reduce} style={mediaStyle} className="relative w-full shrink-0 bg-black">
          {isVideo ? (
            <video
              src={src}
              aria-label={feature.image?.alt || feature.title}
              className="h-full w-full object-cover"
              autoPlay={!reduce}
              loop={!reduce}
              muted
              playsInline
              controls={reduce}
              preload="metadata"
              disablePictureInPicture
              onLoadedMetadata={(e) => setNatural({ w: e.currentTarget.videoWidth, h: e.currentTarget.videoHeight })}
              onClick={(e) => { if (reduce) e.stopPropagation(); }}
              ref={(el) => {
                if (!el) return;
                el.defaultMuted = true;
                el.muted = true;
                if (!reduce) el.play?.().catch(() => {});
              }}
            />
          ) : src ? (
            <img
              src={src}
              alt={feature.image?.alt ?? feature.title}
              className="h-full w-full object-cover"
              onLoad={(e) => setNatural({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })}
            />
          ) : null}
        </motion.div>

        {/* Caption — deliberately larger than the card copy so it isn't ignored. */}
        <div className="shrink-0 border-t border-white/10 px-6 py-4">
          <h3 className="text-xl font-bold text-white">{feature.title}</h3>
          <p className="mt-1 max-w-3xl text-base leading-relaxed text-gray-300">{feature.details ?? feature.desc}</p>
        </div>
      </motion.div>
    </motion.div>,
    document.body,
  );
}
