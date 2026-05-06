---
title: Comment box improvements
status: Todo
createdBy: Guy
updatedBy: Guy
assignee: unassigned
tags:
  - task
history:
  - type: comment
    user: Agent
    date: '2026-05-06T07:31:00.000Z'
    comment: >-
      Fleshed this out. The nested/threaded comments feature has significant
      design implications — need your input on scope. See Open Questions.
  - type: comment
    user: Guy
    date: '2026-05-06T07:32:51.632Z'
    comment: |-
      1. one level

      @.  inline

      3. yes

      4. split into ticket if you wish
  - type: status_change
    from: Require Input
    to: Todo
    user: Guy
    date: '2026-05-06T07:32:56.983Z'
  - type: status_change
    from: Todo
    to: Require Input
    user: Guy
    date: '2026-05-06T07:46:49.892Z'
  - type: status_change
    from: Require Input
    to: Todo
    user: Guy
    date: '2026-05-06T08:06:21.440Z'
---
## Summary

Improve the comments/activity section of the task modal with filtering, threaded replies, and unique comment IDs for agent interoperability.

## Requirements

### 1. Toggle between full activity and comments-only
- Add a toggle/tab at the top of the activity section: **"All Activity"** | **"Comments Only"**
- "All Activity" shows everything (status changes + comments) — current behavior
- "Comments Only" filters out `status_change` entries, showing only `comment` type entries
- Remember the user's preference (localStorage or just session state)

### 2. Nested/threaded comments
- Allow replying to a specific comment
- Each comment displays a "Reply" button
- Replies are indented below the parent comment
- Thread can be collapsed/expanded
- Visual connector line from parent to child (like GitHub/Slack threads)

### 3. Comment IDs
- Each history entry of type `comment` gets a unique `id` field (e.g. UUID or incrementing `c-1`, `c-2`)
- Reply comments reference the parent via a `replyTo` field
- This enables agents to reference specific comments (e.g. "Responding to comment c-3")

## Data Model Changes

### Updated `HistoryEntry` type
```typescript
export interface HistoryEntry {
  id?: string;          // NEW — unique comment ID (e.g. "c-1")
  type: 'status_change' | 'comment';
  from?: string;
  to?: string;
  user: string;
  date: string;
  comment?: string;
  replyTo?: string;     // NEW — parent comment ID for threading
}
```

### ID generation
- Auto-generate IDs for new comments: `c-${Date.now()}-${Math.random().toString(36).substr(2, 4)}`
- Existing comments without IDs are treated as top-level (no ID needed for backwards compat)

## Open Questions

> **@Guy — Need your input:**
>
> 1. **Thread depth?** Should threading be limited to one level (reply to a comment, but can't reply to a reply), or unlimited nesting? One level is simpler and usually sufficient.
> 2. **Reply UI?** When clicking "Reply", should the comment input appear inline below the comment, or should it use the existing comment box at the bottom with a "Replying to..." indicator?
> 3. **Migration?** Should we retroactively generate IDs for existing comments, or only add IDs to new comments going forward?
> 4. **Priority?** Should we do all three features (toggle, threading, IDs) together, or split into separate tickets? The toggle is simple and independent; threading + IDs are coupled.

## Acceptance Criteria

- [ ] Activity section has "All" / "Comments" filter toggle
- [ ] Each new comment gets a unique ID stored in frontmatter
- [ ] "Reply" button on comments opens a reply input
- [ ] Replies are visually threaded/indented below parent
- [ ] Threads can be collapsed
- [ ] Agents can reference comments by ID in their responses
- [ ] Existing comments without IDs still display correctly

## Files to Modify

- `portal/src/types.ts` — Add `id` and `replyTo` to `HistoryEntry`
- `portal/src/components/TaskModal.tsx` — Add filter toggle, reply UI, threaded rendering
- `engine/src/index.ts` — Auto-generate comment IDs on the server side when saving

