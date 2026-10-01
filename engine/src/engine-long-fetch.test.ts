import { describe, it, expect } from 'vitest';
import { ENGINE_FETCH_MAX_MS, ENGINE_FETCH_SLACK_MS, engineFetchTimeoutMs } from './engine-long-fetch.js';

describe('engineLongFetch timeout', () => {
  it('extends past undici\'s 300s default so a 600s delegate wait is not the first to die', () => {
    expect(ENGINE_FETCH_SLACK_MS).toBe(30_000);
    expect(ENGINE_FETCH_MAX_MS).toBe(630_000);
    expect(engineFetchTimeoutMs(600_000)).toBe(630_000);
    expect(engineFetchTimeoutMs(300_000)).toBeGreaterThan(300_000);
  });
});
