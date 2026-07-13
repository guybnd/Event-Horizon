// FLUX-1375: the fallback cost estimator previously blended cache-read/cache-creation tokens into
// the full input rate (cache reads are ~10x cheaper than fresh input) and had no way to price a
// model's cache columns even when model-pricing.md carried them. These pin `parsePricingDoc`'s
// optional cache-column parsing and `estimateCostUSD`'s per-class pricing + default-ratio fallback.
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs/promises')>();
  return { ...actual, default: { ...actual, readFile: vi.fn() } };
});
vi.mock('./file-utils.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./file-utils.js')>();
  return { ...actual, getDocsDir: () => '/tmp/test-docs' };
});

describe('parsePricingDoc (FLUX-1375)', () => {
  it('parses a row with no cache columns — cacheReadPer1M/cacheWritePer1M left undefined', async () => {
    const { parsePricingDoc } = await import('./task-store.js');
    const rows = parsePricingDoc('| model | input_per_1m | output_per_1m |\n|---|---|---|\n| claude-sonnet-4-5 | 3 | 15 |\n');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ inputPer1M: 3, outputPer1M: 15 });
    expect(rows[0]!.cacheReadPer1M).toBeUndefined();
    expect(rows[0]!.cacheWritePer1M).toBeUndefined();
  });

  it('parses a row with explicit cache-read/cache-write columns', async () => {
    const { parsePricingDoc } = await import('./task-store.js');
    const rows = parsePricingDoc('| model | input_per_1m | output_per_1m | cache_read_per_1m | cache_write_per_1m |\n|---|---|---|---|---|\n| claude-opus-4-5 | 75 | 375 | 7.5 | 93.75 |\n');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ inputPer1M: 75, outputPer1M: 375, cacheReadPer1M: 7.5, cacheWritePer1M: 93.75 });
  });

  it('longest model-name match wins, still skips header/separator rows', async () => {
    const { parsePricingDoc } = await import('./task-store.js');
    const rows = parsePricingDoc('| model | input_per_1m | output_per_1m |\n|---|---|---|\n| claude-3-5-sonnet | 3 | 15 |\n| claude-3-5-sonnet-extended | 5 | 25 |\n');
    expect(rows.map(r => r.modelName)).toEqual(['claude-3-5-sonnet-extended', 'claude-3-5-sonnet']);
  });
});

describe('estimateCostUSD (FLUX-1375)', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('unmatched model hint: fresh input at default rate, cache read/write at the 0.1x/1.25x default ratio off the default input rate', async () => {
    const { estimateCostUSD } = await import('./task-store.js');
    // DEFAULT_INPUT_PER_1M=3, DEFAULT_OUTPUT_PER_1M=15 → cacheRead=0.3/1M, cacheWrite=3.75/1M
    const cost = estimateCostUSD('some-unknown-model', {
      freshInputTokens: 1_000_000,
      cacheReadTokens: 1_000_000,
      cacheCreationTokens: 1_000_000,
      outputTokens: 1_000_000,
    });
    // 3 (fresh) + 0.3 (cache read) + 3.75 (cache write) + 15 (output) = 22.05
    expect(cost).toBeCloseTo(22.05, 6);
  });

  it('no cache tokens: matches the pre-FLUX-1375 fresh-input-only formula', async () => {
    const { estimateCostUSD } = await import('./task-store.js');
    const cost = estimateCostUSD(undefined, { freshInputTokens: 500_000, outputTokens: 100_000 });
    expect(cost).toBeCloseTo((500_000 * 3 + 100_000 * 15) / 1_000_000, 6);
  });

  it('a real cache-read-heavy resumed turn no longer gets billed at the full input rate', async () => {
    const { estimateCostUSD } = await import('./task-store.js');
    // A warm resumed turn: mostly cache-read context, a little fresh input.
    const cost = estimateCostUSD(undefined, {
      freshInputTokens: 200,
      cacheReadTokens: 50_000,
      outputTokens: 300,
    });
    const blendedAtFullRate = ((200 + 50_000) * 3 + 300 * 15) / 1_000_000;
    expect(cost).toBeLessThan(blendedAtFullRate);
  });

  it('loadPricingDoc + a matching model hint: honors the doc-declared cache-read/cache-write rates over the default ratio', async () => {
    const fsPromises = await import('fs/promises');
    vi.mocked(fsPromises.default.readFile).mockResolvedValue(
      '| model | input_per_1m | output_per_1m | cache_read_per_1m | cache_write_per_1m |\n' +
      '|---|---|---|---|---|\n' +
      '| claude-opus-4-5 | 75 | 375 | 7.5 | 93.75 |\n' as unknown as never,
    );
    const { loadPricingDoc, estimateCostUSD } = await import('./task-store.js');
    await loadPricingDoc();

    const cost = estimateCostUSD('claude-opus-4-5', {
      freshInputTokens: 1_000_000,
      cacheReadTokens: 1_000_000,
      cacheCreationTokens: 1_000_000,
      outputTokens: 1_000_000,
    });
    // 75 (fresh, matched row) + 7.5 (doc cache-read rate, NOT 75*0.1=7.5 coincidentally equal here —
    // see the next assertion for a case that actually distinguishes doc rate from the default ratio)
    // + 93.75 (doc cache-write rate) + 375 (output) = 551.25
    expect(cost).toBeCloseTo(551.25, 6);
  });

  it('loadPricingDoc: a doc cache rate that DIFFERS from the 0.1x/1.25x default is honored, not overridden', async () => {
    const fsPromises = await import('fs/promises');
    vi.mocked(fsPromises.default.readFile).mockResolvedValue(
      '| model | input_per_1m | output_per_1m | cache_read_per_1m | cache_write_per_1m |\n' +
      '|---|---|---|---|---|\n' +
      '| custom-model | 10 | 50 | 0.5 | 2 |\n' as unknown as never,
    );
    const { loadPricingDoc, estimateCostUSD } = await import('./task-store.js');
    await loadPricingDoc();

    const cost = estimateCostUSD('custom-model', { freshInputTokens: 0, cacheReadTokens: 1_000_000, cacheCreationTokens: 1_000_000, outputTokens: 0 });
    // Default ratio would give 10*0.1=1 (read) + 10*1.25=12.5 (write) = 13.5 — the doc's explicit
    // 0.5 + 2 = 2.5 must win instead.
    expect(cost).toBeCloseTo(2.5, 6);
  });
});
