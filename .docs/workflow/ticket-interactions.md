---
title: Ticket Interactions
order: 3
---

# Ticket Interactions

This page captures the shipped behaviors that shape day-to-day ticket work from
the board, backlog, header, and ticket views.

## Search, sort, and filters

- The header search is a global fuzzy ticket lookup that matches ids, titles,
  and body text across both board and backlog work.
- Header search results are real deep links, so standard browser actions like
  open in new tab, middle-click, and link context menus work as expected, and
  those links open the full ticket view.
- Board and backlog each keep their own local filter search so narrowing one
  page does not overwrite the global lookup box.
- Sort and filter state is URL-backed so local filtered views are reload-safe
  and shareable.
- Advanced board and backlog filters are collapsible to keep the working view
  compact until sort or metadata filtering is needed.
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
- Board card clicks open the popup ticket view for quick board work, while
  header search links open the full-view ticket layout.
- Ticket editing supports both popup and full-view layouts.
- The full-view Back to Board action closes the ticket entirely and returns to
  the underlying board state instead of reopening the same ticket in popup
  mode.
- The full-view mode preserves ticket editing and comments while adding back
  navigation and Escape-based exit behavior.

## Triage cues

- Require-input tickets are intended to be easy to spot from the app chrome and
  the ticket surface.
- Parent and child hierarchy cues show up directly in ticket views and board
  cards when subtask relationships exist.
- Recently updated sorting reflects all activity, including ticket creation and
  field edits, not only comments.

## Related docs

- [[Project Overview]]
- [[Ticket Model]]
- [[Ticket Lifecycle]]
- [[Repository Map]]