// The Furnace — batch drawer (FLUX-1053).
//
// First-class batches. A batch is a named bucket of tickets the Furnace burns unattended
// (implement → review → re-implement ≤ retryCap → leave the PR open at Ready; never merges). Two kinds:
//   sequential — tickets share ONE branch + ONE PR on one worktree, burning in order;
//   parallel   — each ticket its own worktree + PR at burnRate (1–4) concurrency.
//
// Board-anchored: rendered inside the board's dnd-kit DndContext (see Board.tsx) as a fixed right-edge
// panel over the Done column. Board cards can be dragged onto a batch (append) or the New-batch zone
// (create). Clicking a ticket ref opens its NORMAL dock chat (shared TicketRefChip → useDockActions),
// not a bespoke inline surface (FLUX-1061).

import { createElement, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Flame, Bolt, Zap, Layers, FlaskConical, Filter, Play, Square, Plus, Pencil, ExternalLink,
  Check, GitMerge, AlertTriangle, Clock, X, Trash2, Search, RotateCcw, Hand, Undo2,
} from 'lucide-react';
import { useDroppable } from '@dnd-kit/core';
import { useAppSelector, useConfig, useTaskById } from '../store/useAppSelector';
import {
  fetchFurnaceBatches, fetchFurnaceSlots, createFurnaceBatch, updateFurnaceBatch,
  appendFurnaceTicket, removeFurnaceTicket, igniteFurnaceBatch, stopFurnaceBatch, deleteFurnaceBatch,
  mergeFurnaceBatch, retryFurnaceTicket, resumeFurnaceBatch, dismissFurnaceTicket,
  takeoverFurnaceTicket, handBackFurnaceTicket,
} from '../api';
import type {
  FurnaceBatch, BatchTicket, BatchTicketState, BatchStatus, BatchKind, SlotInfo, BatchPr,
} from '../furnaceTypes';
import { MAX_BURN_RATE, FURNACE_REFRESH_EVENT, FURNACE_NEW_DROP_ID, furnaceBatchDropId } from '../furnaceTypes';
import { searchTasks } from '../taskSearch';
import type { LucideIcon } from 'lucide-react';
import { getStatusTint } from '../statusStyles';
import { useDockActions } from './DockProvider';
import { TicketRefChip } from './TicketRefChip';

const POLL_MS = 3000;

// FLUX-1061: the Furnace's own purple/violet accent, a CONSTANT across themes (see index.css). Used
// wherever the drawer previously leaked `var(--eh-accent, #7c3aed)` (green under matrix / purple fallback).
const FURNACE_ACCENT = 'var(--eh-furnace-accent)';
const FURNACE_ACCENT_GLOW = 'var(--eh-furnace-accent-glow)';

const ICON_BY_KEY: Record<string, LucideIcon> = {
  bolt: Bolt, beaker: FlaskConical, layers: Layers, flame: Flame, zap: Zap, filter: Filter,
};
function iconFor(batch: FurnaceBatch): LucideIcon {
  return (batch.icon && ICON_BY_KEY[batch.icon]) || Layers;
}

const STATE_META: Record<BatchTicketState, { label: string; dot: string; text: string }> = {
  queued:         { label: 'queued',        dot: '#a8a29e', text: 'var(--eh-text-secondary)' },
  implementing:   { label: 'impl',          dot: '#22c55e', text: '#22c55e' },
  reviewing:      { label: 'review',        dot: '#0ea5e9', text: '#0ea5e9' },
  reimplementing: { label: 're-impl',       dot: '#e05a00', text: '#e05a00' },
  'cooling-down': { label: 'cooling',       dot: '#38bdf8', text: '#38bdf8' },
  'pr-open':      { label: 'PR open',       dot: '#8b5cf6', text: '#8b5cf6' },
  parked:         { label: 'parked',        dot: '#f59e0b', text: '#f59e0b' },
  failed:         { label: 'failed',        dot: '#ef4444', text: '#ef4444' },
  skipped:        { label: 'skipped',       dot: '#a8a29e', text: 'var(--eh-text-secondary)' },
};

const STATUS_CHIP: Record<BatchStatus, { label: string; bg: string; fg: string }> = {
  draft:   { label: 'draft',   bg: 'var(--eh-surface-raised)', fg: 'var(--eh-text-secondary)' },
  burning: { label: 'burning', bg: 'rgba(34,197,94,.14)', fg: '#22c55e' },
  done:    { label: 'done',    bg: 'rgba(139,92,246,.14)', fg: '#8b5cf6' },
  parked:  { label: 'parked',  bg: 'rgba(245,158,11,.14)', fg: '#f59e0b' },
};

function fmtDuration(from?: string, to?: string): string | null {
  if (!from) return null;
  const start = Date.parse(from);
  const end = to ? Date.parse(to) : Date.now();
  if (Number.isNaN(start) || Number.isNaN(end) || end < start) return null;
  const mins = Math.round((end - start) / 60000);
  if (mins < 60) return `${mins}m`;
  return `${Math.floor(mins / 60)}h ${mins % 60}m`;
}

interface DrawerProps { embedded?: boolean; onClose?: () => void }

export function FurnaceDrawer({ onClose }: DrawerProps) {
  const [batches, setBatches] = useState<FurnaceBatch[]>([]);
  const [slots, setSlots] = useState<SlotInfo>({ used: 0, free: MAX_BURN_RATE, max: MAX_BURN_RATE });
  const [error, setError] = useState<string | null>(null);
  // Gates the empty-state message until the first refresh resolves, so opening the drawer
  // doesn't flash "No batches yet" before the fetch lands.
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  const [newKind, setNewKind] = useState<BatchKind>('parallel');
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  // New-batch drop zone (a board card dropped here creates a fresh batch — see Board.handleDragEnd).
  const { setNodeRef: setNewDropRef, isOver: newIsOver } = useDroppable({ id: FURNACE_NEW_DROP_ID });

  const refresh = useCallback(async () => {
    try {
      const [b, s] = await Promise.all([fetchFurnaceBatches(), fetchFurnaceSlots()]);
      setBatches(b);
      setSlots(s);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load the Furnace');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    timer.current = setInterval(() => { void refresh(); }, POLL_MS);
    const onRefresh = () => { void refresh(); };
    window.addEventListener(FURNACE_REFRESH_EVENT, onRefresh);
    return () => {
      if (timer.current) clearInterval(timer.current);
      window.removeEventListener(FURNACE_REFRESH_EVENT, onRefresh);
    };
  }, [refresh]);

  const createBatch = useCallback(async () => {
    const title = newTitle.trim() || 'New batch';
    try {
      await createFurnaceBatch({ title, kind: newKind });
      setNewTitle('');
      setCreating(false);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to create batch');
    }
  }, [newTitle, newKind, refresh]);

  const burning = batches.filter((b) => b.status === 'burning');
  const drafts = batches.filter((b) => b.status === 'draft');
  const completed = batches.filter((b) => b.status === 'done' || b.status === 'parked');

  return (
    <div className="flex h-full flex-col text-xs" style={{ color: 'var(--eh-text-primary)', background: 'var(--eh-base)' }}>
      {/* Header */}
      <div className="flex items-center gap-2 px-3 py-2 border-b flex-shrink-0" style={{ borderColor: 'var(--eh-border)' }}>
        <Flame className="h-4 w-4" style={{ color: burning.length ? FURNACE_ACCENT : 'var(--eh-text-secondary)' }} />
        <span className="text-[13px] font-semibold flex-1">Furnace</span>
        {burning.length > 0 && <span className="text-[10px]" style={{ color: 'var(--eh-text-secondary)' }}>{burning.length} burning</span>}
        {onClose && (
          <button onClick={onClose} title="Close" aria-label="Close the Furnace" className="rounded p-0.5" style={{ color: 'var(--eh-text-secondary)' }}><X className="h-3.5 w-3.5" /></button>
        )}
      </div>

      <SlotBar slots={slots} />
      {error && (
        <div className="mx-3 mt-2 rounded px-2 py-1 text-[11px]" style={{ background: 'rgba(239,68,68,.12)', color: '#ef4444' }}>{error}</div>
      )}
      <div className="flex-1 overflow-y-auto px-2 py-2 flex flex-col gap-2">
        {!loading && batches.length === 0 && (
          <div className="px-3 py-8 text-center text-[11px]" style={{ color: 'var(--eh-text-secondary)' }}>
            No batches yet. Create one below (or drag a board card here), then add tickets and ignite.
          </div>
        )}

        {burning.length > 0 && <SectionLabel>Burning</SectionLabel>}
        {burning.map((b) => <BatchCard key={b.id} batch={b} slots={slots} onChanged={refresh} />)}

        {drafts.length > 0 && <SectionLabel>Draft</SectionLabel>}
        {drafts.map((b) => <BatchCard key={b.id} batch={b} slots={slots} onChanged={refresh} />)}

        {completed.length > 0 && <SectionLabel>Completed</SectionLabel>}
        {completed.map((b) => <BatchCard key={b.id} batch={b} slots={slots} onChanged={refresh} />)}

        {/* New batch creator / drop zone */}
        {creating ? (
          <div className="rounded-lg border p-2 flex flex-col gap-2" style={{ borderColor: 'var(--eh-border)', background: 'var(--eh-surface)' }}>
            <input
              autoFocus
              value={newTitle}
              onChange={(e) => setNewTitle(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') void createBatch(); if (e.key === 'Escape') setCreating(false); }}
              placeholder="Batch title…"
              className="rounded px-2 py-1 text-xs outline-none"
              style={{ background: 'var(--eh-input-bg)', border: '1px solid var(--eh-border)', color: 'var(--eh-text-primary)' }}
            />
            <div className="flex items-center gap-2">
              <KindToggle kind={newKind} onChange={setNewKind} />
              <span className="flex-1" />
              <button className="rounded px-2 py-1 font-semibold" style={{ background: FURNACE_ACCENT, color: '#fff' }} onClick={() => void createBatch()}>Create</button>
              <button className="rounded px-2 py-1" style={{ border: '1px solid var(--eh-border)', color: 'var(--eh-text-secondary)' }} onClick={() => setCreating(false)}>Cancel</button>
            </div>
          </div>
        ) : (
          <button
            ref={setNewDropRef}
            onClick={() => setCreating(true)}
            className="rounded-lg border border-dashed py-3 text-[11px] flex items-center justify-center gap-1.5 transition-colors"
            style={{ borderColor: newIsOver ? FURNACE_ACCENT : 'var(--eh-border)', color: newIsOver ? FURNACE_ACCENT : 'var(--eh-text-secondary)', background: newIsOver ? FURNACE_ACCENT_GLOW : 'transparent' }}
          >
            <Plus className="h-3.5 w-3.5" /> {newIsOver ? 'Drop to create a new batch' : 'New batch'}
          </button>
        )}
      </div>
    </div>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return <div className="px-1 pt-1 text-[10px] font-bold uppercase tracking-wider" style={{ color: 'var(--eh-text-muted)' }}>{children}</div>;
}

function KindToggle({ kind, onChange, disabled }: { kind: BatchKind; onChange: (k: BatchKind) => void; disabled?: boolean }) {
  return (
    <div className="inline-flex rounded overflow-hidden" style={{ border: '1px solid var(--eh-border)', opacity: disabled ? 0.5 : 1 }}>
      {(['parallel', 'sequential'] as BatchKind[]).map((k) => (
        <button
          key={k}
          disabled={disabled}
          onClick={() => !disabled && onChange(k)}
          className="px-2 py-0.5 text-[10px] font-medium"
          title={k === 'sequential' ? 'Tickets share one branch + PR, burned in order' : 'Each ticket its own branch + PR, burned concurrently'}
          style={{ background: kind === k ? FURNACE_ACCENT : 'transparent', color: kind === k ? '#fff' : 'var(--eh-text-secondary)' }}
        >
          {k}
        </button>
      ))}
    </div>
  );
}

function SlotBar({ slots }: { slots: SlotInfo }) {
  const pips = Array.from({ length: slots.max }, (_, i) => i < slots.used);
  return (
    <div className="flex items-center gap-2 px-3 py-1.5 border-b flex-shrink-0" style={{ borderColor: 'var(--eh-border)', background: 'var(--eh-surface)' }}>
      <span className="text-[10px]" style={{ color: 'var(--eh-text-secondary)' }}>Worktree slots</span>
      <div className="flex gap-1">
        {pips.map((used, i) => (
          <div key={i} className="h-1.5 w-4 rounded-sm" style={{ background: used ? FURNACE_ACCENT : 'var(--eh-border)' }} />
        ))}
      </div>
      <span className="text-[10px]" style={{ color: 'var(--eh-text-secondary)' }}><b style={{ color: 'var(--eh-text-primary)' }}>{slots.used}</b> / {slots.max} used</span>
    </div>
  );
}

function BatchCard({ batch, slots, onChanged }: { batch: FurnaceBatch; slots: SlotInfo; onChanged: () => Promise<void> }) {
  const tasks = useAppSelector((s) => s.tasks);
  // FLUX-1061: open a furnace ticket in the shared dock chat (same surface the rest of the portal uses)
  // instead of a bespoke inline ChatView. Used by the Completed-summary re-impl action.
  const { openTicket } = useDockActions();
  const [renaming, setRenaming] = useState(false);
  const [titleDraft, setTitleDraft] = useState(batch.title);
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState(false);
  const [addQuery, setAddQuery] = useState('');
  const [noSlot, setNoSlot] = useState(false);
  // Escape cancels a rename; this flag lets the resulting onBlur bail out instead of
  // committing the edited-but-cancelled title (the Escape/blur race).
  const renameCancelled = useRef(false);
  // Optimistic burn-rate while dragging the slider, so the thumb tracks the pointer instead of
  // snapping back to server state on every PATCH tick. Cleared once the batch prop catches up.
  const [burnDraft, setBurnDraft] = useState<number | null>(null);
  // A board card dragged onto this card is appended to the batch (see Board.handleDragEnd).
  const { setNodeRef, isOver } = useDroppable({ id: furnaceBatchDropId(batch.id) });

  const isBurning = batch.status === 'burning';
  const isDraft = batch.status === 'draft';
  const isTerminal = batch.status === 'done' || batch.status === 'parked';

  const counts = useMemo(() => {
    // FLUX-1063: a `cooling-down` ticket (rate-limit wait) is still in-flight work — count it as active
    // so the header total agrees with the visible rows instead of silently dropping it.
    const active = batch.tickets.filter((t) => t.state === 'implementing' || t.state === 'reviewing' || t.state === 'reimplementing' || t.state === 'cooling-down').length;
    const queued = batch.tickets.filter((t) => t.state === 'queued').length;
    return { active, queued, total: batch.tickets.length };
  }, [batch.tickets]);

  const run = useCallback(async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try { await fn(); await onChanged(); } finally { setBusy(false); }
  }, [onChanged]);

  const startRename = useCallback(() => {
    renameCancelled.current = false;
    setTitleDraft(batch.title);
    setRenaming(true);
  }, [batch.title]);

  const commitRename = useCallback(async () => {
    // Escape already reset the draft and closed the editor — the trailing onBlur must not re-commit.
    if (renameCancelled.current) { renameCancelled.current = false; return; }
    const title = titleDraft.trim();
    setRenaming(false);
    if (!title || title === batch.title) { setTitleDraft(batch.title); return; }
    await run(() => updateFurnaceBatch(batch.id, { title }));
  }, [titleDraft, batch.title, batch.id, run]);

  // Clear the optimistic burn-rate once the server state reflects the committed value.
  useEffect(() => {
    if (burnDraft !== null && batch.burnRate === burnDraft) setBurnDraft(null);
  }, [batch.burnRate, burnDraft]);

  const shownBurn = burnDraft ?? Math.min(batch.burnRate, MAX_BURN_RATE);
  const commitBurn = useCallback((v: number) => {
    setBurnDraft(v);
    if (v !== batch.burnRate) void run(() => updateFurnaceBatch(batch.id, { burnRate: v }));
  }, [batch.burnRate, batch.id, run]);

  const onIgnite = useCallback(async () => {
    setBusy(true);
    try {
      const r = await igniteFurnaceBatch(batch.id);
      if (!r.ok && r.noSlots) { setNoSlot(true); return; }
      await onChanged();
    } finally { setBusy(false); }
  }, [batch.id, onChanged]);

  // FLUX-1066: resume a halted (parked) batch → burning. Same no-slot handling as ignite.
  const onResume = useCallback(async () => {
    setBusy(true);
    try {
      const r = await resumeFurnaceBatch(batch.id);
      if (!r.ok && r.noSlots) { setNoSlot(true); return; }
      await onChanged();
    } finally { setBusy(false); }
  }, [batch.id, onChanged]);

  const onDelete = useCallback(() => {
    // Drafts hold unsaved config/tickets, so confirm before discarding. Terminal batches are already
    // done — delete straight away. Burning batches never reach this control (engine also 409s).
    if (isDraft && !window.confirm(`Delete draft batch "${batch.title}"? This can't be undone.`)) return;
    void run(() => deleteFurnaceBatch(batch.id));
  }, [isDraft, batch.title, batch.id, run]);

  const addResults = useMemo(() => (addQuery.trim() ? searchTasks(tasks, addQuery, 6) : []), [tasks, addQuery]);
  const igniteDisabled = busy || slots.free < 1 || batch.tickets.length === 0;

  return (
    <div ref={setNodeRef} className="rounded-lg border transition-colors" style={{ borderColor: isOver ? FURNACE_ACCENT : 'var(--eh-border)', background: isOver ? FURNACE_ACCENT_GLOW : isBurning ? 'rgba(34,197,94,.05)' : 'var(--eh-surface)' }}>
      {/* Header */}
      <div className="flex items-start gap-2 p-2">
        <div className="flex h-7 w-7 items-center justify-center rounded flex-shrink-0" style={{ background: 'var(--eh-surface-raised)' }}>
          {createElement(iconFor(batch), { className: 'h-3.5 w-3.5', style: { color: FURNACE_ACCENT } })}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            {renaming ? (
              <input
                autoFocus
                value={titleDraft}
                onChange={(e) => setTitleDraft(e.target.value)}
                onBlur={() => void commitRename()}
                onKeyDown={(e) => { if (e.key === 'Enter') void commitRename(); if (e.key === 'Escape') { renameCancelled.current = true; setRenaming(false); setTitleDraft(batch.title); } }}
                className="w-full rounded px-1 py-0.5 text-xs font-semibold outline-none"
                style={{ background: 'var(--eh-input-bg)', border: `1px solid ${FURNACE_ACCENT}`, color: 'var(--eh-text-primary)' }}
              />
            ) : (
              // FLUX-1062 (#2): the title itself is click-to-rename (spec rev 5); the pencil stays as a
              // secondary affordance for discoverability.
              <span onClick={startRename} className="truncate text-xs font-semibold cursor-text hover:underline" title="Click to rename">{batch.title}</span>
            )}
            {!renaming && (
              <button onClick={startRename} title="Rename" aria-label="Rename batch" className="flex-shrink-0">
                <Pencil className="h-3 w-3" style={{ color: 'var(--eh-text-muted)' }} />
              </button>
            )}
          </div>
          {renaming && !isDraft && (
            <div className="mt-0.5 flex items-center gap-1 text-[10px]" style={{ color: '#f59e0b' }}>
              <AlertTriangle className="h-2.5 w-2.5" /> The branch name will NOT be renamed — display name only.
            </div>
          )}
          <div className="mt-0.5 truncate font-mono text-[10px]" style={{ color: 'var(--eh-text-muted)' }} title={batch.branch}>{batch.branch}</div>
        </div>
        <div className="flex items-center gap-1.5 flex-shrink-0">
          <span className="rounded px-1.5 py-0.5 text-[10px] font-semibold" style={{ background: STATUS_CHIP[batch.status].bg, color: STATUS_CHIP[batch.status].fg }}>{STATUS_CHIP[batch.status].label}</span>
        </div>
      </div>

      {/* Kind + trigger row */}
      <div className="flex items-center gap-2 px-2 pb-1">
        <KindToggle kind={batch.kind} disabled={!isDraft || busy} onChange={(k) => void run(() => updateFurnaceBatch(batch.id, { kind: k }))} />
        {batch.trigger && (
          <span className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px]" style={{ background: 'rgba(167,139,250,.12)', color: '#a78bfa' }}>
            <Clock className="h-2.5 w-2.5" /> after {batch.trigger.type}
          </span>
        )}
      </div>

      {/* Stats (burning) */}
      {isBurning && (
        <div className="flex flex-wrap gap-3 px-2 pb-1 text-[10px]" style={{ color: 'var(--eh-text-secondary)' }}>
          <span>tickets <b style={{ color: 'var(--eh-text-primary)' }}>{counts.total}</b></span>
          <span>burning <b style={{ color: '#22c55e' }}>{counts.active}</b></span>
          <span>queued <b style={{ color: 'var(--eh-text-primary)' }}>{counts.queued}</b></span>
          {fmtDuration(batch.ignitedAt) && <span>{fmtDuration(batch.ignitedAt)} elapsed</span>}
        </div>
      )}

      {/* Ticket rows */}
      <div className="border-t" style={{ borderColor: 'var(--eh-border)' }}>
        {batch.tickets.map((t) => (
          <TicketRow key={t.ticketId} ticket={t} batch={batch} onChanged={onChanged} onRemove={() => void run(() => removeFurnaceTicket(batch.id, t.ticketId))} />
        ))}
        {batch.tickets.length === 0 && (
          <div className="px-2 py-2 text-[11px]" style={{ color: 'var(--eh-text-secondary)' }}>No tickets — add some (or drag a board card here) before igniting.</div>
        )}
      </div>

      {/* Add-ticket search */}
      {adding && (
        <div className="px-2 py-1.5 border-t" style={{ borderColor: 'var(--eh-border)' }}>
          <div className="flex items-center gap-1 rounded px-1.5 py-1" style={{ background: 'var(--eh-surface-raised)' }}>
            <Search className="h-3 w-3" style={{ color: 'var(--eh-text-muted)' }} />
            <input autoFocus value={addQuery} onChange={(e) => setAddQuery(e.target.value)} placeholder="Search tickets…" className="flex-1 bg-transparent text-[11px] outline-none" style={{ color: 'var(--eh-text-primary)' }} />
          </div>
          {addResults.map((r) => (
            <button key={r.task.id} onClick={() => void run(async () => { await appendFurnaceTicket(batch.id, r.task.id); setAdding(false); setAddQuery(''); })}
              className="mt-1 flex w-full items-center gap-1.5 rounded px-1.5 py-1 text-left text-[11px]" style={{ background: 'var(--eh-surface)' }}>
              <span className="font-mono font-medium" style={{ color: 'var(--eh-text-primary)' }}>{r.task.id}</span>
              <span className="truncate" style={{ color: 'var(--eh-text-secondary)' }}>{r.task.title}</span>
            </button>
          ))}
        </div>
      )}

      {/* Completed summary */}
      {isTerminal && batch.prs.length > 0 && <CompletedSummary batch={batch} onOpenTicket={openTicket} onChanged={onChanged} />}

      {/* Controls */}
      <div className="flex items-center gap-2 border-t px-2 py-1.5" style={{ borderColor: 'var(--eh-border)' }}>
        {batch.kind === 'parallel' && !isTerminal && (
          <>
            <span className="text-[10px]" style={{ color: 'var(--eh-text-secondary)' }}>Burn</span>
            <input
              type="range" min={1} max={MAX_BURN_RATE} value={shownBurn}
              aria-label="Burn rate"
              onChange={(e) => setBurnDraft(Number(e.target.value))}
              onPointerUp={(e) => commitBurn(Number((e.target as HTMLInputElement).value))}
              onKeyUp={(e) => commitBurn(Number((e.target as HTMLInputElement).value))}
              className="flex-1" style={{ accentColor: FURNACE_ACCENT }}
            />
            <span className="w-3 text-center text-[11px] font-bold">{shownBurn}</span>
          </>
        )}
        {batch.kind === 'sequential' && !isTerminal && <span className="flex-1 text-[10px]" style={{ color: 'var(--eh-text-secondary)' }}>ordered · one shared PR</span>}
        {isTerminal && <span className="flex-1" />}

        {!isTerminal && !adding && (
          <button onClick={() => setAdding(true)} title="Add ticket" aria-label="Add ticket to batch" className="rounded px-1.5 py-1" style={{ border: '1px solid var(--eh-border)', color: 'var(--eh-text-secondary)' }}>
            <Plus className="h-3 w-3" />
          </button>
        )}
        {isBurning ? (
          <button disabled={busy} onClick={() => void run(() => stopFurnaceBatch(batch.id))} className="inline-flex items-center gap-1 rounded px-2 py-1 text-[10px] font-semibold" style={{ background: 'rgba(127,29,29,.5)', color: '#fca5a5' }}>
            <Square className="h-3 w-3" /> Stop
          </button>
        ) : (
          <>
            {/* FLUX-1062 (#1): drafts are deletable too (engine already supports it — only burning is 409'd). */}
            <button disabled={busy} onClick={onDelete} title="Delete batch" aria-label="Delete batch" className="rounded px-1.5 py-1" style={{ border: '1px solid var(--eh-border)', color: 'var(--eh-text-secondary)' }}>
              <Trash2 className="h-3 w-3" />
            </button>
            {isDraft && (
              <button disabled={igniteDisabled} onClick={() => void onIgnite()} title={slots.free < 1 ? 'No worktree slots available' : 'Ignite'}
                className="inline-flex items-center gap-1 rounded px-2 py-1 text-[10px] font-semibold" style={{ background: igniteDisabled ? 'var(--eh-surface-raised)' : FURNACE_ACCENT, color: igniteDisabled ? 'var(--eh-text-muted)' : '#fff', cursor: igniteDisabled ? 'not-allowed' : 'pointer' }}>
                <Play className="h-3 w-3" /> Ignite
              </button>
            )}
            {/* FLUX-1066: a halted (parked) batch is resumable — reset the breaker + re-burn its remaining work. */}
            {batch.status === 'parked' && (
              <button disabled={busy || slots.free < 1} onClick={() => void onResume()} title={slots.free < 1 ? 'No worktree slots available' : 'Resume — reset the breaker and re-burn'}
                className="inline-flex items-center gap-1 rounded px-2 py-1 text-[10px] font-semibold" style={{ background: busy || slots.free < 1 ? 'var(--eh-surface-raised)' : FURNACE_ACCENT, color: busy || slots.free < 1 ? 'var(--eh-text-muted)' : '#fff', cursor: busy || slots.free < 1 ? 'not-allowed' : 'pointer' }}>
                <Play className="h-3 w-3" /> Resume
              </button>
            )}
          </>
        )}
      </div>

      {noSlot && <NoSlotPopup slots={slots} onClose={() => setNoSlot(false)} />}
    </div>
  );
}

function TicketRow({ ticket, batch, onChanged, onRemove }: { ticket: BatchTicket; batch: FurnaceBatch; onChanged: () => Promise<void>; onRemove: () => void }) {
  const meta = STATE_META[ticket.state];
  const canRemove = !(batch.status === 'burning' && ticket.state !== 'queued');
  // FLUX-1061 (#2/#3): the id is the shared enriched chip (status dot + hover mini-card + Open chat /
  // Open ticket), and the title is colored by BOARD status via the same statusStyles helpers the chip
  // uses — resolved from the live task, so a status change recolors the row. Falls back to the burn-state
  // dot color when the ticket isn't in the store (e.g. a stale/removed board card).
  const config = useConfig();
  const task = useTaskById(ticket.ticketId);
  const titleColor = task ? `rgb(${getStatusTint(config, task.status).rgb})` : meta.text;
  const [busy, setBusy] = useState(false);

  // FLUX-1066: the ROW badge — a taken-over ticket reads "you're driving this" (owner beats state), and a
  // park splits by failure class so the cause is legible (needs-input vs a hard failure), never a bare "parked".
  const badge = ticketBadge(ticket, meta);
  // Recovery affordances: a human-owned ticket can be handed back; a parked/failed one can be retried /
  // taken over / dismissed. No dead ends — every non-happy row offers at least one next action.
  const isHuman = ticket.owner === 'human';
  const isParkedOrFailed = ticket.state === 'parked' || ticket.state === 'failed';

  const act = useCallback(async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try { await fn(); await onChanged(); } finally { setBusy(false); }
  }, [onChanged]);

  return (
    <div className="group flex items-center gap-1.5 px-2 py-1 text-[11px]">
      <TicketRefChip ticketId={ticket.ticketId} />
      <span className="truncate flex-1" style={{ color: titleColor }} title={ticket.note || ticket.title}>{ticket.title}</span>
      {ticket.prUrl && <a href={ticket.prUrl} target="_blank" rel="noreferrer" title="Open pull request" aria-label={`Open pull request for ${ticket.ticketId}`} onClick={(e) => e.stopPropagation()}><ExternalLink className="h-3 w-3" style={{ color: '#818cf8' }} /></a>}
      <span className="rounded px-1 py-0.5 text-[10px] flex-shrink-0" style={{ color: badge.color }} title={ticket.note || badge.label}>{badge.label}</span>

      {/* Recovery actions (FLUX-1066) */}
      {isHuman && (
        <button disabled={busy} onClick={() => void act(() => handBackFurnaceTicket(batch.id, ticket.ticketId))} title="Hand back to the Furnace" aria-label={`Hand ${ticket.ticketId} back to the Furnace`} className="flex-shrink-0">
          <Undo2 className="h-3 w-3" style={{ color: '#a78bfa' }} />
        </button>
      )}
      {!isHuman && isParkedOrFailed && (
        <>
          <button disabled={busy} onClick={() => void act(() => retryFurnaceTicket(batch.id, ticket.ticketId))} title="Retry — fresh attempt" aria-label={`Retry ${ticket.ticketId}`} className="flex-shrink-0">
            <RotateCcw className="h-3 w-3" style={{ color: '#38bdf8' }} />
          </button>
          <button disabled={busy} onClick={() => void act(() => takeoverFurnaceTicket(batch.id, ticket.ticketId))} title="Take over — you drive it" aria-label={`Take over ${ticket.ticketId}`} className="flex-shrink-0">
            <Hand className="h-3 w-3" style={{ color: '#a78bfa' }} />
          </button>
          {!ticket.flagDismissed && (
            <button disabled={busy} onClick={() => void act(() => dismissFurnaceTicket(batch.id, ticket.ticketId))} title="Dismiss flag — I've got this" aria-label={`Dismiss the flag on ${ticket.ticketId}`} className="flex-shrink-0">
              <Check className="h-3 w-3" style={{ color: 'var(--eh-text-muted)' }} />
            </button>
          )}
        </>
      )}

      {canRemove && (
        <button onClick={onRemove} title="Remove from batch" aria-label={`Remove ${ticket.ticketId} from batch`} className="opacity-0 group-hover:opacity-100 flex-shrink-0">
          <X className="h-3 w-3" style={{ color: 'var(--eh-text-muted)' }} />
        </button>
      )}
    </div>
  );
}

/**
 * FLUX-1066: the row badge. Ownership beats state — a human-owned ticket reads "you're driving this". A
 * park is split by failure class so the cause + next action are legible instead of one opaque "parked".
 */
function ticketBadge(ticket: BatchTicket, meta: { label: string; text: string }): { label: string; color: string } {
  if (ticket.owner === 'human') return { label: 'you’re driving', color: '#a78bfa' };
  if (ticket.state === 'parked' && ticket.failureClass === 'needs-input') return { label: 'needs input', color: '#f59e0b' };
  if (ticket.state === 'failed' || ticket.failureClass === 'hard-fail') return { label: 'failed', color: '#ef4444' };
  return { label: meta.label, color: meta.text };
}

function prcStyle(state: BatchPr['reviewState']): { label: string; bg: string; fg: string; icon: LucideIcon } {
  switch (state) {
    case 'approved': return { label: 'approved', bg: 'rgba(34,197,94,.12)', fg: '#4ade80', icon: Check };
    case 'changes_requested': return { label: 'changes', bg: 'rgba(224,90,0,.12)', fg: '#fb923c', icon: AlertTriangle };
    case 'merged': return { label: 'merged', bg: 'rgba(96,165,250,.12)', fg: '#60a5fa', icon: GitMerge };
    default: return { label: 'pending', bg: 'var(--eh-surface-raised)', fg: 'var(--eh-text-secondary)', icon: Clock };
  }
}

function CompletedSummary({ batch, onOpenTicket, onChanged }: { batch: FurnaceBatch; onOpenTicket: (ticketId: string) => void; onChanged: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const allMerged = batch.prs.length > 0 && batch.prs.every((p) => p.reviewState === 'merged');
  const hasApproved = batch.prs.some((p) => p.reviewState === 'approved');

  const merge = useCallback(async (prBranch?: string) => {
    setBusy(true); setErr(null);
    try {
      const r = await mergeFurnaceBatch(batch.id, prBranch);
      if (r.failed.length) setErr(`${r.failed.length} PR(s) failed to merge: ${r.failed.map((f) => f.error).join('; ')}`);
      await onChanged();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Merge failed');
    } finally { setBusy(false); }
  }, [batch.id, onChanged]);

  return (
    <div className="border-t px-2 py-2" style={{ borderColor: 'var(--eh-border)', background: 'rgba(139,92,246,.04)' }}>
      <div className="mb-1.5 flex items-center gap-1 text-[10px] font-bold" style={{ color: allMerged ? '#60a5fa' : '#8b5cf6' }}>
        {allMerged ? <GitMerge className="h-3 w-3" /> : <Check className="h-3 w-3" />} {allMerged ? 'Merged' : `Batch complete — ${batch.prs.length} PR(s)`}
      </div>
      {batch.prs.map((pr) => {
        const c = prcStyle(pr.reviewState);
        return (
          <div key={pr.url} className="flex items-center gap-1.5 py-0.5">
            <span className="text-[10px]" style={{ color: 'var(--eh-text-muted)' }}>PR</span>
            <a href={pr.url} target="_blank" rel="noreferrer" className="min-w-0 flex-1 truncate font-mono text-[11px]" style={{ color: pr.reviewState === 'merged' ? 'var(--eh-text-muted)' : '#818cf8', textDecoration: pr.reviewState === 'merged' ? 'line-through' : 'none' }}>
              {pr.number ? `#${pr.number} ` : ''}{pr.branch}
            </a>
            <span className="inline-flex items-center gap-1 rounded px-1 py-0.5 text-[10px] flex-shrink-0" style={{ background: c.bg, color: c.fg }}>
              {createElement(c.icon, { className: 'h-2.5 w-2.5' })} {c.label}
            </span>
            {pr.reviewState === 'approved' && (
              <button disabled={busy} onClick={() => void merge(pr.branch)} title="Merge this PR" className="rounded px-1.5 py-0.5 text-[10px] font-semibold flex-shrink-0" style={{ background: 'rgba(96,165,250,.16)', color: '#60a5fa' }}>Merge</button>
            )}
            {pr.reviewState === 'changes_requested' && pr.ticketId && (
              <button onClick={() => onOpenTicket(pr.ticketId!)} title="Open the ticket to re-implement" className="rounded px-1.5 py-0.5 text-[10px] font-semibold flex-shrink-0" style={{ border: '1px solid var(--eh-border)', color: 'var(--eh-text-secondary)' }}>Re-impl</button>
            )}
          </div>
        );
      })}
      {hasApproved && (
        <button disabled={busy} onClick={() => void merge()} className="mt-1.5 w-full rounded px-2 py-1 text-[10px] font-semibold" style={{ background: '#60a5fa', color: '#08131f' }}>
          {busy ? 'Merging…' : 'Merge approved'}
        </button>
      )}
      {err && <div className="mt-1 text-[10px]" style={{ color: '#f87171' }}>{err}</div>}
    </div>
  );
}

function NoSlotPopup({ slots, onClose }: { slots: SlotInfo; onClose: () => void }) {
  const okRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    okRef.current?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-[2000] flex items-center justify-center" style={{ background: 'rgba(0,0,0,.4)' }} onClick={onClose}>
      <div role="dialog" aria-modal="true" aria-labelledby="furnace-noslot-title" className="max-w-[280px] rounded-xl p-4" style={{ background: 'var(--eh-surface)', border: `1px solid ${FURNACE_ACCENT}` }} onClick={(e) => e.stopPropagation()}>
        <div id="furnace-noslot-title" className="mb-1.5 flex items-center gap-1.5 text-xs font-bold"><AlertTriangle className="h-3.5 w-3.5" style={{ color: FURNACE_ACCENT }} /> No worktree slots available</div>
        <div className="mb-2.5 text-[11px]" style={{ color: 'var(--eh-text-secondary)' }}>
          All {slots.max} worktree slots are occupied ({slots.used} used). Stop or wait for a running batch to free a slot before igniting a new one.
        </div>
        <div className="mb-2.5 flex gap-1">
          {Array.from({ length: slots.max }, (_, i) => (
            <div key={i} className="h-1.5 w-5 rounded-sm" style={{ background: i < slots.used ? FURNACE_ACCENT : 'var(--eh-border)' }} />
          ))}
        </div>
        <button ref={okRef} onClick={onClose} className="rounded px-3 py-1 text-[11px] font-semibold" style={{ background: FURNACE_ACCENT, color: '#fff' }}>Got it</button>
      </div>
    </div>
  );
}

export default FurnaceDrawer;
