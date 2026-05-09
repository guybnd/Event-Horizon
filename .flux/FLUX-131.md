---
assignee: unassigned
tags: []
priority: Medium
effort: None
implementationLink: ''
subtasks: []
history:
  - type: activity
    user: Guy
    date: '2026-05-08T11:51:56.180Z'
    comment: Created ticket.
  - type: activity
    user: Agent
    date: '2026-05-08T13:12:04.192Z'
    comment: Launched Claude Code session (6577f775).
  - type: comment
    user: Claude Code
    date: '2026-05-08T13:12:08.413Z'
    comment: >-
      ```text

      [stderr] Warning: no stdin data received in 3s, proceeding without it. If
      piping from a slow command, redirect stdin explicitly: < /dev/null to
      skip, or wait longer.

      ```
    id: c-2026-05-08t13-12-08-413z
  - type: comment
    user: Claude Code
    date: '2026-05-08T13:12:14.194Z'
    comment: |-
      ```text
      Reading the ticket and relevant component files.
      ```
    id: c-2026-05-08t13-12-14-194z
  - type: comment
    user: Claude Code
    date: '2026-05-08T13:15:01.622Z'
    comment: >-
      ```text

      The ticket wants hovering over the comment badge on a card to show a
      comment preview tooltip (instead of just the native browser title
      tooltip). Currently hovering the badge is explicitly excluded from the
      description popup. I'll implement this.


      Moving the ticket to In Progress and starting implementation.

      ```
    id: c-2026-05-08t13-15-01-622z
  - type: comment
    user: Claude Code
    date: '2026-05-08T13:16:12.982Z'
    comment: >-
      ```text

      Now implementing the comment hover tooltip. The plan:

      - Add `commentTooltipOpen` state and a ref for the comment badge tooltip

      - On `mouseenter` of the comment badge, show a positioned tooltip with
      recent comments

      - On `mouseleave`, close it

      - Remove the `title` prop from the badge (native tooltip) when comments
      exist

      - Suppress the description popup while the comment tooltip is showing

      ```
    id: c-2026-05-08t13-16-12-982z
  - type: comment
    user: Claude Code
    date: '2026-05-08T13:16:23.584Z'
    comment: >-
      ```text

      I need permissions to edit the files. Let me proceed with both edits once
      you grant permission — the changes are all in
      `portal/src/components/TaskCard.tsx`.


      Here's the full implementation plan so you can review before approving:


      **Changes to `TaskCard.tsx`:**


      1. Add state/ref:
         ```ts
         const [commentTooltipOpen, setCommentTooltipOpen] = useState(false);
         const [commentTooltipPos, setCommentTooltipPos] = useState({ top: 0, left: 0, right: 'auto' as number | string });
         const commentTooltipTimeout = useRef<number | null>(null);
         ```

      2. Add `onMouseEnter`/`onMouseLeave` handlers on the comment badge button
      that position and show/hide the tooltip (with a short ~300ms delay), and
      close the description popup if it's open.


      3. Remove `title={...}` from the badge when comments exist (since we're
      replacing it with a custom tooltip).


      4. Render a portal tooltip showing the last 3 comments (user, relative
      time, truncated text) + unread indicator, positioned to the right of (or
      left of) the badge based on viewport space.


      5. Close the comment tooltip when the comment popover is opened.


      Should I proceed with the implementation?

      ```
    id: c-2026-05-08t13-16-23-584z
  - type: activity
    user: Guy
    date: '2026-05-08T13:23:55.464Z'
    comment: Changed priority from None to Medium.
  - type: activity
    user: Agent
    date: '2026-05-09T08:46:41.601Z'
    comment: Launched Claude Code session (cf8d9261).
  - type: status_change
    from: Grooming
    to: In Progress
    user: Agent
    date: '2026-05-09T08:47:07.814Z'
  - type: comment
    user: Agent
    date: '2026-05-09T08:47:07.814Z'
    comment: >-
      Grooming complete. Implementation plan: add a comment hover tooltip that
      shows the last 3 comments when hovering the comment badge, replacing the
      native title tooltip. Changes confined to TaskCard.tsx: add
      commentTooltipOpen state + positioning, mouseenter/mouseleave handlers on
      the badge with ~300ms delay, remove title prop from badge when comments
      exist, render a portal tooltip with user/time/truncated text + unread
      indicator.
    id: c-2026-05-09t08-47-07-814z
  - type: activity
    user: Agent
    date: '2026-05-09T08:48:26.188Z'
    comment: Launched Claude Code session (73406e44).
  - type: status_change
    from: In Progress
    to: Ready
    user: Agent
    date: '2026-05-09T08:48:39.224Z'
  - type: comment
    user: Agent
    date: '2026-05-09T08:48:39.225Z'
    comment: >-
      Implemented comment hover tooltip in TaskCard.tsx. Hovering the comment
      badge now shows a 280px portal tooltip with the 3 most recent comments
      (user, relative time, truncated text), unread indicators, and a '+N more'
      hint if there are additional comments. The native title prop is removed
      when comments exist. Tooltip has a 300ms delay, closes when the comment
      popover opens, and cleans up on unmount. Type checks pass.
    id: c-2026-05-09t08-48-39-225z
  - type: agent_message
    user: Claude Code
    date: '2026-05-09T08:49:11.469Z'
    comment: >-
      No TypeScript errors. The implementation is complete and already in place:


      - `commentTooltipOpen` state + `commentTooltipPos` state +
      `commentTooltipTimeout` ref added

      - `onMouseEnter`/`onMouseLeave` handlers on the comment badge — shows
      tooltip after 300ms delay, positioned right (or left if near viewport
      edge)

      - `title` prop removed from the badge when comments exist (native tooltip
      replaced by custom one)

      - Portal tooltip renders the last 3 comments with user, relative time,
      truncated text, and unread indicators

      - Comment tooltip dismissed when the full comment popover opens

      - Cleanup effect for `commentTooltipTimeout` on unmount


      Ready to finish — just say `finish FLUX-131` to stage, commit, and close
      the ticket.
  - type: comment
    user: Guy
    date: '2026-05-09T08:54:56.037Z'
    comment: >-
      inconsistent behaviour:


      1. both description tooltip and comment tooltip are able to be open at the
      same tim. this is bad. only one should be open. with the one impointing at
      the most with the most priority obvs.

      2. dont need a different interface for the hover tooltip and the click
      tooltip, just letsuse the click interactable same tooltip.
    replyTo: c-2026-05-09t08-48-39-225z
    id: c-2026-05-09t08-54-56-027z
  - type: status_change
    from: Ready
    to: In Progress
    user: Guy
    date: '2026-05-09T08:54:56.037Z'
    comment: Returned to work
  - type: activity
    user: Agent
    date: '2026-05-09T08:54:56.080Z'
    comment: Launched Claude Code session (e6f0c66a).
  - type: agent_message
    user: Claude Code
    date: '2026-05-09T08:56:49.058Z'
    comment: >-
      No errors. The changes are clean. Here's what changed:


      - **Removed** the separate lightweight `commentTooltipOpen` tooltip state,
      its position state, and its portal entirely.

      - **Hover on the comment badge** now opens the real interactive popover
      after a 300ms delay — same UI as clicking.

      - **Mutual exclusion**: badge hover clears and cancels the description
      popup (`setIsHovering(false)` + clears `hoverTimeout`), and the
      description popup's `handleMouseEnter` already skips when
      `commentBadgeRef` contains the event target — so only one can be open at a
      time.

      - Badge `onMouseLeave` only cancels the pending hover timeout; if the
      popover already opened, it stays open (dismissed by clicking outside, same
      as before).
  - type: status_change
    from: In Progress
    to: Require Input
    user: Guy
    date: '2026-05-09T08:58:26.072Z'
  - type: comment
    user: Guy
    date: '2026-05-09T08:59:23.075Z'
    comment: >-
      you messed up :


      1. tooltip doesnt go away when i move mouse away from the area of the
      tooltip or the button that causes the tooltip

      2. hovering back to the description should open the description tooltip
      after closing the comment tooltip
    replyTo: c-2026-05-09t08-54-56-027z
    id: c-2026-05-09t08-59-23-070z
  - type: status_change
    from: Require Input
    to: In Progress
    user: Guy
    date: '2026-05-09T08:59:23.075Z'
    comment: Response submitted
  - type: activity
    user: Agent
    date: '2026-05-09T08:59:26.222Z'
    comment: Launched Claude Code session (ef35f6c0).
  - type: agent_message
    user: Claude Code
    date: '2026-05-09T09:03:17.870Z'
    comment: >-
      Clean. Here's the summary of what changed:


      **Issue 1 (tooltip doesn't close when mouse leaves):** The previous code
      only cancelled the *open* timer on `onMouseLeave` — it never started a
      *close* timer. Now when the mouse leaves the badge or the popover (and the
      popover was opened by hover), a 200ms close timer fires. Moving the mouse
      back to either the badge or the popover cancels the timer.


      **Issue 2 (hovering back to description doesn't work):** Two fixes:

      - `handleMouseEnter` now only blocks on `commentPopoverOpen` when it was
      click-opened (`!commentOpenedByHover.current`). Hover-opened popovers
      don't block the description timer.

      - When a hover-opened comment popover closes while the mouse is still over
      the card body (`isMouseOverCard.current`), `startDescriptionTimer()` is
      called immediately to restart the description popup timer — so you don't
      need to re-enter the card.
  - type: status_change
    from: In Progress
    to: Ready
    user: Guy
    date: '2026-05-09T09:03:24.872Z'
  - type: status_change
    from: Ready
    to: Done
    user: Agent
    date: '2026-05-09T09:06:31.534Z'
  - type: comment
    user: Agent
    date: '2026-05-09T09:06:31.535Z'
    comment: >-
      Implemented comment hover tooltip using the real interactive popover.
      Mutual exclusion with description tooltip, closes on mouse-leave with
      200ms grace, description timer restarts when hover-opened popover closes.
      Commit 0a81b6a.
    id: c-2026-05-09t09-06-31-535z
  - type: status_change
    from: Done
    to: Released
    user: Agent
    date: '2026-05-09T09:06:34.753Z'
title: hover on comments in card should switch to that tooltip
status: Released
createdBy: Guy
updatedBy: Agent
order: 1
version: 0.2.1
releasedAt: '2026-05-09T09:06:34.753Z'
releaseDocPath: release-notes/0.2.1
---

