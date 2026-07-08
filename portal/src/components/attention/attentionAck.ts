import { useCallback, useState } from 'react';
import { Activity, Hand, Mail, type LucideIcon } from 'lucide-react';

/**
 * FLUX-898: the read/acknowledged layer for the unified attention surface.
 *
 * Read (acknowledged) ≠ resolved. A needs-you item GLOWS while it is new/unacknowledged; clicking
 * the card (or "Mark all read") acknowledges it so it stops glowing — but it stays in the drawer
 * until it is actually resolved (Allow/Deny, answered, swimlane cleared). This module owns only the
 * acknowledged flag; presence/resolution stays in `PendingInteractionsProvider` and the notification
 * store. The acked set is persisted (so a previously-seen item doesn't glow again after a reload) and
 * capped — keys for long-resolved items linger harmlessly until they age out.
 */

const ACK_KEY = 'eh-attention-acked';
const ACK_CAP = 400;

function loadAcked(): Set<string> {
  if (typeof window === 'undefined') return new Set();
  try {
    const raw = localStorage.getItem(ACK_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : [];
    return new Set(Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : []);
  } catch {
    return new Set();
  }
}

function saveAcked(set: Set<string>): void {
  try {
    // Cap to bound growth as items churn; most-recent keys win (slice from the tail).
    localStorage.setItem(ACK_KEY, JSON.stringify([...set].slice(-ACK_CAP)));
  } catch {
    /* storage full/disabled — acknowledgement is a nicety, not load-bearing */
  }
}

export interface AttentionAck {
  /** Has this item been acknowledged (seen)? Unacknowledged items glow. */
  isAcked: (key: string) => boolean;
  /** Acknowledge one or many item keys (stops the glow). Never removes the item. */
  acknowledge: (keys: string | string[]) => void;
}

export function useAttentionAck(): AttentionAck {
  const [acked, setAcked] = useState<Set<string>>(loadAcked);
  const isAcked = useCallback((key: string) => acked.has(key), [acked]);
  const acknowledge = useCallback((keys: string | string[]) => {
    const list = Array.isArray(keys) ? keys : [keys];
    setAcked((prev) => {
      let changed = false;
      let next = new Set(prev);
      for (const k of list) if (!next.has(k)) { next.add(k); changed = true; }
      if (!changed) return prev;
      // Cap the in-memory set too (storage is sliced in saveAcked), so a very long-lived tab can't
      // grow the live Set unbounded — keep the most-recent keys (Set preserves insertion order).
      if (next.size > ACK_CAP) next = new Set([...next].slice(-ACK_CAP));
      saveAcked(next);
      return next;
    });
  }, []);
  return { isAcked, acknowledge };
}

/**
 * FLUX-1289 / restored FLUX-1312: dock-only dismiss for a plan-approval item — "stop showing this in
 * the tray, I don't want to look at it right now", distinct from the "full" Set aside
 * (`dismissPlanReview` in `pendingInteractions.tsx`), which clears `planReviewState` everywhere. This
 * one touches NOTHING durable on the ticket — it only hides the AttentionDock "Needs You" tray item,
 * leaving the ticket's verdict / Column lane / `ChatPlanApprovalCard` / board-card chip reflecting
 * real state. Keyed by ticket id + verdict (not just ticket id) so a fresh review pass — a new
 * verdict — re-arms the item even though the ticket id is unchanged. Same localStorage-backed
 * durability tier as `useAttentionAck` above (a nicety, not load-bearing).
 *
 * FLUX-1303 briefly retired this in favor of a single verdict-clearing dismiss on every surface;
 * FLUX-1312 restores it for the attention panel only (the cross-ticket triage inbox — dismissing
 * there means "snooze", not "resolve"), while the chat card and full plan panel keep the real
 * "Set aside".
 */
const DOCK_DISMISS_KEY = 'eh-plan-review-dock-dismissed';
const DOCK_DISMISS_CAP = 200;

function dockDismissKey(ticketId: string, verdict: string): string {
  return `${ticketId}:${verdict}`;
}

function loadDockDismissed(): Set<string> {
  if (typeof window === 'undefined') return new Set();
  try {
    const raw = localStorage.getItem(DOCK_DISMISS_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : [];
    return new Set(Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : []);
  } catch {
    return new Set();
  }
}

function saveDockDismissed(set: Set<string>): void {
  try {
    localStorage.setItem(DOCK_DISMISS_KEY, JSON.stringify([...set].slice(-DOCK_DISMISS_CAP)));
  } catch {
    /* storage full/disabled — dismiss is a nicety, not load-bearing */
  }
}

export interface PlanReviewDockDismiss {
  /** Has this ticket's CURRENT verdict been dock-dismissed? */
  isDockDismissed: (ticketId: string, verdict: string) => boolean;
  /** Dismiss this ticket's current verdict from the dock tray only. */
  dockDismiss: (ticketId: string, verdict: string) => void;
}

export function usePlanReviewDockDismiss(): PlanReviewDockDismiss {
  const [dismissed, setDismissed] = useState<Set<string>>(loadDockDismissed);
  const isDockDismissed = useCallback(
    (ticketId: string, verdict: string) => dismissed.has(dockDismissKey(ticketId, verdict)),
    [dismissed],
  );
  const dockDismiss = useCallback((ticketId: string, verdict: string) => {
    const key = dockDismissKey(ticketId, verdict);
    setDismissed((prev) => {
      if (prev.has(key)) return prev;
      let next = new Set(prev);
      next.add(key);
      if (next.size > DOCK_DISMISS_CAP) next = new Set([...next].slice(-DOCK_DISMISS_CAP));
      saveDockDismissed(next);
      return next;
    });
  }, []);
  return { isDockDismissed, dockDismiss };
}

export type AttentionTab = 'needs' | 'updates' | 'activity';

/** The derived dock-button state: label, tone, icon, count and the tab it opens to. */
export interface DockLabel {
  tab: AttentionTab;
  label: string;
  /** null = no count shown (the calm Activity tier). */
  count: number | null;
  Icon: LucideIcon;
  /** Tier-1 attention tone — amber + pulse on the button. */
  attention: boolean;
}

/**
 * The 3-tier, highest-priority-wins dock label (FLUX-898 acceptance):
 *   1. `Needs You · [#]`  — attention items exist (count = needs-you items) → opens *Needs you*
 *   2. else `Updates · [#]` — unread notifications exist (count = notifications) → opens *Updates*
 *   3. else `Activity`     — nothing needs you, no unread updates (no count) → opens *Activity*
 */
export function deriveDockLabel(needsYouCount: number, unreadNotifications: number): DockLabel {
  if (needsYouCount > 0) {
    return { tab: 'needs', label: 'Needs You', count: needsYouCount, Icon: Hand, attention: true };
  }
  if (unreadNotifications > 0) {
    return { tab: 'updates', label: 'Updates', count: unreadNotifications, Icon: Mail, attention: false };
  }
  return { tab: 'activity', label: 'Activity', count: null, Icon: Activity, attention: false };
}
