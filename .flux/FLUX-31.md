---
id: FLUX-31
title: add search box for ticket titles or descriptin
status: Todo
priority: None
createdBy: Guy
updatedBy: Agent
assignee: unassigned
tags: []
history:
  - type: comment
    user: Agent
    date: '2026-05-06T23:20:00.000Z'
    comment: >-
      Groomed this into a first-pass ticket for board and backlog text search.
      This is also a good candidate for validating the updated agent skill
      workflow end-to-end because it touches UI behavior, state handling, and
      user-visible filtering.
  - type: status_change
    from: Grooming
    to: Todo
    user: Agent
    date: '2026-05-06T23:20:00.000Z'
effort: None
implementationLink: ''
---

## Summary

Add a simple search box so users can filter tickets by title or description text.
The first pass should work across at least the board and backlog views and update
results as the query changes.

## Scope

### 1. Search input

- Add a visible search box in the main app chrome or relevant view header
- Search should match against ticket title and body text
- Matching should be case-insensitive

### 2. Board filtering

- Board columns should only show tickets matching the current query
- Column counts should reflect the filtered set or clearly stay based on the
  full set; choose one behavior and keep it consistent

### 3. Backlog filtering

- Backlog list should respect the same query
- Empty states should make it clear when no tickets match

### 4. First-pass behavior

- No advanced syntax is required yet
- No fuzzy search is required yet
- Search state does not need persistence unless it falls out naturally from the
  existing URL/view model

## Acceptance Criteria

- [ ] User can type a query and filter tickets by title text
- [ ] User can type a query and filter tickets by description text
- [ ] Search is case-insensitive
- [ ] Board view respects the active query
- [ ] Backlog view respects the active query
- [ ] Clearing the query restores the full ticket set

## Likely Files

- `portal/src/AppContext.tsx`
- `portal/src/components/Header.tsx`
- `portal/src/components/Board.tsx`
- `portal/src/components/BacklogScreen.tsx`


