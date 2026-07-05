import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { recordFullRescan, recordWorkspaceActivation } from './rescan-timing.js';
import { snapshot, resetForTest } from './registry.js';
import { log } from '../log.js';

describe('rescan timing', () => {
  beforeEach(() => {
    resetForTest();
    delete process.env.EH_PERF_SLOW_RESCAN_MS;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('records the duration under store.fullRescan', () => {
    recordFullRescan(42);
    const { histograms } = snapshot();
    expect(histograms['store.fullRescan']?.count).toBe(1);
    expect(histograms['store.fullRescan']?.max).toBe(42);
  });

  it('accumulates multiple calls (e.g. initDir() nested inside activateWorkspace())', () => {
    recordFullRescan(10);
    recordFullRescan(20);
    expect(snapshot().histograms['store.fullRescan']?.count).toBe(2);
  });

  it('warns when a rescan exceeds the slow threshold (default 1000ms)', () => {
    const warnSpy = vi.spyOn(log, 'warn').mockImplementation(() => {});
    recordFullRescan(1500);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0]![0]).toMatch(/slow full rescan/i);
  });

  it('does not warn under the threshold', () => {
    const warnSpy = vi.spyOn(log, 'warn').mockImplementation(() => {});
    recordFullRescan(500);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('respects the EH_PERF_SLOW_RESCAN_MS override', () => {
    process.env.EH_PERF_SLOW_RESCAN_MS = '100';
    const warnSpy = vi.spyOn(log, 'warn').mockImplementation(() => {});
    recordFullRescan(200);
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });
});

describe('workspace-activation timing (FLUX-1184)', () => {
  beforeEach(() => {
    resetForTest();
    delete process.env.EH_PERF_SLOW_ACTIVATION_MS;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('records the duration under store.workspaceActivation, separate from store.fullRescan', () => {
    recordWorkspaceActivation(42);
    const { histograms } = snapshot();
    expect(histograms['store.workspaceActivation']?.count).toBe(1);
    expect(histograms['store.workspaceActivation']?.max).toBe(42);
    expect(histograms['store.fullRescan']).toBeUndefined();
  });

  it('does not also log "slow full rescan" — a slow activation gets its own distinct warning', () => {
    const warnSpy = vi.spyOn(log, 'warn').mockImplementation(() => {});
    recordWorkspaceActivation(2500);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0]![0]).toMatch(/slow workspace activation/i);
    expect(warnSpy.mock.calls[0]![0]).not.toMatch(/slow full rescan/i);
  });

  it('does not warn under the slow-activation threshold (default 2000ms)', () => {
    const warnSpy = vi.spyOn(log, 'warn').mockImplementation(() => {});
    recordWorkspaceActivation(1500);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('respects the EH_PERF_SLOW_ACTIVATION_MS override', () => {
    process.env.EH_PERF_SLOW_ACTIVATION_MS = '100';
    const warnSpy = vi.spyOn(log, 'warn').mockImplementation(() => {});
    recordWorkspaceActivation(200);
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it('one boot (initDir() nested inside activateWorkspace()) now produces one sample per metric, not two on the same one', () => {
    recordFullRescan(1200); // initDir()'s own disk-scan duration
    recordWorkspaceActivation(1800); // activateWorkspace()'s umbrella duration
    const { histograms } = snapshot();
    expect(histograms['store.fullRescan']?.count).toBe(1);
    expect(histograms['store.workspaceActivation']?.count).toBe(1);
  });
});
