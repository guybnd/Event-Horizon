import { useState } from 'react';
import type { ReactNode, Ref } from 'react';
import { motion, useMotionValue, useMotionTemplate } from 'framer-motion';
import { Maximize2, Play } from 'lucide-react';
import type { FeaturePanel } from '../../config/onboardingFeatures';
import { resolveFeatureIcon } from '../../config/featureIcons';
import { OnboardingMedia, prefersReducedMotion } from './OnboardingMedia';
import { TutorialPopover } from '../common/TutorialPopover';
import type { TutorialTrigger } from '../common/TutorialPopover';

/**
 * Sole renderer of the onboarding "What you can do" feature-card grid — used by
 * both the real wizard step and the Studio preview, so they stay identical.
 *
 * FLUX-762 gave each card a hover/focus TutorialPopover (the same media BIGGER +
 * details). FLUX-764 makes the grid feel intentional and premium:
 *   - ONE card active at a time: hovering/focusing a card lifts it, gives it an
 *     accent glow + a cursor-following spotlight, and gently recedes the others.
 *     (Only one popover is ever open — enforced globally inside TutorialPopover.)
 *   - A persistent affordance cue (a play glyph for video demos, an expand glyph
 *     otherwise) + `cursor: help` signal "hover me for more" BEFORE you hover.
 *   - A staggered entrance when the step appears.
 * All motion is reduced-motion aware, dark-mode aware, keyboard-accessible
 * (opens on focus, no focus trap), and uses the theme accent (var(--eh-accent)),
 * driven by motion values so the spotlight never re-renders React per frame.
 */

const VIDEO_RE = /\.(mp4|webm|mov)(?:[?#]|$)/i;
const EASE = [0.16, 1, 0.3, 1] as const;

export function FeatureHighlights({ features }: { features: FeaturePanel[] }) {
  const [activeId, setActiveId] = useState<string | null>(null);
  const reduce = prefersReducedMotion();

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
        />
      ))}
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
}: {
  feature: FeaturePanel;
  index: number;
  reduce: boolean;
  isActive: boolean;
  dimmed: boolean;
  onActivate: () => void;
  onDeactivate: () => void;
}) {
  const Icon = resolveFeatureIcon(feature.icon);
  const hasImage = !!feature.image?.src;
  const isVideo = hasImage && VIDEO_RE.test(feature.image!.src);
  const popoverMedia = feature.image?.src ? feature.image : undefined;
  const hasPanel = !!popoverMedia || !!feature.details;

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
  } ${hasPanel ? 'cursor-help' : ''}`;

  const Affordance = isVideo ? Play : Maximize2;
  const affordance = hasPanel ? (
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

  const card = (trigger?: TutorialTrigger) => (
    // Outer: staggered entrance + the trigger anchor / interaction handlers.
    <motion.div
      ref={trigger?.ref as Ref<HTMLDivElement>}
      aria-describedby={trigger?.['aria-describedby']}
      tabIndex={hasPanel ? 0 : undefined}
      onMouseMove={hasPanel ? onMove : undefined}
      onMouseEnter={() => {
        onActivate();
        trigger?.onMouseEnter();
      }}
      onMouseLeave={() => {
        onDeactivate();
        trigger?.onMouseLeave();
      }}
      onFocus={() => {
        onActivate();
        trigger?.onFocus();
      }}
      onBlur={(e) => {
        onDeactivate();
        trigger?.onBlur(e);
      }}
      onKeyDown={trigger?.onKeyDown}
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
        {hasPanel && !reduce && (
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

  if (!hasPanel) return card();

  return (
    <TutorialPopover title={feature.title} media={popoverMedia} details={feature.details ?? feature.desc}>
      {(trigger) => card(trigger)}
    </TutorialPopover>
  );
}
