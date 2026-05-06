---
id: FLUX-45
title: fix sorting
status: Done
priority: None
createdBy: Guy
updatedBy: Agent
assignee: unassigned
tags: []
history:
  - type: activity
    user: Guy
    date: '2026-05-06T13:32:28.117Z'
    comment: Created ticket.
  - type: comment
    user: Agent
    date: '2026-05-06T23:32:28.1170846+10:00'
    comment: >-
      Plan: add engine-side activity entries for ticket creation and field
      edits, switch default sorting to recent activity, and validate with
      targeted checks.
    id: c-2026-05-06t23-32-28-1170846-10-00
  - type: status_change
    from: Grooming
    to: In Progress
    user: Agent
    date: '2026-05-06T23:32:28.1170846+10:00'
  - type: comment
    user: Agent
    date: '2026-05-06T23:45:40.2757530+10:00'
    comment: >-
      Default task sorting now uses recent activity, the engine now records
      creation and field-edit activity entries, and board columns now respect
      the selected task order instead of re-sorting by manual order. Validated
      with `npm.cmd run build -w portal`, clean editor diagnostics on the
      touched files, and a live create-update-delete API check confirming
      `Created ticket.` and automatic field-change activity entries. Caveat:
      `npx.cmd tsc -p engine/tsconfig.json --noEmit` still fails because of
      pre-existing engine module-configuration diagnostics unrelated to this
      ticket. Commit: `07f89ad` (`Fix task activity sorting`).
    id: c-2026-05-06t23-45-40-2757530-10-00
  - type: status_change
    from: In Progress
    to: Done
    user: Agent
    date: '2026-05-06T23:45:40.2757530+10:00'
effort: None
implementationLink: 07f89ad
subtasks: []
---
1. sort default should be most recent goes on top
2. most recent sorting doesnt seem to account for ticket creation or field editing, just to comments, need to  fix it to nay activity
3. maybe not all acitivities get logged and this is why? ticket creation needs to be a log entry in the activity, so does updating any field.
