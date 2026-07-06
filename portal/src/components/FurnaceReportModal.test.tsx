// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { FurnaceReportModal } from './FurnaceReportModal';
import { DockProvider } from './DockProvider';
import { appStore } from '../store/appStore';
import { AppActionsContext } from '../store/useAppSelector';
import type { AppActions } from '../store/appStore';
import type { Config } from '../types';
import type { FurnaceBatch, FurnaceReport } from '../furnaceTypes';

// FLUX-1210 regression: a batch report persisted before the `merged` bucket was added has no
// `merged` key at all on disk. `ReportSection` used to do `lines.length` with no undefined-guard,
// which threw for any such legacy report — and since the portal has a single top-level
// ErrorBoundary, that crash white-screened the whole app, not just this modal.

function stubActions<T extends object>(): T {
  return new Proxy({}, { get: () => () => {} }) as T;
}

const CONFIG: Config = {
  columns: [{ name: 'Todo' }, { name: 'Done' }],
  hiddenStatuses: [],
  users: [],
  tags: [],
  priorities: [],
  projects: [],
  enableBacklogScreen: true,
  requireCommentOnStatusChange: false,
  requireInputStatus: 'Require Input',
  readyForMergeStatus: 'Ready',
  animationsEnabled: false,
};

const BASE_REPORT: FurnaceReport = {
  generatedAt: '2026-07-01T00:00:00.000Z',
  counts: {},
  prsOpened: [{ ticketId: 'FLUX-1' }],
  merged: [],
  parked: [],
  failed: [],
  processed: 1,
  breakerTripped: false,
};

function mkBatch(report: FurnaceReport): FurnaceBatch {
  return {
    id: 'b1',
    title: 'Test batch',
    kind: 'parallel',
    branch: 'flux/test',
    status: 'done',
    tickets: [],
    burnRate: 1,
    retryCap: 2,
    exhaustionRetryCap: 2,
    rateLimitRetryIntervalMs: 0,
    rateLimitMaxWaitMs: 0,
    maxConsecutiveFailures: 3,
    consecutiveFailures: 0,
    reviewDepth: 'single',
    createdAt: '2026-07-01T00:00:00.000Z',
    updatedAt: '2026-07-01T00:00:00.000Z',
    prs: [],
    report,
  };
}

function renderModal(report: FurnaceReport) {
  const actions = stubActions<AppActions>();
  appStore.patch({ tasks: [], config: CONFIG, tasksLoading: false, currentProject: 'test-project' });
  render(
    <AppActionsContext.Provider value={actions}>
      <DockProvider>
        <FurnaceReportModal batch={mkBatch(report)} onClose={() => {}} />
      </DockProvider>
    </AppActionsContext.Provider>,
  );
}

describe('FurnaceReportModal', () => {
  afterEach(() => cleanup());

  it('does not crash when a persisted report predates the `merged` field (FLUX-1210)', () => {
    // Simulate a legacy sidecar loaded straight from JSON: no `merged` key at all.
    const legacyReport = { ...BASE_REPORT } as Partial<FurnaceReport>;
    delete legacyReport.merged;
    expect(() => renderModal(legacyReport as FurnaceReport)).not.toThrow();
    expect(screen.getByText(/PRs opened/)).toBeTruthy();
    expect(screen.queryByText(/^Merged/)).toBeNull();
  });

  it('renders the Merged section when the report has merged tickets', () => {
    renderModal({ ...BASE_REPORT, merged: [{ ticketId: 'FLUX-2' }] });
    expect(screen.getByText(/Merged \(1\)/)).toBeTruthy();
  });
});
