---
title: Ticket Lifecycle
order: 1
---
# Ticket Lifecycle

Event Horizon treats the ticket file as the canonical workflow record. Chat can coordinate the work, but the durable state is stored on the ticket.

## Status model

-   `Grooming`: clarify the request, shape it into a concrete plan, and capture any implementation choices that still need user input before coding.
    
-   `Todo`: queued, groomed work whose implementation details are sufficiently clarified to be picked up without rediscovery.
    
-   `In Progress`: active implementation.
    
-   `Require Input`: ticket-specific question is waiting on the user.
    
-   `Ready`: implementation is complete enough for user review and finalization.
    
-   `Done`: completion comment recorded, validation captured, and the ticket fully closed.
    

## Expected execution flow

Each step below is paired with the MCP tool that carries it out. The full tool reference is at [[MCP Tools]].

1.  Read the full ticket history (`get_ticket`).

2.  Review the relevant docs so the scope and touchpoints are grounded before code changes. Start with `.docs/`, then `README.md`, then the workflow asset templates if the change touches agent behavior.

3.  If the ticket is in `Grooming`, turn the ticket body into a concrete plan before coding (`update_ticket` for the body and metadata). Tighten the summary and requirements, capture likely touchpoints, note the intended validation shape, review the applicable ticket metadata, and fill any metadata that can already be inferred from the current ticket context. Applicable fields can include `priority`, `effort`, `tags`, hierarchy links, and related-ticket references when those are relevant to the work.

4.  If one of those implementation-critical choices or applicable metadata values is unresolved, move the ticket to `Require Input` (`change_status` with the question as `comment`) instead of silently picking a direction. Include the proposed fill values in that question. Route the answer back to `Grooming` if more planning is needed or to `Todo` when the plan is clarified.

5.  Read the smallest nearby implementation surface once the ticket is concrete enough to support a specific change.

6.  Add a short plan comment when transitioning from grooming into implementation (`add_comment`).

7.  Move the ticket to `Todo` when grooming is complete (`change_status`). **CRITICAL: You MUST NOT begin implementation or move the ticket to `In Progress` during the Grooming session. Once the ticket is moved to `Todo`, you must stop, end your execution, and wait for the user to explicitly start the implementation phase.**

8.  Move to `In Progress` (`change_status`) before the first substantive code change. Make focused changes and run a narrow validation as soon as the first real edit lands. Use `log_progress` when scope shifts, validation fails, or the user redirects.

9.  If blocked on a ticket-specific question during implementation, move the ticket to `Require Input` (`change_status` with the question as `comment`).

10.  When implementation is ready for human review, move the ticket to `Ready` (`change_status` with a completion summary as `comment`).

11.  **Before moving to `Ready` or `Done`, refresh any docs whose described behavior, workflow, or touchpoints changed.** This is part of the work, not a follow-up. See [Documentation touchpoints](#documentation-touchpoints) below for what to check. If you decide nothing needs updating, make that a deliberate conclusion in the completion comment.

12.  When the user says `finish <ticket>`, perform the final commit and close-out sequence with `finish_ticket` (sets `implementationLink`, appends the completion comment, and moves status to `Done` atomically).

13.  If the work needs to spawn child tickets, use `create_subtask` rather than `create_ticket` + manual linking \u2014 it wires the parent's `subtasks` array atomically.


## Documentation touchpoints

Treat docs as part of the deliverable, not a follow-up ticket. Check these before flipping to `Ready` or `Done`:

-   **Reference pages** under `.docs/event-horizon/reference/` describe how code actually behaves today (ticket schema, MCP tools, REST API, realtime channels, agent adapter contract). If you changed any of that behavior, the matching reference page MUST be updated in the same ticket. Drift here breaks future agents.

-   **`architecture/code-map.md`** is the orientation guide for which file owns what. Add or update entries when you introduce a new module that future agents should land on first.

-   **`agent-integrations.md`** and the framework-specific guidance when you change how agents are launched, prompted, or tracked.

-   **`workflow/*.md`** when you change the lifecycle, statuses, or installer behavior.

-   **Root `README.md`** and the workflow asset templates in `.flux/skills/` when user-facing or agent-facing behavior changes.

-   If no existing doc should change, say so explicitly in the completion comment rather than skipping the check silently.

## Related docs

-   [[Project Overview]]
    
-   [[Ticket Model]]
    
-   [[Ticket Interactions]]
    
-   [[Workflow Install]]
