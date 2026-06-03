---
assignee: unassigned
tags:
  - ui
  - portal
priority: Low
effort: XS
implementationLink: cd581c6
subtasks: []
history:
  - type: activity
    user: Guy
    date: '2026-06-03T04:42:45.499Z'
    comment: Created ticket.
  - type: agent_session
    sessionId: 22c3a2ee-96f6-4a25-895b-e99aa5895798
    startedAt: '2026-06-03T04:42:48.850Z'
    status: completed
    progress:
      - timestamp: '2026-06-03T04:42:58.917Z'
        message: Working
        type: tool
        data:
          toolName: ToolSearch
          parameters:
            query: >-
              select:mcp__event-horizon__get_ticket,mcp__event-horizon__update_ticket,mcp__event-horizon__change_status
            max_results: 3
      - timestamp: '2026-06-03T04:43:02.452Z'
        message: Working
        type: tool
        data:
          toolName: mcp__event-horizon__get_ticket
          parameters:
            ticketId: FLUX-362
      - timestamp: '2026-06-03T04:43:03.888Z'
        message: Working
        type: info
      - timestamp: '2026-06-03T04:43:05.567Z'
        message: Reading GlobalSearch.tsx
        type: tool
        data:
          toolName: Read
          parameters:
            file_path: /Users/guy/Event-Horizon/portal/src/components/GlobalSearch.tsx
      - timestamp: '2026-06-03T04:43:18.889Z'
        message: Reading
        type: info
      - timestamp: '2026-06-03T04:43:30.011Z'
        message: Working
        type: tool
        data:
          toolName: mcp__event-horizon__update_ticket
          parameters:
            ticketId: FLUX-362
            title: Search results panel width constrained by search bar container
            priority: Low
            effort: XS
            tags:
              - ui
              - portal
            body: >
              ## Problem / Motivation


              The search results dropdown in `GlobalSearch.tsx` uses `left-0
              right-0` positioning, which locks its width to the parent
              container (`max-w-[380px]`, flex-shrinking further when the header
              is crowded with other elements). This makes the results panel feel
              cramped and narrow. Since the panel is already an absolute overlay
              (`z-20`), there's no layout reason for it to be constrained to the
              input bar's width.


              ## Implementation Plan


              1. In `portal/src/components/GlobalSearch.tsx`, line 78: change
              the results dropdown from `left-0 right-0` to `left-0 min-w-full
              min-w-[520px]` — or more simply, replace `right-0` with `w-max
              max-w-[600px]`.
                 - Recommended: `left-0 w-max min-w-full max-w-[600px]` — dropdown is at least as wide as the input bar, grows to content, caps at 600px.
              2. No other files need changes. This is a pure CSS class tweak.

              3. Validate visually: open search with a crowded header and
              confirm results are readable at full width.
      - timestamp: '2026-06-03T04:43:33.890Z'
        message: Working
        type: info
      - timestamp: '2026-06-03T04:43:35.796Z'
        message: >-
          FLUX-362 is groomed and moved to Todo. The fix is a single-line CSS
          class change in `GlobalSearch.tsx:78` — replacing `right-0` with
          `w-max min-w-full max-w-[600px]` so the dropdown grows to content
          width rather than being pinned to the (often-narrow) search bar's
          bounds.
    user: Claude Code
    date: '2026-06-03T04:42:48.850Z'
    outcome: Claude Code session ended with code 0.
    endedAt: '2026-06-03T04:43:35.796Z'
  - type: activity
    user: Agent
    date: '2026-06-03T04:43:30.050Z'
    comment: >-
      Updated title. Updated description. Changed priority to Low. Changed
      effort to XS. Updated tags.
  - type: status_change
    from: Grooming
    to: Todo
    user: Agent
    date: '2026-06-03T04:43:32.478Z'
  - type: agent_session
    sessionId: 8fdeae52-d8ea-4d2a-ae2a-9a20067fb2e0
    startedAt: '2026-06-03T04:49:39.368Z'
    status: completed
    progress:
      - timestamp: '2026-06-03T04:49:48.203Z'
        message: Working
        type: tool
        data:
          toolName: ToolSearch
          parameters:
            query: 'select:mcp__event-horizon__change_status'
            max_results: 1
      - timestamp: '2026-06-03T04:49:48.628Z'
        message: Reading GlobalSearch.tsx
        type: tool
        data:
          toolName: Read
          parameters:
            file_path: /Users/guy/Event-Horizon/portal/src/components/GlobalSearch.tsx
      - timestamp: '2026-06-03T04:49:51.777Z'
        message: Working
        type: tool
        data:
          toolName: mcp__event-horizon__change_status
          parameters:
            ticketId: FLUX-362
            newStatus: In Progress
      - timestamp: '2026-06-03T04:49:54.414Z'
        message: Working
        type: info
      - timestamp: '2026-06-03T04:49:57.118Z'
        message: Editing GlobalSearch.tsx
        type: tool
        data:
          toolName: Edit
          parameters:
            replace_all: false
            file_path: /Users/guy/Event-Horizon/portal/src/components/GlobalSearch.tsx
            old_string: '        <div className="absolute left-0 right-0 top-[calc(100%+0.5rem)] z-20 overflow-hidden rounded-2xl border border-gray-200 bg-white/95 shadow-xl dark:border-white/10 dark:bg-[#15161d]/95">'
            new_string: '        <div className="absolute left-0 w-max min-w-full max-w-[600px] top-[calc(100%+0.5rem)] z-20 overflow-hidden rounded-2xl border border-gray-200 bg-white/95 shadow-xl dark:border-white/10 dark:bg-[#15161d]/95">'
      - timestamp: '2026-06-03T04:49:59.331Z'
        message: Working
        type: tool
        data:
          toolName: ToolSearch
          parameters:
            query: 'select:mcp__event-horizon__change_status'
            max_results: 1
      - timestamp: '2026-06-03T04:50:04.017Z'
        message: Working
        type: tool
        data:
          toolName: mcp__event-horizon__change_status
          parameters:
            ticketId: FLUX-362
            newStatus: Ready
            comment: >-
              Changed results dropdown from `left-0 right-0` to `left-0 w-max
              min-w-full max-w-[600px]` in GlobalSearch.tsx:78. The panel now
              grows to fit content, is always at least as wide as the input bar,
              and caps at 600px — regardless of how narrow the header search
              container is. Single-file CSS class change, no logic touched.
      - timestamp: '2026-06-03T04:50:07.436Z'
        message: >-
          Done. The one-line change in
          `portal/src/components/GlobalSearch.tsx:78` replaces `right-0` (which
          pinned the panel to the container width) with `w-max min-w-full
          max-w-[600px]`, so the dropdown is always at least as wide as the
          input bar and can expand up to 600px. FLUX-362 is now Ready for your
          review.
    user: Claude Code
    date: '2026-06-03T04:49:39.368Z'
    outcome: Claude Code session ended with code 0.
    endedAt: '2026-06-03T04:50:07.436Z'
  - type: status_change
    from: Todo
    to: In Progress
    user: Agent
    date: '2026-06-03T04:49:51.786Z'
  - type: comment
    user: Agent
    comment: >-
      Changed results dropdown from `left-0 right-0` to `left-0 w-max min-w-full
      max-w-[600px]` in GlobalSearch.tsx:78. The panel now grows to fit content,
      is always at least as wide as the input bar, and caps at 600px —
      regardless of how narrow the header search container is. Single-file CSS
      class change, no logic touched.
    date: '2026-06-03T04:50:04.028Z'
    id: c-2026-06-03t04-50-04-028z
  - type: status_change
    from: In Progress
    to: Ready
    user: Agent
    date: '2026-06-03T04:50:04.028Z'
  - type: agent_session
    sessionId: c673f0e2-81d0-4062-a26b-f5e2e3e8e187
    startedAt: '2026-06-03T04:50:25.045Z'
    status: completed
    progress:
      - timestamp: '2026-06-03T04:50:34.530Z'
        message: 'Running: git diff portal/src/components/GlobalSearch.tsx'
        type: tool
        data:
          toolName: Bash
          parameters:
            command: git diff portal/src/components/GlobalSearch.tsx
            description: Show diff for GlobalSearch.tsx
      - timestamp: '2026-06-03T04:50:38.702Z'
        message: 'Running: git add portal/src/components/GlobalSearch.tsx && ...'
        type: tool
        data:
          toolName: Bash
          parameters:
            command: >-
              git add portal/src/components/GlobalSearch.tsx && git commit -m
              "$(cat <<'EOF'

              Fix: expand search results panel beyond input bar width (FLUX-362)


              Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>

              EOF

              )"
            description: Commit the GlobalSearch fix
      - timestamp: '2026-06-03T04:50:40.115Z'
        message: Running command
        type: info
      - timestamp: '2026-06-03T04:50:41.877Z'
        message: Working
        type: tool
        data:
          toolName: ToolSearch
          parameters:
            query: 'select:mcp__event-horizon__finish_ticket'
            max_results: 1
      - timestamp: '2026-06-03T04:50:45.657Z'
        message: Working
        type: tool
        data:
          toolName: mcp__event-horizon__finish_ticket
          parameters:
            ticketId: FLUX-362
            implementationLink: cd581c6
            completionComment: >-
              Replaced `right-0` with `w-max min-w-full max-w-[600px]` in
              GlobalSearch.tsx:78. Results panel now grows to content width,
              stays at least as wide as the input bar, and caps at 600px —
              single-line CSS change, no logic touched. Commit: cd581c6.
      - timestamp: '2026-06-03T04:50:47.971Z'
        message: >-
          FLUX-362 is done. Commit `cd581c6` — one-line CSS fix in
          `GlobalSearch.tsx:78`.
    user: Claude Code
    date: '2026-06-03T04:50:25.045Z'
    outcome: Claude Code session ended with code 0.
    endedAt: '2026-06-03T04:50:47.971Z'
  - type: comment
    user: Agent
    comment: >-
      Replaced `right-0` with `w-max min-w-full max-w-[600px]` in
      GlobalSearch.tsx:78. Results panel now grows to content width, stays at
      least as wide as the input bar, and caps at 600px — single-line CSS
      change, no logic touched. Commit: cd581c6.
    date: '2026-06-03T04:50:45.678Z'
    id: c-2026-06-03t04-50-45-678z
  - type: status_change
    from: Ready
    to: Done
    user: Agent
    date: '2026-06-03T04:50:45.679Z'
id: FLUX-362
title: Search results panel width constrained by search bar container
status: Done
createdBy: Guy
updatedBy: Agent
tokenMetadata:
  inputTokens: 501417
  outputTokens: 3622
  costUSD: 0.39823
  costIsEstimated: false
  cacheReadTokens: 446070
  cacheCreationTokens: 55314
---
## Problem / Motivation

The search results dropdown in `GlobalSearch.tsx` uses `left-0 right-0` positioning, which locks its width to the parent container (`max-w-[380px]`, flex-shrinking further when the header is crowded with other elements). This makes the results panel feel cramped and narrow. Since the panel is already an absolute overlay (`z-20`), there's no layout reason for it to be constrained to the input bar's width.

## Implementation Plan

1. In `portal/src/components/GlobalSearch.tsx`, line 78: change the results dropdown from `left-0 right-0` to `left-0 min-w-full min-w-[520px]` — or more simply, replace `right-0` with `w-max max-w-[600px]`.
   - Recommended: `left-0 w-max min-w-full max-w-[600px]` — dropdown is at least as wide as the input bar, grows to content, caps at 600px.
2. No other files need changes. This is a pure CSS class tweak.
3. Validate visually: open search with a crowded header and confirm results are readable at full width.
