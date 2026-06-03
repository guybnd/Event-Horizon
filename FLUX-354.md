---
priority: Medium
effort: M
tags:
  - research
  - multi-agent
  - agent-workflow
  - architecture
assignee: unassigned
id: FLUX-354
title: 'Strategy: research integrating an existing orchestration layer'
status: Todo
createdBy: Agent
updatedBy: Agent
history:
  - type: activity
    user: Agent
    date: '2026-06-03T03:50:35.752Z'
    comment: Created ticket.
  - type: agent_session
    sessionId: 5961fc44-50ec-45ea-948f-d6d0d11dc2b5
    startedAt: '2026-06-03T04:51:48.276Z'
    status: completed
    progress:
      - timestamp: '2026-06-03T04:51:57.621Z'
        message: Working
        type: tool
        data:
          toolName: ToolSearch
          parameters:
            query: >-
              select:mcp__event-horizon__get_ticket,mcp__event-horizon__update_ticket,mcp__event-horizon__change_status,mcp__event-horizon__get_board_config
            max_results: 5
      - timestamp: '2026-06-03T04:52:00.398Z'
        message: Working
        type: tool
        data:
          toolName: mcp__event-horizon__get_ticket
          parameters:
            ticketId: FLUX-354
      - timestamp: '2026-06-03T04:52:03.321Z'
        message: Working
        type: info
      - timestamp: '2026-06-03T04:52:32.752Z'
        message: Working
        type: tool
        data:
          toolName: mcp__event-horizon__update_ticket
          parameters:
            ticketId: FLUX-354
            priority: Medium
            effort: M
            tags:
              - research
              - multi-agent
              - agent-workflow
              - architecture
            body: >
              ## Problem / Motivation


              Event Horizon's orchestration layer (relay / scatter-gather /
              supervisor patterns in `agents/types.ts`, `WorkflowBuilder.tsx`
              ~1k lines) adds genuine product value, and the direction is worth
              keeping. However, maintaining a full orchestration *runtime*
              in-house is a different product scope — one that competes with
              established frameworks. If a suitable external tool exists, Event
              Horizon can own the ticket layer and trigger orchestration, while
              the external tool handles the multi-agent execution graph. This
              ticket determines whether that trade-off is worthwhile and, if so,
              which tool best fits.


              ## Implementation Plan


              1. **Read current orchestration surface** — review
              `agents/types.ts` and `WorkflowBuilder.tsx` to catalog the
              patterns we actually use (relay, scatter-gather, supervisor) and
              the interfaces they expose. This anchors the evaluation criteria.


              2. **Survey candidates** — for each of the following, collect a
              one-paragraph profile (what it does, how agents are wired, how
              work is dispatched):
                 - LangGraph (LangChain graph runtime)
                 - CrewAI
                 - AutoGen / AG2
                 - Temporal-based agent frameworks (e.g. Inngest, Windmill)
                 - OpenAI Swarm / Swarm successor
                 - Anthropic MCP orchestration patterns + Claude Code subagents/skills (the current approach)

              3. **Score each candidate** against these criteria (pass / partial
              / fail):
                 - Local-first compatible (runs fully offline, no SaaS dependency)
                 - Runs CLI agents (not just LLM API calls — must support arbitrary subprocess or MCP tool agents)
                 - MCP-native or MCP-compatible
                 - Extensible (can add custom patterns without forking)
                 - License (permissive preferred; copyleft acceptable; proprietary is a flag)

              4. **Map fit to existing patterns** — for the top 1–2 scorers,
              sketch how relay, scatter-gather, and supervisor would be
              expressed using their primitives. Note what Event Horizon would
              still own vs. delegate.


              5. **Decide** — one of:
                 - (a) Keep building in-house — justify why no candidate clears the bar
                 - (b) Integrate one tool as the runtime — identify the adapter surface
                 - (c) Hybrid — our patterns wrap their primitives; identify the seam

              6. **Write ADR** — create `.docs/adr/orchestration-runtime.md`
              with: context, candidates evaluated, decision, consequences, and
              an integration sketch (for options b/c). No production code
              changes.
      - timestamp: '2026-06-03T04:52:33.323Z'
        message: Working
        type: info
      - timestamp: '2026-06-03T04:52:39.948Z'
        message: >-
          FLUX-354 is groomed and moved to **Todo**.


          Changes made:

          - Added `architecture` tag (this produces an ADR-level decision)

          - Rewrote body with a **Problem/Motivation** section and a 6-step
          **Implementation Plan** that:
            1. Anchors evaluation against the actual patterns we use in the codebase
            2. Surveys all named candidates with consistent criteria
            3. Scores each on local-first, CLI-agent, MCP-native, extensibility, and license
            4. Maps top scorers to existing relay/scatter-gather/supervisor patterns
            5. Forces a concrete 3-way decision
            6. Outputs an ADR to `.docs/adr/orchestration-runtime.md`

          No code changes — pure research ticket. Ready to implement.
    user: Claude Code
    date: '2026-06-03T04:51:48.276Z'
    outcome: Claude Code session ended with code 0.
    endedAt: '2026-06-03T04:52:39.948Z'
  - type: activity
    user: Agent
    date: '2026-06-03T04:52:32.790Z'
    comment: Updated description. Updated tags.
  - type: status_change
    from: Grooming
    to: Todo
    user: Agent
    date: '2026-06-03T04:52:34.880Z'
tokenMetadata:
  inputTokens: 155551
  outputTokens: 2009
  costUSD: 0.119675
  costIsEstimated: false
  cacheReadTokens: 143379
  cacheCreationTokens: 12161
---
## Problem / Motivation

Event Horizon's orchestration layer (relay / scatter-gather / supervisor patterns in `agents/types.ts`, `WorkflowBuilder.tsx` ~1k lines) adds genuine product value, and the direction is worth keeping. However, maintaining a full orchestration *runtime* in-house is a different product scope — one that competes with established frameworks. If a suitable external tool exists, Event Horizon can own the ticket layer and trigger orchestration, while the external tool handles the multi-agent execution graph. This ticket determines whether that trade-off is worthwhile and, if so, which tool best fits.

## Implementation Plan

1. **Read current orchestration surface** — review `agents/types.ts` and `WorkflowBuilder.tsx` to catalog the patterns we actually use (relay, scatter-gather, supervisor) and the interfaces they expose. This anchors the evaluation criteria.

2. **Survey candidates** — for each of the following, collect a one-paragraph profile (what it does, how agents are wired, how work is dispatched):
   - LangGraph (LangChain graph runtime)
   - CrewAI
   - AutoGen / AG2
   - Temporal-based agent frameworks (e.g. Inngest, Windmill)
   - OpenAI Swarm / Swarm successor
   - Anthropic MCP orchestration patterns + Claude Code subagents/skills (the current approach)

3. **Score each candidate** against these criteria (pass / partial / fail):
   - Local-first compatible (runs fully offline, no SaaS dependency)
   - Runs CLI agents (not just LLM API calls — must support arbitrary subprocess or MCP tool agents)
   - MCP-native or MCP-compatible
   - Extensible (can add custom patterns without forking)
   - License (permissive preferred; copyleft acceptable; proprietary is a flag)

4. **Map fit to existing patterns** — for the top 1–2 scorers, sketch how relay, scatter-gather, and supervisor would be expressed using their primitives. Note what Event Horizon would still own vs. delegate.

5. **Decide** — one of:
   - (a) Keep building in-house — justify why no candidate clears the bar
   - (b) Integrate one tool as the runtime — identify the adapter surface
   - (c) Hybrid — our patterns wrap their primitives; identify the seam

6. **Write ADR** — create `.docs/adr/orchestration-runtime.md` with: context, candidates evaluated, decision, consequences, and an integration sketch (for options b/c). No production code changes.
