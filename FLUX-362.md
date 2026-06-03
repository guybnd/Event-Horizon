---
assignee: unassigned
tags:
  - ui
  - portal
priority: Low
effort: XS
implementationLink: ''
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
id: FLUX-362
title: Search results panel width constrained by search bar container
status: Todo
createdBy: Guy
updatedBy: Agent
tokenMetadata:
  inputTokens: 180019
  outputTokens: 1877
  costUSD: 0.193101
  costIsEstimated: false
  cacheReadTokens: 148063
  cacheCreationTokens: 31946
---
## Problem / Motivation

The search results dropdown in `GlobalSearch.tsx` uses `left-0 right-0` positioning, which locks its width to the parent container (`max-w-[380px]`, flex-shrinking further when the header is crowded with other elements). This makes the results panel feel cramped and narrow. Since the panel is already an absolute overlay (`z-20`), there's no layout reason for it to be constrained to the input bar's width.

## Implementation Plan

1. In `portal/src/components/GlobalSearch.tsx`, line 78: change the results dropdown from `left-0 right-0` to `left-0 min-w-full min-w-[520px]` — or more simply, replace `right-0` with `w-max max-w-[600px]`.
   - Recommended: `left-0 w-max min-w-full max-w-[600px]` — dropdown is at least as wide as the input bar, grows to content, caps at 600px.
2. No other files need changes. This is a pure CSS class tweak.
3. Validate visually: open search with a crowded header and confirm results are readable at full width.
