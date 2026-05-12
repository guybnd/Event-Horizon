---
assignee: Agent
tags:
  - ux
  - agent
  - ui
priority: Medium
effort: S
implementationLink: ''
subtasks: []
history:
  - type: activity
    user: Guy
    date: '2026-05-09T07:49:16.585Z'
    comment: Created ticket.
  - type: activity
    user: Guy
    date: '2026-05-09T07:51:17.993Z'
    comment: Updated description.
  - type: activity
    user: Agent
    date: '2026-05-09T07:51:20.344Z'
    comment: Launched Claude Code session (430a193b).
  - type: comment
    user: Agent
    date: '2026-05-09T07:55:15.837Z'
    comment: >-
      Grooming: rewrote ticket body with implementation plan. See body for full
      spec.
    id: c-2026-05-09t07-55-15-837z
  - type: status_change
    from: Grooming
    to: Todo
    user: Agent
    date: '2026-05-09T07:55:32.073Z'
  - type: status_change
    from: Todo
    to: In Progress
    user: Agent
    date: '2026-05-09T07:55:40.994Z'
  - type: comment
    user: Agent
    date: '2026-05-09T07:55:40.994Z'
    comment: 'Starting implementation: adding CSS keyframes then updating TaskCard.tsx.'
    id: c-2026-05-09t07-55-40-994z
  - type: status_change
    from: In Progress
    to: Ready
    user: Agent
    date: '2026-05-09T07:57:15.537Z'
  - type: comment
    user: Agent
    date: '2026-05-09T07:57:15.538Z'
    comment: >-
      Implementation complete. Changes: (1) removed inline bot badge from ticket
      ID row; (2) assignee pill now shows the active session label (e.g. 'Claude
      Code') with a Bot icon and 2s pulsing green glow when a session is active,
      and is non-clickable during that time; (3) replaced the static
      animate-pulse ring overlay with a smooth 3s breathing box-shadow animation
      (bot-border-breathe) on the card border. TypeScript clean, no regressions.
      Awaiting user review.
    id: c-2026-05-09t07-57-15-538z
  - type: activity
    user: Guy
    date: '2026-05-09T07:57:16.241Z'
    comment: Updated tags to integration.
  - type: activity
    user: Guy
    date: '2026-05-09T07:57:20.053Z'
    comment: Updated tags to none.
  - type: activity
    user: Guy
    date: '2026-05-09T07:57:20.463Z'
    comment: Updated tags to ux.
  - type: activity
    user: Guy
    date: '2026-05-09T07:57:25.190Z'
    comment: 'Updated tags to ux, agent.'
  - type: activity
    user: Guy
    date: '2026-05-09T07:57:27.019Z'
    comment: 'Updated tags to ux, agent, ui.'
  - type: activity
    user: Agent
    date: '2026-05-09T07:57:27.749Z'
    comment: Claude Code session ended with code 0.
  - type: activity
    user: Agent
    date: '2026-05-09T08:00:31.867Z'
    comment: Launched Claude Code session (ebb4097e).
  - type: status_change
    from: Ready
    to: Done
    user: Agent
    date: '2026-05-09T08:01:19.618Z'
  - type: comment
    user: Agent
    date: '2026-05-09T08:01:19.618Z'
    comment: >-
      Implemented all four requirements: (1) removed inline Bot badge from the
      ID row, (2) assignee pill now shows cliSession.label with Bot icon and
      bot-assignee-glow pulsing animation when a session is active, (3) card
      border uses bot-border-breathe CSS keyframe for a slow breathing glow
      instead of the static animate-pulse overlay, (4) assignee button click is
      disabled while a bot session is active. Two keyframes added to index.css.
      Commit: 42d5e2d.
    id: c-2026-05-09t08-01-19-618z
  - type: activity
    user: Agent
    date: '2026-05-09T08:01:27.023Z'
    comment: Claude Code session ended with code 0.
  - type: status_change
    from: Done
    to: Released
    user: Agent
    date: '2026-05-09T08:10:27.359Z'
title: improvement to card currently active view
status: Released
createdBy: Guy
updatedBy: Agent
tokenMetadata:
  inputTokens: 6829
  outputTokens: 20467
  costUSD: 1.286277
  costIsEstimated: false
version: 0.2.0
releasedAt: '2026-05-09T08:10:27.359Z'
releaseDocPath: release-notes/0.2.0
---
## Overview

Replace the inline "Claude Code" bot badge next to the ticket ID with proper assignee integration. When an agent session is active, the session's label should be used as the displayed assignee on the card, and the card should visually indicate that an agent is live without being interactable.

## Requirements

1. **Auto-assign on active session** — when `task.cliSession` is active (`pending | running | waiting-input`), treat `cliSession.label` (e.g. `Claude Code`) as the displayed assignee on the card. Remove the separate green bot badge from the ID row.
2. **Glowing assignee pill** — when the displayed assignee comes from an active bot session, the assignee button shows a pulsing green glow animation instead of the normal grey style.
3. **Breathing border** — when an active bot session exists, the card border is slightly thicker and plays a slow circular breathing/pulse animation in green.
4. **Non-interactive assignee while bot is active** — the assignee button must not open the reassignment dropdown while a bot session is active.

## Implementation Plan

### 1. `portal/src/index.css` — add two keyframe animations

- `@keyframes bot-border-breathe` — smooth box-shadow pulse for the card border glow (period ~3s)
- `@keyframes bot-assignee-glow` — repeating glow pulse for the assignee pill (period ~2s)

### 2. `portal/src/components/TaskCard.tsx`

**Bot badge removal (line ~568–573):**
- Remove the inline `<span>` that renders the `<Bot />` icon + `task.cliSession.label` next to the ticket ID when `hasActiveCliSession`.

**Assignee pill (line ~740–778):**
- Derive `displayAssignee`: if `hasActiveCliSession` use `task.cliSession.label`, else use `visibleAssignee`.
- Disable the button onClick (no dropdown) when `hasActiveCliSession`.
- When `hasActiveCliSession`, apply bot-glow CSS class and show a `<Bot />` icon instead of `<User />`.
- When not active, keep existing behaviour unchanged.

**Card border (line ~474):**
- Replace the static `animate-pulse` overlay div with a `bot-border-breathe` CSS class on the inner card div for a smooth breathing glow.

## Validation

- Launch an agent session on a ticket and confirm: bot badge is gone, assignee shows agent label with glow, border breathes.
- Confirm clicking the assignee pill while session is active does nothing.
- Confirm normal assignee interactions work when no session is active.
- Confirm the `Require Input` amber ring still appears correctly alongside the new active state.
):**
- Derive `displayAssignee`: if `hasActiveCliSession` use `task.cliSession.label`, else use `visibleAssignee`.
- Disable the button onClick (no dropdown) when `hasActiveCliSession`.
- When `hasActiveCliSession`, apply bot-glow CSS class and show a `<Bot />` icon instead of `<User />`.
- When not active, keep existing behaviour unchanged.

**Card border (line ~474):**
- Replace the static `animate-pulse` overlay div with a `bot-border-breathe` CSS class on the inner card div for a smooth breathing glow.

## Validation

- Launch an agent session on a ticket and confirm: bot badge is gone, assignee shows agent label with glow, border breathes.
- Confirm clicking the assignee pill while session is active does nothing.
- Confirm normal assignee interactions work when no session is active.
- Confirm the `Require Input` amber ring still appears correctly alongside the new active state.
