---
title: Ticket Interactions
order: 3
---

# Ticket Interactions

This page captures the shipped behaviors that shape day-to-day ticket work from
the board, backlog, header, and ticket views.

## Search, sort, and filters

- The header search matches ticket title and body text.
- Search is case-insensitive and applies to both the board and backlog views.
- Sort and filter state is URL-backed so filtered views are reload-safe and
  shareable.
- First-pass filters cover assignee, priority, and tag.
- First-pass sort modes cover priority, recently updated, and assignee.
- Clearing the controls restores the default unfiltered view.

## Require Input flow

- `Require Input` is a dedicated workflow status rather than just a visual hint.
- The header shows a notification-style count of tickets currently waiting for
  user input.
- Opening a `Require Input` ticket presents a focused response flow that
  emphasizes the pending question.
- When submitting a response, the user chooses where the ticket goes next; the
  first shipped destinations are `Todo` and `Grooming`.
- The response flow records the answer and the resulting status transition in
  ticket history.

## Navigation and view state

- Ticket state can be represented in the URL so a specific open ticket and its
  view mode can be reopened or shared.
- Ticket editing supports both popup and full-view layouts.
- The full-view mode preserves ticket editing and comments while adding back
  navigation and Escape-based exit behavior.

## Triage cues

- Require-input tickets are intended to be easy to spot from the app chrome and
  the ticket surface.
- Parent and child hierarchy cues show up directly in ticket views and board
  cards when subtask relationships exist.
- Recently updated sorting reflects all activity, including ticket creation and
  field edits, not only comments.