import raw from './onboardingFeatures.json';
import type { OnboardingImage } from './onboardingFlow';

/**
 * One feature panel shown on the onboarding wizard's "What you can do" step.
 * `icon` is a lucide PascalCase NAME string (resolved via resolveFeatureIcon),
 * never a component. `id` is a stable lowercase-hyphenated slug used as BOTH
 * the React key and the dnd-kit sortable id — never the (editable) title.
 */
export interface FeaturePanel {
  id: string;
  icon: string;
  title: string;
  desc: string;
  /** Phase 3: optional per-feature image rendered as a media-on-top thumbnail. */
  image?: OnboardingImage;
  /** FLUX-762: extended copy shown in the hover tutorial panel; desc stays the short card blurb. */
  details?: string;
}

/** Committed config shape: object wrapper so a header/subtitle can be added later. */
export interface OnboardingFeaturesConfig {
  version: number;
  features: FeaturePanel[];
}

function asString(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value == null) return '';
  return String(value);
}

function asOptionalString(value: unknown): string | undefined {
  if (value == null) return undefined;
  if (typeof value === 'string') return value;
  return String(value);
}

/**
 * Coerce a raw per-feature image defensively (Phase 3). When the entry is a
 * non-null, non-array object, emit { src, alt? } (mirrors onboardingFlow's
 * coerceImage); otherwise return undefined so the field is omitted. Never throws.
 */
function coerceImage(value: unknown): OnboardingImage | undefined {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const e = value as Record<string, unknown>;
  const alt = asOptionalString(e.alt);
  return alt === undefined ? { src: asString(e.src) } : { src: asString(e.src), alt };
}

/**
 * Defensive coercion so a hand-edited or malformed config NEVER crashes
 * onboarding:
 *  - drops non-object entries,
 *  - coerces id/icon/title/desc to strings,
 *  - auto-fills missing/blank/duplicate ids as `feature-<idx>`,
 *  - tolerates unknown icon names (resolved with a fallback at render time).
 */
export function validateFeatures(input: unknown): FeaturePanel[] {
  const list = Array.isArray((input as OnboardingFeaturesConfig)?.features)
    ? (input as OnboardingFeaturesConfig).features
    : Array.isArray(input)
      ? (input as unknown[])
      : [];

  const seen = new Set<string>();
  const out: FeaturePanel[] = [];

  list.forEach((entry, idx) => {
    if (entry == null || typeof entry !== 'object') return;
    const e = entry as Record<string, unknown>;

    let id = asString(e.id).trim();
    if (id === '' || seen.has(id)) {
      id = `feature-${idx}`;
    }
    // Guarantee uniqueness even if the synthetic id collides.
    let unique = id;
    let bump = idx;
    while (seen.has(unique)) {
      unique = `feature-${++bump}`;
    }
    id = unique;
    seen.add(id);

    const panel: FeaturePanel = {
      id,
      icon: asString(e.icon),
      title: asString(e.title),
      desc: asString(e.desc),
    };
    const image = coerceImage(e.image);
    if (image) panel.image = image;
    // FLUX-762: coerce extended details defensively, omitting when absent/blank
    // (mirrors how image is handled). Never throws; survives the engine PUT
    // round-trip because validateConfigBody checks only required keys.
    const details = asOptionalString(e.details);
    if (details !== undefined && details !== '') panel.details = details;
    out.push(panel);
  });

  return out;
}

/**
 * The shipped seed panels, statically imported from the committed JSON and
 * defensively validated. The wizard imports FEATURE_PANELS from here; the dev
 * editor uses this as the fallback when the live engine fetch fails.
 */
export const FEATURE_PANELS: FeaturePanel[] = validateFeatures(raw);
