---
title: Gemini CLI Agent Integration
status: Done
assignee: Gemini
priority: High
created: 2026-05-14T11:45:00.000Z
updated: 2026-05-14T11:45:00.000Z
history:
  - type: activity
    user: Unknown
    date: '2026-05-14T01:57:41.948Z'
    comment: Created ticket.
  - type: agent_session
    sessionId: bd57bb05-46d0-42ed-9cf0-ec1e4eab13f7
    startedAt: '2026-05-14T02:04:51.888Z'
    status: cancelled
    progress:
      - timestamp: '2026-05-14T02:05:07.465Z'
        message: Working
      - timestamp: '2026-05-14T02:05:22.405Z'
        message: Working
    user: Gemini CLI
    date: '2026-05-14T02:04:51.888Z'
    outcome: Gemini CLI session stopped by user.
    endedAt: '2026-05-14T02:07:06.672Z'
  - type: activity
    user: Agent
    date: '2026-05-14T02:07:06.622Z'
    comment: Gemini CLI session stopped.
updatedBy: Agent
---

Implement and polish the Gemini CLI integration as a supported agent framework in EventHorizon.

### Key Deliverables
- **GeminiAdapter**: Full support for Gemini CLI with real-time `stream-json` output parsing.
- **UI/UX Enhancements**:
  - Visual framework selector with branding icons and colors.
  - Contextual "Launch" button icons.
  - Branded settings sections for model overrides.
- **Robust Execution**:
  - Intelligent Windows binary detection (finds node bundle or native `.exe`).
  - Unified CLI arguments for start and resume.
  - Removal of unsupported `--verbose` flag.
- **Skill Infrastructure**:
  - Support for Gemini skill concatenation and installation to `.gemini/skills/`.
  - Automatic instruction patching to `.gemini/instructions.md`.

### Technical Details
- Added `engine/src/agents/gemini.ts` with comprehensive JSON event handling.
- Integrated `FrameworkSelector.tsx` across the portal (Settings and Sidebar).
- Promoted framework state to parent `Settings.tsx` to ensure correct dirty checking.
- Fixed `skill-installer.ts` to use ES modules for modern Node.js support.
