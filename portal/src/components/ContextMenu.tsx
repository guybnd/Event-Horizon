import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';
import {
  Archive, ArrowRightLeft, Bot, ChevronRight, CircleX, Code2, ExternalLink, Filter, Flame,
  FolderGit2, GitBranch, GitCompare, GitMerge, GitPullRequest, Link2, Loader2, MessageCircle, Play, Plus, Search, Square, Trash2, Undo2, X,
} from 'lucide-react';
import type { Task } from '../types';
import { normalizeSubtaskId } from '../types';
import { useAppSelector, useAppActions, useLiveSession } from '../store/useAppSelector';
import { fetchBranches, stopTaskCliSession, fetchFurnaceBatches, appendFurnaceTicket, createFurnaceBatch, type BranchOption } from '../api';
import type { FurnaceBatch } from '../furnaceTypes';
import { getArchiveStatus, getReadyForMergeStatus } from '../workflow';
import { searchTasks } from '../taskSearch';
import { useTicketActions } from '../hooks/useTicketActions';

interface Props {
  task: Task;
  position: { x: number; y: number };
  onClose: () => void;
  /** Open the orchestration launcher for this ticket, optionally pre-set to a template. */
  onLaunchAgent: (templateId?: string) => void;
}

type TopMenu = 'launch' | 'transition' | 'worktree' | 'attachParent' | 'addFurnace' | null;
type WtMenu = 'attachWorktree' | 'attachBranch' | null;

// The CLI-session statuses that count as "still active" (mirrors the engine's stop-route filter
// and CardSessionRow's gating) — used to decide whether to show "Stop agent session" and whether
// the card carries a cluster of sessions.
const ACTIVE_SESSION_STATUSES = ['pending', 'running', 'waiting-input'];

const PRIMARY_LABEL: Record<string, string> = {
  Grooming: 'Start grooming',
  Todo: 'Implement',
  'In Progress': 'Continue',
};

export function ContextMenu({ task, position, onClose, onLaunchAgent }: Props) {
  const { setFilterWorktree, setView, setChangesFocus } = useAppActions();
  const config = useAppSelector((s) => s.config);
  const readComments = useAppSelector((s) => s.readComments);
  const worktrees = useAppSelector((s) => s.worktrees);
  const worktreeBranches = useAppSelector((s) => s.worktreeBranches);
  const filterWorktree = useAppSelector((s) => s.filterWorktree);
  const taskById = useAppSelector((s) => s.taskById);
  // FLUX-918 (m1): the live SSE session slice — preferred over the polled task.cliSession.status when
  // deciding whether to show "Stop agent session", so the item tracks the card's session pill.
  const liveSession = useLiveSession(task.id);
  const menuRef = useRef<HTMLDivElement>(null);
  const [openTop, setOpenTop] = useState<TopMenu>(null);
  const [openWt, setOpenWt] = useState<WtMenu>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [confirmDetach, setConfirmDetach] = useState(false);
  const [confirmMergePr, setConfirmMergePr] = useState(false);
  const [actionError, setActionError] = useState('');
  const [prBusy, setPrBusy] = useState(false);
  const [mergePrBusy, setMergePrBusy] = useState(false);
  const [branches, setBranches] = useState<BranchOption[] | null>(null);
  const [furnaceBatches, setFurnaceBatches] = useState<FurnaceBatch[] | null>(null);

  // FLUX-717: the menu binds every transition/launch/pr/branch/lifecycle action to the unified
  // ticket-action registry instead of hand-rolling its own handlers. (Launcher-opening stays
  // parent-owned via onLaunchAgent so it survives the menu closing; view/nav stays surface-local.)
  const ctl = useTicketActions(task);
  const cardPhase = ctl.cardPhase;
  const hasWorktree = !!task.branch && worktreeBranches.has(task.branch);

  // Warm the launch-template catalog so the "Launch agent" flyout shows names without a click.
  useEffect(() => {
    ctl.loadTemplates();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Lazy-load branches when the "Attach to branch" picker first opens (guarded so
  // the fetch can't setState after the menu closes/unmounts).
  useEffect(() => {
    if (openWt !== 'attachBranch' || branches !== null) return undefined;
    let cancelled = false;
    fetchBranches()
      .then((b) => { if (!cancelled) setBranches(b); })
      .catch(() => { if (!cancelled) setBranches([]); });
    return () => { cancelled = true; };
  }, [openWt, branches]);

  // Lazy-load Furnace batches when the "Add to Furnace" picker first opens.
  useEffect(() => {
    if (openTop !== 'addFurnace' || furnaceBatches !== null) return undefined;
    let cancelled = false;
    fetchFurnaceBatches()
      .then((b) => { if (!cancelled) setFurnaceBatches(b); })
      .catch(() => { if (!cancelled) setFurnaceBatches([]); });
    return () => { cancelled = true; };
  }, [openTop, furnaceBatches]);

  // Adjust position to keep the menu on screen; flyouts open toward the roomy side.
  const [pos, setPos] = useState(position);
  useEffect(() => {
    if (!menuRef.current) return;
    const rect = menuRef.current.getBoundingClientRect();
    let { x, y } = position;
    if (x + rect.width + 4 > window.innerWidth) x = window.innerWidth - rect.width - 8;
    if (y + rect.height + 4 > window.innerHeight) y = window.innerHeight - rect.height - 8;
    setPos({ x: Math.max(8, x), y: Math.max(8, y) });
  }, [position]);

  // Close on outside click or Escape. Flyout panels are portaled to <body> (so
  // they can't be clipped and can clamp to the viewport), so "inside" is anything
  // tagged data-eh-ctxmenu — the root menu OR any open flyout panel — not just menuRef.
  useEffect(() => {
    const handleDown = (e: MouseEvent) => {
      const t = e.target as Element | null;
      if (!t || !t.closest('[data-eh-ctxmenu]')) onClose();
    };
    const handleKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('mousedown', handleDown);
    document.addEventListener('keydown', handleKey);
    return () => {
      document.removeEventListener('mousedown', handleDown);
      document.removeEventListener('keydown', handleKey);
    };
  }, [onClose]);

  const allStatuses = [
    ...(config?.columns?.map((c) => c.name) ?? []),
    ...(config?.hiddenStatuses?.map((h) => h.name) ?? []),
  ].filter((s, i, arr) => arr.indexOf(s) === i && s !== task.status);

  const archiveStatus = getArchiveStatus(config);
  // FLUX-725: comment ids come from the list digest (was a filter over full history).
  const commentIds = (task.historyDigest?.comments ?? []).map((c) => c.id);
  const readIds = new Set(readComments[task.id] ?? []);
  const hasUnread = commentIds.some((id) => !readIds.has(id));
  // ─── Phase templates (Launch agent flyout) — from the registry's resolved single/multi/other set ─
  const launchTemplates = ctl.launchTemplates;
  // Hoisted once (the way TemplateMenu does it) — the index of the first "other" template, so the
  // map can drop a divider between the single/multi defaults and the rest.
  const firstOther = launchTemplates.findIndex((x) => x.variant === 'other');

  const primaryLabel = PRIMARY_LABEL[task.status]
    ?? (cardPhase === 'review' ? 'Send for review' : cardPhase === 'grooming' ? 'Start grooming' : 'Launch agent');

  // ─── Parent-ticket candidates (Attach to parent picker) ───────────────────────
  const parentCandidates = useMemo(() => {
    const childIds = new Set((task.subtasks ?? []).map(normalizeSubtaskId));
    return Array.from(taskById.values()).filter(
      (t) => t.id !== task.id && !childIds.has(t.id) && t.parentId !== task.id,
    );
  }, [taskById, task.id, task.subtasks, task.parentId]);

  // ─── Handlers ─── thin wrappers over the registry ops; presentation (confirm/busy/error) is local.
  const handleOpen = () => { ctl.ops.openTicket(); onClose(); };

  const handlePrimary = async () => {
    onClose();
    // A Todo with no branch needs the launcher's branch picker first.
    if (cardPhase === 'implementation' && task.status === 'Todo' && !task.branch) {
      onLaunchAgent();
      return;
    }
    try {
      const launched = await ctl.tryLaunchPhaseDefault(cardPhase);
      if (!launched) onLaunchAgent(); // no default persona → open launcher
    } catch (err) {
      console.error('Failed to launch phase agent:', err instanceof Error ? err.message : err);
    }
  };

  const launchTemplate = (templateId?: string) => { onClose(); onLaunchAgent(templateId); };

  const handleTransition = (status: string) => { onClose(); void ctl.ops.moveToStatus(status); };
  const handleArchive = () => { onClose(); void ctl.ops.archive(); };
  const handleDelete = () => { onClose(); void ctl.ops.deleteTicket(); };
  const handleMarkRead = () => { ctl.ops.markCommentsRead(); onClose(); };
  const handleClearSwimlane = () => { onClose(); void ctl.ops.clearSwimlane(); };

  // FLUX-909: terminate the ticket's agent session from the card. The stop route already
  // terminalizes parked (waiting-input / pending) sessions and tree-kills the process; the
  // `taskUpdated` SSE refresh then clears the card's session pill. Close first so the menu doesn't
  // linger over the now-stale card.
  // FLUX-918 (m3): an orchestration/cluster card runs several sessions at once. A bare
  // stopTaskCliSession(task.id) only cancels the most-recent one, leaving siblings live; when more
  // than one session is active, scope the stop to ALL of them (the route's stopAll path) instead.
  const activeSessionCount = (task.cliSessions ?? []).filter((s) => ACTIVE_SESSION_STATUSES.includes(s.status)).length;
  const handleStopSession = async () => {
    onClose();
    try {
      await stopTaskCliSession(task.id, activeSessionCount > 1 ? { stopAll: true } : undefined);
    } catch (err) {
      console.error('Failed to stop agent session:', err instanceof Error ? err.message : err);
    }
  };
  // FLUX-918 (m1): gate the item on the live SSE status — the same source CardSessionRow's pill reads
  // — so the menu item and the pill can't disagree at a turn boundary (the polled cliSession.status
  // lags the live status). Fall back to the polled status when no live slice exists yet.
  const liveSessionStatus = liveSession?.status ?? task.cliSession?.status;
  const hasActiveSession = !!task.cliSession && !!liveSessionStatus && ACTIVE_SESSION_STATUSES.includes(liveSessionStatus);

  // Worktree/PR actions — run the registry op (which refreshes), then close. On failure, surface
  // the message in the menu (it stays open) instead of failing silently (FLUX-561).
  const runOp = async (fn: () => Promise<unknown>) => {
    setActionError('');
    try { await fn(); onClose(); }
    catch (err) {
      const msg = err instanceof Error ? err.message : 'Action failed';
      console.error('Ticket action failed:', msg);
      setActionError(msg);
    }
  };
  const handleOpenVSCode = () => runOp(() => ctl.ops.openInVSCode());
  const handleDetach = () => runOp(() => ctl.ops.detachWorktree());
  const handleRaisePr = async () => {
    setPrBusy(true);
    try { await runOp(() => ctl.ops.raisePr()); } finally { setPrBusy(false); }
  };
  // PR tickets (kind:'pr') are engine-managed but their In Progress ↔ Ready review state is
  // human-driven (syncPrTickets preserves it), so allow moving between those + a guarded Merge.
  const movePrStatus = (status: string) => runOp(() => ctl.ops.setStatusRaw(status));
  const handleMergePr = async () => {
    setMergePrBusy(true);
    try { await runOp(() => ctl.ops.mergePrNow()); } finally { setMergePrBusy(false); }
  };
  const handleAttachWorktree = (branch: string) => runOp(() => ctl.ops.joinWorktree(branch));
  const handleAttachBranch = (branch: string) => runOp(() => ctl.ops.attachBranch(branch));
  const handleAttachParent = (parentId: string) => runOp(() => ctl.ops.attachParent(parentId));
  const addToBatch = (batchId: string) => runOp(() => appendFurnaceTicket(batchId, task.id));
  const addToNewBatch = () => runOp(() => createFurnaceBatch({ title: task.title || task.id, ticketIds: [task.id] }));

  const setFilter = (v: string) => { onClose(); setFilterWorktree(v); };

  // PR tickets (kind:'pr', FLUX-567) get a focused menu — the normal ticket-workflow items
  // (Launch/Attach/Raise-PR) don't apply to an engine-managed PR. But the In Progress ↔ Ready
  // review state is human-driven, so we surface Move-to + a guarded Merge here too (FLUX-593).
  if (task.kind === 'pr') {
    const prResolved = task.prState === 'MERGED' || task.prState === 'CLOSED' || task.status === archiveStatus || task.status === 'Done';
    const prMoveTargets = ['In Progress', getReadyForMergeStatus(config)].filter((s) => s !== task.status);
    return createPortal(
      <div
        ref={menuRef}
        data-eh-ctxmenu
        style={{ position: 'fixed', top: pos.y, left: pos.x, maxHeight: 'calc(100vh - 16px)', overflowY: 'auto', zIndex: 1000000 }}
        className="min-w-[200px] rounded-xl border border-gray-200/80 bg-white/95 py-1 shadow-2xl backdrop-blur-xl dark:border-white/10 dark:bg-[#1e1f2a]/95"
        onContextMenu={(e) => e.preventDefault()}
      >
        <MenuItem icon={<ExternalLink className="h-3.5 w-3.5" />} onClick={handleOpen}>Open PR surface</MenuItem>

        {/* Move between the human-driven review states + merge — only while the PR is open. */}
        {!prResolved && <Divider />}
        {!prResolved && prMoveTargets.map((s) => (
          <MenuItem key={s} icon={<ArrowRightLeft className="h-3.5 w-3.5" />} onClick={() => void movePrStatus(s)}>
            Move to {s}
          </MenuItem>
        ))}
        {!prResolved && (
          confirmMergePr ? (
            <div className="flex items-center gap-1 px-3 py-1.5">
              <span className="flex-1 text-xs font-medium text-violet-600 dark:text-violet-300">Merge PR?</span>
              <button onClick={() => void handleMergePr()} disabled={mergePrBusy} className="rounded bg-violet-600 px-2 py-0.5 text-[10px] font-semibold text-white hover:bg-violet-700 disabled:opacity-50">{mergePrBusy ? '…' : 'Yes'}</button>
              <button onClick={() => setConfirmMergePr(false)} className="rounded px-2 py-0.5 text-[10px] font-semibold text-gray-600 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-white/10"><X className="h-3 w-3" /></button>
            </div>
          ) : (
            <MenuItem icon={<GitMerge className="h-3.5 w-3.5" />} onClick={() => { setActionError(''); setConfirmMergePr(true); }}>Merge PR</MenuItem>
          )
        )}

        {(task.branch || hasWorktree) && <Divider />}
        {task.branch && (
          <MenuItem icon={<GitCompare className="h-3.5 w-3.5" />} onClick={() => { onClose(); setChangesFocus(task.branch!); setView('changes'); }}>
            View changes
          </MenuItem>
        )}
        {hasWorktree && (
          <MenuItem icon={<Code2 className="h-3.5 w-3.5" />} onClick={() => void handleOpenVSCode()}>
            Open worktree in VS Code
          </MenuItem>
        )}
        {actionError && (
          <div className="mx-2 my-1 rounded-md bg-red-50 px-2.5 py-1.5 text-[11px] leading-snug text-red-700 dark:bg-red-500/10 dark:text-red-300">
            {actionError}
          </div>
        )}
      </div>,
      document.body,
    );
  }

  return createPortal(
    <div
      ref={menuRef}
      data-eh-ctxmenu
      style={{ position: 'fixed', top: pos.y, left: pos.x, maxHeight: 'calc(100vh - 16px)', overflowY: 'auto', zIndex: 1000000 }}
      className="min-w-[210px] rounded-xl border border-gray-200/80 bg-white/95 py-1 shadow-2xl backdrop-blur-xl dark:border-white/10 dark:bg-[#1e1f2a]/95"
      onContextMenu={(e) => e.preventDefault()}
    >
      <MenuItem icon={<ExternalLink className="h-3.5 w-3.5" />} onClick={handleOpen}>Edit / Open</MenuItem>

      <Divider />

      {/* Phase-contextual primary action + the phase's agent templates. */}
      <MenuItem icon={<Play className="h-3.5 w-3.5" />} onClick={() => void handlePrimary()}>{primaryLabel}</MenuItem>
      <Flyout
        icon={<Bot className="h-3.5 w-3.5" />}
        label="Launch agent"
        open={openTop === 'launch'}
        onToggle={() => setOpenTop(openTop === 'launch' ? null : 'launch')}
      >
        {launchTemplates.every((t) => !t.name) && (
          <div className="px-3 py-1.5 text-[11px] italic text-gray-400">No templates for this phase</div>
        )}
        {launchTemplates.map((t, i) => {
          const label = t.variant === 'single' ? (t.name ?? 'Single') : t.variant === 'multi' ? (t.name ?? 'Multi') : (t.name ?? t.id);
          const badge = t.variant === 'single' ? '1 agent' : t.variant === 'multi' ? 'team' : null;
          return (
            <div key={`${t.variant}:${t.id ?? i}`} className="contents">
              {i === firstOther && firstOther > 0 && <Divider />}
              <MenuItem onClick={() => launchTemplate(t.id)}>
                <span className="flex-1 truncate">{label}</span>
                {badge && <span className="ml-2 text-[10px] text-gray-400">{badge}</span>}
              </MenuItem>
            </div>
          );
        })}
        <Divider />
        <MenuItem onClick={() => launchTemplate()}>Open launcher…</MenuItem>
      </Flyout>

      {/* FLUX-909: stop the running/parked agent session straight from the card. */}
      {hasActiveSession && (
        <MenuItem icon={<Square className="h-3.5 w-3.5" />} onClick={() => void handleStopSession()}>
          Stop agent session
        </MenuItem>
      )}

      <Divider />

      {/* Move to status */}
      <Flyout
        icon={<ArrowRightLeft className="h-3.5 w-3.5" />}
        label="Move to"
        open={openTop === 'transition'}
        onToggle={() => setOpenTop(openTop === 'transition' ? null : 'transition')}
      >
        <div className="max-h-72 overflow-auto">
          {allStatuses.map((s) => (
            <MenuItem key={s} onClick={() => void handleTransition(s)}>{s}</MenuItem>
          ))}
        </div>
      </Flyout>

      <Divider />

      {/* Quick open in VS Code (#7) — top-level for a worktreed ticket. */}
      {hasWorktree && (
        <MenuItem icon={<Code2 className="h-3.5 w-3.5" />} onClick={() => void handleOpenVSCode()}>
          Open worktree in VS Code
        </MenuItem>
      )}

      {/* View this worktree's changes in the Changes view (FLUX-531). */}
      {hasWorktree && (
        <MenuItem icon={<GitCompare className="h-3.5 w-3.5" />} onClick={() => { onClose(); setChangesFocus(task.branch!); setView('changes'); }}>
          View changes
        </MenuItem>
      )}

      {/* Raise PR — branch/worktree tickets only. The PR's surface is its own PR-<n> deck card
          once raised (FLUX-569); this just opens one for the branch. */}
      {!!task.branch && (
        <MenuItem
          icon={prBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <GitPullRequest className="h-3.5 w-3.5" />}
          disabled={prBusy}
          onClick={() => void handleRaisePr()}
        >
          {prBusy ? 'Raising PR…' : 'Raise PR'}
        </MenuItem>
      )}

      {/* Surface a failed worktree/PR action inline (the menu stays open on error). */}
      {actionError && (
        <div className="mx-2 my-1 rounded-md bg-red-50 px-2.5 py-1.5 text-[11px] leading-snug text-red-700 dark:bg-red-500/10 dark:text-red-300">
          {actionError}
        </div>
      )}

      {/* Worktree actions */}
      <Flyout
        icon={<FolderGit2 className="h-3.5 w-3.5" />}
        label="Worktree"
        open={openTop === 'worktree'}
        onToggle={() => { setOpenTop(openTop === 'worktree' ? null : 'worktree'); setOpenWt(null); }}
      >
        {!hasWorktree && (
          <MenuItem icon={<Code2 className="h-3.5 w-3.5" />} onClick={() => void handleOpenVSCode()}>
            Open in VS Code (new worktree)
          </MenuItem>
        )}
        {hasWorktree && (
          confirmDetach ? (
            <div className="flex items-center gap-1 px-3 py-1.5">
              <span className="flex-1 text-xs font-medium text-primary">Close worktree?</span>
              <button onClick={() => void handleDetach()} className="rounded px-2 py-0.5 text-[10px] font-semibold text-white bg-primary hover:opacity-90">Yes</button>
              <button onClick={() => setConfirmDetach(false)} className="rounded px-2 py-0.5 text-[10px] font-semibold text-gray-600 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-white/10"><X className="h-3 w-3" /></button>
            </div>
          ) : (
            <MenuItem icon={<Undo2 className="h-3.5 w-3.5" />} onClick={() => setConfirmDetach(true)}>
              Close worktree (return work to main)
            </MenuItem>
          )
        )}

        <Divider />

        {hasWorktree && (
          <MenuItem icon={<Filter className="h-3.5 w-3.5" />} onClick={() => setFilter(task.branch!)}>
            Isolate this worktree
          </MenuItem>
        )}
        {filterWorktree !== '' ? (
          <MenuItem icon={<X className="h-3.5 w-3.5" />} onClick={() => setFilter('')}>Clear worktree filter</MenuItem>
        ) : (
          <MenuItem icon={<FolderGit2 className="h-3.5 w-3.5" />} onClick={() => setFilter('any')}>Show all worktrees</MenuItem>
        )}

        <Divider />

        {/* Attach to worktree (join) */}
        <Flyout
          icon={<FolderGit2 className="h-3.5 w-3.5" />}
          label="Attach to worktree"
          open={openWt === 'attachWorktree'}
          onToggle={() => setOpenWt(openWt === 'attachWorktree' ? null : 'attachWorktree')}
        >
          {worktrees.filter((w) => w.branch !== task.branch).length === 0 ? (
            <div className="px-3 py-1.5 text-[11px] italic text-gray-400">No other active worktrees</div>
          ) : (
            worktrees.filter((w) => w.branch !== task.branch).map((w) => (
              <MenuItem key={w.path} onClick={() => void handleAttachWorktree(w.branch)}>
                <span className="flex-1 truncate">{w.ticketId ?? w.branch}</span>
                {w.ticketId && <span className="ml-2 truncate text-[10px] text-gray-400">{w.branch}</span>}
              </MenuItem>
            ))
          )}
        </Flyout>

        {/* Attach to branch (search) */}
        <Flyout
          icon={<GitBranch className="h-3.5 w-3.5" />}
          label="Attach to branch"
          open={openWt === 'attachBranch'}
          onToggle={() => setOpenWt(openWt === 'attachBranch' ? null : 'attachBranch')}
        >
          <SearchPicker
            placeholder="Search branches…"
            emptyText={branches === null ? 'Loading…' : 'No matching branches'}
            getKey={(b: BranchOption) => b.name}
            filter={(q) => (branches ?? [])
              .filter((b) => b.name !== task.branch && b.name.toLowerCase().includes(q.toLowerCase()))
              .slice(0, 7)}
            renderItem={(b) => (<>
              <span className="flex-1 truncate">{b.name}</span>
              {b.hasWorktree && <FolderGit2 className="ml-2 h-3 w-3 flex-none text-primary" />}
            </>)}
            onPick={(b) => void handleAttachBranch(b.name)}
          />
        </Flyout>
      </Flyout>

      {/* Attach to parent ticket (fuzzy search) — top-level; hierarchy, not worktree. */}
      <Flyout
        icon={<Link2 className="h-3.5 w-3.5" />}
        label="Attach to parent"
        open={openTop === 'attachParent'}
        onToggle={() => setOpenTop(openTop === 'attachParent' ? null : 'attachParent')}
      >
        <SearchPicker
          placeholder="Search tickets…"
          emptyText="No matching tickets"
          getKey={(t: Task) => t.id}
          filter={(q) => (q.trim()
            ? searchTasks(parentCandidates, q, 7).map((r) => r.task)
            : parentCandidates.slice(0, 7))}
          renderItem={(t) => (<>
            <span className="flex-none font-mono text-[10px] text-gray-400">{t.id}</span>
            <span className="ml-1.5 flex-1 truncate">{t.title}</span>
          </>)}
          onPick={(t) => void handleAttachParent(t.id)}
        />
      </Flyout>

      {/* Add this ticket to a Furnace batch (FLUX-1053) — existing batch or a new one. */}
      <Flyout
        icon={<Flame className="h-3.5 w-3.5" />}
        label="Add to Furnace"
        open={openTop === 'addFurnace'}
        onToggle={() => setOpenTop(openTop === 'addFurnace' ? null : 'addFurnace')}
      >
        {furnaceBatches === null ? (
          <div className="px-3 py-1.5 text-[11px] italic text-gray-400">Loading…</div>
        ) : (
          <>
            {furnaceBatches
              .filter((b) => b.status === 'draft' || b.status === 'burning')
              .filter((b) => !b.tickets.some((t) => t.ticketId === task.id))
              .map((b) => (
                <MenuItem key={b.id} onClick={() => void addToBatch(b.id)}>
                  <span className="flex-1 truncate">{b.title}</span>
                  <span className="ml-2 text-[10px] text-gray-400">{b.status}</span>
                </MenuItem>
              ))}
            <Divider />
            <MenuItem icon={<Plus className="h-3.5 w-3.5" />} onClick={() => void addToNewBatch()}>New batch</MenuItem>
          </>
        )}
      </Flyout>

      {(hasUnread || task.swimlane) && <Divider />}
      {hasUnread && (
        <MenuItem icon={<MessageCircle className="h-3.5 w-3.5" />} onClick={handleMarkRead}>Mark comments as read</MenuItem>
      )}
      {task.swimlane && (
        <MenuItem icon={<CircleX className="h-3.5 w-3.5" />} onClick={handleClearSwimlane}>Clear Swimlane</MenuItem>
      )}

      <Divider />

      {task.status !== archiveStatus && (
        <MenuItem icon={<Archive className="h-3.5 w-3.5" />} onClick={() => void handleArchive()}>Archive</MenuItem>
      )}
      {confirmDelete ? (
        <div className="flex items-center gap-1 px-3 py-1.5">
          <span className="flex-1 text-xs font-medium text-red-500">Confirm delete?</span>
          <button onClick={() => void handleDelete()} className="rounded px-2 py-0.5 text-[10px] font-semibold text-white bg-red-500 hover:bg-red-600">Yes</button>
          <button onClick={() => setConfirmDelete(false)} className="rounded px-2 py-0.5 text-[10px] font-semibold text-gray-600 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-white/10"><X className="h-3 w-3" /></button>
        </div>
      ) : (
        <MenuItem icon={<Trash2 className="h-3.5 w-3.5" />} danger onClick={() => setConfirmDelete(true)}>Delete</MenuItem>
      )}
    </div>,
    document.body,
  );
}

function Divider() {
  return <div className="my-1 border-t border-gray-100 dark:border-white/5" />;
}

function MenuItem({
  icon, danger, onClick, children, disabled,
}: {
  icon?: ReactNode;
  danger?: boolean;
  onClick: () => void;
  children: ReactNode;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
        danger
          ? 'text-red-500 hover:bg-red-50 dark:hover:bg-red-500/10'
          : 'text-gray-700 hover:bg-gray-100 dark:text-gray-200 dark:hover:bg-white/5'
      }`}
    >
      {icon && <span className={`flex-none ${danger ? 'text-red-400' : 'text-gray-400'}`}>{icon}</span>}
      {children}
    </button>
  );
}

/**
 * A submenu that opens to the SIDE as a flyout. The panel is portaled to <body>
 * and positioned with fixed coordinates derived from the trigger row, then clamped
 * into the viewport on BOTH axes — so it never spills off-screen and isn't pinned
 * to the click height (it shifts up/sideways as needed to fit).
 */
function Flyout({
  icon, label, open, onToggle, children,
}: {
  icon: ReactNode;
  label: string;
  open: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  const rowRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [coords, setCoords] = useState<{ left: number; top: number; placement: 'left' | 'right' } | null>(null);

  // Measure the row + panel and place the panel beside the row, clamped to the
  // viewport. Runs before paint (no flash) and re-runs on panel resize (the search
  // list growing/shrinking) and on scroll/resize.
  useLayoutEffect(() => {
    if (!open) { setCoords(null); return undefined; }
    const compute = () => {
      const row = rowRef.current?.getBoundingClientRect();
      const panel = panelRef.current?.getBoundingClientRect();
      if (!row || !panel) return;
      const gap = 4, pad = 8;
      const vw = window.innerWidth, vh = window.innerHeight;
      // Horizontal: prefer the right of the row; flip left if it would overflow;
      // if it fits on neither side, pin to whichever keeps the most on-screen.
      let placement: 'left' | 'right' = 'right';
      let left = row.right + gap;
      if (left + panel.width > vw - pad) {
        const leftSide = row.left - gap - panel.width;
        if (leftSide >= pad) { left = leftSide; placement = 'left'; }
        else { left = Math.max(pad, vw - panel.width - pad); }
      }
      // Vertical: anchor near the row top, then slide up so the whole panel fits.
      let top = Math.min(row.top, vh - panel.height - pad);
      top = Math.max(pad, top);
      setCoords((prev) =>
        prev && prev.left === left && prev.top === top && prev.placement === placement
          ? prev
          : { left, top, placement },
      );
    };
    compute();
    const ro = new ResizeObserver(compute);
    if (panelRef.current) ro.observe(panelRef.current);
    window.addEventListener('resize', compute);
    window.addEventListener('scroll', compute, true);
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', compute);
      window.removeEventListener('scroll', compute, true);
    };
  }, [open]);

  return (
    <>
      <button
        ref={rowRef}
        type="button"
        onClick={onToggle}
        className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs transition-colors ${
          open ? 'bg-gray-100 dark:bg-white/5' : 'hover:bg-gray-100 dark:hover:bg-white/5'
        } text-gray-700 dark:text-gray-200`}
      >
        <span className="flex-none text-gray-400">{icon}</span>
        <span className="flex-1">{label}</span>
        <ChevronRight className={`h-3.5 w-3.5 flex-none text-gray-400 ${coords?.placement === 'left' ? 'rotate-180' : ''}`} />
      </button>
      {open && createPortal(
        <div
          ref={panelRef}
          data-eh-ctxmenu
          style={{
            position: 'fixed',
            left: coords?.left ?? -9999,
            top: coords?.top ?? -9999,
            // Cap to the viewport so an over-tall panel scrolls instead of spilling
            // off the bottom — this also keeps measured height ≤ vh-2·pad, which makes
            // the top-clamp provably overflow-free.
            maxHeight: 'calc(100vh - 16px)',
            overflowY: 'auto',
            // Hidden (but still measurable AND focusable — unlike visibility:hidden)
            // until positioned, so there's no first-paint flash at -9999.
            opacity: coords ? 1 : 0,
            pointerEvents: coords ? undefined : 'none',
            zIndex: 1000001,
          }}
          className="min-w-[210px] rounded-xl border border-gray-200/80 bg-white/95 py-1 shadow-2xl backdrop-blur-xl dark:border-white/10 dark:bg-[#1e1f2a]/95"
        >
          {children}
        </div>,
        document.body,
      )}
    </>
  );
}

/** A flyout body with an auto-focused fuzzy search input and top-N results. */
function SearchPicker<T>({
  placeholder, emptyText, filter, getKey, renderItem, onPick,
}: {
  placeholder: string;
  emptyText: string;
  filter: (q: string) => T[];
  getKey: (t: T) => string;
  renderItem: (t: T) => ReactNode;
  onPick: (t: T) => void;
}) {
  const [q, setQ] = useState('');
  const results = filter(q);
  return (
    <div className="w-64">
      <div className="flex items-center gap-1.5 px-2 py-1.5">
        <Search className="h-3.5 w-3.5 flex-none text-gray-400" />
        <input
          autoFocus
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onClick={(e) => e.stopPropagation()}
          placeholder={placeholder}
          className="w-full bg-transparent text-xs text-gray-700 outline-none placeholder:text-gray-400 dark:text-gray-200"
        />
      </div>
      <div className="border-t border-gray-100 dark:border-white/5" />
      <div className="max-h-56 overflow-auto py-0.5">
        {results.length === 0 ? (
          <div className="px-3 py-1.5 text-[11px] italic text-gray-400">{emptyText}</div>
        ) : (
          results.map((t) => (
            <button
              key={getKey(t)}
              type="button"
              onClick={() => onPick(t)}
              className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-gray-700 transition-colors hover:bg-gray-100 dark:text-gray-200 dark:hover:bg-white/5"
            >
              {renderItem(t)}
            </button>
          ))
        )}
      </div>
    </div>
  );
}
