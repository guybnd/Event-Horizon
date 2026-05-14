---
title: Gemini CLI Agent Integration
status: Done
assignee: Gemini
priority: High
created: 2026-05-14T11:45:00.000Z
updated: 2026-05-14T11:45:00.000Z
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
