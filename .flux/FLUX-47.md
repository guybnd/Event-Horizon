---
id: FLUX-47
title: document implemented features and fold docs into ticket workflow
status: In Progress
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
      harvesting completed ticket work into the docs set, and to update both
      the Event Horizon skill and Copilot instructions so agents review
      relevant docs when grooming a task and refresh docs before marking work
      ready for review or done.
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
effort: M
implementationLink: ''
subtasks: []
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

- [ ] `.docs/` contains useful project documentation derived from implemented work
- [ ] The workflow skill tells agents to review docs when grooming or starting work
- [ ] The workflow skill tells agents to update relevant docs before close-out
- [ ] The Copilot instructions carry the same documentation expectations
- [ ] The updated workflow assets can still be installed into the workspace cleanly

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