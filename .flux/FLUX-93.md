---
assignee: unassigned
tags:
  - feature
  - ux
priority: Low
effort: M
implementationLink: '988d7c7'
subtasks: []
history:
  - type: activity
    user: Guy
    date: '2026-05-07T13:53:26.203Z'
    comment: Created ticket.
  - type: comment
    user: Agent
    date: '2026-05-08T00:00:00.000Z'
    comment: >-
      Groomed. Plan: add a comment count badge to TaskCard. Hover shows a
      scrollable popover (similar to the existing description preview portal).
      Unread tracking needs a persistence strategy — localStorage keyed by
      userId+ticketId+commentId is the simplest approach without a backend
      change. Glowing border on cards with unread comments. Clicking a comment
      in the popover marks it read. Medium effort due to the unread-state layer.
    id: c-flux93-groom
  - type: status_change
    from: Grooming
    to: Todo
    user: Agent
    date: '2026-05-08T00:00:00.000Z'
  - type: comment
    user: Agent
    date: '2026-05-08T16:00:00.000Z'
    comment: >-
      Plan: comment count badge on TaskCard (MessageCircle icon + count). Unread
      tracking via localStorage keyed flux:read:<userId>:<ticketId>. Amber glow
      ring on cards with unread comments. Click badge opens a fixed-position
      portal popover listing all comments with author/date/text; unread entries
      highlighted. Opening popover marks all as read and persists to
      localStorage. All changes self-contained in TaskCard.tsx — no backend
      needed.
    id: c-flux93-plan
  - type: status_change
    from: Todo
    to: In Progress
    user: Agent
    date: '2026-05-08T16:00:00.000Z'
  - type: comment
    user: Agent
    date: '2026-05-08T16:15:00.000Z'
    comment: >-
      Implemented. All changes in portal/src/components/TaskCard.tsx — no
      backend changes needed.


      What was added:

      - MessageCircle badge button in the card bottom row showing comment count.
        Amber bg + amber dot when there are unread comments; neutral grey when all read.

      - localStorage-backed unread tracking keyed flux:read:<user>:<ticketId>.
        Loaded on mount via useEffect([currentUser, task.id]). Opening the popover
        marks all comments as read and persists to localStorage immediately.

      - Amber ring-2 glow on the card border when unread comments exist
      (suppressed
        when a liveAccentClass ring is already present to avoid CSS class conflict).

      - Click-triggered fixed-position portal popover showing all comments in a
        scrollable list. Each entry shows author, date (short format), comment text
        (line-clamp-4), and an amber dot on unread entries. Popover closes on
        outside click via a mousedown listener. Hover popup suppressed while the
        comment popover is open.

      Validated: badge shows count, amber styling clears after opening popover,
      grey badge persists after re-render, popover closes on outside click.
    id: c-flux93-impl
  - type: status_change
    from: In Progress
    to: Ready
    user: Agent
    date: '2026-05-08T16:15:00.000Z'
  - type: comment
    user: Guy
    date: '2026-05-08T03:47:16.638Z'
    comment: >-
      more feedback:


      1. in the comment box i want each comment to be independently clicked on
      to mark it as read, nto that as soon as i press on comment box it marks
      them all as read. each comment should have its own read unread state

      2. comments sometimes are trailing and not fully displaed

      3. we can show a bigger comment box if neccesary.

      4. when hovering  on description, if i then go to hover on the comment i
      want to swap the tooltip to the comment tooltip hover, not have both open.
    replyTo: c-flux93-impl
    id: c-2026-05-08t03-47-16-638z
  - type: status_change
    from: Ready
    to: In Progress
    user: Guy
    date: '2026-05-08T03:47:16.638Z'
    comment: Returned to work
  - type: comment
    user: Agent
    date: '2026-05-08T16:30:00.000Z'
    comment: >-
      Addressed all four feedback points:

      1. Per-comment read state — opening the popover no longer marks anything as
         read. Each unread entry shows "click to mark read" and handles its own
         click via markCommentRead(), persisting only that comment's ID to
         localStorage.

      2. Full comment text — removed line-clamp-4; comments now render fully with
         whitespace-pre-wrap so line breaks display correctly.

      3. Bigger popover — widened from w-80/max-h-80 to w-[420px]/max-h-[480px].

      4. Description hover closes on comment open — openCommentPopover now calls
         setIsHovering(false) and clears hoverTimeout before opening the comment
         popover, so the two never appear simultaneously.
    id: c-flux93-revision
  - type: status_change
    from: In Progress
    to: Ready
    user: Agent
    date: '2026-05-08T16:30:00.000Z'
  - type: comment
    user: Agent
    date: '2026-05-08T16:45:00.000Z'
    comment: >-
      Extended per user feedback:


      1. Newest-first ordering in popover — topLevelComments is now the comments
         array filtered to non-replies and reversed. Replies within a thread
         remain oldest-first (natural conversation order).

      2. Relative timestamps — added relativeTime() to workflow.ts; both
         TaskCard popover and TaskModal history list now show "4h ago / 2d ago /
         just now" with the full absolute datetime in the title attribute on hover.
         TaskModal entry dates and reply dates both updated.

      3. Threaded replies in popover — replies are grouped under their parent
         comment with a left-border indent, shown oldest-first below the parent.

      4. Inline reply from popover — each top-level comment has a Reply button
         that opens a textarea inline. Ctrl+Enter submits; Escape cancels.
         Submitting calls updateTask directly (no modal needed) and triggers
         refresh.

      5. Mark all read button moved to popover sticky header alongside unread
         count.

      6. TaskModal activity list also reversed to newest-first.

      Validated visually: popover shows newest-first, relative time, Reply button
      per comment, threaded replies indented. Modal history newest-first.
    id: c-flux93-v3
  - type: status_change
    from: Ready
    to: In Progress
    user: Agent
    date: '2026-05-08T16:45:00.000Z'
  - type: status_change
    from: In Progress
    to: Ready
    user: Agent
    date: '2026-05-08T16:45:00.000Z'
  - type: comment
    user: Agent
    date: '2026-05-08T17:00:00.000Z'
    comment: >-
      Migrated read/unread state from localStorage to a server-side
      .flux/read-state.json sidecar file.


      Changes:

      - engine/src/index.ts: GET /api/read-state returns full state object
        keyed by user then ticketId. PUT /api/read-state accepts a partial
        patch and merges it into the file (Set union per ticket), so concurrent
        users on a shared engine never overwrite each other's reads.

      - portal/src/api.ts: added fetchReadState() and saveReadState() helpers.

      - portal/src/AppContext.tsx: on mount (and on user change) loads the full
        state from the API into shared readComments state. markCommentRead and
        markAllCommentsRead both update shared state and fire a background
        saveReadState() call. ensureReadStateLoaded is now a no-op (kept for
        API compat — full state loads on mount).

      - TaskCard.tsx / TaskModal.tsx: removed all local readCommentIds state
        and localStorage calls. Both now read from AppContext.readComments and
        call ctxMarkCommentRead / ctxMarkAllCommentsRead. Read state is now
        shared in-memory across both components — marking read in the card
        popover immediately reflects in the full ticket view and vice versa.

      - .gitignore: added .flux/read-state.json to avoid git merge noise.

      Validated: GET and PUT endpoints merge correctly, board loads with
      server-side read state, badge/glow/popover styling still works.
    id: c-flux93-read-state
  - type: status_change
    from: In Progress
    to: Ready
    user: Agent
    date: '2026-05-08T17:00:00.000Z'
  - type: comment
    user: Agent
    date: '2026-05-08T17:05:00.000Z'
    comment: >-
      Done. Committed. Read-state gitignore removed; follow-on ticket FLUX-117
      created for cross-device persistence.
    id: c-flux93-close
  - type: status_change
    from: Ready
    to: Done
    user: Agent
    date: '2026-05-08T17:05:00.000Z'
title: add comments preview to card display
status: Done
createdBy: Guy
updatedBy: Guy
---

# Goal

Board task cards should surface comment activity without opening the full ticket:
- Comment count badge on the card.
- Indicator if there are unread comments.
- Hover popover with scrollable comment list (like the description hover preview).
- Clicking an unread comment in the popover marks it as read.
- Cards with unread comments get a glowing border.

# Implementation Plan

1. **Unread tracking:** Use `localStorage` keyed as `flux:read:<userId>:<ticketId>:<commentId>`. On load, compare stored read IDs against the ticket's comment history to determine which are unread.

2. **TaskCard badge (`portal/src/components/TaskCard.tsx`):**
   - Count comments (`history.filter(e => e.type === 'comment')`).
   - Show a small badge with the count.
   - Add a glow ring class (e.g. `ring-2 ring-amber-400 animate-pulse`) to the card border when there are unread comments.

3. **Hover popover:**
   - Reuse the portal-based hover pattern from the existing description preview.
   - Render comments in a scrollable list, newest last.
   - Unread comments highlighted with a subtle background.
   - On hover, mark all as read (or on individual click per comment).

4. **TaskCard changes are self-contained** — no backend changes needed.

# Validation

- Card shows comment count when ticket has comments.
- New comment (added via modal) causes badge to show unread indicator on next board view.
- Hovering the badge shows the comment popover.
- After hovering, unread indicator clears.
- Glowing border visible on cards with unread comments, absent otherwise.
