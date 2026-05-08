---
id: FLUX-113
title: Spike - Brainstorm a mode of work decoupled from the repo
status: Todo
createdBy: Guy
updatedBy: Guy
assignee: unassigned
tags:
  - architecture
  - research
priority: Low
effort: M
implementationLink: ''
subtasks: []
history:
  - type: activity
    user: Guy
    date: '2026-05-08T00:26:07.123Z'
    comment: Created ticket.
---

## Summary
Currently, Event Horizon tickets are stored directly in the repository as Markdown/YAML files. This creates "git spam" and pollutes commit history with project management updates. We need to investigate alternative storage architectures that decouple the task engine from the application repository.

## Requirements

### 1. Research Alternative Storage Models
- Investigate a global `.flux` directory in the user's home folder.
- Consider a SQLite database or a centralized server backend.
- Evaluate the tradeoffs: ease of setup vs. git pollution vs. collaboration friction.

### 2. Propose a Decoupled Workflow
- Write a short research document or proposal outlining how Event Horizon could work without storing files in the local git repository.
- Detail how this impacts the agent's ability to read and modify tickets.

## Acceptance Criteria
- [ ] A research document or artifact is produced comparing storage options.
- [ ] A recommendation is made for the next iteration of the Event Horizon architecture to solve the git spam issue.

## Likely Affected Areas
- Documentation/Architecture plans.

## Notes
- This is purely an exploratory spike. No code changes are expected in this ticket.

## Original Request
consider and brainstorm a mode of work that is decoupled from the repo
is this better workflow to avoid git spam? how would this be possible? lets think it through
