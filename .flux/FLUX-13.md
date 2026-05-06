---
title: 'Require Input: visual indicator and prompt UI'
status: Done
createdBy: Guy
updatedBy: Agent
assignee: Agent
tags:
  - feature
history:
  - type: comment
    user: Agent
    date: '2026-05-06T07:30:00.000Z'
    comment: >-
      Fleshed this out with full spec. This is self-contained and ready to work
      on — the "Require Input" status column already exists in config.
---
## Summary

When a ticket is moved to "Require Input" status (by an agent or user), show a prominent visual indicator on the card in the kanban board, and when opening the ticket, highlight the pending question so the user can respond quickly.

## Requirements

### 1. Kanban card indicator
- Cards in the "Require Input" column show a red/orange exclamation mark badge (⚠️ or ❗)
- The badge should be visible at a glance — positioned at the top-right corner of the card or next to the title
- Optionally pulse/animate to draw attention
- Use `lucide-react`'s `AlertCircle` or `AlertTriangle` icon

### 2. Latest question highlight in modal
- When opening a "Require Input" ticket, display a prominent banner/callout at the top of the modal
- The banner shows the **most recent comment** (which should contain the question)
- Styled distinctly: yellow/amber background, exclamation icon, "Response Needed" label
- Below the banner, the comment input is pre-focused so the user can reply immediately

### 3. Clearing the indicator
- When the user replies (adds a comment), automatically move the ticket back to its previous status or to "Todo"
- Alternatively, just leave it in "Require Input" and let the user manually change status — the indicator still serves its purpose

### 4. Agent usage
- Agents use `move_to_require_input` MCP tool (FLUX-6) or directly update status + add comment via REST API
- The last comment on a "Require Input" ticket is treated as the pending question

## Implementation Plan

### TaskCard.tsx changes
```tsx
// Add to card when status === 'Require Input'
<AlertCircle className="w-4 h-4 text-amber-500 animate-pulse" />
```

### TaskModal.tsx changes
```tsx
// At top of modal content, if status === 'Require Input'
<div className="bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-500/30 rounded-lg p-4 flex gap-3">
  <AlertCircle className="text-amber-500 shrink-0" />
  <div>
    <p className="font-semibold text-amber-800 dark:text-amber-300 text-sm">Response Needed</p>
    <p className="text-sm text-amber-700 dark:text-amber-400 mt-1">{lastComment}</p>
  </div>
</div>
```

## Acceptance Criteria

- [ ] Cards in "Require Input" column show a visible exclamation/alert badge
- [ ] Badge has a subtle animation (pulse) to draw attention
- [ ] Opening a "Require Input" ticket shows a highlighted banner with the pending question
- [ ] Comment input is focused when opening a "Require Input" ticket
- [ ] Works correctly when ticket is moved to "Require Input" via drag-and-drop
- [ ] Works correctly when moved via status dropdown in modal

## Files to Modify

- `portal/src/components/TaskCard.tsx` — Add alert badge for "Require Input" status
- `portal/src/components/TaskModal.tsx` — Add question banner and auto-focus comment input

