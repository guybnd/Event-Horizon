---
title: Decouple Event Horizon internal documentation from host project docs space
status: Done
createdBy: User
updatedBy: Guy
assignee: unassigned
tags:
  - architecture
  - documentation
priority: Medium
effort: M
implementationLink: 3fe4e57fffdb1c9e766db4dd4d0e0ae7e594a155
subtasks: []
history:
  - type: activity
    user: User
    date: '2026-05-07T09:45:00.000Z'
    comment: Created ticket.
  - type: activity
    user: Agent
    date: '2026-05-07T09:45:00.000Z'
    comment: >-
      Created grooming ticket based on user feedback regarding the `.docs/`
      structure conflict.
  - type: comment
    user: Guy
    date: '2026-05-07T10:40:58.407Z'
    comment: >-
      I think the event horizon docs should simply live ina event horizon folder
      inside the docs structure, that way everything is bundled cleanly in a
      single folder but still viewable and useable from the docs tool. user can
      then delete this folder if he so wishes
    id: c-2026-05-07t10-40-58-407z
order: 86
---
# Context
Event Horizon provides a repo-backed wiki feature that defaults to reading and writing from a top-level `.docs/` folder. This is intended to act as the *host project's* documentation space.

However, Event Horizon itself has its own project documentation (how the engine works, architectural overview, ticket lifecycle, etc.). Currently, this internal EH documentation lives in the `.docs/` folder as well.

# Problem
If a user installs Event Horizon into their own repository, they may already have their own `.docs/` directory, or they may want to use the Event Horizon Docs screen strictly for their own project purposes. Having Event Horizon's product documentation mixed identically into the host's `.docs/` folder creates confusion and namespace conflicts. 

We need to make Event Horizon's product documentation and Readme footprint friendly and distinct from the host project's domain.

# Implementation Plan

1. Move .docs/ files to .docs/event-horizon/.
2. Add docsRoot to config.json and engine.
