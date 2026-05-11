---
assignee: unassigned
tags:
  - agent-workflow
  - workflow
  - skills
priority: Medium
effort: S
implementationLink: ''
subtasks: []
history:
  - type: activity
    user: Guy
    date: '2026-05-11T05:00:43.543Z'
    comment: Created ticket.
  - type: activity
    user: Agent
    date: '2026-05-11T05:00:47.953Z'
    comment: Launched Claude Code session (12c50388).
  - type: activity
    user: Agent
    date: '2026-05-11T05:00:53.395Z'
    comment: Claude Code session lost (engine restarted).
  - type: status_change
    from: Grooming
    to: Require Input
    user: Agent
    date: '2026-05-11T05:02:00.485Z'
  - type: activity
    user: Agent
    date: '2026-05-11T05:02:00.485Z'
    comment: >-
      Updated tags to agent-workflow, workflow, skills. Changed priority from
      None to Medium. Changed effort from None to S.
  - type: comment
    user: Agent
    date: '2026-05-11T05:02:00.485Z'
    comment: >-
      Grooming this ticket. Before writing the implementation plan, I need to
      understand which approach you want:


      **A) Mandatory gate** — grooming always pauses after initial discovery and
      asks the user a structured direction question before writing any plan.
      Every ticket gets a user-input gate. Maximum control, more friction.


      **B) Broader trigger criteria** — grooming still only asks when it
      discovers genuine choices, but the bar is much lower: any alternative
      approach, scope ambiguity, acceptance-criteria gap, or architectural
      tradeoff triggers a question instead of silently picking. Less friction
      than A, significantly more thorough than current behaviour.


      Which approach would you prefer? (Default proposed: B)
    id: c-2026-05-11t05-02-00-485z
  - type: agent_message
    user: Claude Code
    date: '2026-05-11T05:02:03.876Z'
    comment: >-
      FLUX-206 is now in `Require Input`. Before I write the implementation
      plan, I need your direction:


      **A) Mandatory gate** — grooming always pauses after initial discovery and
      posts a structured direction question before writing any plan. Every
      ticket gets a user-input gate regardless of whether choices were found.


      **B) Broader trigger criteria** — grooming only asks when it discovers
      actual choices, but the bar is much lower than today: any alternative
      implementation approach, scope boundary ambiguity, acceptance-criteria
      gap, or architectural tradeoff triggers a question instead of silently
      picking a direction.


      Which would you like? (My default proposal: **B**)
  - type: comment
    user: Guy
    date: '2026-05-11T05:02:45.360Z'
    comment: B
    replyTo: c-2026-05-11t05-02-00-485z
    id: c-2026-05-11t05-02-45-355z
  - type: status_change
    from: Require Input
    to: Grooming
    user: Guy
    date: '2026-05-11T05:02:45.360Z'
    comment: Response submitted
  - type: activity
    user: Agent
    date: '2026-05-11T05:02:49.598Z'
    comment: Launched Claude Code session (de54840b).
  - type: activity
    user: Agent
    date: '2026-05-11T05:03:53.338Z'
    comment: Updated description.
  - type: status_change
    from: Grooming
    to: Todo
    user: Agent
    date: '2026-05-11T05:04:14.284Z'
  - type: comment
    user: Agent
    date: '2026-05-11T05:04:14.285Z'
    comment: >-
      Grooming complete. Both skill files updated with broader trigger criteria
      for requireInput: alternative approaches, scope ambiguity,
      acceptance-criteria gaps, architectural tradeoffs, and unresolved
      metadata. New explicit scan step added before plan writing. HARD GATE
      wording preserved. Changes applied to
      .docs/skills/event-horizon-grooming.md and .claude/rules/event-horizon.md.
    id: c-2026-05-11t05-04-14-285z
  - type: activity
    user: Agent
    date: '2026-05-11T05:04:16.939Z'
    comment: Claude Code session ended with code 0.
  - type: status_change
    from: Todo
    to: Ready
    user: Guy
    date: '2026-05-11T05:05:12.548Z'
  - type: activity
    user: Agent
    date: '2026-05-11T05:05:19.242Z'
    comment: Launched Claude Code session (4a865830).
  - type: status_change
    from: Ready
    to: Done
    user: Agent
    date: '2026-05-11T05:06:04.897Z'
  - type: comment
    user: Agent
    date: '2026-05-11T05:06:04.898Z'
    comment: >-
      Shipped in commit 3ebe97a. Updated grooming step 5 in
      .docs/skills/event-horizon-grooming.md (and the in-process
      .claude/rules/event-horizon.md copy) to broaden the requireInput trigger:
      active scan for alternative approaches, scope ambiguity,
      acceptance-criteria gaps, architectural tradeoffs, and unresolved metadata
      — all now trigger a user question before the plan is written. HARD GATE
      wording preserved.
    id: c-2026-05-11t05-06-04-898z
  - type: agent_message
    user: Claude Code
    date: '2026-05-11T05:06:10.929Z'
    comment: >-
      FLUX-206 is done. Commit `3ebe97a` ships the broader grooming trigger
      criteria to `.docs/skills/event-horizon-grooming.md`, ticket closed.
  - type: activity
    user: Agent
    date: '2026-05-11T05:20:31.512Z'
    comment: Claude Code session lost (engine restarted).
title: grooming almost never asks for user input
status: Done
createdBy: Guy
updatedBy: Agent
tokenMetadata:
  inputTokens: 254652
  outputTokens: 4743
  costUSD: 0.229416
  costIsEstimated: false
order: 0
---
## Implementation Plan

**User decision (approach B):** Broaden trigger criteria — grooming still only asks when it discovers genuine choices, but the bar is much lower than today. Any alternative approach, scope ambiguity, acceptance-criteria gap, or architectural tradeoff triggers a `requireInput` question instead of silently picking a direction.

### Scope

Update the grooming skill (step 5) in both:
- `.docs/skills/event-horizon-grooming.md`
- `.claude/rules/event-horizon.md` (the `event-horizon-grooming` skill module)

No code changes. This is purely a skill/workflow text update.

### Changes to Step 5

Replace the current narrow trigger (`implementation-critical choices or applicable metadata values are unresolved`) with a broader explicit trigger list:

- **Alternative approaches** — two or more plausible implementation paths with meaningfully different tradeoffs
- **Scope ambiguity** — the ticket could be interpreted to include or exclude certain work
- **Acceptance-criteria gap** — unclear what done looks like or how the result will be verified
- **Architectural tradeoff** — the work touches existing patterns in a way that allows multiple valid designs
- **Unresolved metadata** — priority, effort, tags or assignee not clearly inferable without user input

Also insert a new explicit step before the plan-writing step: **actively scan for these trigger conditions** before writing the plan, and if any are found, ask first.

### Validation

- Both files updated and in sync
- The HARD GATE note about `requireInput` + history comment atomicity is preserved
- Ticket moved to `Todo`
