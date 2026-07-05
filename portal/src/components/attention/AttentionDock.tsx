import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import {
  AlertTriangle,
  ArrowRight,
  CheckCheck,
  ChevronDown,
  ExternalLink,
  FileWarning,
  GitMerge,
  HelpCircle,
  MessageCircleQuestion,
  RefreshCw,
  ShieldAlert,
  type LucideIcon,
} from 'lucide-react';
import { useAppSelector, useAppActions, useTaskById } from '../../store/useAppSelector';
import { API_URL, resolvePermission } from '../../api';
import { useNotificationPrefs, isNotificationVisible } from '../../hooks/useNotificationPrefs';
import { useDockActions, useDockOpenIds } from '../DockProvider';
import { usePendingInteractions, requireInputMeta } from '../pendingInteractions';
import { ApprovalCard } from '../ApprovalPrompts';
import { QuestionCard } from '../AskQuestionPrompts';
import { RebaseCard, RebaseFailureCard } from '../BoardRebasePanel';
import { FloatingPanel } from '../FloatingPanel';
import { NotificationPanel } from '../NotificationPanel';
import { TicketRefChip } from '../TicketRefChip';
import { ActivityPanel } from '../ActivityPanel';
import { ParseErrorBanner } from '../ParseErrorBanner';
import { useAttentionAck, deriveDockLabel, type AttentionTab } from './attentionAck';

/**
 * FLUX-898: the unified, dock-anchored attention surface.
 *
 * One dock button answers "what needs me?" via a 3-tier dynamic label (Needs You ▸ Updates ▸
 * Activity, highest-priority-wins). Clicking it raises a corner-resizable, size-persistent panel
 * with three tabs:
 *   - Needs you — live blocking interactions (approvals / questions / board-rebases / require-input)
 *     + pinned system items (parse errors, restart), each mirrored here with a glow-until-acked
 *     wrapper, an originating-ticket ref (+ hover mini-panel) and a "Jump to chat" affordance.
 *   - Updates  — the bell `NotificationPanel`, embedded.
 *   - Activity — the board `ActivityPanel`, embedded.
 *
 * A new blocking prompt PEEKS from the button (no auto-open, never covers board cards) with inline
 * actions + a minimize that tucks it back unacknowledged. Read ≠ resolved: acknowledging stops the
 * glow but an item leaves only when actually acted on. Replaces the old `PendingTab` +
 * `PendingInteractionFallback` floating window; inline-in-chat answering is unchanged.
 */

type ItemKind = 'approval' | 'question' | 'rebase' | 'rebase-failure' | 'require-input' | 'system';

interface NeedsItem {
  key: string;
  kind: ItemKind;
  conversationId: string | null;
  /** Originating ticket id (for the ref chip + mini-panel); null for board/unrouted/system. */
  ticketId: string | null;
  createdAt: string;
  Icon: LucideIcon;
  iconClass: string;
  title: string;
  kindLabel: string;
  /** One-line summary used by the peek. */
  summary: string;
  body: ReactNode;
  /** Peek action style — approvals get inline Allow/Deny, everything else gets Open. */
  peekStyle: 'allow-deny' | 'open' | 'none';
  /** Approval id for the peek's inline Allow/Deny. */
  approvalId?: string;
  /** FLUX-899: a live tool call is paused on this item right now (approvals + questions) — the
   *  card gets a stronger, persistent (non-glow-dependent) visual treatment so it doesn't fade
   *  into the passive items once acknowledged. Board-rebase proposals are async, not a paused
   *  live call, so they stay non-blocking (FLUX-1101). */
  blocking?: boolean;
}

const PEEK_AUTO_DISMISS_MS = 11_000;
/** Bound the per-session "already-peeked" memory so a very long-lived tab can't grow it unbounded. */
const DISMISSED_PEEKS_CAP = 200;

/** The glow-until-acknowledged wrapper around a reused prompt card body. A capture-phase click
 *  anywhere in the card — including on its inner controls — acknowledges it (stops the glow);
 *  the control still resolves as normal. The item stays until it is actually resolved. */
function NeedsCard({
  item,
  isNew,
  onAcknowledge,
  onJump,
}: {
  item: NeedsItem;
  isNew: boolean;
  onAcknowledge: () => void;
  onJump: (id: string) => void;
}) {
  const Icon = item.Icon;
  return (
    <div
      onClickCapture={() => { if (isNew) onAcknowledge(); }}
      title={isNew ? 'Click to acknowledge (stops the glow)' : undefined}
      className={`rounded-xl border p-2.5 transition-colors ${
        isNew
          ? 'eh-attention-glow border-amber-400/60 bg-amber-400/[0.06]'
          : item.blocking
            ? 'eh-border eh-surface ring-1 ring-rose-400/40'
            : 'eh-border eh-surface'
      }`}
    >
      <div className="mb-1.5 flex items-center gap-2">
        {/* FLUX-899: "new" is an icon+label affordance, not color/motion alone — legible with
            reduced-motion (the pulse turns off; the word stays) and for colorblind users. */}
        {isNew && (
          <span className="eh-attention-dot inline-flex shrink-0 items-center rounded-full bg-amber-400/20 px-1.5 py-px text-[9px] font-bold uppercase tracking-wide text-amber-700 ring-1 ring-amber-400/50 dark:text-amber-300">
            New
          </span>
        )}
        <Icon className={`h-4 w-4 shrink-0 ${item.iconClass}`} />
        <span className="truncate text-sm font-semibold text-[var(--eh-text-primary)]">{item.title}</span>
        <span
          className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wide ${
            item.blocking
              ? 'font-bold text-rose-700 ring-1 ring-rose-400/60 bg-rose-500/15 dark:text-rose-300'
              : 'text-[var(--eh-text-muted)] ring-1 ring-[var(--eh-border)]'
          }`}
        >
          {item.kindLabel}
        </span>
        <TicketRefChip ticketId={item.ticketId} time={item.createdAt} variant="muted" alignEnd />
      </div>
      {item.body}
      {item.conversationId && (
        <button
          type="button"
          onClick={() => onJump(item.conversationId as string)}
          className="mt-2 inline-flex items-center gap-1 text-[11px] text-[var(--eh-text-muted)] transition-colors hover:text-primary"
        >
          Jump to chat <ArrowRight className="h-3 w-3" />
        </button>
      )}
    </div>
  );
}

/** A pinned require-input ticket rendered as a needs-you item: free-form question + open-to-answer. */
function RequireInputBody({ ticketId, onOpen }: { ticketId: string; onOpen: (id: string) => void }) {
  const task = useTaskById(ticketId);
  if (!task) return null;
  const question = requireInputMeta(task).question;
  const clipped = question.length > 280 ? `${question.slice(0, 280).trimEnd()}…` : question;
  return (
    <>
      <div className="whitespace-pre-wrap break-words text-[12px] leading-snug text-[var(--eh-text-secondary)]">{clipped}</div>
      <button
        type="button"
        onClick={() => onOpen(ticketId)}
        className="mt-2 inline-flex items-center justify-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-[12px] font-semibold text-white transition-colors hover:bg-primary-hover"
      >
        <ExternalLink className="h-3.5 w-3.5" /> Open to answer
      </button>
    </>
  );
}

function RestartBody() {
  const [restarting, setRestarting] = useState(false);
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-[12px] text-[var(--eh-text-secondary)]">
        {restarting ? 'Restarting…' : 'Engine files changed — active sessions will finish first.'}
      </span>
      {!restarting && (
        <button
          type="button"
          onClick={async () => {
            setRestarting(true);
            try { await fetch(`${API_URL}/restart`, { method: 'POST' }); } catch { /* connection drops on restart */ }
          }}
          className="shrink-0 rounded-lg bg-amber-500 px-3 py-1 text-[12px] font-semibold text-white transition-colors hover:bg-amber-600"
        >
          Restart now
        </button>
      )}
    </div>
  );
}

export function AttentionDock() {
  const pi = usePendingInteractions();
  const {
    approvals, questions, rebases, rebaseFailures, requireInputTickets, singleActiveConversationId,
    removeApproval, removeQuestion, removeRebase, reportRebaseFailure, dismissRebaseFailure,
  } = pi;
  // FLUX-923: which chat windows are open right now. Drives the dynamic attention handoff — a prompt
  // whose chat is OPEN is already shown inline there, so the dock must NOT also peek/glow for it (no
  // double-demand). The moment that chat is minimized/closed the dock re-asserts the glow. Cheap
  // subscription (open-set only), so this doesn't re-render on composer keystrokes.
  const openIdList = useDockOpenIds();
  const openIds = useMemo(() => new Set(openIdList), [openIdList]);
  const notifications = useAppSelector((s) => s.notifications);
  const parseErrors = useAppSelector((s) => s.parseErrors);
  const restartPending = useAppSelector((s) => s.restartPending);
  const { refreshNotifications } = useAppActions();
  const { openChat, openTicket } = useDockActions();
  const { prefs } = useNotificationPrefs();
  const ack = useAttentionAck();

  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<AttentionTab>('needs');
  const [revealNonce, setRevealNonce] = useState(0);
  const [peekKey, setPeekKey] = useState<string | null>(null);
  // FLUX-898 (M3): pause the peek auto-dismiss while the user is hovering / keyboard-focused inside it.
  const [peekPaused, setPeekPaused] = useState(false);
  // FLUX-898 (M3): text for the assertive sr-only live region — announces a freshly-arrived needs-you item.
  const [announce, setAnnounce] = useState('');
  const knownKeysRef = useRef<Set<string> | null>(null);
  const dismissedPeeksRef = useRef<Set<string>>(new Set());

  // Unread notifications that the Updates tab actually shows (honors mute prefs) — drives the count.
  const unreadNotifications = useMemo(
    () => notifications.filter((n) => !n.read && !n.dismissed && isNotificationVisible(n, prefs)).length,
    [notifications, prefs],
  );

  const jumpToChat = useCallback((id: string) => { openChat(id); setOpen(false); }, [openChat]);
  const openToAnswer = useCallback((id: string) => { openTicket(id); setOpen(false); }, [openTicket]);

  // Remember a peeked key so it doesn't peek again this session — capped to bound growth.
  const rememberDismissedPeek = useCallback((key: string) => {
    const s = dismissedPeeksRef.current;
    s.add(key);
    if (s.size > DISMISSED_PEEKS_CAP) dismissedPeeksRef.current = new Set([...s].slice(-DISMISSED_PEEKS_CAP));
  }, []);

  // The ordered needs-you list, each mirrored on the surface regardless of whether its chat is open.
  const items = useMemo<NeedsItem[]>(() => {
    const list: NeedsItem[] = [];
    for (const p of approvals) {
      list.push({
        key: `approval:${p.id}`, kind: 'approval', conversationId: p.conversationId, ticketId: p.conversationId,
        createdAt: p.createdAt, Icon: ShieldAlert, iconClass: 'text-amber-500', title: 'Permission request',
        kindLabel: 'blocking', summary: `Permission — ${p.toolName}`, peekStyle: 'allow-deny', approvalId: p.id,
        blocking: true,
        body: <ApprovalCard pending={p} onResolved={() => removeApproval(p.id)} />,
      });
    }
    for (const p of questions) {
      const q = p.questions[0];
      list.push({
        key: `question:${p.id}`, kind: 'question', conversationId: p.conversationId, ticketId: p.conversationId,
        createdAt: p.createdAt, Icon: MessageCircleQuestion, iconClass: 'text-violet-500', title: 'Question from agent',
        kindLabel: 'decision', summary: q?.header || q?.question || 'Awaiting your answer', peekStyle: 'open',
        blocking: true,
        body: <QuestionCard pending={p} onResolved={() => removeQuestion(p.id)} scrollable />,
      });
    }
    for (const p of rebases) {
      list.push({
        key: `rebase:${p.id}`, kind: 'rebase', conversationId: p.conversationId, ticketId: p.conversationId,
        createdAt: p.createdAt, Icon: GitMerge, iconClass: 'text-primary', title: 'Board-rebase proposal',
        kindLabel: 'review', summary: `Board rebase · ${p.items.length} item${p.items.length === 1 ? '' : 's'}`, peekStyle: 'open',
        body: <RebaseCard batch={p} onResolved={() => removeRebase(p.id)} onFailures={reportRebaseFailure} />,
      });
    }
    for (const f of rebaseFailures) {
      list.push({
        key: `rebase-failure:${f.batchId}`, kind: 'rebase-failure', conversationId: f.conversationId, ticketId: f.conversationId,
        createdAt: f.createdAt, Icon: AlertTriangle, iconClass: 'text-rose-500', title: 'Board-rebase failed',
        kindLabel: 'failed', summary: `Rebase failures · ${f.failed.length} item${f.failed.length === 1 ? '' : 's'}`, peekStyle: 'open',
        body: <RebaseFailureCard failure={f} onDismiss={() => dismissRebaseFailure(f.batchId)} />,
      });
    }
    for (const t of requireInputTickets) {
      const meta = requireInputMeta(t);
      list.push({
        key: `require-input:${t.id}:${meta.setDate}`, kind: 'require-input', conversationId: t.id, ticketId: t.id,
        createdAt: meta.setDate || '', Icon: HelpCircle, iconClass: 'text-amber-500',
        title: 'Awaiting your input', kindLabel: 'require-input', summary: meta.question, peekStyle: 'open',
        body: <RequireInputBody ticketId={t.id} onOpen={openToAnswer} />,
      });
    }
    // Pinned system items — global one-off banners folded into the surface.
    if (parseErrors.length > 0) {
      list.push({
        key: 'system:parse', kind: 'system', conversationId: null, ticketId: null, createdAt: '',
        Icon: FileWarning, iconClass: 'text-rose-500', title: 'Corrupted ticket file(s)', kindLabel: 'system',
        summary: `${parseErrors.length} ticket file(s) failed to parse`, peekStyle: 'none',
        body: <ParseErrorBanner errors={parseErrors} />,
      });
    }
    if (restartPending) {
      list.push({
        key: 'system:restart', kind: 'system', conversationId: null, ticketId: null, createdAt: '',
        Icon: RefreshCw, iconClass: 'text-amber-500', title: 'Engine restart pending', kindLabel: 'system',
        summary: 'Engine restart pending', peekStyle: 'none', body: <RestartBody />,
      });
    }
    return list;
  }, [approvals, questions, rebases, rebaseFailures, requireInputTickets, parseErrors, restartPending,
      removeApproval, removeQuestion, removeRebase, reportRebaseFailure, dismissRebaseFailure, openToAnswer]);

  const needsYouCount = items.length;
  const label = deriveDockLabel(needsYouCount, unreadNotifications);

  // FLUX-923: is this item's prompt ALREADY shown inline in an open chat? For a routed item that's its
  // own conversation window; for an UNROUTED question (conversationId == null) it's the resilience-net
  // claimant — the single live chat that surfaces it inline (see ChatQuestionPicker / pendingInteractions).
  // System items (no conversation) are never "open inline", so they always keep demanding. An item stays
  // LISTED in the panel regardless — only the peek + button glow (the demand) are suppressed while open.
  const isOpenInline = useCallback(
    (item: NeedsItem) => {
      const cid = item.conversationId ?? (item.kind === 'question' ? singleActiveConversationId : null);
      return cid != null && openIds.has(cid);
    },
    [openIds, singleActiveConversationId],
  );
  // Items that still DEMAND attention from the dock — i.e. not currently shown inline in an open chat.
  const hasDemanding = items.some((i) => !isOpenInline(i));

  // Peek bookkeeping: surface a freshly-arrived, unacknowledged, non-dismissed blocking item (the
  // first in priority order — approvals → questions → rebases → …) when the panel is closed, instead
  // of auto-opening the panel (FLUX-898: peek, never force-open).
  useEffect(() => {
    const currentKeys = new Set(items.map((i) => i.key));
    // First run seeds the baseline so pre-existing items never peek on mount/reload.
    if (knownKeysRef.current === null) {
      knownKeysRef.current = currentKeys;
      return;
    }
    const known = knownKeysRef.current;
    // Clear a peek whose item has resolved, OR whose chat is now open (it shows inline there — FLUX-923).
    if (peekKey) {
      const pk = items.find((i) => i.key === peekKey);
      if (!pk || isOpenInline(pk)) setPeekKey(null);
    }
    // A11y (FLUX-898 M3): announce a freshly-arrived blocking item to screen readers regardless of
    // whether the panel is open, so a waiting permission approval / question isn't silent. FLUX-923:
    // the announcement fires even when the item is already shown inline in an open chat — the inline
    // picker has no role/aria-live, so without this a sighted-only visual pulse would leave a SR user
    // with no cue at all. (We do NOT suppress on `isOpenInline` here: the key is marked `known` below
    // unconditionally, so suppressing-while-open would also silence it permanently after a minimize.)
    // Only the visual peek below stays suppressed while open — an announcement isn't a double-demand.
    const arrived = items.find(
      (i) => i.peekStyle !== 'none' && !known.has(i.key) && !ack.isAcked(i.key),
    );
    if (arrived) setAnnounce(`${arrived.title}: ${arrived.summary}`);
    if (!open) {
      // FLUX-923: never peek a prompt whose chat is open (no double-demand) — the inline picker has it.
      const candidate = items.find(
        (i) => i.peekStyle !== 'none' && !known.has(i.key) && !ack.isAcked(i.key) && !dismissedPeeksRef.current.has(i.key) && !isOpenInline(i),
      );
      if (candidate) setPeekKey(candidate.key);
    }
    knownKeysRef.current = currentKeys;
    // ack.isAcked is a stable useCallback (keyed on the acked set); depending on the whole `ack`
    // object (recreated each render) would needlessly re-run this peek selector every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, open, peekKey, ack.isAcked, isOpenInline]);

  // Opening the panel dismisses any peek.
  useEffect(() => { if (open) setPeekKey(null); }, [open]);

  // A fresh peek starts un-paused — the previous peek's hover/focus state shouldn't carry over.
  useEffect(() => { setPeekPaused(false); }, [peekKey]);

  // Auto-dismiss the peek (tucks it back unacknowledged) after a few seconds — but PAUSE the timer
  // while the user is hovering or keyboard-focused inside it (M3), so an in-flight Allow/Deny click
  // isn't yanked out from under them. Leaving/blurring restarts the full window.
  useEffect(() => {
    if (!peekKey || peekPaused) return;
    const t = window.setTimeout(() => {
      rememberDismissedPeek(peekKey);
      setPeekKey(null);
    }, PEEK_AUTO_DISMISS_MS);
    return () => window.clearTimeout(t);
  }, [peekKey, peekPaused, rememberDismissedPeek]);

  const peekItem = peekKey ? items.find((i) => i.key === peekKey) ?? null : null;

  // FLUX-1023: the peek must draw above every real window (chat docks / modals), but it lives inside
  // the dock bar — a `fixed z-40` element with a `-translate-x-1/2` transform, i.e. its own stacking
  // context — so an `absolute z-50` peek nested there is capped at effective level 40 and page-level
  // chat windows (`fixed z-50`) draw over it. Portaling the peek to <body> (like the opened panel)
  // escapes that context; we anchor it off the live dock-button rect so it still points at the button.
  const buttonRef = useRef<HTMLButtonElement>(null);
  const [peekPos, setPeekPos] = useState<{ left: number; bottom: number } | null>(null);
  useLayoutEffect(() => {
    if (!peekKey || open) { setPeekPos(null); return; }
    const measure = () => {
      const el = buttonRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      // Sit 8px above the button (matches the old `mb-2` gap), left edges aligned.
      setPeekPos({ left: r.left, bottom: window.innerHeight - r.top + 8 });
    };
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [peekKey, open]);

  const toggleOpen = useCallback(() => {
    setOpen((v) => {
      const next = !v;
      if (next) { setTab(label.tab); setRevealNonce((n) => n + 1); }
      return next;
    });
  }, [label.tab]);

  const markAllRead = useCallback(() => { ack.acknowledge(items.map((i) => i.key)); }, [ack, items]);

  const minimizePeek = useCallback(() => {
    if (peekKey) rememberDismissedPeek(peekKey);
    setPeekKey(null);
  }, [peekKey, rememberDismissedPeek]);

  const peekAllow = useCallback(async (id: string, behavior: 'allow' | 'deny') => {
    setPeekKey(null);
    try { await resolvePermission(id, behavior); removeApproval(id); } catch { /* stays in drawer to retry */ }
  }, [removeApproval]);

  // FLUX-923: glow the dock button only while something still DEMANDS attention — suppress the amber
  // pulse when every needs-you item is already shown inline in an open chat (it stays listed + counted
  // in the panel, just not loudly demanding). Re-asserts the instant such a chat is minimized.
  const tone = label.attention && hasDemanding;
  const TABS: { key: AttentionTab; label: string; count: number | null }[] = [
    { key: 'needs', label: 'Needs you', count: needsYouCount },
    { key: 'updates', label: 'Updates', count: unreadNotifications },
    { key: 'activity', label: 'Activity', count: null },
  ];
  const LabelIcon = label.Icon;

  return (
    <div className="relative flex-shrink-0">
      {/* A11y (M3): assertive live region announcing a freshly-arrived needs-you item, so a blocking
          permission approval / question is signalled to screen readers even when the panel is closed. */}
      <div role="alert" aria-live="assertive" className="sr-only">{announce}</div>
      {/* The dock button — dynamic 3-tier label. */}
      <button
        ref={buttonRef}
        type="button"
        onClick={toggleOpen}
        aria-label={`${label.label}${label.count != null ? ` — ${label.count}` : ''}`}
        title={label.label}
        className={`group relative flex h-9 flex-shrink-0 items-center gap-1.5 rounded-lg border pl-2 pr-2.5 text-left shadow-sm transition-all duration-150 ${
          tone
            ? 'eh-taskcard-needs-input border-amber-400/70 bg-amber-400/15 text-amber-700 dark:text-amber-300'
            : open
              ? 'border-gray-300 bg-gray-100 text-gray-700 dark:border-white/20 dark:bg-white/15 dark:text-gray-200'
              : 'border-gray-200 bg-white text-gray-500 hover:bg-gray-50 dark:border-white/10 dark:bg-white/5 dark:text-gray-400 dark:hover:bg-white/10'
        }`}
      >
        <LabelIcon className={`h-4 w-4 flex-shrink-0 ${tone ? 'text-amber-500' : ''}`} />
        <span className="text-xs font-semibold leading-none tracking-tight">{label.label}</span>
        {label.count != null && (
          <span className={`ml-0.5 flex h-4 min-w-[16px] items-center justify-center rounded-full px-1 text-[10px] font-bold leading-none text-white ${tone ? 'bg-amber-500' : 'bg-sky-500'}`}>
            {label.count}
          </span>
        )}
        {open && (
          <span aria-hidden className="pointer-events-none absolute bottom-0 left-1/2 h-[2px] w-3/4 -translate-x-1/2 rounded-full bg-current opacity-70" />
        )}
      </button>

      {/* The peek — anchored above the button, never covers board cards, never force-opens the panel.
          FLUX-1023: portaled to <body> with fixed geometry (see peekPos above) so it escapes the dock
          bar's z-40/transform stacking context and draws over chat windows + modals at z-[70]. */}
      {peekItem && !open && peekPos && createPortal(
        <div
          className="fixed z-[70] w-max max-w-[min(92vw,420px)]"
          style={{ left: peekPos.left, bottom: peekPos.bottom }}
          onPointerEnter={() => setPeekPaused(true)}
          onPointerLeave={() => setPeekPaused(false)}
          onFocus={() => setPeekPaused(true)}
          onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setPeekPaused(false); }}
        >
          <div className="eh-attention-glow flex items-center gap-2 rounded-lg border border-amber-400/60 bg-[var(--eh-surface)] px-3 py-2 shadow-2xl">
            <peekItem.Icon className={`h-4 w-4 shrink-0 ${peekItem.iconClass}`} />
            <TicketRefChip ticketId={peekItem.ticketId} variant="muted" alignEnd />
            <span className="min-w-0 flex-1 truncate text-xs text-[var(--eh-text-secondary)]">{peekItem.summary}</span>
            {peekItem.peekStyle === 'allow-deny' && peekItem.approvalId ? (
              <>
                <button type="button" onClick={() => peekAllow(peekItem.approvalId as string, 'allow')} className="shrink-0 rounded border border-emerald-500/30 bg-emerald-500/20 px-2 py-0.5 text-[11px] font-medium text-emerald-700 transition-colors hover:bg-emerald-500/30 dark:text-emerald-300">Allow</button>
                <button type="button" onClick={() => peekAllow(peekItem.approvalId as string, 'deny')} className="shrink-0 rounded border border-rose-500/25 bg-rose-500/15 px-2 py-0.5 text-[11px] font-medium text-rose-700 transition-colors hover:bg-rose-500/25 dark:text-rose-300">Deny</button>
              </>
            ) : null}
            <button type="button" onClick={toggleOpen} className="shrink-0 text-[11px] text-[var(--eh-text-muted)] transition-colors hover:text-primary">Open</button>
            <span className="h-4 w-px shrink-0 bg-[var(--eh-border)]" />
            <button
              type="button"
              onClick={minimizePeek}
              title="Tuck back into the surface — stays unacknowledged (keeps glowing in the drawer)"
              aria-label="Minimize"
              className="shrink-0 text-[var(--eh-text-muted)] transition-colors hover:text-[var(--eh-text-primary)]"
            >
              <ChevronDown className="h-4 w-4" />
            </button>
          </div>
          <span className="absolute -bottom-1 left-5 h-2.5 w-2.5 rotate-45 border-b border-r border-amber-400/60 bg-[var(--eh-surface)]" aria-hidden />
        </div>,
        document.body,
      )}

      {/* The raised panel — corner-resizable + size-persistent, three tabs. Portaled to <body> so its
          position:fixed geometry is viewport-relative (the dock bar's -translate-x transform would
          otherwise re-base it). */}
      {open && createPortal(
        <FloatingPanel
          storageKey="eh.attention.geometry.v1"
          title={
            <span className="flex items-center gap-1.5">
              <LabelIcon className="h-4 w-4" />
              {label.label}
            </span>
          }
          defaultWidth={560}
          defaultHeight={620}
          tone={tone ? 'attention' : 'default'}
          pulse={tone}
          revealSignal={revealNonce}
          onClose={() => setOpen(false)}
        >
          <div className="flex h-full min-h-0 flex-col">
            {/* Tabs */}
            <div className="flex items-center gap-1 border-b border-[var(--eh-border)] pb-2">
              {TABS.map((t) => {
                const active = tab === t.key;
                return (
                  <button
                    key={t.key}
                    type="button"
                    onClick={() => setTab(t.key)}
                    className={`flex items-center gap-1.5 rounded-lg px-2.5 py-1 text-[12px] font-semibold transition-colors ${active ? 'bg-primary/15 text-primary' : 'text-[var(--eh-text-muted)] hover:bg-black/5 dark:hover:bg-white/5'}`}
                  >
                    {t.label}
                    {t.count != null && t.count > 0 && (
                      <span className={`rounded-full px-1.5 text-[10px] font-bold tabular-nums ${active ? 'bg-primary/20 text-primary' : 'bg-black/10 text-[var(--eh-text-muted)] dark:bg-white/10'}`}>{t.count}</span>
                    )}
                  </button>
                );
              })}
              {tab === 'needs' && needsYouCount > 0 && (
                <button
                  type="button"
                  onClick={markAllRead}
                  title="Marks new items as read (stops the glow). Does not dismiss them."
                  className="ml-auto inline-flex items-center gap-1 text-[11px] text-[var(--eh-text-muted)] transition-colors hover:text-primary"
                >
                  <CheckCheck className="h-3 w-3" /> Mark all read
                </button>
              )}
            </div>

            {/* Tab content */}
            <div className="min-h-0 flex-1 overflow-y-auto pt-2">
              {tab === 'needs' && (
                needsYouCount === 0 ? (
                  <div className="px-1 py-10 text-center text-xs text-[var(--eh-text-muted)]">Nothing needs you — you’re all caught up.</div>
                ) : (
                  <div className="flex flex-col gap-2">
                    {items.map((item) => (
                      <NeedsCard
                        key={item.key}
                        item={item}
                        isNew={!ack.isAcked(item.key)}
                        onAcknowledge={() => ack.acknowledge(item.key)}
                        onJump={jumpToChat}
                      />
                    ))}
                  </div>
                )
              )}
              {tab === 'updates' && (
                <NotificationPanel embedded notifications={notifications} onClose={() => setOpen(false)} onUpdate={refreshNotifications} />
              )}
              {tab === 'activity' && <ActivityPanel embedded onClose={() => setOpen(false)} />}
            </div>
          </div>
        </FloatingPanel>,
        document.body,
      )}
    </div>
  );
}
