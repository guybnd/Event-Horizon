import type { ReactNode } from 'react';
import type { OnboardingImage as OnboardingImageType } from '../../config/onboardingFlow';
import { VIDEO_EXTS, prefersReducedMotion } from './onboardingMediaUtils';

/**
 * FLUX-763 — the SINGLE shared media element used everywhere an onboarding asset is
 * shown (content pages, feature cards, the TutorialPopover hover panel, the Studio
 * preview, the upload thumbnail). It extends the FLUX-760 single-renderer invariant
 * to video: it sniffs the src extension and renders a gif-like looping <video> for
 * .mp4/.webm/.mov, or the existing plain <img> otherwise.
 *
 * This is a NEW leaf file (it does NOT edit OnboardingImage in place) so the import
 * graph stays a clean tree: TutorialPopover (components/common) and ImageUploadField
 * (components/dev) import this leaf directly, never pulling OnboardingContentPage's
 * FeatureHighlights/icon graph. OnboardingContentPage re-exports OnboardingImage as a
 * one-line delegate to this component so no existing importer breaks.
 *
 * It MUST NOT import anything from components/dev/** — it ships in prod (the real
 * wizard renders through it) and the Studio/upload path must stay DCE'd out.
 *
 * `VIDEO_EXTS`/`prefersReducedMotion` live in `onboardingMediaUtils.ts` (not here) so
 * this file exports only the component — Fast Refresh requires component-only exports.
 */

/** byte-identical to the original OnboardingImage <img> default class. */
const DEFAULT_MEDIA_CLASS =
  'mb-6 max-h-64 w-full rounded-2xl border border-gray-200 object-contain dark:border-white/10';

/**
 * The SINGLE media renderer. Keeps the `image`-prop shape so it is a drop-in for the
 * old OnboardingImage call sites and for TutorialPopover's `media` (TutorialMedia is
 * structurally identical to OnboardingImage, so it passes through with no adapter).
 *
 * - empty/absent src → renders nothing (preserves the 'src:"" = none' contract).
 * - video src → gif-like <video> (silent, looping, inline, autoplaying, chromeless).
 * - everything else → plain <img> (GIF/png/jpg/svg animate natively).
 * - BOTH branches fall back to DEFAULT_MEDIA_CLASS when className is undefined
 *   (load-bearing: OnboardingContentPage's page.image call site passes no className).
 */
export function OnboardingMedia({
  image,
  className,
}: {
  image: OnboardingImageType | undefined;
  className?: string;
}): ReactNode {
  if (!image || !image.src) return null;

  // Strip the cache-buster (?v=Date.now()) and any hash BEFORE sniffing the extension,
  // otherwise `.mp4?v=123` mis-classifies as an <img>. Load-bearing.
  const path = image.src.split(/[?#]/)[0]!;
  const ext = path.slice(path.lastIndexOf('.')).toLowerCase();
  const isVideo = VIDEO_EXTS.has(ext);
  const mediaClass = className ?? DEFAULT_MEDIA_CLASS;

  if (isVideo) {
    const reduceMotion = prefersReducedMotion();
    // Reduced-motion: render paused on frame 0 (preload=metadata paints it like a
    // poster) and expose `controls` so the user can opt in. The <img>/gif branch is
    // unaffected (a gif cannot be paused via attributes — matches current behavior).
    return (
      <video
        src={image.src}
        aria-label={image.alt || undefined}
        className={mediaClass}
        autoPlay={!reduceMotion}
        loop={!reduceMotion}
        muted
        playsInline
        controls={reduceMotion}
        preload="metadata"
        disablePictureInPicture
        tabIndex={-1}
        ref={(el) => {
          if (!el) return;
          // React does not reliably reflect the `muted` prop to the DOM property on
          // first mount, so set it imperatively (belt #2) or autoplay gets blocked.
          el.defaultMuted = true;
          el.muted = true;
          if (!reduceMotion) {
            // A rejected autoplay promise (Data Saver / Low Power Mode) must never throw.
            el.play?.().catch(() => {});
          }
        }}
      />
    );
  }

  return <img src={image.src} alt={image.alt ?? ''} className={mediaClass} />;
}
