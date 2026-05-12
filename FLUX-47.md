---
id: FLUX-47
title: document implemented features and fold docs into ticket workflow
status: Released
priority: High
createdBy: Guy
updatedBy: Agent
assignee: Agent
tags:
  - docs
  - task
history:
  - type: comment
    user: Agent
    date: '2026-05-07T11:04:22.6881555+10:00'
    comment: >-
      Captured from the request to start proper project documentation by
      harvesting completed ticket work into the docs set, and to update both the
      Event Horizon skill and Copilot instructions so agents review relevant
      docs when grooming a task and refresh docs before marking work ready for
      review or done.
    id: c-2026-05-07t11-04-22-6881555-10-00
  - type: comment
    user: Agent
    date: '2026-05-07T11:07:34.3763085+10:00'
    comment: >-
      Plan: turn the placeholder docs surface into durable project docs using
      the shipped workflow, docs, and installer tickets as the source of truth;
      then update the skill and Copilot instructions so task grooming starts
      with doc review and near-completion includes doc refresh checks; finally
      reinstall the workflow assets and run focused validation.
    id: c-2026-05-07t11-07-34-3763085-10-00
  - type: status_change
    from: Grooming
    to: In Progress
    user: Agent
    date: '2026-05-07T11:07:34.3763085+10:00'
  - type: comment
    user: Agent
    date: '2026-05-07T11:12:48.9513605+10:00'
    comment: >-
      Added a real `.docs/` project documentation set covering architecture,
      repository touchpoints, ticket lifecycle, and workflow installation;
      updated the source skill and always-on Copilot instructions so agents
      review docs during grooming or task start-up and refresh docs before
      moving work to `Ready` or `Done`; refreshed the installed workspace copies
      through the installer and updated the README to point at the docs surface.
      Validated with a live `GET /api/docs` check confirming the new docs tree,
      `npm.cmd run install-skill -- --target c:\GitHub\EventHorizon --framework
      copilot`, and spot checks of the installed `.github` workflow files.
      Commit: `0140d15` (`Document workflow touchpoints and doc update rules`).
    id: c-2026-05-07t11-12-48-9513605-10-00
  - type: status_change
    from: In Progress
    to: Ready
    user: Agent
    date: '2026-05-07T11:12:48.9513605+10:00'
  - type: comment
    user: Agent
    date: '2026-05-07T11:34:54.8016874+10:00'
    comment: >-
      Finalizing FLUX-47 after the explicit `finish FLUX-47` handoff. No
      additional product changes were needed beyond closing the ticket; the
      shipped implementation remains the documentation and workflow update
      recorded in commit `0140d15` (`Document workflow touchpoints and doc
      update rules`). Revalidated by checking that FLUX-47 still parses through
      the live task API after the final status transition.
    id: c-2026-05-07t11-34-54-8016874-10-00
  - type: status_change
    from: Ready
    to: Done
    user: Agent
    date: '2026-05-07T11:34:54.8016874+10:00'
  - type: status_change
    from: Done
    to: Released
    user: Agent
    date: '2026-05-07T13:54:26.948Z'
effort: M
implementationLink: 0140d15
subtasks: []
version: v0.1.0
releasedAt: '2026-05-07T13:54:26.948Z'
releaseDocPath: release-notes/v0.1.0
---
## Summary

Build out the project's documentation from completed ticket work and tighten
the workflow guidance so documentation is part of normal ticket execution.

## Requirements

### 1. Expand project documentation from shipped work
- Review the most relevant completed tickets and extract durable project
  behavior, architecture, and workflow details into the repo docs surface
- Replace placeholder docs with useful pages that help future work start from
  existing system knowledge instead of rediscovery

### 2. Make docs review part of ticket grooming
- Update the Event Horizon workflow guidance so agents read the relevant docs
  during grooming or early task routing to understand scope and touchpoints
- Keep that guidance concrete enough that agents know which doc sources to
  inspect before making changes

### 3. Make docs updates part of ticket close-out
- Update the Event Horizon workflow guidance so agents review whether relevant
  docs should be refreshed when work is nearing completion
- Ensure the near-completion guidance covers both the workspace skill and the
  always-on Copilot instructions template

## Acceptance Criteria

- [x] `.docs/` contains useful project documentation derived from implemented work
- [x] The workflow skill tells agents to review docs when grooming or starting work
- [x] The workflow skill tells agents to update relevant docs before close-out
- [x] The Copilot instructions carry the same documentation expectations
- [x] The updated workflow assets can still be installed into the workspace cleanly

## Likely Affected Areas

- `.docs/`
- `README.md`
- `.flux/skills/event-horizon-agent.md`
- `.flux/skills/event-horizon-copilot-instructions.md`
- `.github/skills/event-horizon/SKILL.md`
- `.github/copilot-instructions.md`

## Dependencies

- Builds on completed workflow and installer work from FLUX-8, FLUX-43, and FLUX-44
- Uses shipped docs support from FLUX-5 as the main in-product documentation surface
