import { icons } from 'lucide-react';
import type { ComponentType } from 'react';
import type { LucideProps } from 'lucide-react';

/**
 * Single source of truth for resolving a feature-panel icon NAME (a string
 * stored in the committed JSON config) to a renderable lucide component.
 *
 * Components cannot live in JSON, so the config stores the lucide PascalCase
 * NAME (e.g. "GitBranch"). Both the shared FeatureHighlights cards and the
 * dev editor's icon picker resolve through `resolveFeatureIcon`, so render
 * and picker can never drift and a bad/mistyped name always falls back
 * instead of crashing onboarding.
 *
 * lucide-react 1.14.0 exposes an `icons` record (1703 PascalCase keys, e.g.
 * `icons.GitBranch`); there is NO DynamicIcon export, so the record is the
 * lookup. resolveFeatureIcon references the already-imported `icons` record,
 * so tree-shaking is unaffected (the bundler keeps only what is reachable
 * through the committed config / picker grid).
 */

export type LucideIconName = keyof typeof icons;

/** Fallback when a stored icon name is unknown — Sparkles already ships in the wizard. */
export const FALLBACK_ICON_NAME = 'Sparkles' as LucideIconName;

/**
 * Resolve a stored icon NAME string to a lucide component. An unknown or
 * mistyped name never crashes render — it shows the fallback icon.
 */
export function resolveFeatureIcon(name: string): ComponentType<LucideProps> {
  return icons[name as LucideIconName] ?? icons[FALLBACK_ICON_NAME];
}

/**
 * Curated, product-relevant icon names surfaced by the editor's icon picker.
 * Intentionally finite (NOT all 1703 names) so the picker grid stays tasteful;
 * the picker's text filter MAY additionally match the full Object.keys(icons)
 * keyset so power users can type any valid name. Tree-shaking is unaffected
 * because resolveFeatureIcon uses the already-imported `icons` record.
 */
export const FEATURE_ICON_NAMES: LucideIconName[] = [
  'GitBranch',
  'GitPullRequest',
  'GitMerge',
  'BookOpen',
  'Users',
  'MessageSquare',
  'Boxes',
  'Sparkles',
  'Rocket',
  'Terminal',
  'Package',
  'FolderOpen',
  'Folder',
  'HardDrive',
  'Workflow',
  'Bot',
  'Zap',
  'Bell',
  'Shield',
  'Target',
  'Tag',
  'Settings',
  'Eye',
  'WandSparkles',
  'Layers',
  'Search',
  'Star',
  'Clock',
  'FileText',
  'Kanban',
  'ListChecks',
];
