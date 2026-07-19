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

import { createElement, memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Flame, Play, Square, Plus, Pencil, ExternalLink,
  Check, GitMerge, AlertTriangle, Clock, X, Trash2, Search, RotateCcw, Hand, Undo2, GripVertical,
  FileText, Bot,
} from 'lucide-react';
import { useDroppable, DndContext, closestCenter, type DragEndEvent } from '@dnd-kit/core';
import { SortableContext, useSortable, verticalListSortingStrategy, arrayMove } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { useAppSelector, useAppActions, useConfig, useTaskById } from '../store/useAppSelector';
import {
  fetchFurnaceBatches, fetchFurnaceSlots, createFurnaceBatch, updateFurnaceBatch,
  appendFurnaceTicket, removeFurnaceTicket, igniteFurnaceBatch, stopFurnaceBatch, deleteFurnaceBatch,
  mergeFurnaceBatch, retryFurnaceTicket, resumeFurnaceBatch, dismissFurnaceTicket,
  takeoverFurnaceTicket, handBackFurnaceTicket, startTaskCliSessionEx, fetchTaskCliSession,
  FURNACE_CONVERSATION_ID,
} from '../api';
import type {
  FurnaceBatch, BatchTicket, BatchTicketState, BatchStatus, BatchKind, SlotInfo, BatchPr, FurnaceSlotHolder, BatchTrigger,
} from '../furnaceTypes';
import { MAX_BURN_RATE, FURNACE_REFRESH_EVENT, FURNACE_NEW_DROP_ID, furnaceBatchDropId } from '../furnaceTypes';
import { searchTasks } from '../taskSearch';
import type { LucideIcon } from 'lucide-react';
import { getStatusTint } from '../statusStyles';
import { STATE_META } from '../lib/memberState';
import { useDockActions } from './DockProvider';
import { TicketRefChip } from './TicketRefChip';
import { FurnaceReportModal } from './FurnaceReportModal';
import { fmtDuration } from '../lib/furnaceFormat';
import { mergeFurnaceBatches } from '../lib/mergeFurnaceBatches';
import { useEscapeKey } from '../hooks/useEscapeKey';
import { useConfirm } from '../hooks/useConfirm';
import { iconFor } from './furnace/furnaceVisuals';

const POLL_MS = 3000;
// FLUX-1487: a batch's ticket list collapses behind a "+ N more" row past this many rows.
const TICKET_PREVIEW_COUNT = 5;

// FLUX-1061: the Furnace's own purple/violet accent, a CONSTANT across themes (see index.css). Used
// wherever the drawer previously leaked `var(--eh-accent, #7c3aed)` (green under matrix / purple fallback).
// Exported (FLUX-1039) so FurnaceReportModal reuses the same tokens instead of duplicating the CSS var strings.
export const FURNACE_ACCENT = 'var(--eh-furnace-accent)';
export const FURNACE_ACCENT_GLOW = 'var(--eh-furnace-accent-glow)';

const STATUS_CHIP: Record<BatchStatus, { label: string; bg: string; fg: string }> = {
  draft:   { label: 'draft',   bg: 'var(--eh-surface-raised)', fg: 'var(--eh-text-secondary)' },
  // FLUX-1487: burning reads as the furnace identity (orange) — a finished burn is the "success" green.
  burning: { label: 'burning', bg: FURNACE_ACCENT_GLOW, fg: FURNACE_ACCENT },
  done:    { label: 'done',    bg: 'rgba(34,197,94,.14)', fg: '#22c55e' },
  parked:  { label: 'parked',  bg: 'rgba(245,158,11,.14)', fg: '#f59e0b' },
};

// FLUX-1487: per-ticket progress-segments row on a burning batch card. Actively-working states pulse
// green (matches the board's own running-session language); a finished/PR-open ticket reads accent
// (the furnace identity); a stuck (parked/failed) ticket reads the deep-red heat-edge color so it
// doesn't get lost among neutral queued segments; queued stays neutral.
const TICKET_PROGRESS_ACTIVE = new Set<BatchTicketState>(['implementing', 'reviewing', 'reimplementing', 'cooling-down']);
function ticketProgressColor(ticket: BatchTicket): string {
  if (TICKET_PROGRESS_ACTIVE.has(ticket.state)) return '#22c55e';
  if (ticket.state === 'pr-open') return FURNACE_ACCENT;
  if (ticket.state === 'parked' || ticket.state === 'failed') return 'var(--eh-furnace-accent-deep)';
  return 'var(--eh-border)';
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

  // FLUX-1175: the Furnace Operator ("Smelter") chat entry point + its drafting/operator
  // authority mode. The mode is a workspace-wide setting (config.furnaceSettings.smelterMode,
  // default 'drafting') — the engine composes the matching authority contract into the
  // Smelter's resolved prompt at launch (see resolvePersonaPrompt in orchestration-personas.ts).
  // FLUX-1234: the interactive mode *control* now lives in the Smelter chat header (see
  // SmelterModeToggle, rendered by ChatDock for the Furnace conversation) — it governs the Smelter
  // agent, so it belongs with the agent. The drawer keeps only a read-only indicator of the mode.
  const config = useConfig();
  const { openChat } = useDockActions();
  const [startingSmelter, setStartingSmelter] = useState(false);
  const smelterMode = config?.furnaceSettings?.smelterMode === 'operator' ? 'operator' : 'drafting';

  // FLUX-1209: Smelter's chat now launches on its own FURNACE_CONVERSATION_ID — a distinct,
  // resumable conversation — instead of riding on (and relabeling) the board orchestrator's.
  const chatWithSmelter = useCallback(async () => {
    setStartingSmelter(true);
    setError(null);
    try {
      // FLUX-1238: if a Smelter chat already exists, just reopen/focus the window — never
      // re-launch. Mirror the engine's own start guard (cli-session.ts): a running/pending
      // session would 409 ("already active"), and a waiting-input session would be cancelled
      // and re-prompted. Only a missing (null) or terminal session falls through to cold-start.
      const existing = await fetchTaskCliSession(FURNACE_CONVERSATION_ID).catch(() => null);
      const alreadyOpen = existing && (
        existing.status === 'running' || existing.status === 'pending' || existing.status === 'waiting-input'
      );
      if (alreadyOpen) {
        openChat(FURNACE_CONVERSATION_ID);
        return; // reopen only — never re-launch
      }
      await startTaskCliSessionEx(FURNACE_CONVERSATION_ID, {
        personaId: 'smelter',
        phase: 'chat',
      });
      openChat(FURNACE_CONVERSATION_ID);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to start a Smelter chat');
    } finally {
      setStartingSmelter(false);
    }
  }, [openChat]);

  const refresh = useCallback(async () => {
    try {
      const [b, s] = await Promise.all([fetchFurnaceBatches(), fetchFurnaceSlots()]);
      // FLUX-1196: an idle poll returns byte-identical data every ~3s. Reusing the previous
      // batch references (and bailing the slots update entirely when unchanged) means `setState`
      // sees the SAME value it already holds and skips the re-render — no commit, no child churn.
      setBatches((prev) => mergeFurnaceBatches(prev, b));
      setSlots((prev) => (prev.used === s.used && prev.free === s.free && prev.max === s.max ? prev : s));
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

  // FLUX-1487: pressing Escape while the floating panel is open now closes it — previously only
  // sub-popovers (TriggerPopover, NoSlotPopup) consumed Escape at all.
  useEscapeKey(() => onClose?.(), { enabled: !!onClose });

  return (
    <div className="flex h-full flex-col text-xs" style={{ color: 'var(--eh-text-primary)', background: 'var(--eh-base)' }}>
      {/* Header */}
      <div className="flex items-center gap-2.5 px-3 py-2.5 border-b flex-shrink-0" style={{ borderColor: 'var(--eh-border)' }}>
        <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-xl" style={{ background: FURNACE_ACCENT_GLOW }}>
          <Flame className="h-4 w-4" style={{ color: FURNACE_ACCENT }} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-semibold leading-tight">Furnace</div>
          <div className="flex items-center gap-1 text-[10px] leading-tight" style={{ color: 'var(--eh-text-secondary)' }}>
            {burning.length > 0 ? (
              <>
                <span className="h-1.5 w-1.5 flex-shrink-0 animate-pulse rounded-full" style={{ background: FURNACE_ACCENT }} />
                {burning.length} batch{burning.length === 1 ? '' : 'es'} burning
              </>
            ) : (
              'Idle'
            )}
          </div>
        </div>
        <SlotMeter slots={slots} />
        {onClose && (
          <button onClick={onClose} title="Close" aria-label="Close the Furnace" className="rounded p-0.5 flex-shrink-0" style={{ color: 'var(--eh-text-secondary)' }}><X className="h-3.5 w-3.5" /></button>
        )}
      </div>

      {/* FLUX-1175: the Furnace Operator ("Smelter") — chat entry point.
          FLUX-1234: the drafting/operator authority *control* moved into the Smelter chat header
          (SmelterModeToggle). The drawer keeps a read-only indicator of the current mode, so the
          batch surface still communicates the Smelter's authority without owning the setting.
          Drafting (default): every real ignite/stop/resume/retry needs your confirmation in-chat.
          Operator: full autonomous burn-lifecycle authority once you ask it to manage a burn. */}
      <div className="flex items-center gap-2 px-3 py-1.5 border-b flex-shrink-0" style={{ borderColor: 'var(--eh-border)' }}>
        <button
          onClick={() => void chatWithSmelter()}
          disabled={startingSmelter}
          title="Talk to the Furnace Operator — plan a burn or troubleshoot a parked batch"
          className="inline-flex items-center gap-1.5 rounded px-2 py-1 text-[11px] font-medium disabled:opacity-50"
          style={{ background: `linear-gradient(135deg, ${FURNACE_ACCENT}, var(--eh-furnace-accent-deep))`, color: '#fff' }}
        >
          <Bot className="h-3.5 w-3.5" /> {startingSmelter ? 'Starting…' : 'Chat with Smelter'}
        </button>
        <span className="flex-1" />
        <span
          className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium"
          title={`Smelter mode: ${smelterMode}. Change it in the Smelter chat (Chat with Smelter). Drafting = every real burn action needs confirmation; Operator = autonomous burn-lifecycle authority.`}
          style={{ border: '1px solid var(--eh-border)', color: 'var(--eh-text-secondary)' }}
        >
          <span style={{ color: 'var(--eh-text-muted)' }}>Mode</span>
          <span style={{ color: FURNACE_ACCENT }}>{smelterMode}</span>
        </span>
      </div>

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
        {burning.map((b) => <BatchCard key={b.id} batch={b} allBatches={batches} slots={slots} onChanged={refresh} />)}

        {drafts.length > 0 && <SectionLabel>Draft</SectionLabel>}
        {drafts.map((b) => <BatchCard key={b.id} batch={b} allBatches={batches} slots={slots} onChanged={refresh} />)}

        {completed.length > 0 && <SectionLabel>Completed</SectionLabel>}
        {completed.map((b) => <BatchCard key={b.id} batch={b} allBatches={batches} slots={slots} onChanged={refresh} />)}

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
            className="rounded-lg border border-dashed py-4 text-[11px] flex items-center justify-center gap-1.5 transition-colors"
            style={{ borderColor: newIsOver ? FURNACE_ACCENT : 'var(--eh-border)', color: newIsOver ? FURNACE_ACCENT : 'var(--eh-text-secondary)', background: newIsOver ? FURNACE_ACCENT_GLOW : 'transparent' }}
          >
            <Plus className="h-3.5 w-3.5" /> {newIsOver ? 'Drop to create a new batch' : 'New batch'}
          </button>
        )}
      </div>
    </div>
  );
}

// FLUX-1234: the Smelter's authority toggle (drafting vs operator). Moved out of the Furnace drawer
// header (where it read like a batch-level control) into the Smelter chat header — ChatDock renders
// this for the Furnace conversation, so the setting sits with the agent it governs. It reads/writes
// the SAME workspace-wide config.furnaceSettings.smelterMode (no schema change); the engine composes
// the matching authority contract into the Smelter's prompt at launch. Compact, so it fits the chat
// title bar; pointer-down is stopped so a click doesn't start dragging the title bar (the parent
// title bar is a drag handle in ChatDock).
export function SmelterModeToggle() {
  const config = useConfig();
  const { saveConfig } = useAppActions();
  const smelterMode = config?.furnaceSettings?.smelterMode === 'operator' ? 'operator' : 'drafting';

  const setSmelterMode = useCallback(async (mode: 'drafting' | 'operator') => {
    if (!config || mode === smelterMode) return;
    await saveConfig({
      ...config,
      furnaceSettings: {
        rateLimitRetryIntervalMs: config.furnaceSettings?.rateLimitRetryIntervalMs ?? 20 * 60 * 1000,
        rateLimitMaxWaitMs: config.furnaceSettings?.rateLimitMaxWaitMs ?? 5 * 60 * 60 * 1000,
        smelterMode: mode,
      },
    });
  }, [config, smelterMode, saveConfig]);

  return (
    <div className="inline-flex items-center gap-1">
      <span className="text-[10px]" style={{ color: 'var(--eh-text-secondary)' }}>Mode</span>
      <div className="inline-flex rounded overflow-hidden" style={{ border: '1px solid var(--eh-border)' }}>
        {(['drafting', 'operator'] as const).map((m) => (
          <button
            key={m}
            type="button"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={() => void setSmelterMode(m)}
            className="px-2 py-0.5 text-[10px] font-medium"
            title={m === 'drafting' ? 'Manual — every real burn action needs your confirmation' : 'Autonomous — full burn-lifecycle authority once asked to manage a burn'}
            style={{ background: smelterMode === m ? FURNACE_ACCENT : 'transparent', color: smelterMode === m ? '#fff' : 'var(--eh-text-secondary)' }}
          >
            {m}
          </button>
        ))}
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

/** FLUX-1487: 1–4 segmented burn-rate stepper (replaces the raw `<input type=range>`) — bar-chart-style,
 *  filled up to the current value. Each segment commits its value directly on click (no drag/release). */
function BurnRateStepper({ value, onCommit }: { value: number; onCommit: (v: number) => void }) {
  return (
    <div className="flex flex-1 items-center gap-1.5">
      <span className="text-[10px]" style={{ color: 'var(--eh-text-secondary)' }}>Burn</span>
      <div className="flex flex-1 items-end gap-0.5" role="group" aria-label="Burn rate">
        {Array.from({ length: MAX_BURN_RATE }, (_, i) => i + 1).map((n) => (
          <button
            key={n}
            type="button"
            onClick={() => onCommit(n)}
            title={`Burn rate ${n}`}
            aria-label={`Set burn rate to ${n}`}
            aria-pressed={value === n}
            className="flex-1 rounded-sm transition-colors"
            style={{ height: `${4 + n * 3}px`, background: n <= value ? FURNACE_ACCENT : 'var(--eh-border)' }}
          />
        ))}
      </div>
      <span className="w-3 text-center text-[11px] font-bold">{value}</span>
    </div>
  );
}

/** Format a `pr`-type trigger ref for display: a GitHub PR URL collapses to `#123`; a bare number gets a `#`. */
function formatPrRef(ref: string): string {
  const m = ref.match(/\/pull\/(\d+)\/?$/);
  if (m) return `#${m[1]}`;
  if (/^\d+$/.test(ref)) return `#${ref}`;
  return ref;
}

/** FLUX-1142: resolve a batch's trigger into a display label + explanatory tooltip. Names the referenced
 *  batch/PR instead of the bare `after {type}` chip that shipped editor-less in PR #262. */
function resolveTriggerLabel(trigger: BatchTrigger | undefined, allBatches: FurnaceBatch[]): { label: string; tooltip: string } | null {
  if (!trigger) return null;
  if (trigger.type === 'batch') {
    const ref = allBatches.find((b) => b.id === trigger.ref);
    if (!ref) return { label: '(deleted batch)', tooltip: 'The referenced batch no longer exists — this trigger will never fire.' };
    return { label: ref.title, tooltip: `Ignites automatically once "${ref.title}" finishes and all its PRs are merged.` };
  }
  return { label: formatPrRef(trigger.ref), tooltip: `Ignites automatically once PR ${trigger.ref} is merged.` };
}

/** The informative trigger badge + (when not burning) its editor popover (FLUX-1142). */
export function TriggerControl({ batch, allBatches, disabled, onChanged }: { batch: FurnaceBatch; allBatches: FurnaceBatch[]; disabled: boolean; onChanged: () => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const resolved = resolveTriggerLabel(batch.trigger, allBatches);
  // FLUX-1199: `disabled` (non-draft) blocks ARMING a new trigger, but a batch that left draft
  // with a trigger already armed still needs a way to clear the now-inert badge. Keep the resolved
  // badge clickable and open the popover in clear-only mode; arming a fresh trigger stays blocked.
  const clearOnly = disabled && !!batch.trigger;

  return (
    <div className="relative">
      {resolved ? (
        <button
          data-trigger-toggle
          onClick={() => setOpen((o) => !o)}
          title={clearOnly ? `${resolved.tooltip} Click to clear.` : `${resolved.tooltip} Click to change.`}
          className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px]"
          style={{ background: FURNACE_ACCENT_GLOW, color: 'var(--eh-furnace-accent-soft)', cursor: 'pointer' }}
        >
          <Clock className="h-2.5 w-2.5" /> after: {resolved.label}
        </button>
      ) : !disabled ? (
        <button
          data-trigger-toggle
          onClick={() => setOpen((o) => !o)}
          title="Auto-ignite this batch once another batch or PR merges"
          className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px]"
          style={{ border: '1px dashed var(--eh-border)', color: 'var(--eh-text-secondary)' }}
        >
          <Clock className="h-2.5 w-2.5" /> + trigger
        </button>
      ) : null}
      {open && (
        <TriggerPopover batch={batch} allBatches={allBatches} clearOnly={clearOnly} onChanged={onChanged} onClose={() => setOpen(false)} />
      )}
    </div>
  );
}

/** Popover editor for a batch's auto-ignite trigger — "after batch" or "after PR", plus a clear action. */
function TriggerPopover({ batch, allBatches, clearOnly, onChanged, onClose }: { batch: FurnaceBatch; allBatches: FurnaceBatch[]; clearOnly: boolean; onChanged: () => Promise<void>; onClose: () => void }) {
  const [mode, setMode] = useState<'batch' | 'pr'>(batch.trigger?.type ?? 'batch');
  const [batchRef, setBatchRef] = useState(batch.trigger?.type === 'batch' ? batch.trigger.ref : '');
  const [prRef, setPrRef] = useState(batch.trigger?.type === 'pr' ? batch.trigger.ref : '');
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // FLUX-1142: ignore clicks on the toggle button ([data-trigger-toggle]) so it can close the
    // popover itself — otherwise the outside-mousedown closes it and the toggle's onClick
    // immediately re-opens it (stuck open). Same fix as ActivityPanel (FLUX-885) / NotificationPanel.
    const onDocDown = (e: MouseEvent) => {
      const target = e.target as Element;
      if (target?.closest?.('[data-trigger-toggle]')) return;
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('mousedown', onDocDown);
    window.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDocDown); window.removeEventListener('keydown', onKey); };
  }, [onClose]);

  // FLUX-1142: only OTHER non-terminal batches are offered, and a candidate whose own trigger already
  // points back at this batch is excluded — that would be a direct A→B→A cycle. Self-reference can't
  // happen since `batch.id` itself is never in the list. The engine re-validates both on save (this is
  // just avoiding a round-trip 400 for the common cases the picker can prevent outright).
  const candidates = useMemo(
    () => allBatches.filter((b) =>
      b.id !== batch.id &&
      (b.status === 'draft' || b.status === 'burning') &&
      !(b.trigger?.type === 'batch' && b.trigger.ref === batch.id),
    ),
    [allBatches, batch.id],
  );

  const canSave = mode === 'batch' ? batchRef.length > 0 : prRef.trim().length > 0;

  const save = useCallback(async (trigger: BatchTrigger | null) => {
    setSaving(true);
    setErr(null);
    try {
      await updateFurnaceBatch(batch.id, { trigger });
      await onChanged();
      onClose();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Failed to update trigger');
    } finally {
      setSaving(false);
    }
  }, [batch.id, onChanged, onClose]);

  // FLUX-1199: the batch has left draft, so the armed trigger is inert and can no longer be
  // re-armed — only cleared. Skip the mode toggle / picker / Save and expose Clear alone.
  if (clearOnly) {
    return (
      <div ref={boxRef} className="absolute left-0 top-full z-30 mt-1 w-56 rounded-lg p-2" style={{ background: 'var(--eh-surface)', border: `1px solid ${FURNACE_ACCENT}`, boxShadow: '0 4px 16px rgba(0,0,0,.3)' }}>
        <div className="mb-1.5 text-[10px]" style={{ color: 'var(--eh-text-secondary)' }}>This batch has left draft — the trigger is inert and can only be cleared.</div>
        {err && <div className="mb-1.5 text-[10px]" style={{ color: '#ef4444' }}>{err}</div>}
        <div className="flex items-center gap-1.5">
          <button disabled={saving} onClick={() => void save(null)} className="rounded px-1.5 py-1 text-[10px]" style={{ border: '1px solid var(--eh-border)', color: 'var(--eh-text-secondary)' }}>Clear</button>
          <span className="flex-1" />
          <button onClick={onClose} className="rounded px-1.5 py-1 text-[10px]" style={{ color: 'var(--eh-text-secondary)' }}>Cancel</button>
        </div>
      </div>
    );
  }

  return (
    <div ref={boxRef} className="absolute left-0 top-full z-30 mt-1 w-56 rounded-lg p-2" style={{ background: 'var(--eh-surface)', border: `1px solid ${FURNACE_ACCENT}`, boxShadow: '0 4px 16px rgba(0,0,0,.3)' }}>
      <div className="mb-1.5 text-[10px] font-semibold" style={{ color: 'var(--eh-text-secondary)' }}>Auto-ignite this batch after…</div>
      <div className="mb-1.5 inline-flex rounded overflow-hidden" style={{ border: '1px solid var(--eh-border)' }}>
        {(['batch', 'pr'] as const).map((m) => (
          <button
            key={m}
            onClick={() => setMode(m)}
            className="px-2 py-0.5 text-[10px] font-medium"
            style={{ background: mode === m ? FURNACE_ACCENT : 'transparent', color: mode === m ? '#fff' : 'var(--eh-text-secondary)' }}
          >
            {m === 'batch' ? 'a batch' : 'a PR'}
          </button>
        ))}
      </div>
      {mode === 'batch' ? (
        candidates.length > 0 ? (
          <select
            autoFocus
            value={batchRef}
            onChange={(e) => setBatchRef(e.target.value)}
            className="mb-1.5 w-full rounded px-1.5 py-1 text-[11px] outline-none"
            style={{ background: 'var(--eh-input-bg)', border: '1px solid var(--eh-border)', color: 'var(--eh-text-primary)' }}
          >
            <option value="">Select a batch…</option>
            {candidates.map((b) => <option key={b.id} value={b.id}>{b.title}</option>)}
          </select>
        ) : (
          <div className="mb-1.5 text-[10px]" style={{ color: 'var(--eh-text-secondary)' }}>No other eligible batches.</div>
        )
      ) : (
        <input
          autoFocus
          value={prRef}
          onChange={(e) => setPrRef(e.target.value)}
          placeholder="PR url or #123"
          className="mb-1.5 w-full rounded px-1.5 py-1 text-[11px] outline-none"
          style={{ background: 'var(--eh-input-bg)', border: '1px solid var(--eh-border)', color: 'var(--eh-text-primary)' }}
        />
      )}
      {err && <div className="mb-1.5 text-[10px]" style={{ color: '#ef4444' }}>{err}</div>}
      <div className="flex items-center gap-1.5">
        {batch.trigger && (
          <button disabled={saving} onClick={() => void save(null)} className="rounded px-1.5 py-1 text-[10px]" style={{ border: '1px solid var(--eh-border)', color: 'var(--eh-text-secondary)' }}>Clear</button>
        )}
        <span className="flex-1" />
        <button onClick={onClose} className="rounded px-1.5 py-1 text-[10px]" style={{ color: 'var(--eh-text-secondary)' }}>Cancel</button>
        <button
          disabled={saving || !canSave}
          onClick={() => void save(mode === 'batch' ? { type: 'batch', ref: batchRef } : { type: 'pr', ref: prRef.trim() })}
          className="rounded px-2 py-1 text-[10px] font-semibold"
          style={{ background: canSave ? FURNACE_ACCENT : 'var(--eh-surface-raised)', color: canSave ? '#fff' : 'var(--eh-text-muted)', cursor: canSave ? 'pointer' : 'not-allowed' }}
        >
          Save
        </button>
      </div>
    </div>
  );
}

/** FLUX-1487: compact worktree-slots meter folded into the drawer header (was its own bordered row). */
function SlotMeter({ slots }: { slots: SlotInfo }) {
  const pips = Array.from({ length: slots.max }, (_, i) => i < slots.used);
  return (
    <div className="flex flex-shrink-0 items-center gap-1.5" title={`${slots.used} / ${slots.max} worktree slots in use`}>
      <div className="flex gap-0.5">
        {pips.map((used, i) => (
          <div
            key={i}
            className="h-3 w-1.5 rounded-sm"
            style={{ background: used ? `linear-gradient(180deg, ${FURNACE_ACCENT}, var(--eh-furnace-accent-deep))` : 'var(--eh-border)' }}
          />
        ))}
      </div>
      <span className="text-[10px]" style={{ color: 'var(--eh-text-secondary)' }}>{slots.used}/{slots.max}</span>
    </div>
  );
}

/**
 * FLUX-1196: `allBatches` is only used to resolve a trigger badge (label + the popover's candidate
 * list) — it doesn't need referential equality, just the handful of fields those care about. This
 * lets a sibling batch's poll update (which always produces a new top-level `batches` array) skip
 * re-rendering every OTHER batch's card, since `allBatches` compares equal even though its array
 * reference changed.
 */
function triggerRelevantBatchesEqual(a: FurnaceBatch[], b: FurnaceBatch[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    if (x.id !== y.id || x.title !== y.title || x.status !== y.status) return false;
    if ((x.trigger?.type ?? '') !== (y.trigger?.type ?? '') || (x.trigger?.ref ?? '') !== (y.trigger?.ref ?? '')) return false;
  }
  return true;
}

const BatchCard = memo(function BatchCard({ batch, allBatches, slots, onChanged }: { batch: FurnaceBatch; allBatches: FurnaceBatch[]; slots: SlotInfo; onChanged: () => Promise<void> }) {
  const tasks = useAppSelector((s) => s.tasks);
  // FLUX-1061: open a furnace ticket in the shared dock chat (same surface the rest of the portal uses)
  // instead of a bespoke inline ChatView. Used by the Completed-summary re-impl action.
  const { openTicket } = useDockActions();
  const [renaming, setRenaming] = useState(false);
  const [titleDraft, setTitleDraft] = useState(batch.title);
  const [busy, setBusy] = useState(false);
  const confirm = useConfirm();
  const [adding, setAdding] = useState(false);
  const [addQuery, setAddQuery] = useState('');
  // null = popup closed; an array (possibly empty) = popup open, naming the current slot holders (FLUX-1157).
  const [noSlot, setNoSlot] = useState<FurnaceSlotHolder[] | null>(null);
  const [viewingReport, setViewingReport] = useState(false);
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

  // FLUX-1196: a stable per-batch handler (vs. a fresh closure per ticket row on every render) so
  // memoized `TicketRow`s don't lose their memoization over an `onRemove` prop that never actually changes.
  const removeTicket = useCallback((ticketId: string) => {
    void run(() => removeFurnaceTicket(batch.id, ticketId));
  }, [batch.id, run]);

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
      if (!r.ok && r.noSlots) { setNoSlot(r.holders ?? []); return; }
      await onChanged();
    } finally { setBusy(false); }
  }, [batch.id, onChanged]);

  // FLUX-1066: resume a halted (parked) batch → burning. Same no-slot handling as ignite.
  const onResume = useCallback(async () => {
    setBusy(true);
    try {
      const r = await resumeFurnaceBatch(batch.id);
      if (!r.ok && r.noSlots) { setNoSlot(r.holders ?? []); return; }
      await onChanged();
    } finally { setBusy(false); }
  }, [batch.id, onChanged]);

  const onDelete = useCallback(async () => {
    // Drafts hold unsaved config/tickets, so confirm before discarding. Terminal batches are already
    // done — delete straight away. Burning batches never reach this control (engine also 409s).
    if (isDraft && !(await confirm({ title: `Delete draft batch "${batch.title}"? This can't be undone.`, tone: 'danger', confirmLabel: 'Delete' }))) return;
    void run(() => deleteFurnaceBatch(batch.id));
  }, [isDraft, batch.title, batch.id, run, confirm]);

  const addResults = useMemo(() => (addQuery.trim() ? searchTasks(tasks, addQuery, 6) : []), [tasks, addQuery]);
  const igniteDisabled = busy || slots.free < 1 || batch.tickets.length === 0;
  // FLUX-1487: a long ticket list collapses behind a "+ N more" row instead of always rendering
  // every row — kept as a plain prefix slice so rail numbering (position in batch.tickets) stays stable.
  const [showAllTickets, setShowAllTickets] = useState(false);
  const visibleTickets = showAllTickets ? batch.tickets : batch.tickets.slice(0, TICKET_PREVIEW_COUNT);
  const hiddenTicketCount = batch.tickets.length - visibleTickets.length;

  // FLUX-1082: drag-and-drop reorder. Only `queued` tickets may be dragged or targeted — a ticket that
  // has already started (or finished) burning stays fixed in place, in a draft or a burning batch alike.
  const onReorderTickets = useCallback((event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const tickets = batch.tickets;
    const activeTicket = tickets.find((t) => t.ticketId === active.id);
    const overTicket = tickets.find((t) => t.ticketId === over.id);
    if (!activeTicket || !overTicket || activeTicket.state !== 'queued' || overTicket.state !== 'queued') return;
    const queued = tickets.filter((t) => t.state === 'queued');
    const oldIndex = queued.findIndex((t) => t.ticketId === active.id);
    const newIndex = queued.findIndex((t) => t.ticketId === over.id);
    const reorderedQueued = arrayMove(queued, oldIndex, newIndex);
    // Splice the reordered queued subset back into their original slots — non-queued tickets never move.
    let qi = 0;
    const next = tickets.map((t) => (t.state === 'queued' ? reorderedQueued[qi++] : t));
    const renumbered = next.map((t, i) => ({ ...t, order: i }));
    void run(() => updateFurnaceBatch(batch.id, { tickets: renumbered }));
  }, [batch.tickets, batch.id, run]);

  // FLUX-1487: quiet by default (drafts/finished cards), only the burning card gets the animated heat
  // edge — so the eye finds what's actually running instead of every card competing for attention.
  const rootClassName = `rounded-2xl border transition-colors${isBurning ? ' eh-furnace-burning-glow' : ''}`;

  return (
    <div ref={setNodeRef} className={rootClassName} style={{ borderColor: isOver ? FURNACE_ACCENT : isBurning ? 'var(--eh-furnace-accent-glow)' : 'var(--eh-border)', background: isOver ? FURNACE_ACCENT_GLOW : isBurning ? 'rgba(249,115,22,.04)' : 'var(--eh-surface)' }}>
      {/* Header */}
      <div className="flex items-start gap-2 p-2">
        <div className="flex h-7 w-7 items-center justify-center rounded-lg flex-shrink-0" style={{ background: 'var(--eh-surface-raised)' }}>
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
              // secondary affordance for discoverability. FLUX-1057: keyboard-activatable (role/tabIndex/
              // Enter+Space) so keyboard users aren't limited to the adjacent Pencil button.
              <span
                onClick={startRename}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); startRename(); } }}
                role="button"
                tabIndex={0}
                className="truncate text-xs font-semibold cursor-text hover:underline"
                title="Click to rename"
              >
                {batch.title}
              </span>
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
          <div className="mt-0.5 text-[9px] font-semibold uppercase tracking-wider" style={{ color: 'var(--eh-text-muted)' }}>
            {batch.kind === 'sequential' ? 'Sequential · one shared PR' : 'Parallel · PR per ticket'}
          </div>
          <div className="mt-0.5 truncate font-mono text-[10px]" style={{ color: 'var(--eh-text-muted)' }} title={batch.branch}>{batch.branch}</div>
          {/* FLUX-1270: display-only provenance — this batch was spun off from a parallel batch to
              pull a same-branch-dependent follow-up + its parent onto their own reused branch. */}
          {batch.spawnedFrom && (() => {
            const originBatch = allBatches.find((b) => b.id === batch.spawnedFrom!.batchId);
            const originTicket = tasks.find((t) => t.id === batch.spawnedFrom!.ticketId);
            return (
              <div
                className="mt-0.5 truncate text-[10px]"
                style={{ color: 'var(--eh-text-muted)' }}
                title={`Spun off from ${batch.spawnedFrom.ticketId}${originBatch ? ` / ${originBatch.title}` : ''} — reuses its branch so the follow-up's work stays on the same still-open PR.`}
              >
                ↳ spun off from {originTicket?.title ? `${batch.spawnedFrom.ticketId} (${originTicket.title})` : batch.spawnedFrom.ticketId}
                {originBatch ? ` · ${originBatch.title}` : ''}
              </div>
            );
          })()}
        </div>
        <div className="flex items-center gap-1.5 flex-shrink-0">
          <span className="rounded px-1.5 py-0.5 text-[10px] font-semibold" style={{ background: STATUS_CHIP[batch.status].bg, color: STATUS_CHIP[batch.status].fg }}>{STATUS_CHIP[batch.status].label}</span>
        </div>
      </div>

      {/* Kind + trigger row */}
      <div className="flex items-center gap-2 px-2 pb-1">
        <KindToggle kind={batch.kind} disabled={!isDraft || busy} onChange={(k) => void run(() => updateFurnaceBatch(batch.id, { kind: k }))} />
        {/* FLUX-1181: only editable while `draft` — the Stoker's checkTriggers only evaluates draft
            batches, and resume takes parked/done straight to burning, so a trigger armed on a
            non-draft batch would be accepted by the editor but could never actually fire. Always
            shows the resolved badge (even mid-burn) so an armed trigger stays legible at a glance. */}
        <TriggerControl batch={batch} allBatches={allBatches} disabled={!isDraft} onChanged={onChanged} />
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
      {isBurning && batch.tickets.length > 0 && (
        <div className="flex items-center gap-0.5 px-2 pb-1.5" title="Per-ticket burn progress">
          {batch.tickets.map((t) => (
            <div key={t.ticketId} className={`h-1 flex-1 rounded-full${TICKET_PROGRESS_ACTIVE.has(t.state) ? ' animate-pulse' : ''}`} style={{ background: ticketProgressColor(t) }} />
          ))}
        </div>
      )}

      {/* Ticket rows — nested DndContext scoped to this batch's own list, independent of the board's. */}
      <div className="border-t" style={{ borderColor: 'var(--eh-border)' }}>
        <DndContext collisionDetection={closestCenter} onDragEnd={onReorderTickets}>
          <SortableContext items={visibleTickets.map((t) => t.ticketId)} strategy={verticalListSortingStrategy}>
            {visibleTickets.map((t, i) => (
              <TicketRow
                key={t.ticketId}
                ticket={t}
                batchId={batch.id}
                batchStatus={batch.status}
                onChanged={onChanged}
                onRemove={removeTicket}
                railIndex={batch.kind === 'sequential' ? i + 1 : undefined}
                railTotal={batch.kind === 'sequential' ? visibleTickets.length : undefined}
              />
            ))}
          </SortableContext>
        </DndContext>
        {hiddenTicketCount > 0 && (
          <button
            onClick={() => setShowAllTickets(true)}
            className="w-full px-2 py-1 text-left text-[10px] hover:underline"
            style={{ color: 'var(--eh-text-secondary)' }}
          >
            + {hiddenTicketCount} more ticket{hiddenTicketCount === 1 ? '' : 's'}…
          </button>
        )}
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
        {isBurning ? (
          <span className="flex-1 text-[10px]" style={{ color: 'var(--eh-text-secondary)' }}>
            burning{fmtDuration(batch.ignitedAt) ? ` ${fmtDuration(batch.ignitedAt)}` : ''} · {Math.max(0, counts.total - counts.active - counts.queued)} of {counts.total} done
          </span>
        ) : batch.kind === 'parallel' && !isTerminal ? (
          <BurnRateStepper value={shownBurn} onCommit={commitBurn} />
        ) : batch.kind === 'sequential' && !isTerminal ? (
          <span className="flex-1 text-[10px]" style={{ color: 'var(--eh-text-secondary)' }}>ordered · one shared PR</span>
        ) : (
          <span className="flex-1" />
        )}

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
            {/* FLUX-1039: the assembled burn report, independent of CompletedSummary's prs.length gate
                so a zero-PR terminal batch (all parked/failed/skipped) still gets a completion surface. */}
            {isTerminal && batch.report && (
              <button onClick={() => setViewingReport(true)} title="View report" aria-label="View burn report" className="rounded px-1.5 py-1" style={{ border: '1px solid var(--eh-border)', color: 'var(--eh-text-secondary)' }}>
                <FileText className="h-3 w-3" />
              </button>
            )}
            {isDraft && (
              <button disabled={igniteDisabled} onClick={() => void onIgnite()} title={slots.free < 1 ? 'No worktree slots available' : 'Ignite'}
                className="inline-flex items-center gap-1 rounded px-2 py-1 text-[10px] font-semibold"
                style={{ background: igniteDisabled ? 'var(--eh-surface-raised)' : `linear-gradient(135deg, ${FURNACE_ACCENT}, var(--eh-furnace-accent-deep))`, color: igniteDisabled ? 'var(--eh-text-muted)' : '#fff', cursor: igniteDisabled ? 'not-allowed' : 'pointer' }}>
                <Play className="h-3 w-3" /> Ignite
              </button>
            )}
            {/* FLUX-1066: a halted (parked) batch is resumable — reset the breaker + re-burn its remaining work. */}
            {batch.status === 'parked' && (
              <button disabled={busy || slots.free < 1} onClick={() => void onResume()} title={slots.free < 1 ? 'No worktree slots available' : 'Resume — reset the breaker and re-burn'}
                className="inline-flex items-center gap-1 rounded px-2 py-1 text-[10px] font-semibold"
                style={{ background: busy || slots.free < 1 ? 'var(--eh-surface-raised)' : `linear-gradient(135deg, ${FURNACE_ACCENT}, var(--eh-furnace-accent-deep))`, color: busy || slots.free < 1 ? 'var(--eh-text-muted)' : '#fff', cursor: busy || slots.free < 1 ? 'not-allowed' : 'pointer' }}>
                <Play className="h-3 w-3" /> Resume
              </button>
            )}
          </>
        )}
      </div>

      {noSlot && <NoSlotPopup slots={slots} holders={noSlot} onClose={() => setNoSlot(null)} />}
      {viewingReport && batch.report && <FurnaceReportModal batch={batch} onClose={() => setViewingReport(false)} />}
    </div>
  );
}, (prev, next) =>
  // FLUX-1196: `batch`/`slots.*`/`onChanged` gate everything a card renders; `allBatches` only feeds
  // the trigger badge, so it's compared field-wise (see `triggerRelevantBatchesEqual`) rather than by
  // reference — a sibling batch updating (which always produces a fresh top-level array) shouldn't
  // re-render every other card.
  prev.batch === next.batch &&
  prev.onChanged === next.onChanged &&
  prev.slots.used === next.slots.used &&
  prev.slots.free === next.slots.free &&
  prev.slots.max === next.slots.max &&
  triggerRelevantBatchesEqual(prev.allBatches, next.allBatches));

// FLUX-1203: takes `batchId`/`batchStatus` as primitives rather than the whole `batch` object. The
// batch reference changes on every write (`mutateFurnaceBatch` structuredClones it), so a `batch`
// prop would defeat the shallow-prop memo for every row whenever any sibling ticket changed — even
// with per-ticket identity reuse in `mergeFurnaceBatches`. Primitives keep the memo gating per-ticket.
export const TicketRow = memo(function TicketRow({ ticket, batchId, batchStatus, onChanged, onRemove, railIndex, railTotal }: { ticket: BatchTicket; batchId: string; batchStatus: BatchStatus; onChanged: () => Promise<void>; onRemove: (ticketId: string) => void; railIndex?: number; railTotal?: number }) {
  const meta = STATE_META[ticket.state];
  const canRemove = !(batchStatus === 'burning' && ticket.state !== 'queued');
  // FLUX-1082: only a still-queued ticket may be dragged to reorder — one that's started/finished
  // burning is fixed in place (draft batches have every ticket `queued`, so all rows are draggable there).
  const draggable = ticket.state === 'queued';
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: ticket.ticketId, disabled: !draggable });
  const dragStyle = { transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.5 : 1 };
  // FLUX-1061 (#2/#3): the id is the shared enriched chip (status dot + hover mini-card + Open chat /
  // Open ticket), and the title is colored by BOARD status via the same statusStyles helpers the chip
  // uses — resolved from the live task, so a status change recolors the row. Falls back to the burn-state
  // dot color when the ticket isn't in the store (e.g. a stale/removed board card).
  const config = useConfig();
  const task = useTaskById(ticket.ticketId);
  const titleColor = task ? `rgb(${getStatusTint(config, task.status).rgb})` : meta.text;
  const [busy, setBusy] = useState(false);
  // FLUX-1090: a failed recovery action (e.g. hand-back rejected as "still burning") used to be swallowed
  // silently — the button just looked like it did nothing. Surface it inline instead.
  const [err, setErr] = useState<string | null>(null);

  // FLUX-1066: the ROW badge — a taken-over ticket reads "you're driving this" (owner beats state), and a
  // park splits by failure class so the cause is legible (needs-input vs a hard failure), never a bare "parked".
  const badge = ticketBadge(ticket, meta);
  // Recovery affordances: a human-owned ticket can be handed back; a parked/failed one can be retried /
  // taken over / dismissed. No dead ends — every non-happy row offers at least one next action.
  const isHuman = ticket.owner === 'human';
  const isParkedOrFailed = ticket.state === 'parked' || ticket.state === 'failed';

  const act = useCallback(async (fn: () => Promise<unknown>) => {
    setBusy(true); setErr(null);
    try { await fn(); await onChanged(); }
    catch (e) { setErr(e instanceof Error ? e.message : 'Action failed'); }
    finally { setBusy(false); }
  }, [onChanged]);

  return (
    <div ref={setNodeRef} style={dragStyle} className="group flex flex-col gap-0.5 px-2 py-1 text-[11px]">
      <div className="flex items-center gap-1.5">
        {railIndex !== undefined ? (
          // FLUX-1487: sequential batches get a numbered order rail instead of a plain grip — the
          // burn order IS the information, so it stays visible (not hover-gated like the parallel grip).
          // Still the drag handle when the ticket is queued (attributes/listeners attach here too).
          <div className={`relative flex h-3.5 w-3.5 flex-shrink-0 items-center justify-center${draggable ? ' touch-none' : ''}`} {...(draggable ? { ...attributes, ...listeners } : {})}>
            <span
              className="flex h-3.5 w-3.5 items-center justify-center rounded-full text-[8px] font-bold leading-none"
              style={{ background: FURNACE_ACCENT_GLOW, color: FURNACE_ACCENT, border: `1px solid ${FURNACE_ACCENT}`, cursor: draggable ? 'grab' : 'default' }}
            >
              {railIndex}
            </span>
            {railTotal !== undefined && railIndex < railTotal && (
              <span className="absolute left-1/2 top-full h-2 w-px -translate-x-1/2" style={{ background: 'var(--eh-border)' }} />
            )}
          </div>
        ) : draggable ? (
          <button {...attributes} {...listeners} title="Drag to reorder" aria-label={`Reorder ${ticket.ticketId}`} className="flex-shrink-0 cursor-grab touch-none opacity-0 transition-opacity group-hover:opacity-100 active:cursor-grabbing">
            <GripVertical className="h-3 w-3" style={{ color: 'var(--eh-text-muted)' }} />
          </button>
        ) : (
          <span className="h-3 w-3 flex-shrink-0" />
        )}
        <TicketRefChip ticketId={ticket.ticketId} />
        <span className="truncate flex-1" style={{ color: titleColor }} title={ticket.note || ticket.title}>{ticket.title}</span>
        {ticket.prUrl && <a href={ticket.prUrl} target="_blank" rel="noreferrer" title="Open pull request" aria-label={`Open pull request for ${ticket.ticketId}`} onClick={(e) => e.stopPropagation()}><ExternalLink className="h-3 w-3" style={{ color: '#818cf8' }} /></a>}
        <span className="rounded px-1 py-0.5 text-[10px] flex-shrink-0" style={{ color: badge.color }} title={ticket.note || badge.label}>{badge.label}</span>

        {/* Recovery actions (FLUX-1066) */}
        {isHuman && (
          <button disabled={busy} onClick={() => void act(() => handBackFurnaceTicket(batchId, ticket.ticketId))} title="Hand back to the Furnace" aria-label={`Hand ${ticket.ticketId} back to the Furnace`} className="flex-shrink-0">
            <Undo2 className="h-3 w-3" style={{ color: '#a78bfa' }} />
          </button>
        )}
        {!isHuman && isParkedOrFailed && (
          <>
            <button disabled={busy} onClick={() => void act(() => retryFurnaceTicket(batchId, ticket.ticketId))} title="Retry — fresh attempt" aria-label={`Retry ${ticket.ticketId}`} className="flex-shrink-0">
              <RotateCcw className="h-3 w-3" style={{ color: '#38bdf8' }} />
            </button>
            <button disabled={busy} onClick={() => void act(() => takeoverFurnaceTicket(batchId, ticket.ticketId))} title="Take over — you drive it" aria-label={`Take over ${ticket.ticketId}`} className="flex-shrink-0">
              <Hand className="h-3 w-3" style={{ color: '#a78bfa' }} />
            </button>
          </>
        )}
        {/* FLUX-1297: Dismiss is NOT gated on !isHuman — a taken-over ticket (owner: 'human') can still
            carry a stuck parked/failed flag with no other escape than handing it back to the Furnace. */}
        {isParkedOrFailed && !ticket.flagDismissed && (
          <button disabled={busy} onClick={() => void act(() => dismissFurnaceTicket(batchId, ticket.ticketId))} title="Dismiss flag — I've got this" aria-label={`Dismiss the flag on ${ticket.ticketId}`} className="flex-shrink-0">
            <Check className="h-3 w-3" style={{ color: 'var(--eh-text-muted)' }} />
          </button>
        )}

        {canRemove && (
          <button onClick={() => onRemove(ticket.ticketId)} title="Remove from batch" aria-label={`Remove ${ticket.ticketId} from batch`} className="opacity-0 group-hover:opacity-100 flex-shrink-0">
            <X className="h-3 w-3" style={{ color: 'var(--eh-text-muted)' }} />
          </button>
        )}
      </div>
      {err && <div className="pl-4 text-[10px]" style={{ color: '#f87171' }}>{err}</div>}
    </div>
  );
});

/**
 * FLUX-1066: the row badge. Ownership beats state — a human-owned ticket reads "you're driving this". A
 * park is split by failure class so the cause + next action are legible instead of one opaque "parked".
 */
function ticketBadge(ticket: BatchTicket, meta: { label: string; text: string }): { label: string; color: string } {
  if (ticket.owner === 'human') return { label: 'you’re driving', color: '#a78bfa' };
  // FLUX-1210: a `pr-open` ticket already merged (board status flipped to Done/Released outside the
  // Furnace) — stop showing the stale "PR open" badge, match `prcStyle`'s merged color.
  if (ticket.state === 'pr-open' && ticket.mergedAt) return { label: 'merged', color: '#60a5fa' };
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
    <div className="border-t px-2 py-2" style={{ borderColor: 'var(--eh-border)', background: 'rgba(34,197,94,.04)' }}>
      <div className="mb-1.5 flex items-center gap-1 text-[10px] font-bold" style={{ color: allMerged ? '#60a5fa' : '#22c55e' }}>
        {allMerged ? <GitMerge className="h-3 w-3" /> : <Check className="h-3 w-3" />} {allMerged ? 'Merged' : `Finished · ${batch.prs.length} PR${batch.prs.length === 1 ? '' : 's'} open at Ready`}
      </div>
      {fmtDuration(batch.ignitedAt, batch.completedAt) && (
        <div className="mb-1.5 text-[10px]" style={{ color: 'var(--eh-text-secondary)' }}>
          burned {batch.tickets.length} ticket{batch.tickets.length === 1 ? '' : 's'} in {fmtDuration(batch.ignitedAt, batch.completedAt)}
        </div>
      )}
      {batch.prs.map((pr) => {
        const c = prcStyle(pr.reviewState);
        return (
          <div key={pr.url} className="flex items-center gap-1.5 py-0.5">
            <span className="text-[10px]" style={{ color: 'var(--eh-text-muted)' }}>PR</span>
            <a href={pr.url} target="_blank" rel="noreferrer" className="min-w-0 flex-1 truncate font-mono text-[11px]" style={{ color: pr.reviewState === 'merged' ? 'var(--eh-text-muted)' : '#818cf8', textDecoration: pr.reviewState === 'merged' ? 'line-through' : 'none' }}>
              {pr.number ? `#${pr.number} ` : ''}{pr.branch}
              {pr.ticketIds && pr.ticketIds.length > 1 && (
                <span style={{ color: 'var(--eh-text-muted)' }}> ({pr.ticketIds.join(', ')})</span>
              )}
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

function NoSlotPopup({ slots, holders, onClose }: { slots: SlotInfo; holders: FurnaceSlotHolder[]; onClose: () => void }) {
  const okRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    okRef.current?.focus();
  }, []);
  // FLUX-1022: route Escape through the shared stack instead of a standalone listener, so it
  // coordinates with other overlays (e.g. a floating chat window open at the same time) instead of
  // both eating the same keypress.
  useEscapeKey(onClose);
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
        {/* FLUX-1157: name the holders so the user can act (finish/abandon/take over) instead of guessing. */}
        {holders.length > 0 && (
          <div className="mb-2.5 rounded-md p-2" style={{ background: 'var(--eh-surface-raised)' }}>
            <div className="mb-1 text-[10px] font-semibold" style={{ color: 'var(--eh-text-secondary)' }}>Holding the slots:</div>
            <ul className="space-y-0.5">
              {holders.map((h) => (
                <li key={h.ticketId} className="text-[10px]" style={{ color: 'var(--eh-text-primary)' }}>
                  <span className="font-semibold">{h.ticketId}</span>{' '}
                  <span style={{ color: 'var(--eh-text-secondary)' }}>— {h.reason}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
        <button ref={okRef} onClick={onClose} className="rounded px-3 py-1 text-[11px] font-semibold" style={{ background: FURNACE_ACCENT, color: '#fff' }}>Got it</button>
      </div>
    </div>
  );
}

export default FurnaceDrawer;
