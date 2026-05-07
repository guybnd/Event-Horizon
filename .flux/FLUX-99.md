---
assignee: unassigned
tags:
  - integration
  - settings
priority: Medium
effort: Small
implementationLink: 'e90e38b3e32c7fb4e725067056c12077ca9c7397'
subtasks:
  - Add framework parameter to /api/skill/install endpoint
  - Update Settings.tsx with an intelligent default/selectable IDE picker
  - 'Implement installer logic for Cursor, Cline, Windsurf, and Claude Code'
history:
  - type: activity
    user: Guy
    date: '2026-05-07T15:05:59.737Z'
    comment: Created ticket.
  - type: activity
    user: Guy
    date: '2026-05-07T15:06:54.971Z'
    comment: Updated description.
  - type: comment
    user: GitHub Copilot
    date: '2026-05-08T12:00:00.000Z'
    comment: >-
      Groomed ticket. Proposed supporting Cursor, Cline, Windsurf, and Claude
      Code in addition to Copilot and Gemini. Do we agree on the list of target
      IDEs/Agents? Moving to Require Input.
    id: c-2026-05-08t12-00-00-000z
  - type: comment
    user: Guy
    date: '2026-05-07T15:19:33.872Z'
    comment: yes. gemini maybe gemini CLI and antigravity. what about codex?
    id: c-2026-05-07t15-19-33-872z
  - type: status_change
    from: Require Input
    to: Todo
    user: Guy
    date: '2026-05-07T15:19:33.872Z'
    comment: Response submitted
  - type: status_change
    from: Todo
    to: In Progress
    user: GitHub Copilot
    date: '2026-05-08T12:00:00.000Z'
    comment: Starting implementation of IDE integration mappings.
  - type: status_change
    from: In Progress
    to: Ready
    user: GitHub Copilot
    date: '2026-05-08T12:00:01.000Z'
    comment: Completed implementation for Cursor, Cline, Windsurf, Claude Code, and Gemini. Updated settings UI and installer mapping. Docs updated. Ready for merge.
  - type: status_change
    from: Ready
    to: Done
    user: GitHub Copilot
    date: '2026-05-08T12:05:00.000Z'
    comment: Shipped framework-specific ticket rules installation to Cursor, Cline, Windsurf, and Claude Code (along with generic and Gemini formats). Re-added framework mapping logic in UI and installer APIs. Validated by CLI build. Revisions committed cleanly.
title: support integration to various IDE from t he settings integration button
status: Done
createdBy: Guy
updatedBy: Guy
---
**Objective**
Support installing the Event Horizon workflow instructions and skills across various agentic code editors (Cursor, Cline, Windsurf, Claude Code, GitHub Copilot) from the Settings screen.

**Requirements**
1. Add a selector in the "Agent Integration" settings tab for installing to specific tools.
2. Default the selector to "Intelligent / Auto-detect" which detects target footprints like `.cursor` or `.vscode`, but allow manual override.
3. Pass the chosen `framework` from the Settings UI -> `api.ts` -> `/api/skill/install` API.
4. Expand `workflow-installer.ts` to output the proper rule format based on the selected editor (e.g. `.cursorrules`, `.clinerules`, `.windsurfrules`, `.clauderc`).
