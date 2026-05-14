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

1.  Read the full ticket history.
    
2.  Review the relevant docs so the scope and touchpoints are grounded before code changes. Start with `.docs/`, then `README.md`, then the workflow asset templates if the change touches agent behavior.
    
3.  If the ticket is in `Grooming`, turn the ticket body into a concrete plan before coding. Tighten the summary and requirements, capture likely touchpoints, note the intended validation shape, review the applicable ticket metadata, and fill any metadata that can already be inferred from the current ticket context. Applicable fields can include `priority`, `effort`, `tags`, hierarchy links, and related-ticket references when those are relevant to the work.
    
4.  If one of those implementation-critical choices or applicable metadata values is unresolved, move the ticket to `Require Input` and record the question in history instead of silently picking a direction. Include the proposed fill values in that question. Route the answer back to `Grooming` if more planning is needed or to `Todo` when the plan is clarified.
    
5.  Read the smallest nearby implementation surface once the ticket is concrete enough to support a specific change.
    
6.  Add a short plan comment when transitioning from grooming into implementation.
    
7.  Move the ticket to `Todo` when grooming is complete. **CRITICAL: You MUST NOT begin implementation or move the ticket to `In Progress` during the Grooming session. Once the ticket is moved to `Todo`, you must stop, end your execution, and wait for the user to explicitly start the implementation phase.**
    
8.  Make focused changes and run a narrow validation as soon as the first real edit lands.
    
9.  If blocked on a ticket-specific question during implementation, move the ticket to `Require Input` and record the question in history.
    
10.  When implementation is ready for human review, move the ticket to `Ready`.
    
11.  Before moving to `Ready` or `Done`, refresh any docs whose described behavior, workflow, or touchpoints changed.
    
12.  When the user says `finish <ticket>`, perform the final commit and close-out sequence, then move the ticket to `Done`.
     

## Documentation touchpoints

-   Workflow changes usually require updates to `.docs/`, the root README, and the workflow asset templates in `.flux/skills/`.
    
-   Product behavior changes should update the nearest durable doc instead of relying on ticket history alone.
    
-   If no existing doc should change, make that a deliberate conclusion rather than an assumption.

## Related docs

-   [[Project Overview]]
    
-   [[Ticket Model]]
    
-   [[Ticket Interactions]]
    
-   [[Workflow Install]]
