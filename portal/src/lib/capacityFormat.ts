import type { CliFramework, UsageGauge } from '../types';

const PROVIDER_LABELS: Record<CliFramework, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
  copilot: 'Copilot',
  gemini: 'Gemini',
  grok: 'Grok',
  antigravity: 'Antigravity',
};

export function providerLabel(provider: CliFramework): string {
  return PROVIDER_LABELS[provider] ?? provider;
}

/** Unit-honest figure for a gauge — never a bare percent beside a token count (a Copilot
 *  `unit:'requests'` gauge always shows "N / M requests", never "97.5%"). A `floor` gauge with a
 *  consumed count but no denominator (Claude Code — see `computeClaudeFloorUsage`) is prefixed
 *  "≥" since local counting can only ever under-report, never invent usage. */
export function gaugeFigure(gauge: UsageGauge): string {
  if (gauge.unlimited && gauge.used != null) {
    return `${formatCount(gauge.used)} ${gauge.unit} (unlimited)`;
  }
  if (gauge.used != null && gauge.limit != null) {
    return `${formatCount(gauge.used)} / ${formatCount(gauge.limit)} ${gauge.unit}`;
  }
  if (gauge.used != null) {
    const prefix = gauge.provenance === 'floor' ? '≥ ' : '';
    return `${prefix}${formatCount(gauge.used)} ${gauge.unit} consumed`;
  }
  if (gauge.percent != null) return `${Math.round(gauge.percent)}%`;
  if (gauge.percentFloor != null) return `at least ${Math.round(gauge.percentFloor)}%`;
  return '—';
}

export function formatCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return `${n}`;
}

/** "resets in 2h 14m" style countdown text; `undefined` when there's no `resetsAt` or it has
 *  already passed (a past `resetsAt` is the freshness engine's job to flag, not this formatter's). */
export function resetCountdown(resetsAt: string | undefined, nowMs: number): string | undefined {
  if (!resetsAt) return undefined;
  const targetMs = Date.parse(resetsAt);
  if (!Number.isFinite(targetMs)) return undefined;
  const deltaMs = targetMs - nowMs;
  if (deltaMs <= 0) return undefined;
  const totalMinutes = Math.round(deltaMs / 60_000);
  const days = Math.floor(totalMinutes / (24 * 60));
  const hours = Math.floor((totalMinutes % (24 * 60)) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return `resets in ${days}d ${hours}h`;
  if (hours > 0) return `resets in ${hours}h ${minutes}m`;
  return `resets in ${minutes}m`;
}
