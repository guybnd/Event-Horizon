---
id: FLUX-55
title: require clarification of implementation details during grooming
status: Done
priority: High
createdBy: Guy
updatedBy: Agent
assignee: Agent
tags:
  - docs
  - task
history:
  - type: activity
    user: Guy
    date: '2026-05-07T12:21:48.0764879+10:00'
    comment: Created ticket.
  - type: comment
    user: Agent
    date: '2026-05-07T12:22:05.5385028+10:00'
    comment: >-
      Plan: make Grooming an explicit planning phase that produces a structured
      ticket description and surfaces unresolved implementation choices through
      the ticket workflow before coding; then update the skill, always-on
      instructions, and lifecycle docs, refresh the installed workflow assets,
      and validate the ticket parsing plus installer output.
    id: c-2026-05-07t12-22-05-5385028-10-00
  - type: status_change
    from: Grooming
    to: In Progress
    user: Agent
    date: '2026-05-07T12:22:05.5385028+10:00'
  - type: comment
    user: Agent
    date: '2026-05-07T12:51:08.6819757+10:00'
    comment: >-
      Tightened the workflow so `Grooming` is explicitly a planning phase that
      must produce a concrete ticket plan and surface unresolved
      implementation-critical choices through `Require Input` before coding.
      Updated the lifecycle doc, README guidance, and the source workflow
      assets, then refreshed the installed `.github` copies with `npm.cmd run
      install-skill -- --target c:\GitHub\EventHorizon --framework copilot`.
      Validated by confirming the installed skill and Copilot instructions carry
      the new grooming rules and by checking the live task API still parses this
      ticket in its updated state.
    id: c-2026-05-07t12-51-08-6819757-10-00
  - type: status_change
    from: In Progress
    to: Ready
    user: Agent
    date: '2026-05-07T12:51:08.6819757+10:00'
  - type: comment
    user: Agent
    date: '2026-05-07T12:55:35.2876774+10:00'
    comment: >-
      Finalizing FLUX-55 after the explicit `finish FLUX-55` handoff. The
      shipped workflow change is in commit `c43c278` (`Enforce grooming
      clarification before implementation`), which updates the lifecycle docs,
      README guidance, source workflow templates, and refreshed installed
      workspace copies so grooming now requires a concrete plan plus
      user-confirmed implementation choices before coding. Revalidated by
      confirming the live task API still parses FLUX-55 after the close-out
      transition.
    id: c-2026-05-07t12-55-35-2876774-10-00
  - type: status_change
    from: Ready
    to: Done
    user: Agent
    date: '2026-05-07T12:55:35.2876774+10:00'
effort: S
implementationLink: c43c278
subtasks: []
---
## Summary

Tighten the Event Horizon workflow so tickets in `Grooming` stay in a real
planning and clarification phase instead of being treated as implied
implementation work.

## Requirements

### 1. Make grooming a distinct workflow stage
- Update the workflow guidance so `Grooming` means refining the ticket into a
  clear implementation plan rather than starting code immediately.
- Require grooming output to capture the plan, likely touchpoints, and any
  implementation choices that still need a decision.

### 2. Require user input on implementation-critical choices
- Update the workflow guidance so agents must surface unresolved
  implementation details to the user instead of silently choosing a direction
  when those decisions materially affect the solution.
- Route ticket-specific clarification through the ticket workflow so the
  question and answer stay attached to the ticket.

### 3. Clarify status transitions out of grooming
- Define when a ticket should remain in `Grooming`, when it should move to
  `Require Input`, when it should return to `Todo`, and when it is acceptable
  to move to `In Progress`.
- Refresh the installed workflow assets so the stricter guidance is active in
  the workspace, not only in the source templates.

## Acceptance Criteria

- [x] The workflow docs describe `Grooming` as a planning and clarification
  stage, not an implicit start of implementation
- [x] The skill and Copilot instructions require agents to capture open
  implementation questions and ask the user before coding when those
  choices are unresolved
- [x] The workflow guidance explains the intended path between `Grooming`,
  `Require Input`, `Todo`, and `In Progress`
- [x] The installed workflow assets are refreshed after the source updates

## Likely Affected Areas

- `.docs/workflow/ticket-lifecycle.md`
- `README.md`
- `.flux/skills/event-horizon-agent.md`
- `.flux/skills/event-horizon-copilot-instructions.md`
- `.github/skills/event-horizon/SKILL.md`
- `.github/copilot-instructions.md`