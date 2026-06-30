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
