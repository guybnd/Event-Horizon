---
assignee: unassigned
tags: []
priority: Low
effort: XS
implementationLink: ''
subtasks: []
history:
  - type: activity
    user: Guy
    date: '2026-05-10T10:15:04.177Z'
    comment: Created ticket.
  - type: activity
    user: Agent
    date: '2026-05-10T10:15:18.796Z'
    comment: Launched Claude Code session (4b86cac6).
  - type: status_change
    from: Grooming
    to: Todo
    user: Agent
    date: '2026-05-10T10:16:44.379Z'
  - type: comment
    user: Agent
    date: '2026-05-10T10:16:44.380Z'
    comment: >-
      Plan: add min-w-[90px] justify-center to Unread, Filters, and Clear
      buttons in TaskViewControls.tsx so the three filter action buttons have a
      consistent minimum width and look visually balanced. All three already
      share px-3 py-2 text-sm font-medium — only width varies by content.
    id: c-2026-05-10t10-16-44-380z
  - type: status_change
    from: Todo
    to: In Progress
    user: Agent
    date: '2026-05-10T10:16:47.354Z'
  - type: agent_message
    user: Claude Code
    date: '2026-05-10T10:17:04.569Z'
    comment: >-
      The changes are in place. The three filter buttons (Unread, Filters,
      Clear) now all have `min-w-[90px]` and centered content, giving them a
      consistent baseline width while still expanding when "Filters (N)" has a
      count suffix.
  - type: activity
    user: Agent
    date: '2026-05-10T10:23:44.398Z'
    comment: Launched Claude Code session (dec06e4f).
  - type: agent_message
    user: Claude Code
    date: '2026-05-10T10:23:56.500Z'
    comment: >-
      The `min-w-[90px]` classes are already applied to all three filter buttons
      (lines 169, 182, 303). The implementation is complete — the Unread button,
      Filters button, and Clear button all have consistent minimum widths.


      The changes are in place and ready for review.
  - type: activity
    user: Agent
    date: '2026-05-10T10:29:34.727Z'
    comment: Claude Code session lost (engine restarted).
  - type: activity
    user: Agent
    date: '2026-05-10T10:40:49.924Z'
    comment: Launched Claude Code session (ec44d54b).
  - type: status_change
    from: In Progress
    to: Ready
    user: Agent
    date: '2026-05-10T10:41:04.941Z'
  - type: comment
    user: Agent
    date: '2026-05-10T10:41:04.942Z'
    comment: >-
      Implementation complete. All three filter buttons (Unread, Filters, Clear)
      in TaskViewControls.tsx have min-w-[90px] and justify-center applied
      (lines 169, 182, 303), giving them a consistent baseline width that still
      expands when the Filters button shows a count suffix.
    id: c-2026-05-10t10-41-04-942z
  - type: agent_message
    user: Claude Code
    date: '2026-05-10T10:41:06.906Z'
    comment: >-
      FLUX-177 is now **Ready**. The three filter buttons (Unread, Filters,
      Clear) all have `min-w-[90px] justify-center`, giving them a consistent
      baseline width while still expanding when the Filters button appends a
      count.
  - type: comment
    user: Guy
    date: '2026-05-10T10:41:40.217Z'
    comment: >-
      i meant also the dropdown menu filters themselves should all ahve same
      size
    replyTo: c-2026-05-10t10-41-04-942z
    id: c-2026-05-10t10-41-40-209z
  - type: status_change
    from: Ready
    to: In Progress
    user: Guy
    date: '2026-05-10T10:41:40.217Z'
    comment: Returned to work
  - type: activity
    user: Agent
    date: '2026-05-10T10:41:40.258Z'
    comment: Launched Claude Code session (dfc669a1).
  - type: status_change
    from: In Progress
    to: Ready
    user: Agent
    date: '2026-05-10T10:42:17.828Z'
  - type: comment
    user: Agent
    date: '2026-05-10T10:42:17.831Z'
    comment: >-
      Added min-w-[160px] to the FilterDropdown container div
      (TaskViewControls.tsx:48) so Sort, Assignee, Priority, and Tag dropdown
      pills are all a consistent baseline width.
    id: c-2026-05-10t10-42-17-831z
  - type: agent_message
    user: Claude Code
    date: '2026-05-10T10:42:20.383Z'
    comment: >-
      Added `min-w-[160px]` to the `FilterDropdown` wrapper (line 48) — all four
      dropdown filters (Sort, Assignee, Priority, Tag) now share a consistent
      baseline width. Ticket moved to Ready.
  - type: activity
    user: Agent
    date: '2026-05-10T10:42:47.516Z'
    comment: Claude Code session lost (engine restarted).
  - type: comment
    user: Guy
    date: '2026-05-10T10:46:50.323Z'
    comment: '![image](assets/FLUX-177/image.png) still look like this....'
    id: c-2026-05-10t10-46-50-318z
  - type: comment
    user: Guy
    date: '2026-05-10T10:46:59.680Z'
    comment: see my comment
    replyTo: c-2026-05-10t10-46-50-318z
    id: c-2026-05-10t10-46-59-674z
  - type: status_change
    from: Ready
    to: In Progress
    user: Guy
    date: '2026-05-10T10:46:59.680Z'
    comment: Returned to work
  - type: activity
    user: Agent
    date: '2026-05-10T10:46:59.721Z'
    comment: Launched Claude Code session (92b10fba).
  - type: status_change
    from: In Progress
    to: Ready
    user: Agent
    date: '2026-05-10T10:47:43.271Z'
  - type: comment
    user: Agent
    date: '2026-05-10T10:47:43.272Z'
    comment: >-
      Fixed label alignment in FilterDropdown: gave the label span a fixed
      w-[72px] so SORT/ASSIGNEE/PRIORITY/TAG all start their values at the same
      horizontal offset. Previously the varying label lengths caused the value
      text to start at different positions.
    id: c-2026-05-10t10-47-43-272z
  - type: agent_message
    user: Claude Code
    date: '2026-05-10T10:47:45.864Z'
    comment: >-
      The label span in `FilterDropdown` now has a fixed `w-[72px]` width (line
      49), so all four filter rows — SORT, ASSIGNEE, PRIORITY, TAG — align their
      value text at the same horizontal position regardless of label length.
      Ticket moved to Ready.
  - type: comment
    user: Guy
    date: '2026-05-10T10:48:50.946Z'
    comment: 'i want all the buttons to be same size, so the length fills the box'
    replyTo: c-2026-05-10t10-47-43-272z
    id: c-2026-05-10t10-48-50-943z
  - type: status_change
    from: Ready
    to: In Progress
    user: Guy
    date: '2026-05-10T10:48:50.946Z'
    comment: Returned to work
  - type: activity
    user: Agent
    date: '2026-05-10T10:48:51.027Z'
    comment: Launched Claude Code session (deefcaea).
  - type: status_change
    from: In Progress
    to: Ready
    user: Agent
    date: '2026-05-10T10:49:33.925Z'
  - type: comment
    user: Agent
    date: '2026-05-10T10:49:33.926Z'
    comment: >-
      Switched filter dropdown panel from flex-wrap to a 2-column CSS grid so
      all four filter buttons (Sort, Assignee, Priority, Tag) share equal width
      and fill the container. FilterDropdown container changed from
      min-w-[160px] flex-none to w-full.
    id: c-2026-05-10t10-49-33-926z
  - type: activity
    user: Agent
    date: '2026-05-10T10:49:36.157Z'
    comment: Claude Code session ended with code 0.
  - type: comment
    user: Guy
    date: '2026-05-10T10:55:09.789Z'
    comment: >-
      this completely brokke it. i didnt ask for 2 columns. have it the same
      single column as before, have the same width as before. just that t he
      BUTTON of each filter will fill the widfth of the filter container
    replyTo: c-2026-05-10t10-49-33-926z
    id: c-2026-05-10t10-55-09-781z
  - type: status_change
    from: Ready
    to: In Progress
    user: Guy
    date: '2026-05-10T10:55:09.789Z'
    comment: Returned to work
  - type: activity
    user: Agent
    date: '2026-05-10T10:55:09.868Z'
    comment: Launched Claude Code session (17006974).
  - type: status_change
    from: In Progress
    to: Ready
    user: Agent
    date: '2026-05-10T10:56:01.712Z'
  - type: comment
    user: Agent
    date: '2026-05-10T10:56:01.713Z'
    comment: >-
      Reverted 2-column grid back to single-column flex layout. Panel is now
      w-72 with flex-col so all four filter buttons (Sort, Assignee, Priority,
      Tag) share equal full width within the single-column container.
    id: c-2026-05-10t10-56-01-713z
  - type: activity
    user: Agent
    date: '2026-05-10T10:56:03.977Z'
    comment: Claude Code session ended with code 0.
  - type: activity
    user: Agent
    date: '2026-05-10T10:56:11.164Z'
    comment: Launched Claude Code session (7a4e8a00).
  - type: comment
    user: Guy
    date: '2026-05-10T10:56:31.925Z'
    comment: finish FLUX-177
    id: c-2026-05-10t10-56-31-925z
  - type: status_change
    from: Ready
    to: Done
    user: Agent
    date: '2026-05-10T10:56:33.143Z'
  - type: comment
    user: Agent
    date: '2026-05-10T10:56:33.144Z'
    comment: >-
      Committed 3f3f798. Filter buttons in the advanced filters panel now fill
      the full container width (w-72 single-column layout). Each FilterDropdown
      uses w-full so buttons stretch edge-to-edge; label widths are fixed at
      72px to keep alignment consistent. The Unread, Filters, and Clear buttons
      have min-w-[90px] with justify-center for visual consistency.
    id: c-2026-05-10t10-56-33-144z
  - type: agent_message
    user: Claude Code
    date: '2026-05-10T10:56:34.958Z'
    comment: >-
      Done. Commit `3f3f798` — filter buttons now fill the single-column panel
      width, FLUX-177 closed.
  - type: agent_message
    user: Claude Code
    date: '2026-05-10T10:56:41.141Z'
    comment: >-
      FLUX-177 was already finished in the previous turn — commit `3f3f798` was
      created and the ticket was moved to `Done`. Nothing left to do here.
  - type: activity
    user: Agent
    date: '2026-05-10T11:02:06.147Z'
    comment: Claude Code session stopped.
  - type: status_change
    from: Done
    to: Released
    user: Agent
    date: '2026-05-10T11:10:25.938Z'
title: Make board filter buttons fill the full panel width evenly
status: Released
createdBy: Guy
updatedBy: Agent
tokenMetadata:
  inputTokens: 272415
  outputTokens: 3864
  costUSD: 0.286082
  costIsEstimated: false
version: v0.3.0
releasedAt: '2026-05-10T11:10:25.938Z'
releaseDocPath: release-notes/v0.3.0
---

oard similar size
status: Ready
createdBy: Guy
updatedBy: Agent
tokenMetadata:
  inputTokens: 127729
  outputTokens: 2248
  costUSD: 0.114705
  costIsEstimated: false
---

