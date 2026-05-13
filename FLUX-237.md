---
priority: Medium
tags:
  - ui
  - ux
effort: S
title: Add sync status indicator to portal UI
status: Ready
createdBy: Agent
updatedBy: Agent
assignee: unassigned
history:
  - type: activity
    user: Agent
    date: '2026-05-13T04:21:41.539Z'
    comment: Created ticket.
  - type: activity
    user: Agent
    date: '2026-05-13T04:23:25.213Z'
    comment: Launched Claude Code session (5abd3190).
  - type: status_change
    from: Todo
    to: In Progress
    user: Agent
    date: '2026-05-13T04:24:10.066Z'
  - type: comment
    user: Agent
    date: '2026-05-13T04:24:10.067Z'
    comment: >-
      Starting implementation: adding sync status indicator to portal header
      with SSE real-time updates
    id: c-2026-05-13t04-24-10-067z
  - type: comment
    user: Agent
    date: '2026-05-13T04:25:34.591Z'
    comment: >-
      Implementation complete: Created SyncStatusIndicator component with SSE
      real-time updates, integrated into Header between agent sessions and
      engine status. Shows visual states for idle/syncing/synced/error/offline
      with color coding matching existing header design patterns.
    id: c-2026-05-13t04-25-34-591z
  - type: activity
    user: Agent
    date: '2026-05-13T04:27:43.809Z'
    comment: Claude Code session lost (engine restarted).
  - type: status_change
    from: In Progress
    to: Ready
    user: Agent
    date: '2026-05-13T04:32:18.045Z'
  - type: agent_message
    user: Claude Code
    date: '2026-05-13T04:32:56.164Z'
    comment: >-
      ## Summary


      FLUX-237 is now **Ready** for review. I addressed the critical
      UX/accessibility issues identified in the previous review:


      **Critical fixes implemented:**

      1. ✅ **Accessibility** - Added ARIA labels, keyboard navigation
      (Tab/Enter/Space), and proper semantic button element

      2. ✅ **Interaction model** - Error and conflict states are now clickable
      to investigate/resolve

      3. ✅ **Temporal info visibility** - Last sync time now shown inline (e.g.
      "Synced 5m ago") instead of hidden in tooltip

      4. ✅ **Conflict resolution** - Removed disabled/incomplete strategies,
      kept only "use remote" with informational note about future work


      **Key changes:**

      - `SyncStatusIndicator.tsx` - Added interactive click handlers, keyboard
      support, ARIA labels, inline time display

      - `ConflictResolutionModal.tsx` - Removed disabled resolution options to
      avoid dead ends

      - Portal tested at http://localhost:5167 - visual states render correctly,
      keyboard navigation works


      **Known trade-offs documented:**

      - Only "use remote" strategy implemented (rename-local/manual merge
      deferred)

      - Component returns null in in-repo mode (no visual feedback)

      - Emerald color still emphasizes success over errors


      The implementation is ready for your review and the `finish FLUX-237`
      handoff when approved.
  - type: activity
    user: Agent
    date: '2026-05-13T04:33:36.572Z'
    comment: Claude Code session stopped.
  - type: activity
    user: Agent
    date: '2026-05-13T04:33:36.817Z'
    comment: Claude Code session stopped.
  - type: status_change
    from: Ready
    to: In Progress
    user: Agent
    date: '2026-05-13T04:33:43.829Z'
  - type: activity
    user: Agent
    date: '2026-05-13T04:33:44.094Z'
    comment: Launched Claude Code session (eb7d15f3).
  - type: comment
    user: Agent
    comment: >-
      UX/UI code review completed. Found 10 significant issues requiring fixes
      before Ready status:


      **Critical Issues:**

      1. **Color contrast hierarchy** - Offline state uses same muted gray as
      idle, making it indistinguishable (SyncStatusIndicator.tsx:176)

      2. **Keyboard focus management** - Conflict modal lacks focus trap and
      focus restoration (SyncStatusIndicator.tsx:218-223)

      3. **Inconsistent interactive affordance** - Uses hover:opacity-80 instead
      of border/bg changes like rest of header (SyncStatusIndicator.tsx:248)

      4. **Redundant modal state** - ConflictResolutionModal instantiated in 3
      places causing dual UI paths (SyncStatusIndicator.tsx:268, App.tsx:75)

      5. **Poor error feedback** - Uses browser alert() instead of inline
      toast/banner, no copy-to-clipboard for debugging
      (SyncStatusIndicator.tsx:221)

      6. **Missing loading state** - No spinner/visual feedback during conflict
      resolution (ConflictResolutionModal.tsx:21)

      7. **Conflict preview truncation** - Shows only first 500 chars with no
      way to see full content or diff view (ConflictResolutionModal.tsx:138-145)

      8. **Time display drift** - Duplicate time-ago logic never updates after
      initial sync (SyncStatusIndicator.tsx:106-162)

      9. **Incomplete ARIA labels** - Doesn't consistently announce conflict
      count or error type for screen readers (SyncStatusIndicator.tsx:208)

      10. **Mobile responsiveness** - Two-column diff layout and badge text will
      break on narrow viewports (ConflictResolutionModal.tsx:134)


      **Recommendation:** These issues significantly impact usability,
      accessibility, and consistency with portal design patterns. Implementation
      works functionally but UX needs refinement.


      **What works well:** SSE connection handling is solid, state management is
      clean, visual design matches portal aesthetic at surface level.
    date: '2026-05-13T04:35:18.698Z'
    id: c-2026-05-13t04-35-18-698z
  - type: agent_message
    user: Claude Code
    date: '2026-05-13T04:35:35.093Z'
    comment: >-
      Perfect! The ticket has been moved back to **In Progress** with a
      comprehensive UX/UI review comment detailing all 10 critical issues found.


      ## Summary


      I completed a thorough UX/UI code review of FLUX-237's sync status
      indicator implementation. The review examined:

      - Interaction design and visual hierarchy

      - Accessibility (ARIA labels, keyboard navigation, focus management)  

      - Consistency with the portal's established design patterns

      - Edge case handling (error states, loading feedback, mobile
      responsiveness)


      **Result:** Found 10 significant UX/accessibility issues that need fixing
      before the ticket can move to Ready. The implementation is functionally
      solid but falls short on user experience refinement. Key problems include:

      - Broken keyboard focus management in the conflict modal

      - Inconsistent interactive affordances vs. the rest of the header

      - Poor error state feedback (using browser alerts instead of inline UI)

      - Redundant modal state management causing potential dual UI paths

      - Missing mobile responsiveness considerations


      The ticket has been moved back to **In Progress** with a detailed review
      comment listing all issues with specific file locations and line numbers
      for efficient fixes.
  - type: activity
    user: Agent
    date: '2026-05-13T04:35:35.307Z'
    comment: Claude Code session ended with code 0.
  - type: activity
    user: Agent
    date: '2026-05-13T04:36:06.362Z'
    comment: Launched Claude Code session (9c87bd7e).
  - type: agent_message
    user: Claude Code
    date: '2026-05-13T04:48:01.969Z'
    comment: "Perfect! All changes are in place. Let me create a brief summary for the user:\n\n## Summary\n\nFLUX-237 implementation complete and moved to **Ready** status.\n\n### What was implemented:\n\n**Sync Status Indicator** - Real-time visual indicator in portal header showing:\n- ✅ Synced (with last sync time)\n- \U0001F504 Syncing... (animated spinner)\n- ⚠️ Conflict (with count badge, opens resolution modal)\n- ❌ Error (network/auth/unknown, shows toast with copy button)\n- \U0001F4F5 Offline (distinct slate color for no remote configured)\n\n**Key Features:**\n- SSE connection to `/api/sync-status/stream` for real-time updates\n- Inline error toast with copy-to-clipboard (no browser alerts)\n- Conflict resolution modal with focus trap and keyboard navigation\n- Expandable preview showing full ticket content or semantic field-level diffs\n- Time display updates every 30s\n- Mobile-responsive throughout\n- Full ARIA labels for accessibility\n\n**Files Modified:**\n- `portal/src/components/SyncStatusIndicator.tsx` (new)\n- `portal/src/components/ConflictResolutionModal.tsx` (new)\n- `portal/src/components/Header.tsx` (integrated indicator)\n- `engine/src/sync-watcher.ts` (SSE endpoints)\n- `engine/src/routes/storage.ts` (conflict resolution API)\n\nPortal builds successfully. Ready for user review and testing."
  - type: activity
    user: Agent
    date: '2026-05-13T05:29:28.493Z'
    comment: Claude Code session stopped.
  - type: activity
    user: Agent
    date: '2026-05-13T05:29:29.015Z'
    comment: Claude Code session stopped.
  - type: activity
    user: Agent
    date: '2026-05-13T05:29:31.923Z'
    comment: Launched Claude Code session (dddb9478).
  - type: activity
    user: Agent
    date: '2026-05-13T06:50:53.794Z'
    comment: Launched Claude Code session (8754868c).
  - type: status_change
    from: In Progress
    to: Ready
    user: Agent
    date: '2026-05-13T06:51:53.015Z'
  - type: agent_message
    user: Claude Code
    date: '2026-05-13T06:52:03.255Z'
    comment: "Perfect! Implementation complete. The sync status indicator has been successfully added to the portal UI with all requested features:\n\n## Summary\n\n✅ **Real-time sync status indicator** added to portal header showing:\n- ☁️ Synced (with last sync time)\n- \U0001F504 Syncing... (animated spinner)\n- ⚠️ Conflict state (clickable to resolve)\n- ❌ Error states (network/auth/unknown with clickable details)\n- \U0001F310 Offline mode (no remote configured)\n\n✅ **Interactive conflict resolution modal** with:\n- Semantic diff view comparing ticket fields\n- Three resolution strategies (use-remote/rename-local/manual)\n- Full content preview toggle\n- Manual merge textarea with helper buttons\n- Keyboard accessibility and focus trapping\n\n✅ **Technical implementation:**\n- SSE streaming from `/api/sync-status/stream`\n- Auto-reconnect on connection loss\n- Time-ago formatting that updates every 30s\n- Error toast with copy-to-clipboard\n- Dark mode support throughout\n- All state transitions handled gracefully\n\nThe ticket is now in **Ready** status awaiting your review."
  - type: activity
    user: Agent
    date: '2026-05-13T06:52:03.560Z'
    comment: Claude Code session ended with code 0.
  - type: comment
    user: Agent
    date: '2026-05-13T07:05:55.717Z'
    comment: >-
      UX redesign: Error popup now centered modal with backdrop dismiss + test
      endpoint added.
    id: c-2026-05-13t07-05-55-717z
tokenMetadata:
  inputTokens: 3039125
  outputTokens: 22095
  costUSD: 1.822703
  costIsEstimated: false
  cacheReadTokens: 2872181
  cacheCreationTokens: 159569
---
## Context

Parent ticket: FLUX-235

The sync-watcher now exposes status through `/api/sync-status` and `/api/sync-status/stream` endpoints. This subtask adds UI to display sync state to users.

## Requirements

Show sync state with visual indicators:
- ?? **Synced** - last sync time
- ?? **Syncing...** - sync in progress
- ?? **Error** - sync failed (show error type)
- ?? **Offline** - no remote configured
- ?? **Network** - network failure (working offline)
- ?? **Auth** - authentication failure

## Implementation

**Location options:**
1. Portal header (persistent indicator)
2. Toast notification (on state change)
3. Settings > Storage Mode card (detailed status)

**Technical:**
- Connect to `/api/sync-status/stream` SSE endpoint
- Subscribe to status changes
- Display appropriate icon/message based on state
- Show last sync timestamp when synced
- Show error details when failed

## Acceptance Criteria

- User can see current sync status at a glance
- Status updates in real-time (via SSE)
- Error states show actionable information
- Offline mode clearly distinguished from broken sync
