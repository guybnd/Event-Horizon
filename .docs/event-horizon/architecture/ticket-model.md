---
title: Ticket Model
order: 3
---

# Ticket Model

Event Horizon stores each ticket as a markdown file in `.flux/` with YAML
frontmatter and a markdown body. The engine owns normalization and persistence;
the portal mostly renders and edits that repo-backed state.

## Core fields

- `id`, `title`, and `status` identify the ticket and place it in the workflow.
- `assignee` and `tags` capture ownership and categorization.
- `priority` is a named value from `.flux/config.json`; priorities are
  configurable in Settings and are editable from both the card and the ticket
  editor.
- `effort` stores T-shirt sizes (`XS`, `S`, `M`, `L`, `XL`) and follows the
  same quick-edit pattern as priority.
- `implementationLink` is an optional commit or pull request link that stays on
  the ticket as the primary implementation reference.
- `subtasks` stores child ticket IDs for linked-ticket hierarchy.
- `history` records comments, status changes, and activity events.
- `order` is the persisted manual sort position for tickets within a column.

## Ordering and activity semantics

- Board column order comes from the `config.columns` array in
  `.flux/config.json`.
- Ticket order within a given status comes from the ticket's `order` field,
  which is updated by drag-and-drop.
- The default "recently updated" behavior uses any recorded activity, not only
  comments.
- The engine records creation and field-edit activity entries so audit trails
  and recent-activity sorting reflect real ticket movement.

## Hierarchy semantics

- The first shipped subtask model uses linked existing tickets only, not inline
  checklist items.
- The ticket editor shows a `Subtasks` section when child links exist.
- Users can attach and detach child tickets from the ticket editor.
- Opening a linked subtask row navigates directly to that child ticket.
- Parent relationships are derived from subtask links, which lets board cards
  show a clickable parent badge without duplicating parent state on every child.

## Editing surfaces

- High-frequency metadata such as priority and effort can be changed directly
  from the card surface.
- Full ticket editing lives in the popup or full-view ticket surface.
- URL-backed ticket navigation and triage behaviors are covered in
  [[Ticket Interactions]].

## Related docs

- [[Project Overview]]
- [[Code Map]]
- [[Ticket Interactions]]
- [[Ticket Lifecycle]]