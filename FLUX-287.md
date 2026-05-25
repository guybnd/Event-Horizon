---
id: FLUX-287
title: 'Engine: normalize legacy status_change shapes (oldStatus/newStatus → from/to)'
status: Released
priority: High
effort: S
implementationLink: c31cb35
assignee: unassigned
tags:
  - bug
  - engine
createdBy: Guy
updatedBy: Agent
history:
  - type: activity
    user: Guy
    date: '2026-05-25T10:00:00.000Z'
    comment: Created ticket.
  - type: activity
    user: Guy
    date: '2026-05-25T10:00:00.000Z'
    comment: >-
      Created ticket. FLUX-281 history contains status_change entries with
      oldStatus/newStatus instead of from/to, written by Gemini CLI and a Claude
      session. The engine treats these as malformed (hasAppendedStatusChange
      misses them) and downstream gates silently fail.
  - type: comment
    user: Agent
    date: '2026-05-25T10:05:00.000Z'
    comment: >-
      Plan: extend normalizeHistoryEntries in engine/src/history.ts to migrate
      status_change entries with oldStatus/newStatus → from/to. Marking changed
      so the file is rewritten on next save (auto-heal). No migration script;
      FLUX-281 self-heals on its next API write.
    id: c-2026-05-25t10-05-00-000z
  - type: status_change
    from: Grooming
    to: In Progress
    user: Agent
    date: '2026-05-25T10:05:30.000Z'
  - type: comment
    user: Agent
    date: '2026-05-25T10:25:00.000Z'
    comment: >-
      Implemented in engine/src/history.ts normalizeHistoryEntries:
      status_change entries with oldStatus/newStatus get migrated to from/to and
      the changed flag triggers a rewrite on next save. Verified with a test
      script using FLUX-281's actual legacy entries — both entries normalized
      correctly, hasAppendedStatusChange now matches. FLUX-281 will self-heal on
      its next API write.
    id: c-2026-05-25t10-25-00-000z
  - type: status_change
    from: In Progress
    to: Ready
    user: Agent
    date: '2026-05-25T10:25:30.000Z'
  - type: status_change
    from: Done
    to: Released
    user: Agent
    date: '2026-05-25T09:54:03.285Z'
version: v0.8.0
releasedAt: '2026-05-25T09:54:03.285Z'
releaseDocPath: release-notes/v0.8.0
---

## Problem / Motivation

Agents editing `.flux/<id>.md` directly sometimes invent the wrong status_change shape — `oldStatus`/`newStatus` instead of the canonical `from`/`to` defined in [engine/src/task-store.ts:104-111](engine/src/task-store.ts#L104-L111). Once written to disk, those entries:

- Bypass `hasAppendedStatusChange` checks in [engine/src/history.ts:182-187](engine/src/history.ts#L182-L187), so the `Require Input`/`Ready` comment-required gates in [engine/src/routes/tasks.ts:237-253](engine/src/routes/tasks.ts#L237-L253) silently miss them.
- Render incorrectly in the portal's history view.
- Persist forever — there is no normalization pass on read.

FLUX-281 is the current example: lines 35-44 and 53-57 use the wrong shape.

## Implementation Plan

### Step 1: Normalize on load

In `engine/src/history.ts` `normalizeHistoryEntries`, for any entry where `type === 'status_change'`:
- If `from` is missing but `oldStatus` is present, copy `oldStatus → from` and delete `oldStatus`.
- Same for `newStatus → to`.
- Mark `changed = true` so the file is rewritten on next save.

### Step 2: Heal existing data

`normalizeHistoryEntries` is called on every load via `task-store.ts`, so the next save of FLUX-281 (or any affected ticket) will write the corrected shape automatically. No migration script needed.

### Step 3: Validation

- Verify FLUX-281 normalizes correctly: read it through the API, save a no-op change, confirm the YAML now has `from`/`to`.
- Confirm `hasAppendedStatusChange` matches against the normalized history.

## Out of Scope

- Forcing agents through the API instead of YAML edits → [[FLUX-289]].
- Documentation / "WRONG vs RIGHT" examples in the skill → [[FLUX-288]].
