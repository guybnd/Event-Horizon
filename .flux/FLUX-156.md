---
assignee: unassigned
tags:
  - ui
  - portal
priority: Medium
effort: S
implementationLink: ''
subtasks: []
history:
  - type: activity
    user: Guy
    date: '2026-05-09T04:07:21.533Z'
    comment: Created ticket.
  - type: activity
    user: Guy
    date: '2026-05-09T04:10:22.682Z'
    comment: Updated description.
  - type: activity
    user: Agent
    date: '2026-05-09T04:10:27.040Z'
    comment: Launched Claude Code session (1eab421e).
  - type: activity
    user: Agent
    date: '2026-05-09T04:15:13.068Z'
    comment: Launched Claude Code session (40b1d690).
  - type: status_change
    from: Grooming
    to: In Progress
    user: Agent
    date: '2026-05-09T04:20:00.000Z'
  - type: comment
    user: Agent
    date: '2026-05-09T04:20:01.000Z'
    comment: >-
      Plan: (1) nav pills collapse to icon-only at rest, expand on hover (active
      always shows text+icon); (2) stat cards compact by default, label animates
      in on hover; (3) user+project key stacked into one slot on right; engine
      indicator dot-only when connected, expands to full pill when offline;
      power+theme buttons reduced to p-1.5 icons grouped together.
    id: c-2026-05-09t04-20-01-000z
  - type: status_change
    from: In Progress
    to: Ready
    user: Agent
    date: '2026-05-09T04:25:00.000Z'
  - type: comment
    user: Agent
    date: '2026-05-09T04:25:01.000Z'
    comment: >-
      Implementation complete in portal/src/components/Header.tsx. All three
      changes shipped: nav pills are icon-only at rest and expand on hover
      (active item always shows label); stat cards show icon+value at rest and
      reveal label text on hover; right side reorganised with user+project
      stacked as two rows, engine indicator is dot-only when connected (expands
      when offline), power and theme buttons are compact icon-only. TypeScript
      clean. Awaiting finish command.
    id: c-2026-05-09t04-25-01-000z
  - type: status_change
    from: Ready
    to: In Progress
    user: Guy
    date: '2026-05-09T04:17:02.542Z'
  - type: status_change
    from: In Progress
    to: Ready
    user: Guy
    date: '2026-05-09T04:17:07.970Z'
  - type: comment
    user: Guy
    date: '2026-05-09T04:17:28.675Z'
    comment: finish FLUX-156
    id: c-2026-05-09t04-17-28-675z
title: header is. too cramped need to resize the UI
status: Ready
createdBy: Guy
updatedBy: Guy
order: 2
---

## Goal

Reduce header crowding so all controls are visible without horizontal scrolling.

## Changes

### 1. Nav buttons — icon-only by default, text on hover
- Each nav pill shows only the icon at rest
- On hover, `max-width` transition expands the pill and fades in the label text
- The active nav item always shows both icon and text

### 2. Stat cards (User Prompts, Agent Sessions, Lifetime Cost) — compact with hover expand
- At rest: icon + numeric value only, no label text visible
- On hover: card slightly widens and the label text fades/slides in
- Uses `group` + `max-width` / `opacity` CSS transitions

### 3. Right-side reorganisation
- **Current User + Project Key** collapsed into a single stacked two-row block
- **Engine indicator** is a dot only when connected; expands to label + status when offline
- **Power + theme** buttons reduced to compact icon-only buttons

## Files
- `portal/src/components/Header.tsx`
