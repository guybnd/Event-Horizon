---
assignee: unassigned
tags:
  - workflow
  - agent
priority: High
effort: M
implementationLink: 'aa978f8d791b9326d7070abb82bb1aa97e31afd1'
subtasks: []
history:
  - type: activity
    user: Guy
    date: '2026-05-07T06:27:33.885Z'
    comment: Created ticket.
  - type: activity
    user: GitHub Copilot
    date: '2026-05-07T06:30:00.000Z'
    comment: Started work on ticket. Moving docs to clarify atomic commit flow on finish.
  - type: status_change
    from: Todo
    to: In Progress
    user: GitHub Copilot
    date: '2026-05-07T06:35:00.000Z'
  - type: activity
    user: GitHub Copilot
    date: '2026-05-07T06:40:00.000Z'
    comment: Completed documentation updates for the ticket finishing workflow. Skipping backfill mechanism for this ticket as recommended in the notes. Marking as Ready for review.
  - type: status_change
    from: In Progress
    to: Ready
    user: GitHub Copilot
    date: '2026-05-07T06:40:01.000Z'
  - type: activity
    user: GitHub Copilot
    date: '2026-05-07T06:45:00.000Z'
    comment: Finalizing ticket. Commits were created and backfill logic split to ticket FLUX-71.
  - type: status_change
    from: Ready
    to: Done
    user: GitHub Copilot
    date: '2026-05-07T06:45:01.000Z'
id: FLUX-70
title: Improve ticket finishing flow instructions
status: Done
createdBy: Guy
updatedBy: GitHub Copilot
---
## Summary

Clarify and enforce the ticket finishing lifecycle in both agent skill docs and
copilot instructions so agents never try to create a commit *before* the user
confirms finalization. The current flow tries to get a commit reference before
moving to Done, which creates a chicken-and-egg problem. The corrected flow
should be: agent moves ticket to Ready → user reviews → user confirms → agent
commits all relevant files and moves to Done in one atomic step.

Additionally, add a separate backfill mechanism that retroactively fills the
`implementationLink` field on tickets that were completed without one.

## Requirements

### 1. Clarify the finishing lifecycle in agent instructions
- Agent completes implementation and moves ticket to `Ready` with a review prompt comment
- Agent does NOT create a commit at this point — work stays uncommitted or on a working branch
- User reviews or tests the work (manually or via automation)
- User confirms to the agent that the Ready ticket is good to finalize (e.g. `finish FLUX-70`)
- Only upon user confirmation does the agent: stage all files relevant to the ticket, create one focused commit, record the commit hash in `implementationLink`, and move the ticket to `Done`
- The commit and the status transition to Done happen together as one atomic step

### 2. Update agent skill document
- Revise `.flux/skills/event-horizon-agent.md` sections on Ready status handling (lines 83-87) and commit guidance (lines 99-108) to make the no-commit-before-confirmation rule explicit
- Ensure the `finish <ticket>` flow description matches: stage → commit → set implementationLink → move to Done
- Remove any language that implies a commit should exist before the user confirms finalization

### 3. Update copilot instructions
- Revise `.flux/skills/event-horizon-copilot-instructions.md` rules 10-13 to match the same corrected flow
- Make clear that `finish <ticket>` is the trigger for both the commit and the Done transition

### 4. Add commit backfill mechanism (separate concern)
- Create a skill, command, or engine endpoint that scans Done tickets with empty `implementationLink`
- For each, search recent git log for commits mentioning the ticket ID
- If a matching commit is found, populate `implementationLink` with the commit hash
- This should be runnable on-demand (e.g. `backfill commits` command or a scheduled agent task)
- Should not modify tickets that already have an `implementationLink` value

## Acceptance Criteria

- [ ] Agent skill doc explicitly states: no commit before user confirms finalization
- [ ] Agent skill doc describes the atomic finish flow: stage → commit → implementationLink → Done
- [ ] Copilot instructions match the same corrected flow
- [ ] The `finish <ticket>` command triggers commit creation, not just status change
- [ ] A backfill mechanism exists to retroactively fill `implementationLink` on old Done tickets
- [ ] Backfill does not overwrite existing `implementationLink` values

## Likely Affected Areas

- `.flux/skills/event-horizon-agent.md`
- `.flux/skills/event-horizon-copilot-instructions.md`
- `engine/src/index.ts` (if adding a backfill endpoint)
- `.flux/skills/` (if adding a backfill skill)

## Dependencies

- None — this is a workflow documentation fix that can land independently

## Notes

- The backfill mechanism (requirement 4) could be split into its own ticket if this one feels too broad. The doc fixes (requirements 1-3) are the critical path.
- The current agent instructions at lines 83-87 and 96 of the agent skill already describe the Ready→finish→Done flow conceptually, but the commit guidance contradicts it by implying commits happen before finalization

## Original Request
we need to make it clear to agent, then when he thinks task is finished he moves it to ready.
only once user tells agent its confirmed to finish task does he collect the commit together and does it as he simultaneously moves the ticket to done
i.e
agent moves ticket to ready and prompts user review
user reviews or tests (by automation or manually)
user confirms to agent that ready ticket is good to finalize
finalization moves the ticket to done and creates a commit with all the files relevant to the ticket

we can maybe separately have a command or a skill that goes over tickets with no commit line filled in them and goes through recent commits and fills it out (as the current flow attempts to get a commit number before finalizing which is causing all this mess)
