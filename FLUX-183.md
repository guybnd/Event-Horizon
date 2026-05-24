---
priority: Low
effort: L
tags:
  - refactor
  - dx
assignee: unassigned
createdBy: Unknown
title: Extract TaskModal hooks and sub-components
status: Backlog
updatedBy: Guy
history:
  - type: activity
    user: Unknown
    date: '2026-05-10T14:43:30.805Z'
    comment: Created ticket.
  - type: activity
    user: Agent
    date: '2026-05-11T01:32:34.992Z'
    comment: Launched Claude Code session (9172761c).
  - type: activity
    user: Agent
    date: '2026-05-11T03:29:41.494Z'
    comment: Claude Code session lost (engine restarted).
  - type: status_change
    from: Grooming
    to: Backlog
    user: Guy
    date: '2026-05-24T13:26:13.146Z'
order: 1
---
## Goal

Break `portal/src/components/TaskModal.tsx` (2707 lines, 38+ `useState` calls) into focused custom hooks and sub-components, targeting ~600 lines for the parent component.

## Context

This is the second follow-on from FLUX-172. `TaskModal` is the largest file in the portal and the biggest AI context burden. It owns form state, CLI session state, image attachment logic, metadata fields, comment boxes, CLI session panel, and the history list — all in one function.

## Proposed Extractions

| Extract | Lines saved (approx) | What it contains |
|---|---|---|
| `useTaskForm(modalTask)` hook | ~120 | All form field state + dirty detection + originalPayload/currentPayload memos |
| `useCliSession(taskId)` hook | ~100 | cliSession state, sessionIsActive, selected framework, skipPermissions |
| `useImageAttachment(...)` hook | ~140 | `attachImageFilesToDraft`, `attachCommentImageFiles`, `attachReplyImageFiles`, paste/drag handlers |
| `MetadataPanel` component | ~250 | Status, Assignee, Priority, Effort, EffortOverride, ImplLink, Tags, Subtasks selects/inputs |
| `CommentBox` component | ~120 | Textarea + paste/drag handlers + asset error + submit button |
| `CliSessionPanel` component | ~150 | Live output pre, token display, stop/launch controls |

`TaskModal` becomes responsible only for layout, modal chrome, and wiring the extracted pieces together.

## File Placement

- Hooks: `portal/src/hooks/useTaskForm.ts`, `useCliSession.ts`, `useImageAttachment.ts`
- Components: `portal/src/components/task-modal/MetadataPanel.tsx`, `CommentBox.tsx`, `CliSessionPanel.tsx`

## Constraints

- No behaviour changes — structural refactor only
- All existing TaskModal functionality must work identically after extraction
- TypeScript types must remain accurate; no `any` casts introduced

## Validation

- Portal compiles without TypeScript errors
- Opening a ticket shows all metadata, history, and comment box correctly
- CLI session launch, live output, and stop work
- Image paste/drag attachment works in comment box
