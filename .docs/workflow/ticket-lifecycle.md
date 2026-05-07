---
title: Ticket Lifecycle
order: 1
---
# Ticket Lifecycle

Event Horizon treats the ticket file as the canonical workflow record. Chat can coordinate the work, but the durable state is stored on the ticket.

## Status model

-   `Grooming`: clarify the request, scope the work, and capture the likely touchpoints before implementation.
    
-   `Todo`: queued, understood work that is ready to be picked up.
    
-   `In Progress`: active implementation.
    
-   `Require Input`: ticket-specific question is waiting on the user.
    
-   `Ready`: implementation is complete enough for user review and finalization.
    
-   `Done`: completion comment recorded, validation captured, and the ticket fully closed.
    

## Expected execution flow

1.  Read the full ticket history.
    
2.  Review the relevant docs so the scope and touchpoints are grounded before code changes. Start with `.docs/`, then `README.md`, then the workflow asset templates if the change touches agent behavior.
    
3.  Read the smallest nearby implementation surface.
    
4.  Add a short plan comment.
    
5.  Move the ticket to `In Progress` before substantive edits.
    
6.  Make focused changes and run a narrow validation as soon as the first real edit lands.
    
7.  If blocked on a ticket-specific question, move the ticket to `Require Input` and record the question in history.
    
8.  When implementation is ready for human review, move the ticket to `Ready`.
    
9.  Before moving to `Ready` or `Done`, refresh any docs whose described behavior, workflow, or touchpoints changed.
    
10.  When the user says `finish <ticket>`, perform the final commit and close-out sequence, then move the ticket to `Done`.
     

## Documentation touchpoints

-   Workflow changes usually require updates to `.docs/`, the root README, and the workflow asset templates in `.flux/skills/`.
    
-   Product behavior changes should update the nearest durable doc instead of relying on ticket history alone.
    
-   If no existing doc should change, make that a deliberate conclusion rather than an assumption.

## Related docs

-   [[Project Overview]]
    
-   [[Ticket Model]]
    
-   [[Ticket Interactions]]
    
-   [[Workflow Install]]
