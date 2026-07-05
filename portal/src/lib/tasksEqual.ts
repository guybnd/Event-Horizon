import type { InlineSubtask, Task } from '../types';

/**
 * Cheap, allocation-free replacement for the old `buildTaskSignature` double
 * `JSON.stringify` (FLUX-628). Returns true when `a` and `b` are equal across the
 * fields the board's live-event diff cares about, short-circuiting on the first
 * difference — no serialization, no 200-char body slice copy, no array stringify.
 *
 * Compares exactly the fields the old signature hashed (status, title, body
 * length + first 200 chars, assignee, priority, effort, implementationLink,
 * order, swimlane, tags, subtasks, history length + last-entry key, cliSession
 * status/activity/label, tokenMetadata, artifacts (latest + revision count)) so
 * change-detection semantics are unchanged — a pure hot-path swap.
 */
export function tasksEqual(a: Task, b: Task): boolean {
  if (a === b) return true;

  if (
    a.status !== b.status ||
    (a.title || '') !== (b.title || '') ||
    (a.assignee || 'unassigned') !== (b.assignee || 'unassigned') ||
    (a.priority || 'None') !== (b.priority || 'None') ||
    (a.effort || 'None') !== (b.effort || 'None') ||
    (a.implementationLink || '') !== (b.implementationLink || '') ||
    (a.order ?? null) !== (b.order ?? null) ||
    (a.swimlane || null) !== (b.swimlane || null)
  ) {
    return false;
  }

  const aBody = a.body || '';
  const bBody = b.body || '';
  // The old signature only hashed body length + the first 200 chars, so two
  // equal-length bodies whose heads match are treated as unchanged. Preserve that.
  if (aBody.length !== bBody.length) return false;
  if (aBody.length > 0 && aBody.slice(0, 200) !== bBody.slice(0, 200)) return false;

  if (!stringArraysEqual(a.tags, b.tags)) return false;
  if (!subtasksEqual(a.subtasks, b.subtasks)) return false;

  // FLUX-725: history change-detection now reads the list digest (length + last-entry key) instead
  // of the raw `history[]`, which the list payload no longer carries. Any new entry bumps `length`
  // and `lastEntry`, so a new comment / status change is still detected with no missed re-render.
  const aDig = a.historyDigest;
  const bDig = b.historyDigest;
  if ((aDig?.length ?? 0) !== (bDig?.length ?? 0)) return false;
  const aLast = aDig?.lastEntry ?? null;
  const bLast = bDig?.lastEntry ?? null;
  const aLastKey = aLast ? (aLast.date || '') + (aLast.type || '') : null;
  const bLastKey = bLast ? (bLast.date || '') + (bLast.type || '') : null;
  if (aLastKey !== bLastKey) return false;

  if (
    (a.cliSession?.status ?? null) !== (b.cliSession?.status ?? null) ||
    (a.cliSession?.currentActivity ?? null) !== (b.cliSession?.currentActivity ?? null) ||
    (a.cliSession?.label ?? null) !== (b.cliSession?.label ?? null)
  ) {
    return false;
  }

  if (!artifactsEqual(a.artifacts, b.artifacts)) return false;

  return tokenMetadataEqual(a.tokenMetadata, b.tokenMetadata);
}

function artifactsEqual(a: Task['artifacts'], b: Task['artifacts']): boolean {
  // Revisions are append-only and `latest` increments on every publish, so the
  // two scalars (latest pointer + revision count) detect any publish — first
  // artifact (0 → 1) or a new revision — without walking the revisions array.
  return (
    (a?.latest ?? 0) === (b?.latest ?? 0) &&
    (a?.revisions?.length ?? 0) === (b?.revisions?.length ?? 0)
  );
}

function stringArraysEqual(a: string[] | undefined, b: string[] | undefined): boolean {
  const aa = a ?? [];
  const bb = b ?? [];
  if (aa.length !== bb.length) return false;
  for (let i = 0; i < aa.length; i++) {
    if (aa[i] !== bb[i]) return false;
  }
  return true;
}

function subtasksEqual(
  a: (string | InlineSubtask)[] | undefined,
  b: (string | InlineSubtask)[] | undefined,
): boolean {
  const aa = a ?? [];
  const bb = b ?? [];
  if (aa.length !== bb.length) return false;
  for (let i = 0; i < aa.length; i++) {
    const ea = aa[i];
    const eb = bb[i];
    const aIsStr = typeof ea === 'string';
    const bIsStr = typeof eb === 'string';
    if (aIsStr !== bIsStr) return false;
    if (aIsStr) {
      if (ea !== eb) return false;
    } else {
      const oa = ea as InlineSubtask;
      const ob = eb as InlineSubtask;
      if (oa.id !== ob.id || (oa.title || '') !== (ob.title || '') || (oa.status || '') !== (ob.status || '')) {
        return false;
      }
    }
  }
  return true;
}

function tokenMetadataEqual(a: Task['tokenMetadata'], b: Task['tokenMetadata']): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    a.inputTokens === b.inputTokens &&
    a.outputTokens === b.outputTokens &&
    a.costUSD === b.costUSD &&
    (a.costIsEstimated ?? false) === (b.costIsEstimated ?? false) &&
    (a.cacheReadTokens ?? 0) === (b.cacheReadTokens ?? 0) &&
    (a.cacheCreationTokens ?? 0) === (b.cacheCreationTokens ?? 0)
  );
}
