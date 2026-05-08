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
title: hover on comments in card should switch to that tooltip
status: Grooming
createdBy: Guy
updatedBy: Guy
order: 2
---

