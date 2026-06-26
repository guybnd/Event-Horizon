import type { Notification } from '../api';

/**
 * FLUX-726: portal-side categorization of the 4 notification types into two buckets.
 *
 *  - **action** — `prompt` (Require Input / Needs-action) + `error` (integration incomplete,
 *    skills outdated, PR failures). These demand a decision or signal a failure.
 *  - **update** — `completion` (ticket done) + `info` (update available). FYI only.
 *
 * This is a pure presentation map kept on the client on purpose — with only 4 types it's the
 * smallest surface and avoids adding a server `category` field (and the ticket-schema + reference-
 * doc churn that would bring). The Notification payload/shape is unchanged.
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
