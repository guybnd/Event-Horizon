---
assignee: unassigned
tags:
  - bug
priority: High
effort: XS
implementationLink: 338f602
subtasks: []
history:
  - type: activity
    user: Guy
    date: '2026-05-09T04:25:00.000Z'
    comment: Created ticket.
  - type: agent_message
    user: Claude Code
    date: '2026-05-09T04:25:00.000Z'
    comment: >-
      Fixed. Removed `overflow-x-auto` from the block `code` element in
      `TaskMarkdown.tsx` — the `pre` wrapper already handles horizontal
      scrolling with `w-full overflow-x-auto`. Also changed `pre` from
      `max-w-full` to `w-full` for consistent containment. Agent comment boxes
      with code fences now scroll horizontally within the box instead of
      expanding it.


      Commit: 338f602
  - type: status_change
    from: Ready
    to: Done
    user: Agent
    date: '2026-05-09T04:25:01.000Z'
  - type: status_change
    from: Ready
    to: Done
    user: Agent
    date: '2026-05-09T04:19:12.700Z'
  - type: activity
    user: Agent
    date: '2026-05-09T04:19:12.700Z'
    comment: Updated implementation link.
  - type: agent_message
    user: Claude Code
    date: '2026-05-09T04:19:15.650Z'
    comment: >-
      ```text

      FLUX-153 is closed. Commit `338f602` — removed `overflow-x-auto` from the
      block `code` element in `TaskMarkdown.tsx`; the `pre` wrapper handles
      scrolling, so agent comment boxes with code fences now stay contained
      instead of overflowing.

      ```
  - type: status_change
    from: Done
    to: Released
    user: Agent
    date: '2026-05-09T08:10:27.355Z'
title: comment boxes from the agent are cutoff
status: Released
createdBy: Guy
updatedBy: Agent
order: 1
version: 0.2.0
releasedAt: '2026-05-09T08:10:27.355Z'
releaseDocPath: release-notes/0.2.0
---
## Problem

Agent comment boxes in the ticket modal activity feed are horizontally cut off. Long lines of text overflow the container instead of wrapping, making the content unreadable.

## Root Cause

The comment box `div` in `TaskModal.tsx` uses `flex-1` but is missing `min-w-0`. In CSS flexbox, items do not shrink below their intrinsic content size by default. Without `min-w-0`, the container refuses to shrink when its content (long unbroken text) is wider than available space, causing the overflow/cutoff.

## Fix

Add `min-w-0` to the comment entry container div at `portal/src/components/TaskModal.tsx:1438`.

**Before:**
```
className={`flex-1 rounded-lg border p-3 transition-colors ${...}`}
```

**After:**
```
className={`flex-1 min-w-0 rounded-lg border p-3 transition-colors ${...}`}
```

## Validation

- Verify agent comments with long lines wrap correctly in the activity feed.
- Verify all comment types (agent_message, comment, status_change) still render correctly.
