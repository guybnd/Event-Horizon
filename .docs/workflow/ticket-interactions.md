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
- Board card clicks use a settings-controlled open mode, defaulting to full
  view while still allowing popup mode for quicker inline work.
- Header search links always open the full-view ticket layout.
- Ticket editing supports both popup and full-view layouts.
- The full-view Back to Board action closes the ticket entirely and returns to
  the underlying board state instead of reopening the same ticket in popup
  mode.
- The full-view mode preserves ticket editing and comments while adding back
  navigation and Escape-based exit behavior.

## Description attachments

- Ticket descriptions render through the shared markdown surface in popup,
  full-view, and backlog detail layouts, so image links behave consistently
  across those ticket views.
- Those ticket-description surfaces default to rendered markdown, and clicking
  the description switches that surface into the same formatted editor model
  used by Docs rather than a raw markdown textarea.
- Clicking outside a ticket description editor returns that surface to rendered
  markdown preview.
- Popup and full-view description edits stay inside the normal ticket draft and
  save flow, while backlog detail editing uses the same shared editor shell with
  local save and cancel actions that only appear once the description actually
  changed.
- When editing a saved ticket description, users can paste or drag and drop
  supported image files (`.png`, `.jpg`, `.jpeg`, `.svg`) directly into the
  editor.
- Attached images are written under `.flux/assets/<ticket-id>/...`, and the
  editor inserts a relative markdown image link into the ticket body at the
  current selection.
- Unsupported dropped or pasted files show a clear warning instead of silently
  failing.
- Missing image assets render a lightweight unavailable state instead of
  breaking the ticket view.

## Comment image attachments

- The main comment composer and inline reply composer both accept pasted or
  dropped supported image files on saved tickets.
- Comment and reply image uploads reuse the same
  `.flux/assets/<ticket-id>/...` storage model as description attachments and
  insert relative markdown image links into the draft automatically.
- In comment history, image markdown renders as a compact clickable affordance
  instead of a full-width inline image block so the activity stream stays
  readable.
- Hovering a comment-image affordance shows a bounded in-page preview.
- Clicking a comment-image affordance opens a larger popup preview.
- Missing comment-image assets render an unavailable state instead of breaking
  the thread UI.

## Triage cues

- Require-input tickets are intended to be easy to spot from the app chrome and
  the ticket surface.
- Status colors are configurable in Settings and follow the ticket anywhere the
  UI renders a status badge, including search results, board lanes, and ticket
  headers/history.
- Parent and child hierarchy cues show up directly in ticket views and board
  cards when subtask relationships exist.
- Recently updated sorting reflects all activity, including ticket creation and
  field edits, not only comments.
- Board, backlog, and header ticket data update in place while the portal is
  visible instead of requiring a manual reload.
- Newly created tickets animate into their destination lane, and tickets that
  move between statuses land in the target column with a stronger arrival
  bounce so live board changes are easier to notice.

## Related docs

- [[Project Overview]]
- [[Ticket Model]]
- [[Ticket Lifecycle]]
- [[Repository Map]]