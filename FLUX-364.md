---
id: FLUX-364
title: Improve board search readability and card scan/action hierarchy
status: Ready
priority: Medium
effort: M
assignee: unassigned
tags:
  - portal
  - ux
createdBy: Agent
updatedBy: Agent
history:
  - type: activity
    user: Agent
    date: '2026-06-03T05:07:33.775Z'
    comment: Created ticket.
  - type: comment
    user: Agent
    comment: >-
      Plan: (1) Update GlobalSearch overlay container, header, and row
      typography/spacing for stronger visual separation; (2) Rework TaskCard
      metadata into clear tiers (identity/status, details, tags/ownership); (3)
      Tighten card body rhythm and excerpt readability; (4) Re-style Ready
      actions so Review is neutral, Return is caution-tier with spacing, Finish
      remains primary; (5) build portal to validate.
    date: '2026-06-03T05:07:42.321Z'
    id: c-2026-06-03t05-07-42-321z
  - type: status_change
    from: Todo
    to: In Progress
    user: Agent
    date: '2026-06-03T05:07:42.328Z'
  - type: comment
    user: Agent
    comment: >-
      Implemented notes 2, 3, 4, and 5.


      What changed:

      - Global search overlay now has stronger depth separation (elevated
      shadow/ring/backdrop), clearer header contrast, and improved result-row
      readability.

      - Task cards now use clearer hierarchy: title -> identity/status row ->
      detail chips (effort/priority) -> summary block -> context row.

      - Metadata chips were tiered visually: status elevated, effort/priority as
      secondary bordered chips, tags/assignee as contextual chips.

      - Ready actions were rebalanced: Review neutral, Return explicit caution
      style, Finish remains primary.


      Validation:

      - No TypeScript errors in edited files.

      - portal build currently fails due to pre-existing TaskModal type issues
      unrelated to this change.
    date: '2026-06-03T05:09:17.938Z'
    id: c-2026-06-03t05-09-17-938z
  - type: status_change
    from: In Progress
    to: Ready
    user: Agent
    date: '2026-06-03T05:09:17.938Z'
---
Apply dashboard refinements:
- Strengthen global search overlay depth separation and result readability
- Improve TaskCard scan rhythm and metadata grouping
- Introduce clearer visual tiers for status/priority/effort/tags metadata
- Clarify Ready-state action hierarchy and increase safety for return action
- Validate portal build
