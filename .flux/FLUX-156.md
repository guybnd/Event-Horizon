---
assignee: unassigned
tags:
  - ui
  - ux
priority: High
effort: M
implementationLink: 1c6d6f5
subtasks: []
history:
  - type: activity
    user: Guy
    date: '2026-05-09T04:30:00.000Z'
    comment: Created ticket.
  - type: status_change
    from: In Progress
    to: Done
    user: Agent
    date: '2026-05-09T04:30:00.000Z'
  - type: comment
    user: Agent
    date: '2026-05-09T04:30:00.000Z'
    comment: >-
      Implemented and committed in 1c6d6f5. Changes:


      1. **Nav buttons**: icon-only at rest, label animates in on hover via
      max-w/opacity transition. Active state always shows label.

      2. **Stat cards** (User Prompts, Agent Sessions, Lifetime Cost): collapsed
      to icon+value, hover reveals short label with smooth transition. Reduced
      from double-stacked rows to single inline row.

      3. **Right side reorganised**: User + Project Key merged into two-row
      stacked block at far right (label + compact input). Engine indicator is
      dot-only when connected, expands to full pill only when offline. Power and
      theme buttons grouped and shrunk to p-1.5 icons. Header padding reduced
      from px-8/py-4 to px-4/py-3.


      Validated: TypeScript clean, portal running at localhost:5173.
    id: c-2026-05-09t04-30-00-000z
  - type: status_change
    from: In Progress
    to: Done
    user: Agent
    date: '2026-05-09T04:20:05.114Z'
  - type: agent_message
    user: Claude Code
    date: '2026-05-09T04:20:10.427Z'
    comment: >-
      ```text

      FLUX-156 is done. All three changes are live in commit `1c6d6f5`:


      1. **Nav buttons** — icon-only at rest, text slides in on hover (`max-w` +
      opacity transition). Active view always shows the label.

      2. **Stat cards** — User Prompts, Agent Sessions, Lifetime Cost are now
      icon + number by default; short label (Prompts / Agents / Cost) fades in
      on hover.

      3. **Right side** — User and Project Key merged into one stacked two-row
      block; Engine indicator is a single dot when connected, expands to the
      offline pill only when the engine drops; Power and theme buttons are
      smaller grouped icons; header padding tightened to `px-4 py-3`.

      ```
title: header is. too cramped need to resize the UI
status: Done
createdBy: Guy
updatedBy: Agent
order: 2
---
## Implementation Plan

Redesign the header to reduce horizontal cramping with three targeted changes:

### 1. Nav buttons — icon-only by default, text on hover

Collapse the nav pill buttons (Board, Backlog, Releases, Docs, Settings) so they only show the icon at rest. On hover, the button expands smoothly to reveal the label via a CSS width transition (`overflow-hidden`, `max-w` transition from icon-width to full-width). Active state still shows the full label so the user always knows where they are.

### 2. Stat cards — compact at rest, expand on hover

The three stat cards (User Prompts, Agent Sessions, Lifetime Cost) currently show a 10px uppercase title + value stacked. Collapse them to icon + value only at rest. On hover, animate in the label with a smooth transition (`max-w` or opacity + translate). This preserves all information without the permanent text widths inflating the header.

### 3. Right-side layout reorganisation

- **Power button** moves to the left side of the right group (before the stat cards or at the far right before user/project), replacing its current spot at the end.
- **Current User + Project Key** merge into a single two-row element at the far right to halve the horizontal space.
- **Engine status indicator** uses a small dot-only presentation when connected (already nearly there); when offline it expands with label + pulsing dot to draw attention.
- Remove the Rocket icon branding block from the far left if needed to recover horizontal room (the title + tagline stays but the icon chip can be smaller).

### Files to change

- `portal/src/components/Header.tsx` — all JSX and class changes

### Validation

- Open portal at `http://localhost:5173`, verify Settings button is no longer cut off
- Hover each nav button to confirm text animates in
- Hover each stat card to confirm label reveals
- Verify engine offline state still shows visually prominent indicator
- Verify power button position is left of user/project block
