/**
 * A quiet relative time — "now", "3m", "2h", then a short absolute date ("Jun 21") once past a
 * day. Pure: re-derives on each render, no live ticker (callers re-render often enough; between-
 * tick staleness is acceptable). Returns '' for a missing/unparseable `ts` so callers can render
 * nothing. Extracted from ChatView for reuse (FLUX-684 → FLUX-722).
 */
export function formatRelative(ts: string | undefined | null): string {
  if (!ts) return '';
  const then = new Date(ts).getTime();
  if (Number.isNaN(then)) return '';
  const s = Math.max(0, Math.floor((Date.now() - then) / 1000));
  if (s < 45) return 'now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
