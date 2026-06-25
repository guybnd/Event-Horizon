import { useMemo, useState } from 'react';
import { icons, Search, X } from 'lucide-react';
import {
  resolveFeatureIcon,
  FEATURE_ICON_NAMES,
  FALLBACK_ICON_NAME,
} from '../../config/featureIcons';

/**
 * Dev-only icon picker, EXTRACTED VERBATIM from OnboardingEditorScreen.tsx
 * (FLUX-755, lines 363-429) so both the Studio's Features tab and the new Flow
 * tab reuse ONE copy (FLUX-759). Reachable ONLY through the import.meta.env.DEV
 * lazy Studio chunk, so it is dead-code-eliminated from the prod bundle.
 *
 * IconGlyph renders a stored icon NAME through the same resolver the cards use
 * (guaranteed fallback). IconPicker is the searchable icon grid.
 */

/** Renders a stored icon NAME through the same resolver the cards use (guaranteed fallback). */
export function IconGlyph({ name, className }: { name: string; className?: string }) {
  const Icon = resolveFeatureIcon(name);
  return <Icon className={className} />;
}

/** Icon grid: the curated list is the default surface; the filter may match the full keyset. */
export function IconPicker({
  current,
  onPick,
  onClose,
}: {
  current: string;
  onPick: (name: string) => void;
  onClose: () => void;
}) {
  const [filter, setFilter] = useState('');

  const names = useMemo<string[]>(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return FEATURE_ICON_NAMES as unknown as string[];
    // Power users may type any valid lucide name — match against the full keyset.
    return Object.keys(icons)
      .filter((n) => n.toLowerCase().includes(q))
      .slice(0, 60);
  }, [filter]);

  return (
    <div className="mt-2 rounded-lg border border-gray-200 bg-gray-50 p-2 dark:border-white/10 dark:bg-white/[0.03]">
      <div className="mb-2 flex items-center gap-1.5 rounded-md border border-gray-200 bg-white px-2 py-1 dark:border-white/10 dark:bg-white/5">
        <Search className="h-3.5 w-3.5 text-gray-400" />
        <input
          autoFocus
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter icons…"
          className="w-full bg-transparent text-xs text-gray-900 outline-none placeholder:text-gray-400 dark:text-white"
        />
        <button onClick={onClose} aria-label="Close picker" className="text-gray-400 hover:text-gray-600">
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
      <div className="grid max-h-44 grid-cols-8 gap-1 overflow-y-auto">
        {names.map((name) => {
          const active = name === current;
          return (
            <button
              key={name}
              onClick={() => onPick(name)}
              title={name}
              className={`flex aspect-square items-center justify-center rounded-md transition-colors ${
                active
                  ? 'bg-primary/15 text-primary ring-1 ring-primary'
                  : 'text-gray-500 hover:bg-gray-200 dark:text-gray-400 dark:hover:bg-white/10'
              }`}
            >
              <IconGlyph name={name} className="h-4 w-4" />
            </button>
          );
        })}
        {names.length === 0 && (
          <span className="col-span-8 py-2 text-center text-xs text-gray-400">No matches</span>
        )}
      </div>
    </div>
  );
}

// Keep FALLBACK_ICON_NAME re-exported for convenience of consumers that previously
// imported it alongside the picker (the Features tab uses it for new panels).
export { FALLBACK_ICON_NAME };
