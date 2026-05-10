---
assignee: unassigned
tags: []
priority: High
effort: XS
implementationLink: ''
subtasks: []
history:
  - type: activity
    user: Guy
    date: '2026-05-10T05:47:15.083Z'
    comment: Created ticket.
  - type: activity
    user: Agent
    date: '2026-05-10T05:48:46.242Z'
    comment: Launched Claude Code session (1505090c).
  - type: status_change
    from: Grooming
    to: Todo
    user: Agent
    date: '2026-05-10T05:49:32.188Z'
  - type: comment
    user: Agent
    date: '2026-05-10T05:49:32.189Z'
    comment: >-
      Bug identified: originalPayload (isDirty baseline) omits effortLevel but
      currentPayload includes it, so the modal always thinks data is dirty on
      open. Fix: add effortLevel to originalPayload using (modalTask as
      any).effortLevel || '' to match the state initializer.
    id: c-2026-05-10t05-49-32-189z
  - type: status_change
    from: Todo
    to: In Progress
    user: Agent
    date: '2026-05-10T05:49:35.054Z'
  - type: status_change
    from: In Progress
    to: Ready
    user: Agent
    date: '2026-05-10T05:49:43.147Z'
  - type: comment
    user: Agent
    date: '2026-05-10T05:49:43.147Z'
    comment: >-
      Added effortLevel to originalPayload in TaskModal.tsx line 486. The field
      was present in currentPayload but absent from originalPayload, causing
      isDirty to always be true on open. One-line fix restores correct baseline
      comparison.
    id: c-2026-05-10t05-49-43-147z
  - type: agent_message
    user: Claude Code
    date: '2026-05-10T05:49:46.396Z'
    comment: >-
      **Fix**: `originalPayload` was missing `effortLevel` while
      `currentPayload` included it, so the JSON strings always differed on modal
      open — triggering the dirty-state confirmation every time.


      Added `effortLevel: (modalTask as any)?.effortLevel || ''` to
      `originalPayload` in `TaskModal.tsx:486` to match the state initializer.
      Ticket is in **Ready** — say `finish FLUX-171` when you've verified it
      works.
  - type: activity
    user: Agent
    date: '2026-05-10T05:50:43.784Z'
    comment: Launched Claude Code session (54a234cf).
  - type: status_change
    from: Ready
    to: Done
    user: Agent
    date: '2026-05-10T05:51:10.652Z'
  - type: comment
    user: Agent
    date: '2026-05-10T05:51:10.652Z'
    comment: >-
      Committed cd09028. Fixed false dirty-state by adding effortLevel to
      originalPayload (line 484) so it matches currentPayload on open. Also
      fixed incidental indentation issue in currentPayload object. Closes
      FLUX-171.
    id: c-2026-05-10t05-51-10-652z
  - type: agent_message
    user: Claude Code
    date: '2026-05-10T05:51:16.100Z'
    comment: >-
      Done. Commit `cd09028` fixes the false dirty-state: `effortLevel` was in
      `currentPayload` but missing from `originalPayload`, so the JSON strings
      always differed on open. Also fixed a stray indentation issue introduced
      during the fix. FLUX-171 is now `Done`.
  - type: activity
    user: Agent
    date: '2026-05-10T06:08:07.555Z'
    comment: Claude Code session lost (engine restarted).
title: every time open ticket fullscreen it think its data is dirty
status: Done
createdBy: Guy
updatedBy: Agent
---
prompting to ask for confirmation uypon exit even if there was no changes to save.. need to check
