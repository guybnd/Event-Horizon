---
assignee: Agent
tags:
  - ui
  - feature
priority: High
effort: S
implementationLink: ''
subtasks: []
history:
  - type: activity
    user: Agent
    date: '2026-05-07T08:56:05.212Z'
    comment: Implementation complete. Moved to Ready for user review.
  - type: activity
    user: Agent
    date: '2026-05-07T08:46:10.766Z'
    comment: Started implementation. Moved to In Progress.
  - type: activity
    user: Guy
    date: '2026-05-07T04:23:22.373Z'
    comment: Created ticket.
  - type: comment
    user: Agent
    date: '2026-05-07T05:23:46.190Z'
    comment: >-
      Grooming check: The implementation plan is defined in the description
      below.  Proposed Metadata: Priority: Low, Effort: S, Tags: ui, feature.
      Does this plan and metadata look correct? Please confirm or adjust.
    id: c-1778131426191-flux-62.md
  - type: comment
    user: Guy
    date: '2026-05-07T05:33:59.974Z'
    comment: this not really a well groomed card what is this two line BS.
    id: c-2026-05-07t05-33-59-974z
  - type: status_change
    from: Require Input
    to: Grooming
    user: Guy
    date: '2026-05-07T05:33:59.974Z'
    comment: Response submitted
  - type: activity
    user: Guy
    date: '2026-05-07T08:07:03.153Z'
    comment: Changed priority from Low to High.
  - type: activity
    user: Guy
    date: '2026-05-07T08:07:13.020Z'
    comment: Changed assignee from unassigned to Agent.
title: Show full description popup on card hover (1.5s)
status: Ready
createdBy: Guy
updatedBy: Guy
order: 10
---
## Summary

Show a rich markdown-rendered tooltip popup when hovering over a task card for
a configurable delay (default 1.5s). The feature should be toggleable and
configurable through Settings.

## Requirements

### 1. Hover delay and popup rendering
- After hovering a task card for the configured delay, show a floating popup
- Popup renders the ticket description in full markdown formatting (headings, code blocks, lists, etc.)
- Popup dismisses on mouse-leave or click-away
- Position popup intelligently to avoid viewport overflow
- Debounce hover intent to avoid popup flicker on fast mouse movements

### 2. Settings integration
- Add a toggle in Settings to enable/disable hover previews globally
- Add a configurable delay timer input (default 1500ms)
- Store both preferences in `config.json`

### 3. Performance and edge cases
- Do not pre-render popups for all cards; render on demand only for the hovered card
- Handle long descriptions with scroll or max-height constraint
- Handle cards with empty or very short descriptions gracefully

## Acceptance Criteria

- [ ] Hovering a card for 1.5s (default) shows a markdown-rendered description popup
- [ ] Popup can be disabled in Settings
- [ ] Popup delay is configurable in Settings
- [ ] Popup handles long descriptions with scroll/max-height
- [ ] Works on both Board and Backlog views
- [ ] Popup does not flicker on fast mouse movements

## Likely Affected Areas

- `portal/src/components/TaskCard.tsx`
- `portal/src/components/Settings.tsx`
- `.flux/config.json`

## Original Request
1. popup should show in full markdown formatted
2. can configure if this happens in settings, and configure the popup timer
