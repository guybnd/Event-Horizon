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
  - type: agent_message
    user: Claude Code
    date: '2026-05-13T12:08:17.235Z'
    comment: "I'll review this plan from a UX perspective and suggest alternatives.\n\n## UX Review of Current Plan\n\n**What works well:**\n- Surfacing invisible agent activity addresses a real pain point\n- Distinguishing progress from summaries is conceptually sound\n- Settings for user control respects different preferences\n- Enforcement ensures documentation isn't lost\n\n**Key concerns:**\n\n### 1. **Filter Proliferation**\nYour plan adds 2 more filters (\"Agent Progress\", \"Agent Summary\") to an already 4-tab system → **6 total tabs**. This is cognitively overwhelming and breaks the \"7±2 items\" heuristic. Most users want a binary choice: \"show me everything\" or \"show me what matters.\"\n\n### 2. **Card Surface Clutter**\nAdding a \"thought bubble\" alongside existing badges/status creates visual noise. Cards are high-traffic UI—every pixel needs to justify itself. A pulsing animation on every active ticket could feel chaotic on a busy board.\n\n### 3. **Three Types of Agent Content**\n- `agent_message` (progress)  \n- `agent_message` (summary)  \n- `comment` (from agent)  \n\nThis tri-modal distinction is an implementation detail leaking into UX. Users shouldn't need to understand these categories.\n\n---\n\n## Alternative Approach: Session-Centric & Minimal\n\n### **Core Insight**\nReframe from \"messages\" to **sessions**. A session is a discrete unit of agent work with a clear lifecycle: start → progress → outcome.\n\n### **1. Data Model: Agent Sessions**\n\nAdd a new history entry type: `agent_session`\n\n```yaml\n- type: agent_session\n  sessionId: \"ses_abc123\"\n  startedAt: \"2026-05-13T12:00:00Z\"\n  endedAt: \"2026-05-13T12:05:32Z\"  # null if active\n  status: \"active\" | \"completed\" | \"failed\" | \"cancelled\"\n  outcome: \"Moved ticket to Ready after implementing feature\"  # summary\n  progress: \n    - { ts: \"12:00:15\", msg: \"Reading ticket and docs\" }\n    - { ts: \"12:02:30\", msg: \"Editing 3 files\" }\n    - { ts: \"12:04:00\", msg: \"Running validation\" }\n  metrics:\n    duration: 332\n    tokensUsed: 45000\n```\n\n**Benefits:**\n- Groups related activity naturally\n- Progress is nested (collapsed by default)\n- One entry per session keeps history clean\n- Easy to update in real-time (append to `progress` array)\n\n### **2. Card UI: Enhance Status, Don't Add Bubbles**\n\n**Instead of a new thought bubble:**\n\nReplace static status badge with dynamic status line:\n\n```\n[Normal ticket]\n● In Progress\n\n[Agent active]\n● In Progress • Agent: Running tests ⚡\n\n[Agent recently finished]  \n● Ready • Agent finished 2m ago\n```\n\n- The lightning bolt (`⚡`) or spinner indicates live activity\n- Tooltip on hover shows last 3 progress items\n- No new UI elements, just richer status text\n- Muted styling for \"Agent:\" portion so it doesn't dominate\n\n### **3. Modal History: Simplified Filters**\n\n**Collapse 6 filters → 3:**\n\n| Filter | Shows |\n|--------|-------|\n| **All** | Everything (default) |\n| **Decisions** | Comments + status changes + session outcomes (no progress steps) |\n| **Sessions** | Agent sessions expanded with all progress steps |\n\n**Visual hierarchy in history:**\n- **Session headers**: Bold, with expand/collapse triangle\n  - `\U0001F916 Agent Session • 5m 32s • Completed`\n- **Progress steps** (when expanded): Indented, muted text, timestamps\n- **Outcome**: Regular comment weight, shown even when collapsed\n\n### **4. Enforcement: Session Outcome Required**\n\n**On session end:**\n- Engine automatically closes the session entry and requires an `outcome` string\n- If agent changes status without completing session properly, return `INCOMPLETE_SESSION` error\n- No separate \"comment\" vs \"agent_message\" distinction—the session outcome IS the summary\n\n**On status change during session:**\n- Agent can add a progress item OR update the session outcome\n- Moving to `Ready`/`Done` must include a session outcome\n\n---\n\n## Comparison Table\n\n| Aspect | Original Plan | Session-Centric Alternative |\n|--------|---------------|----------------------------|\n| **Card UI** | +1 thought bubble component | Enhance existing status line |\n| **History filters** | 6 tabs | 3 tabs |\n| **Agent content types** | 3 (progress msg, summary msg, comment) | 1 (session with nested progress) |\n| **History entries per session** | N progress + 1 summary = N+1 | 1 (with nested data) |\n| **Visual complexity** | High (new badges, animations, toggles) | Low (typography + expand/collapse) |\n| **Implementation scope** | M-L (7-8 files, new components) | M (same files, simpler data model) |\n\n---\n\n## Recommended Path Forward\n\n**If you want minimal disruption:**\n1. Implement sessions as proposed above\n2. Enhance status line on cards (no bubble)\n3. Use 3 filters instead of 6\n4. Add expand/collapse for session progress in modal\n\n**If you want to validate assumptions first:**\n1. Ship a simpler v1: Just auto-log session start/end as regular comments\n2. Observe if users complain about too much history noise\n3. If yes → implement sessions with collapsible progress\n4. If no → maybe enforcement + better filtering is enough\n\n---\n\n**Bottom line:** Your instinct to surface agent activity is correct, but the proposed UI adds a lot of chrome. A session-centric model with minimal new UI (enhanced status line + collapsible history) achieves the same goals with less cognitive load.\n\nWhat direction resonates with you? I can update the ticket body with whichever approach you prefer."
  - type: activity
    user: Agent
    date: '2026-05-13T12:08:17.251Z'
    comment: Claude Code session ended with code 0.
title: 'UX brainstorm: show AI thought \ progress in ticket'
status: Grooming
createdBy: Guy
updatedBy: Agent
tokenMetadata:
  inputTokens: 1462939
  outputTokens: 8873
  costUSD: 1.078872
  costIsEstimated: false
  cacheReadTokens: 1313341
  cacheCreationTokens: 131093
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
