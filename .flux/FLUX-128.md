---
title: Add Antigravity support to the workflow integrator
status: Done
createdBy: Guy
updatedBy: Guy
assignee: unassigned
tags:
  - feature
  - integration
priority: Medium
effort: S
implementationLink: ''
subtasks: []
history:
  - type: activity
    user: Antigravity
    date: '2026-05-08T08:20:00.000Z'
    comment: Created ticket.
  - type: comment
    user: Antigravity
    date: '2026-05-08T08:23:00.000Z'
    comment: >-
      Implemented Antigravity support in `engine/src/workflow-installer.ts`.
      Added `'antigravity'` to the `Framework` type. Updated `resolveFramework`
      to detect `.gemini/antigravity`. Mapped `instructionsDestinationFor` to
      return `.gemini/instructions.md`. Also fixed a minor bug in
      `instructionsSourceExists` evaluation. Ran `npm run build` successfully.
    id: c-2026-05-08t08-23-00-000z
  - type: status_change
    from: Todo
    to: Ready
    user: Antigravity
    date: '2026-05-08T08:23:00.000Z'
  - type: comment
    user: Guy
    date: '2026-05-08T08:25:04.512Z'
    comment: i dont  see an option for antigravity in the picker manu
    replyTo: c-2026-05-08t08-23-00-000z
    id: c-2026-05-08t08-25-04-512z
  - type: status_change
    from: Ready
    to: Todo
    user: Guy
    date: '2026-05-08T08:25:04.512Z'
    comment: Returned to work
  - type: status_change
    from: Todo
    to: In Progress
    user: Guy
    date: '2026-05-08T08:25:08.853Z'
  - type: status_change
    from: In Progress
    to: Done
    user: Guy
    date: '2026-05-08T08:28:34.202Z'
order: 123
---

## Problem / Motivation
Currently, the `workflow-installer.ts` integrator automatically detects and configures itself for environments like Copilot, Cursor, Cline, and Windsurf. While there is partial support for a generic `.gemini` folder, Antigravity has specific capabilities and expected paths for its skills and instructions that are not fully utilized. This prevents Antigravity from automatically receiving the Event Horizon instructions and skills in its native format when the workflow installer runs.

## Requirements

### 1. Detect Antigravity Environment
- Update `resolveFramework` in `engine/src/workflow-installer.ts` to explicitly detect an Antigravity setup (e.g., by checking for `.gemini/antigravity` or defining a new `'antigravity'` framework).

### 2. Configure Destinations
- Update `skillDestinationFor` to install skills into the appropriate Antigravity skill paths.
- Update `instructionsDestinationFor` to return the path where Antigravity expects its project instructions (rather than returning `undefined` like the current `'gemini'` case).

## Acceptance Criteria
- [x] Running the workflow installer in a repository with Antigravity properly detects the environment.
- [x] Skills and instructions are written to the correct Antigravity target paths.
- [x] Antigravity agents successfully inherit the workflow context automatically in newly installed projects.

## Likely Affected Areas
- `engine/src/workflow-installer.ts`

## Notes
- Depending on how Antigravity natively loads project rules, we might need to write to `.gemini/instructions.md` or directly interact with the KI (Knowledge Item) structure.
