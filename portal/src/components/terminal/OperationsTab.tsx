import { useState, useEffect, useRef, useMemo, useCallback, memo } from 'react';
import { fetchRecentOperations } from '../../api';
import { useAppSelector } from '../../store/useAppSelector';
import { mergeOperations } from '../../lib/mergeOperations';
import { formatClockTime } from '../../lib/formatClockTime';
import { FilterChipRow } from './FilterChipRow';
import type { OperationEvent, OperationKind, OperationOutcome } from '../../types';

// ─── Operations Tab (S11, epic FLUX-996, FLUX-1007) ───────────────────────────
// Dev-only tail of S9's operation-telemetry stream (git/gh/spawn/handshake). No new SSE
// plumbing: every `broadcastEvent('operation', ...)` already lands in the shared
// `engineEvents` ring buffer via AppContext's catch-all `eh-event` listener (FLUX-1030) —
// this tab is a pure consumer that filters that buffer plus a one-time GET /api/operations
// backfill for history that predates the panel being opened.

type KindFilter = 'All' | OperationKind;
type OutcomeFilter = 'All' | OperationOutcome;

const KINDS: KindFilter[] = ['All', 'git', 'gh', 'spawn', 'handshake'];
const OUTCOMES: OutcomeFilter[] = ['All', 'ok', 'timeout', 'error', 'aborted'];

const OUTCOME_BADGE: Record<OperationOutcome, string> = {
  ok: 'text-emerald-400 border-emerald-500/40',
  timeout: 'text-amber-400 border-amber-500/40',
  error: 'text-red-400 border-red-500/40',
  aborted: 'text-red-400 border-red-500/40',
};

// Memoized so an appended operation only mounts one new row (FLUX-1139) — mirrors
// EngineEventRow in TerminalPanel.tsx.
const OperationRow = memo(function OperationRow({ op }: { op: OperationEvent }) {
  const ts = formatClockTime(op.endedAt);
  return (
    <div className="flex items-center gap-2 min-w-0" title={op.cmd}>
      <span className="shrink-0 text-gray-600">{ts}</span>
      <span className={`shrink-0 px-1.5 rounded border text-[10px] font-semibold ${OUTCOME_BADGE[op.outcome]}`}>{op.outcome}</span>
      <span className="shrink-0 px-1.5 rounded border border-gray-600 text-[10px] text-gray-400">{op.kind}</span>
      <span className="text-gray-300 truncate max-w-[320px]">{op.cmd}</span>
      <span className="shrink-0 text-gray-500">{op.durationMs}ms</span>
      {(op.ticketId || op.sessionId) && (
        <span className="shrink-0 text-gray-600">
          {op.ticketId ?? ''}{op.sessionId ? ` #${op.sessionId.slice(0, 8)}` : ''}
        </span>
      )}
      {op.outcome !== 'ok' && op.reason && (
        <span className="text-red-300/80 truncate">{op.reason}</span>
      )}
    </div>
  );
});

export function OperationsTab({ isActive }: { isActive: boolean }) {
  const [kindFilter, setKindFilter] = useState<KindFilter>('All');
  const [outcomeFilter, setOutcomeFilter] = useState<OutcomeFilter>('All');
  const [search, setSearch] = useState('');
  const [backfill, setBackfill] = useState<OperationEvent[]>([]);
  const backfilledRef = useRef(false);
  const containerRef = useRef<HTMLDivElement>(null);
  // Same "stick to bottom" fix as EngineEventsTab (FLUX-1115) — only auto-follow while the
  // user is already at/near the bottom; otherwise leave scroll position alone.
  const stuckToBottomRef = useRef(true);
  const [stuckToBottom, setStuckToBottom] = useState(true);
  const baselineCountRef = useRef(0);
  const isConnected = useAppSelector(s => s.isConnected);
  const engineEvents = useAppSelector(s => s.engineEvents);

  // Backfill once, the first time this tab is actually shown — mirrors AppContext's
  // reconcile-on-open pattern rather than fetching eagerly for a tab nobody opens.
  useEffect(() => {
    if (!isActive || backfilledRef.current) return;
    backfilledRef.current = true;
    fetchRecentOperations().then(setBackfill).catch(() => {});
  }, [isActive]);

  // Skip the filter/map over the (up to ENGINE_EVENTS_MAX-sized) shared buffer entirely
  // while this tab isn't visible — mirrors EngineEventsTab's isActive gate (FLUX-1115).
  // merged/filtered downstream become trivial (just the bounded backfill) while inactive.
  const live = useMemo(() => {
    if (!isActive) return [];
    return engineEvents.filter(e => e.type === 'operation').map(e => e.data as OperationEvent);
  }, [engineEvents, isActive]);

  const merged = useMemo(() => mergeOperations(backfill, live), [backfill, live]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return merged.filter(op => {
      if (kindFilter !== 'All' && op.kind !== kindFilter) return false;
      if (outcomeFilter !== 'All' && op.outcome !== outcomeFilter) return false;
      if (q) {
        const haystack = `${op.cmd} ${op.reason ?? ''} ${op.ticketId ?? ''}`.toLowerCase();
        if (!haystack.includes(q)) return false;
      }
      return true;
    });
  }, [merged, kindFilter, outcomeFilter, search]);

  const handleScroll = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    const stuck = distanceFromBottom < 48;
    if (stuck !== stuckToBottomRef.current) {
      stuckToBottomRef.current = stuck;
      setStuckToBottom(stuck);
      if (!stuck) baselineCountRef.current = filtered.length;
    }
  }, [filtered.length]);

  const jumpToBottom = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    stuckToBottomRef.current = true;
    setStuckToBottom(true);
  }, []);

  useEffect(() => {
    if (isActive && stuckToBottomRef.current) {
      const el = containerRef.current;
      if (el) el.scrollTop = el.scrollHeight;
    }
  }, [filtered.length, isActive]);

  const unseenCount = !stuckToBottom ? Math.max(0, filtered.length - baselineCountRef.current) : 0;

  return (
    <div className="flex-1 flex flex-col overflow-hidden relative" style={{ display: isActive ? 'flex' : 'none' }}>
      <div className="flex items-center gap-2.5 px-3 py-2 border-b flex-wrap" style={{ borderColor: 'var(--eh-border)', background: 'var(--eh-column-bg)' }}>
        <FilterChipRow label="Filter by kind" options={KINDS} value={kindFilter} onChange={setKindFilter} />
        <span className="text-gray-700">|</span>
        <FilterChipRow label="Filter by outcome" options={OUTCOMES} value={outcomeFilter} onChange={setOutcomeFilter} />
        <input
          type="text"
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Search cmd / reason / ticket…"
          className="px-2 py-0.5 rounded text-[11px] border w-44"
          style={{ background: 'var(--eh-base)', borderColor: 'var(--eh-border)', color: 'var(--eh-text-primary)' }}
        />
        <div className="ml-auto flex items-center gap-1.5">
          <div className={`h-1.5 w-1.5 rounded-full ${isConnected ? 'bg-emerald-500' : 'bg-red-500 animate-pulse'}`} />
          <span className="text-[10px]" style={{ color: 'var(--eh-text-muted)' }}>{isConnected ? 'Connected' : 'Offline'}</span>
        </div>
      </div>
      <div
        ref={containerRef}
        onScroll={handleScroll}
        className="flex-1 overflow-y-auto overflow-x-auto font-mono text-[11px] p-2 space-y-1"
        style={{ background: '#1e1e1e', color: '#d4d4d4' }}
      >
        {filtered.length === 0 && (
          <div className="text-gray-500 italic py-4 text-center">No operations yet — waiting for git/gh/spawn/handshake activity…</div>
        )}
        {filtered.map(op => (
          <OperationRow key={op.opId} op={op} />
        ))}
      </div>
      {!stuckToBottom && unseenCount > 0 && (
        <button
          onClick={jumpToBottom}
          className="absolute bottom-3 left-1/2 -translate-x-1/2 px-3 py-1 rounded-full text-[11px] font-semibold shadow-lg cursor-pointer border transition-colors"
          style={{ background: 'var(--eh-accent)', borderColor: 'var(--eh-accent)', color: '#fff' }}
        >
          ↓ {unseenCount} new event{unseenCount !== 1 ? 's' : ''}
        </button>
      )}
    </div>
  );
}
