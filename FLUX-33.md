---
title: Automatic Definition of Done Verification
status: Todo
priority: High
createdBy: Guy
updatedBy: Guy
assignee: unassigned
tags:
  - feature
  - validation
  - agent
history:
  - type: activity
    user: Guy
    date: '2026-05-06T12:06:00.000Z'
    comment: Created ticket.
  - type: comment
    user: Agent
    date: '2026-05-06T12:06:00.000Z'
    comment: >-
      Captured from Guy's request. This ticket introduces a secondary
      verification-only workflow that checks whether a task truly meets its
      definition of done before final closure.
    id: c-2026-05-06t12-06-00-000z
  - type: status_change
    from: Todo
    to: Grooming
    user: Guy
    date: '2026-05-06T12:52:25.028Z'
  - type: comment
    user: Agent
    date: '2026-05-07T13:01:33.5429940+10:00'
    comment: >-
      The main unresolved workflow choice is which state should trigger this
      verifier. Should validation run when a ticket enters the current `Ready`
      status, or do you want a separate dedicated review status such as `In
      Review` or `Sentry` added before this ticket moves to `Todo`?
    id: c-2026-05-07t13-01-33-5429940-10-00-flux-33
  - type: status_change
    from: Grooming
    to: Require Input
    user: Agent
    date: '2026-05-07T13:01:33.5429940+10:00'
  - type: comment
    user: Guy
    date: '2026-05-07T03:58:47.248Z'
    comment: >-
      i guess we need a review status between, so that review triggers testing
      results etc. when ready status we should already present user with the
      test results, docs that were added, etc. then user can launch that finish
      that branch or commit
    id: c-2026-05-07t03-58-47-248z
  - type: status_change
    from: Require Input
    to: Grooming
    user: Guy
    date: '2026-05-07T03:58:47.248Z'
    comment: Response submitted
  - type: comment
    user: Agent
    date: '2026-05-07T03:53:39.4816199Z'
    comment: >-
      Groomed this around the clarified workflow: a dedicated review status
      should trigger validation, and `Ready` should only be used after test
      results, docs updates, and review artifacts are already attached. This is
      now concrete enough for `Todo`.
    id: c-2026-05-07t03-53-39-4816199z-flux-33
  - type: status_change
    from: Grooming
    to: Todo
    user: Agent
    date: '2026-05-07T03:53:39.4816199Z'
effort: XL
implementationLink: ''
subtasks: []
order: 1
---
## Groomed Scope

Create a verification loop that runs when a ticket enters a dedicated review
status between implementation and `Ready`. This secondary process should not
edit product code; it should validate the primary agent's work and record the
result back into the ticket before the user sees the final `Ready` handoff.

## Requirements

### 1. Trigger a verification-only flow
- Add or formalize a dedicated review state such as `In Review` or `Sentry` before `Ready`
- Detect when a ticket transitions into that review state
- Launch a secondary verification process that is read-only with respect to source code
- Keep `Ready` reserved for the human-review step after validation artifacts are already present

### 2. Run concrete local validation
- Execute local test suites relevant to the repo, such as `npm test`, `npm run build`, or project-specific checks
- Capture pass/fail results, skipped checks, and environment limitations
- Scope validation to the ticket where possible instead of always running the broadest suite

### 3. Review the actual change set
- Analyze the diff between the active branch and `main` for the ticket's work
- Check whether the implementation matches the ticket requirements and acceptance criteria
- Flag missing validation, regressions, or obvious scope drift

### 4. Write back a verification report
- Post a `# Validation` section into the ticket body or equivalent visible surface
- Summarize checks performed, findings, and residual risks
- Record docs updates and validation artifacts so the later `Ready` state already contains review-ready context

## Acceptance Criteria

- [ ] Entering the dedicated review status triggers a verification-only workflow
- [ ] The verifier does not modify product code
- [ ] Local tests or builds are executed and reported when available
- [ ] The verifier analyzes the change diff for the ticket against `main`
- [ ] A `# Validation` report is added to the ticket with results, caveats, and review-ready context before `Ready`

## Likely Affected Areas

- `engine/src/index.ts`
- `portal/src/components/TaskModal.tsx`
- `portal/src/types.ts`
- `portal/src/components/Settings.tsx`
- Agent workflow or verification runner modules
- `.flux/skills/event-horizon-agent.md`
- `.flux/config.json`

## Notes

- This ticket likely depends on how review states are represented in config and UI
- The first version can focus on read-only verification and reporting, not auto-approval
