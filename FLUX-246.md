---
assignee: unassigned
tags: []
priority: None
effort: None
implementationLink: ''
subtasks: []
history:
  - type: activity
    user: Guy
    date: '2026-05-13T12:37:54.852Z'
    comment: Created ticket.
  - type: activity
    user: Agent
    date: '2026-05-13T12:37:57.875Z'
    comment: Launched Claude Code session (7654dd72).
  - type: activity
    user: Agent
    date: '2026-05-13T12:39:28.232Z'
    comment: Claude Code session lost (engine restarted).
  - type: agent_session
    sessionId: d1b82f3d-37a6-4963-b89b-cfb27cb3dac6
    startedAt: '2026-05-13T12:40:30.772Z'
    status: active
    progress: []
    user: Claude Code
    date: '2026-05-13T12:40:30.772Z'
  - type: status_change
    from: Grooming
    to: Todo
    user: Agent
    date: '2026-05-13T12:41:55.388Z'
  - type: status_change
    from: Todo
    to: In Progress
    user: Agent
    date: '2026-05-13T12:42:17.392Z'
  - type: comment
    user: Agent
    date: '2026-05-13T12:42:17.393Z'
    comment: >-
      Fixed overlay rendering condition in TaskModal.tsx line 1080. Changed
      condition from `isModalOpen && config` to `isModalOpen && config &&
      !isFullView` so the backdrop only renders for popup mode. Also simplified
      the onClick handler since it's now popup-only. Ready to test both view
      modes.
    id: c-2026-05-13t12-42-17-393z
  - type: status_change
    from: In Progress
    to: Ready
    user: Agent
    date: '2026-05-13T12:42:48.070Z'
  - type: comment
    user: Agent
    date: '2026-05-13T12:42:48.071Z'
    comment: 'Implementation complete. Fixed the overlay rendering bug in TaskModal.tsx:'
    id: c-2026-05-13t12-42-48-071z
title: 'bug: full ticket view also loads the pop up view?'
status: Ready
createdBy: Guy
updatedBy: Agent
---
## Bug Analysis

**Root cause:** The TaskModal component renders the overlay backdrop unconditionally when `isModalOpen && config` is true, regardless of view mode. While the click handler is conditionally disabled for full view, the visual overlay is always present.

**Current rendering structure:**
1. Overlay: renders when `isModalOpen && config` (always, for both modes)
2. Full view: renders when `isModalOpen && config && isFullView`
3. Popup view: renders when `isModalOpen && config && !isFullView`

**Problem:** The overlay with backdrop blur appears in both modes when it should only appear for popup mode. The full view should have no overlay since it takes the full viewport (inset-3).

## Implementation Plan

1. **Fix the overlay rendering condition** in TaskModal.tsx:
   - Change line 1080 from `{isModalOpen && config && (` to `{isModalOpen && config && !isFullView && (`
   - This ensures the overlay only renders for popup mode

2. **Verify z-index layering:**
   - Overlay: z-[55]
   - Full view content: z-[60]
   - Popup content: z-[60]
   - Ensure no conflicts

3. **Test both modes:**
   - Open ticket in popup mode → should show overlay backdrop
   - Switch to full view → overlay should disappear
   - Direct URL with view=full → no overlay from start
   - Direct URL with view=popup or no view param → overlay present

## Files to modify
- `portal/src/components/TaskModal.tsx` (line ~1080)

## Validation
- Open any ticket in popup mode, verify overlay visible
- Click 'Full View' button, verify overlay disappears
- Navigate directly to URL with `?ticket=FLUX-XX&view=full`, verify no overlay
- Navigate to URL with `?ticket=FLUX-XX&view=popup`, verify overlay visible
