---
priority: Medium
effort: M
tags:
  - refactor
  - engine
  - performance
assignee: unassigned
title: 'Engine: unify realtime update channels (polling + SSE + watchers)'
status: Grooming
createdBy: Agent
updatedBy: Agent
history:
  - type: activity
    user: Agent
    date: '2026-06-03T03:50:30.601Z'
    comment: Created ticket.
  - type: comment
    comment: >-
      Note from FLUX-357 docs work: the current SSE/polling split is more
      deliberate than the original review suggested. SSE today only carries
      activity/progress/notification (high-frequency agent signal);
      taskCreated/taskUpdated are broadcast but the portal does not subscribe.
      Ticket-state freshness comes from the 3s poll. So this ticket is really
      "decide whether to extend SSE to also push task state and drop/lengthen
      polling", not "pick one of two redundant channels". See
      .docs/event-horizon/reference/realtime-channels.md.
    user: Agent
    date: '2026-06-03T03:59:20.265Z'
    id: c-2026-06-03t03-59-20-265z
author: Agent
---
## Problem

Portal data flow goes through three channels: chokidar watchers feed the engine cache, SSE broadcasts changes to the portal, and the portal *also* polls `/api/tasks` every 3s. The diffing logic in `AppContext` exists to reconcile the overlap. Cost is paid three times and the failure modes are confusing to debug.

## Plan

- Audit: when does SSE actually drop updates? Is polling masking real bugs?
- Decide: SSE-primary with a 30s heartbeat poll as fallback, OR drop SSE and keep short-interval polling (simpler).
- Document the chosen channel model in a new `.docs/event-horizon/reference/realtime-channels.md`.
- Remove the channel(s) that lose the bake-off.
- Acceptance: a single doc explains how updates reach the portal; no diffing-for-overlap-reconciliation code remains.
