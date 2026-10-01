import type { CliSessionSummary } from '../types';
import { formatCount } from '../lib/capacityFormat';
import { ProvenanceBar } from './ProvenanceBar';

// Cap the number of rendered compaction tick marks — a runaway session could in principle
// compact hundreds of times, and packing that many 1px marks into a small bar would just paint
// a solid line rather than communicate a count.
const MAX_MARKERS = 20;

/**
 * Per-session context-window ratio strip (FLUX-1748), shown next to a session's token badge.
 * Context is never summable across a group (three members at 120k of a 200k window are three
 * ratios, not 360k/200k) — callers render one of these PER SESSION, never one for a group's
 * aggregate `tokenData`. When `contextWindow` is unknown, shows the token count with an
 * unknown-style track instead of fabricating a ratio. Renders nothing when NEITHER field is
 * present — only `anthropic-stream.ts` ever sets `lastTurnContextTokens`, so every Codex/Copilot/
 * Gemini/Grok session would otherwise carry a permanent dashed empty bar that conveys no data at
 * all, rather than an honest "unknown" for a dimension the framework never reports.
 */
export function ContextStrip({ session, className = '' }: { session: CliSessionSummary; className?: string }) {
  const { lastTurnContextTokens, contextWindow, compactionCount } = session;
  if (lastTurnContextTokens == null && contextWindow == null) return null;
  const hasRatio = contextWindow != null && contextWindow > 0 && lastTurnContextTokens != null;
  const percent = hasRatio ? Math.min(100, (lastTurnContextTokens! / contextWindow!) * 100) : undefined;
  const markers = Math.min(compactionCount ?? 0, MAX_MARKERS);

  return (
    <div className={`flex items-center gap-1.5 ${className}`} data-testid="context-strip">
      <div className="relative min-w-0 flex-1">
        <ProvenanceBar
          provenance={hasRatio ? 'exact' : 'unknown'}
          percent={percent}
          label="context window used"
          className="h-1.5"
        />
        {markers > 0 && (
          <div className="pointer-events-none absolute inset-0 flex items-center" aria-hidden>
            {Array.from({ length: markers }, (_, i) => (
              <span
                key={i}
                data-testid="compaction-marker"
                className="absolute top-0 h-full w-px bg-amber-500/70 dark:bg-amber-400/70"
                style={{ left: `${((i + 1) / (markers + 1)) * 100}%` }}
              />
            ))}
          </div>
        )}
      </div>
      <span className="shrink-0 text-[9px] font-mono text-gray-400 dark:text-gray-500">
        {lastTurnContextTokens == null ? '—' : hasRatio ? `${Math.round(percent!)}%` : `${formatCount(lastTurnContextTokens)} tok`}
      </span>
    </div>
  );
}
