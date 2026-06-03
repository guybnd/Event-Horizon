---
priority: Medium
effort: M
tags:
  - research
  - multi-agent
  - agent-workflow
assignee: unassigned
id: FLUX-354
title: 'Strategy: research integrating an existing orchestration layer'
status: Grooming
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
    status: cancelled
    progress: []
    user: Claude Code
    date: '2026-06-03T04:51:48.276Z'
    outcome: Session abandoned (engine restarted).
    endedAt: '2026-06-03T04:51:53.762Z'
---
## Problem

Orchestration features (relay / scatter-gather / supervisor patterns in `agents/types.ts`, `WorkflowBuilder.tsx` at ~1k lines) bring real cohesion to Event Horizon, and we want to keep that direction. But building a full orchestration runtime in-house is a different product. There may be an existing tool we can integrate with — Event Horizon owns the ticket layer and triggers orchestration, the other tool runs the multi-agent pattern.

## Plan

- Survey current options: LangGraph, CrewAI, AutoGen, Temporal-based agent frameworks, OpenAI Swarm successor, Anthropic's MCP orchestration patterns, Claude Code subagents/skills.
- Score each on: local-first compatible, runs CLI agents (not just LLM APIs), MCP-native, extensibility, license.
- Decide: (a) keep building in-house, (b) integrate one tool as the runtime, (c) hybrid (our patterns wrap their primitives).
- Output: ADR with recommendation and an integration sketch.
- This is a research ticket — no production code changes.
