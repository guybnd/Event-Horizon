---
priority: Medium
effort: XS
tags:
  - bug
  - dx
assignee: unassigned
createdBy: Unknown
title: Portal build breaks repeatedly due to linter reverting unused-var fixes
status: Done
updatedBy: Agent
history:
  - type: activity
    user: Unknown
    date: '2026-05-11T04:04:59.987Z'
    comment: Created ticket.
  - type: activity
    user: Agent
    date: '2026-05-11T04:06:24.247Z'
    comment: Launched Claude Code session (7df84fdf).
  - type: activity
    user: Agent
    date: '2026-05-11T04:06:35.973Z'
    comment: Claude Code session lost (engine restarted).
  - type: status_change
    from: Grooming
    to: In Progress
    user: Agent
    date: '2026-05-11T04:07:29.790Z'
  - type: comment
    user: Agent
    date: '2026-05-11T04:07:29.791Z'
    comment: >-
      Fixing the four unused-var issues by removing the declarations, not
      suppressing them. WorkflowSection: drop raw status props; CliSessionPanel:
      drop taskId; useTaskForm and MetadataPanel are already fixed in working
      tree.
    id: c-2026-05-11t04-07-29-791z
  - type: status_change
    from: In Progress
    to: Ready
    user: Agent
    date: '2026-05-11T04:08:15.957Z'
  - type: comment
    user: Agent
    date: '2026-05-11T04:08:15.958Z'
    comment: >-
      All four unused-var issues fixed by removing the declarations rather than
      suppressing them. WorkflowSection: dropped requireInputStatus,
      readyForMergeStatus, archiveStatus from props and destructure (call site
      in Settings.tsx updated). CliSessionPanel: dropped taskId from props and
      destructure (call site in TaskModal.tsx updated). useTaskForm and
      MetadataPanel were already corrected in the working tree. Portal build
      passes clean.
    id: c-2026-05-11t04-08-15-958z
  - type: agent_message
    user: Claude Code
    date: '2026-05-11T04:08:23.190Z'
    comment: >-
      All four fixes applied and build passes clean:


      1. **`WorkflowSection.tsx`** — removed `requireInputStatus`,
      `readyForMergeStatus`, `archiveStatus` from `WorkflowSectionProps` and the
      destructure; updated call site in `Settings.tsx` to drop the three props.

      2. **`CliSessionPanel.tsx`** — removed `taskId` from
      `CliSessionPanelProps` and the destructure; removed
      `taskId={modalTask.id}` from `TaskModal.tsx`.

      3. **`useTaskForm.ts`** — already widened to `Task | Partial<Task> | null
      | undefined` in the working tree.

      4. **`MetadataPanel.tsx`** — already has `icon?: string` in the working
      tree.


      Ticket is in **Ready** — say `finish FLUX-196` when you want the commit.
  - type: activity
    user: Agent
    date: '2026-05-11T04:08:37.027Z'
    comment: Launched Claude Code session (1728f4d1).
  - type: status_change
    from: Ready
    to: Done
    user: Agent
    date: '2026-05-11T04:09:06.145Z'
  - type: comment
    user: Agent
    date: '2026-05-11T04:09:06.147Z'
    comment: >-
      Closed. Commit 8f65b52: removed unused props (requireInputStatus,
      readyForMergeStatus, archiveStatus from WorkflowSection; taskId from
      CliSessionPanel), widened useTaskForm param type, made MetadataPanel icon
      optional. Portal build passes clean.
    id: c-2026-05-11t04-09-06-147z
  - type: activity
    user: Agent
    date: '2026-05-11T04:09:12.077Z'
    comment: Claude Code session ended with code 0.
tokenMetadata:
  inputTokens: 165881
  outputTokens: 1186
  costUSD: 0.103011
  costIsEstimated: false
---
## Problem

The portal has `noUnusedLocals: true` and `noUnusedParameters: true` in `tsconfig.app.json`, and `@typescript-eslint/no-unused-vars` via `tseslint.configs.recommended` in `eslint.config.js`. When fixes use the `_` prefix convention to suppress unused-var errors, the eslint auto-formatter reverts the names back, re-introducing the TS compiler errors on the next build.

This caused the build to fail twice in a row on the same four files, requiring manual re-application of fixes each time.

## Root Cause

The props/types have drifted from their actual usage — the real fix is to remove or correct the declarations, not suppress the warnings.

## Affected Files

- `portal/src/components/settings/WorkflowSection.tsx` — `requireInputStatus`, `readyForMergeStatus`, `archiveStatus` are destructured from props but never read; only the `normalized*` variants are used
- `portal/src/components/task-modal/CliSessionPanel.tsx` — `taskId` prop is declared in the interface and destructured but never used in the JSX
- `portal/src/hooks/useTaskForm.ts` — typed as `Task | null | undefined` but callers pass `Partial<Task> | null`
- `portal/src/components/task-modal/MetadataPanel.tsx` — `availablePriorities[].icon` typed as `string` but `PriorityDef.icon` is `string | undefined`

## Fix

1. `WorkflowSection` — remove `requireInputStatus`, `readyForMergeStatus`, `archiveStatus` from `WorkflowSectionProps` and the destructure; the parent already passes the `normalized*` versions separately
2. `CliSessionPanel` — remove `taskId` from `CliSessionPanelProps` and the destructure (and from the call site in `TaskModal.tsx`) if genuinely unused, or wire it into the JSX if it was intended to be used
3. `useTaskForm` — widen parameter type to `Task | Partial<Task> | null | undefined`
4. `MetadataPanel` — change `icon: string` to `icon?: string` in the inline priority prop type
