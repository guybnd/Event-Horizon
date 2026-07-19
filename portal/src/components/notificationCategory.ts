import type { Notification } from '../api';

/**
 * FLUX-726: portal-side categorization of the notification types into two buckets.
 *
 *  - **action** — `prompt` (Require Input / Needs-action) + `error` (integration incomplete,
 *    skills outdated, PR failures). These demand a decision or signal a failure.
 *  - **update** — `completion` (ticket done) + `review` (verdict recorded) + `info` (update
 *    available). FYI only.
 *
 * This is a pure presentation map kept on the client on purpose — it's the smallest surface and
 * avoids adding a server `category` field (and the ticket-schema + reference-doc churn that would
 * bring). The Notification payload/shape is unchanged.
 *
 * FLUX-922: `review` lands in `update` (the verdict is a status outcome, not a blocking ask) — a
 * `changes-requested` verdict already re-routes the ticket to In Progress, where the resulting
 * needs-action surfaces drive the follow-up.
 */
export type NotificationCategory = 'action' | 'update';

export function notificationCategory(type: Notification['type']): NotificationCategory {
  return type === 'prompt' || type === 'error' ? 'action' : 'update';
}

/** Ordered category metadata — "Action needed" leads (FLUX-726 acceptance #2). */
export const CATEGORY_META: { key: NotificationCategory; label: string }[] = [
  { key: 'action', label: 'Action needed' },
  { key: 'update', label: 'Updates' },
];

/**
 * FLUX-1486: a pre-spawn session-launch failure deserves a foreground surface even while the
 * window is focused (unlike ordinary `prompt`/`error` chatter, which stays badge-only per
 * FLUX-796). Detected by the message shape the engine already emits for this case — see
 * `${session.label} session failed to start: ${message}` in `engine/src/routes/cli-session.ts`
 * (raiseNeedsAction call). No new notification subtype; if that reason string is ever reworded,
 * this predicate silently stops matching.
 */
export function isLaunchFailureNotification(n: Notification): boolean {
  return n.type === 'prompt' && n.message.includes('session failed to start');
}
