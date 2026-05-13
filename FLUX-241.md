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
title: 'UX brainstorm: show AI thought \ progress in ticket'
status: Todo
createdBy: Guy
updatedBy: Agent
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
