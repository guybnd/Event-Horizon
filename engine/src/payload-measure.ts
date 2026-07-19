// FLUX-1512: shared bytes/tokensEst arithmetic for the two payload-measurement modules
// (agent-payload-metrics.ts, context-budget-metrics.ts). The two callers measure semantically
// different things — one a value as a JSON payload field, the other raw prompt/module text as
// sent — so this consolidates only the shared arithmetic, not the semantics: two thin named
// exports below, each preserving its call site's exact prior behavior.

function bytesAndTokens(text: string): { bytes: number; tokensEst: number } {
  // tokensEst is a rough chars/4 heuristic — good enough to rank sections by
  // relative weight, not an exact tokenizer count.
  return { bytes: Buffer.byteLength(text, 'utf8'), tokensEst: Math.ceil(text.length / 4) };
}

/**
 * JSON-encodes `value` first, then measures the resulting JSON text — for measuring a value's
 * weight as a JSON payload field (agent-payload-metrics.ts's `get_ticket` section breakdown).
 */
export function measureJson(value: unknown): { bytes: number; tokensEst: number } {
  if (value === undefined) return { bytes: 0, tokensEst: 0 };
  const json = JSON.stringify(value);
  if (json === undefined) return { bytes: 0, tokensEst: 0 };
  return bytesAndTokens(json);
}

/**
 * Measures raw text directly, with no JSON re-encoding — for prompt/module text sent as-is
 * (context-budget-metrics.ts's launch-prompt/skill-module measurement).
 */
export function measureText(value: string | undefined | null): { bytes: number; tokensEst: number } {
  if (!value) return { bytes: 0, tokensEst: 0 };
  return bytesAndTokens(value);
}
