---
assignee: unassigned
tags: []
priority: Medium
effort: M
implementationLink: ''
subtasks: []
history:
  - type: activity
    user: Guy
    date: '2026-05-13T11:48:28.282Z'
    comment: Created ticket.
  - type: activity
    user: Agent
    date: '2026-05-13T11:48:32.207Z'
    comment: Launched Claude Code session (906adbb5).
  - type: activity
    user: Agent
    date: '2026-05-13T11:48:36.406Z'
    comment: Claude Code session lost (engine restarted).
  - type: activity
    user: Agent
    date: '2026-05-13T11:49:00.860Z'
    comment: Claude Code session stopped.
  - type: activity
    user: Agent
    date: '2026-05-13T11:59:42.979Z'
    comment: Launched Claude Code session (5a097dc9).
  - type: status_change
    from: Grooming
    to: Todo
    user: Agent
    date: '2026-05-13T12:01:12.309Z'
  - type: comment
    user: Agent
    date: '2026-05-13T12:01:12.310Z'
    comment: >-
      Groomed ticket: created implementation plan covering progress tracking, UI
      components, enforcement rules, and data flow. This is a Medium effort
      ticket requiring changes across engine session lifecycle, history system,
      and portal UI components.
    id: c-2026-05-13t12-01-12-310z
  - type: agent_message
    user: Claude Code
    date: '2026-05-13T12:01:30.819Z'
    comment: >-
      Grooming complete! I've successfully:


      1. **Analyzed the problem** - Reviewed the current system for agent
      messages, history tracking, and UI components

      2. **Created a comprehensive implementation plan** covering:
         - Backend session lifecycle hooks for auto-logging progress
         - Enhanced history entry types to distinguish progress vs summary messages
         - New UI components (progress bubble on TaskCard, enhanced filters in TaskModal)
         - Enforcement rules to ensure agents always leave summaries on status changes
         - Settings for user control over progress visibility
      3. **Updated ticket metadata**:
         - Priority: Medium
         - Effort: M (Medium)
         - Status: Todo (ready for implementation)
      4. **Added grooming comment** explaining the plan scope


      The ticket is now ready for implementation with a detailed breakdown of
      the required changes across the engine and portal surfaces.
  - type: activity
    user: Agent
    date: '2026-05-13T12:01:30.855Z'
    comment: Claude Code session ended with code 0.
  - type: status_change
    from: Todo
    to: In Progress
    user: Agent
    date: '2026-05-13T12:02:51.346Z'
  - type: activity
    user: Agent
    date: '2026-05-13T12:02:51.409Z'
    comment: Launched Claude Code session (a483c84f).
  - type: status_change
    from: In Progress
    to: Todo
    user: Agent
    date: '2026-05-13T12:04:01.152Z'
  - type: comment
    user: Agent
    date: '2026-05-13T12:04:10.597Z'
    comment: >-
      **UX Review Finding: Work Mismatch Detected**


      The uncommitted code changes do not implement FLUX-241's requirements.
      Instead, they implement parse error detection and display (FLUX-159):


      **What was built:**

      - ParseErrorButton & ParseErrorBanner components

      - Backend parse error tracking in task-store.ts

      - API endpoint /tasks/errors

      - Integration into Board and Backlog screens

      - Auto-stop CLI sessions when moving to Ready


      **What FLUX-241 requires:**

      - Real-time progress "thought bubbles" on TaskCard

      - Agent progress vs summary distinction in history

      - Enhanced TaskModal activity filters

      - Session lifecycle hooks for auto-logging

      - Settings toggles for progress display

      - Enforcement rules for status change summaries


      **Recommendation:**

      1. Commit the parse error work to FLUX-159

      2. Return to FLUX-241 and implement the actual requirements per the ticket
      body


      Moving ticket back to Todo.
    id: c-ux-review-2026-05-13
  - type: agent_message
    user: Claude Code
    date: '2026-05-13T12:04:18.699Z'
    comment: >-
      Perfect! The review comment has been posted and the ticket moved back to
      Todo. Now let me provide a summary to the user:


      ## UX Review Complete: Work Mismatch Detected


      **Finding:** The uncommitted code changes do **not** implement FLUX-241's
      requirements. They implement a completely different feature (parse error
      detection for FLUX-159).


      ### What Was Actually Built

      - `ParseErrorButton` & `ParseErrorBanner` components for displaying
      corrupted ticket files

      - Backend parse error tracking in `task-store.ts` with `/tasks/errors` API
      endpoint

      - Integration into Board and Backlog screens

      - Auto-stop CLI sessions when tickets move to Ready status


      ### What FLUX-241 Actually Requires

      According to the ticket body, these features were planned but **not
      implemented**:

      - Real-time AI "thought bubble" progress display on TaskCard

      - `isAgentProgress` and `isSummary` flags to distinguish progress vs final
      summaries

      - Enhanced TaskModal activity filters (Agent Progress, Agent Summary)

      - Session lifecycle hooks for auto-logging progress

      - Settings toggles for progress bubble visibility

      - Enforcement rules requiring summaries on status changes


      ### Actions Taken

      1. ✅ Posted detailed review comment to FLUX-241 history

      2. ✅ Moved ticket from "In Progress" back to "Todo"


      ### Recommendation

      The parse error work should be committed to **FLUX-159** (the correct
      ticket), then return to implement FLUX-241's actual requirements as
      specified in the implementation plan.
  - type: activity
    user: Agent
    date: '2026-05-13T12:04:18.743Z'
    comment: Claude Code session ended with code 0.
  - type: comment
    user: Guy
    date: '2026-05-13T12:07:15.535Z'
    comment: >-
      i want a UI UX expert to review this and tell me if theres a better way or
      idea to accomplish this problem's solution
    id: c-2026-05-13t12-07-15-534z
  - type: status_change
    from: Todo
    to: Grooming
    user: Guy
    date: '2026-05-13T12:07:19.979Z'
  - type: activity
    user: Agent
    date: '2026-05-13T12:07:22.311Z'
    comment: Launched Claude Code session (8b1cf59f).
title: 'UX brainstorm: show AI thought \ progress in ticket'
status: Grooming
createdBy: Guy
updatedBy: Agent
tokenMetadata:
  inputTokens: 1438257
  outputTokens: 6747
  costUSD: 0.987483
  costIsEstimated: false
  cacheReadTokens: 1303231
  cacheCreationTokens: 116531
order: 1
---
## Problem Summary

The current UX makes it difficult to track AI progress on tickets. Agent messages are not surfaced well, progress is invisible during active sessions, and there's no enforcement that agents leave summary comments on status changes or session ends.

## Implementation Plan

### 1. Activity & Progress Tracking System

**Backend (engine/src/agents/claude-code.ts)**
- Extend `currentActivity` tracking to include more granular states
- Add session lifecycle hooks to automatically create history entries:
  - On session start: `agent_message` with "Started working on FLUX-XXX"
  - On session end (completed/failed/cancelled): `agent_message` with summary (duration, token usage, outcome)
- When status changes during agent session, enforce that a `comment` (not just `agent_message`) accompanies the change

**History Entry Enhancement (engine/src/history.ts)**
- Add `isAgentProgress` field to `agent_message` type history entries to distinguish:
  - Progress updates (e.g., "Reading files...", "Running tests...")
  - Final summaries (e.g., "Implementation complete")
- Ensure `agent_message` entries get unique IDs like comments do

### 2. Portal UI Components

**A. Real-Time Progress Display in TaskCard**
- Add collapsible "thought bubble" UI element (similar to comment badge)
- Position: Below title area or as floating badge
- Show when: Active CLI session with `currentActivity` present
- Content: Latest `agent_message` entries + live activity state
- Visual: Pulsing/animated border when active, muted when collapsed
- Toggle: Click to expand/collapse, setting to auto-hide/show

**B. TaskModal Activity Section Enhancement**
- Add dedicated "Agent Progress" filter tab alongside existing "All", "Activity", "Comments", "Agent"
- Visual distinction: Use Bot icon and different background for `agent_message` entries
- Filtering logic:
  - "All": Everything
  - "Activity": status_change + activity (no agent_message)
  - "Comments": user comments only
  - "Agent": agent_message entries only (NEW: distinguish progress vs summary)
  - "Agent Progress": Only show `isAgentProgress: true` entries (intermediate steps)
  - "Agent Summary": Only show final agent summaries (session end, status changes)

**C. Settings Toggle**
- Add to Settings → Display: "Show AI progress bubbles on cards" (default: true)
- Add delay slider: "Show progress after X seconds" (default: 2s)
- Store in config as `agentProgressBubbles: { enabled: boolean, delay: number }`

### 3. Enforcement Rules

**On Status Change (engine/src/routes/tasks.ts)**
- When agent changes ticket status, validate that either:
  1. A `comment` entry (type=comment) is included in the same update, OR
  2. An `agent_message` entry with `isSummary: true` is included
- Return error if neither present: `AGENT_STATUS_CHANGE_MISSING_SUMMARY`

**On Session End (engine/src/agents/claude-code.ts)**
- When session completes/fails/cancelled, automatically append:
  - `agent_message` with `isSummary: true`
  - Content: Session outcome, duration, tokens used, last activity
  - If session was for a ticket and ticket is still `In Progress`, suggest moving to `Ready` or record blocker

### 4. UI Polish

**TaskCard Thought Bubble**
- Position: Top-right area, below/beside comment badge
- Visual: Small bot icon with animated pulse when active
- On hover: Show tooltip with latest activity
- On click: Expand inline panel showing last 3 agent_message entries
- Mute button: Suppress bubble for this specific ticket (store in localStorage)

**HistoryList Component**
- Distinguish `agent_message` entries with:
  - Progress entries: Lighter background, smaller font, timestamp-focused
  - Summary entries: Full comment-style rendering with Bot icon and border
- Add "Show/Hide Progress Steps" toggle button at top of history section

### 5. Data Migration

- No schema changes needed (history already supports `agent_message` type)
- Add optional `isAgentProgress`, `isSummary` boolean flags to history entries (backward compatible)
- Existing `agent_message` entries without flags default to summary display

## Acceptance Criteria

1. When agent starts working on a ticket, an `agent_message` is logged automatically
2. During active sessions, TaskCard shows collapsible progress bubble with latest activity
3. When agent changes ticket status, a user-facing comment or summary is enforced
4. TaskModal history has clear visual distinction between progress steps and final summaries
5. User can filter history to see only summaries or only progress steps
6. Settings allow disabling progress bubbles globally
7. Session end automatically logs a summary message with outcome and metrics

## Files to Modify

- `engine/src/agents/claude-code.ts` - Session lifecycle hooks, auto-logging
- `engine/src/history.ts` - Add helper for agent summary entries
- `engine/src/routes/tasks.ts` - Enforce summary on status change
- `portal/src/types.ts` - Extend HistoryEntry type with progress/summary flags
- `portal/src/components/TaskCard.tsx` - Add progress bubble component
- `portal/src/components/TaskModal.tsx` - Enhance activity filter UI
- `portal/src/components/task-modal/HistoryList.tsx` - Visual distinction for agent entries
- `portal/src/AppContext.tsx` - Settings for progress bubble config

## Estimated Effort

**M** (Medium) - Touches multiple surfaces but each change is relatively straightforward
