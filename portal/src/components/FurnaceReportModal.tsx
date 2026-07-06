// FLUX-1039: renders a terminal batch's assembled `FurnaceReport` (PRs opened / parked / failed,
// breaker/stop state, next actions) — previously computed engine-side but never shown in the portal.

import { useEffect, useRef } from 'react';
import { Flame, X, AlertTriangle, ExternalLink } from 'lucide-react';
import type { FurnaceBatch, FurnaceReportLine } from '../furnaceTypes';
import { TicketRefChip } from './TicketRefChip';
import { fmtDuration } from '../lib/furnaceFormat';
import { FURNACE_ACCENT } from './FurnaceDrawer';

interface Props {
  batch: FurnaceBatch;
  onClose: () => void;
}

// Counts already broken out into their own line-item sections below — no need to repeat them
// as bare numbers too.
const SECTIONED_STATES = new Set(['pr-open', 'parked', 'failed']);

export function FurnaceReportModal({ batch, onClose }: Props) {
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Read live from the prop (not snapshotted at open time) so this stays correct across the
  // drawer's 3s poll — bail quietly if the batch somehow no longer carries a report.
  const report = batch.report;
  if (!report) return null;

  const duration = fmtDuration(report.startedAt, report.endedAt);
  const otherCounts = Object.entries(report.counts).filter(([state, n]) => !!n && !SECTIONED_STATES.has(state));

  return (
    <div className="fixed inset-0 z-[2000] flex items-center justify-center p-4" style={{ background: 'rgba(0,0,0,.5)' }} onClick={onClose}>
      <div
        role="dialog" aria-modal="true" aria-labelledby="furnace-report-title"
        className="flex w-full max-w-lg flex-col rounded-xl text-xs"
        style={{ background: 'var(--eh-surface)', border: `1px solid ${FURNACE_ACCENT}`, maxHeight: '85vh', color: 'var(--eh-text-primary)' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 border-b px-4 py-3 flex-shrink-0" style={{ borderColor: 'var(--eh-border)' }}>
          <Flame className="h-4 w-4 flex-shrink-0" style={{ color: FURNACE_ACCENT }} />
          <span id="furnace-report-title" className="min-w-0 flex-1 truncate text-[13px] font-semibold">{batch.title} — burn report</span>
          <button ref={closeRef} onClick={onClose} title="Close" aria-label="Close report" className="flex-shrink-0 rounded p-0.5" style={{ color: 'var(--eh-text-secondary)' }}>
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-4 py-3">
          <div className="flex flex-wrap items-center gap-3 text-[11px]" style={{ color: 'var(--eh-text-secondary)' }}>
            <span>processed <b style={{ color: 'var(--eh-text-primary)' }}>{report.processed}</b></span>
            {duration && <span>{duration} elapsed</span>}
            {otherCounts.map(([state, n]) => (
              <span key={state}>{state.replace(/-/g, ' ')} <b style={{ color: 'var(--eh-text-primary)' }}>{n}</b></span>
            ))}
          </div>

          {(report.breakerTripped || report.stopReason) && (
            <div className="mt-2 flex items-start gap-1.5 rounded px-2 py-1.5 text-[11px]" style={{ background: 'rgba(245,158,11,.12)', color: '#f59e0b' }}>
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" />
              <span>{report.breakerTripped ? 'Circuit breaker tripped. ' : ''}{report.stopReason ?? ''}</span>
            </div>
          )}

          <ReportSection title="PRs opened" lines={report.prsOpened} />
          <ReportSection title="Parked" lines={report.parked} />
          <ReportSection title="Failed" lines={report.failed} />

          {report.nextActions && report.nextActions.length > 0 && (
            <div className="mt-3">
              <SectionHeader>Next actions</SectionHeader>
              <ul className="mt-1 flex flex-col gap-0.5 pl-4 text-[11px]" style={{ color: 'var(--eh-text-secondary)', listStyleType: 'disc' }}>
                {report.nextActions.map((a, i) => <li key={i}>{a}</li>)}
              </ul>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function SectionHeader({ children }: { children: React.ReactNode }) {
  return <div className="text-[10px] font-bold uppercase tracking-wider" style={{ color: 'var(--eh-text-muted)' }}>{children}</div>;
}

function ReportSection({ title, lines }: { title: string; lines: FurnaceReportLine[] }) {
  if (lines.length === 0) return null;
  return (
    <div className="mt-3">
      <SectionHeader>{title} ({lines.length})</SectionHeader>
      <div className="mt-1 flex flex-col gap-1">
        {lines.map((line) => (
          <div key={line.ticketId} className="flex flex-col gap-0.5">
            <div className="flex items-center gap-1.5">
              <TicketRefChip ticketId={line.ticketId} />
              {line.title && <span className="min-w-0 flex-1 truncate" style={{ color: 'var(--eh-text-secondary)' }}>{line.title}</span>}
              {line.prUrl && (
                <a href={line.prUrl} target="_blank" rel="noreferrer" title="Open pull request" aria-label={`Open pull request for ${line.ticketId}`} onClick={(e) => e.stopPropagation()}>
                  <ExternalLink className="h-3 w-3" style={{ color: '#818cf8' }} />
                </a>
              )}
            </div>
            {line.reason && <div className="pl-1 text-[10px]" style={{ color: 'var(--eh-text-secondary)' }}>{line.reason}</div>}
          </div>
        ))}
      </div>
    </div>
  );
}
