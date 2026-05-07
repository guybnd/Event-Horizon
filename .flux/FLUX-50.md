---
assignee: unassigned
tags: []
priority: None
effort: None
implementationLink: ''
subtasks: []
history:
  - type: activity
    user: Guy
    date: '2026-05-07T01:28:32.411Z'
    comment: Created ticket.
  - type: comment
    user: Agent
    date: '2026-05-07T13:01:33.5429940+10:00'
    comment: >-
      The key workflow decision is still open. Should creating a release move
      selected tickets into a dedicated `Released` status, or should tickets
      keep their workflow status and instead gain release/version metadata that
      the new Releases surface groups by version?
    id: c-2026-05-07t13-01-33-5429940-10-00-flux-50
  - type: status_change
    from: Grooming
    to: Require Input
    user: Agent
    date: '2026-05-07T13:01:33.5429940+10:00'
  - type: comment
    user: Guy
    date: '2026-05-07T03:07:37.337Z'
    comment: >-
      probably Both, we want to have a new field for tickets of 'version' that
      releasing them will apply this fields input

      they should also move to 'released' status which will remove them from the
      Done column and entirely from the board, being viewable only from search
      or releases menu
    id: c-2026-05-07t03-07-37-337z
  - type: status_change
    from: Require Input
    to: Grooming
    user: Guy
    date: '2026-05-07T03:07:37.337Z'
    comment: Response submitted
title: '"Releases" feature'
status: Grooming
createdBy: Guy
updatedBy: Guy
---
need to add a 'releases' section that acts as version control of sorts

when looking at the Done section there should be a button top that says 'releas'e
pressing on it let you select the tickets from the Done section you want to tag in a release and pick a version, 

when finish selecting them, it will move all those tickets to a dedicated 'released' status and remove from board
viewing them will only be avaiulable through search or through the releases section, under their applicable version

add more ideas here to flesh it out
