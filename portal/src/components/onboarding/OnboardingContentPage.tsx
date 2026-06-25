import type { ReactNode } from 'react';
import type { FeaturePanel } from '../../config/onboardingFeatures';
import type { OnboardingImage as OnboardingImageType, OnboardingPage } from '../../config/onboardingFlow';
import { resolveFeatureIcon } from '../../config/featureIcons';
import { FeatureHighlights } from './FeatureHighlights';
import { OnboardingMedia } from './OnboardingMedia';

/**
 * FLUX-760 Phase 3 — the SINGLE shared content-page renderer + image element.
 *
 * Before this, OnboardingWizard.renderContentPage and FlowPlayPreview.ContentPageView
 * were character-identical copies of the same heading/title/subtitle/body/feature-grid/
 * cta markup (a known verbatim-copy drift hazard). This module extracts that markup
 * ONCE so the real wizard and the dev Studio preview are pixel-identical by
 * construction; the only difference is the injected CTA handler (`onCta`).
 *
 * This is PRODUCTION render code (no dev gate) — the real wizard renders through it,
 * so the page/feature images ship in prod even though the upload path + Studio are
 * stripped.
 */

/**
 * Back-compat delegate (FLUX-763). The single media renderer now lives in the leaf
 * file OnboardingMedia (img-vs-video by extension); this re-export keeps every existing
 * importer working AND makes page.image render video for video srcs with no call-site
 * change. The default-class fallback carries through OnboardingMedia to both branches.
 */
export function OnboardingImage({
  image,
  className,
}: {
  image: OnboardingImageType | undefined;
  className?: string;
}): ReactNode {
  return <OnboardingMedia image={image} className={className} />;
}

/**
 * Shared content-page body: heading icon + title + subtitle + optional page image +
 * optional body paragraph + optional feature grid (when features.layout==='grid') +
 * ctas as buttons. The CTA click handler is INJECTED via `onCta(action)` — the real
 * wizard passes its CONTENT_ACTIONS dispatcher; the dev preview passes a no-op so
 * preview navigation stays Back/Next-only.
 *
 * The page image renders between the subtitle and the body/feature grid.
 */
export function OnboardingContentPage({
  page,
  features,
  onCta,
}: {
  page: OnboardingPage;
  features: FeaturePanel[];
  onCta: (action: string) => void;
}): ReactNode {
  const Icon = resolveFeatureIcon(page.icon ?? 'Sparkles');
  const showFeatureGrid = page.features?.layout === 'grid';
  const ctas = page.ctas ?? [];
  return (
    <div>
      <div className="mb-8 flex flex-col items-center gap-3 text-center">
        <div className="flex items-center justify-center rounded-2xl bg-primary/10 p-4">
          <Icon className="h-8 w-8 text-primary" />
        </div>
        <h1 className="text-2xl font-bold tracking-tight text-gray-900 dark:text-white">
          {page.title}
        </h1>
        {page.subtitle && (
          <p className="text-sm text-gray-500 dark:text-gray-400 max-w-sm">
            {page.subtitle}
          </p>
        )}
      </div>

      <OnboardingImage image={page.image} />

      {page.body && (
        <p className="mb-6 text-sm text-gray-500 dark:text-gray-400">{page.body}</p>
      )}

      {showFeatureGrid && <FeatureHighlights features={features} />}

      <div className="flex flex-col gap-3">
        {ctas.map((cta, i) => {
          const isPrimary = i === 0;
          return (
            <button
              key={i}
              type="button"
              onClick={() => {
                if (cta.action) onCta(cta.action);
              }}
              className={
                isPrimary
                  ? 'flex h-11 w-full items-center justify-center rounded-2xl bg-primary px-6 text-sm font-semibold text-white shadow-sm transition-all hover:bg-primary-hover'
                  : 'flex h-11 items-center justify-center rounded-2xl border border-gray-200 bg-white px-6 text-sm font-medium text-gray-700 shadow-sm transition-all hover:bg-gray-50 dark:border-white/10 dark:bg-white/5 dark:text-gray-300 dark:hover:bg-white/10'
              }
            >
              {cta.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}
