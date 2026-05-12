---
title: 'Description view: rendered markdown with WYSIWYG editing'
status: Archived
createdBy: Guy
updatedBy: Guy
assignee: Agent
tags:
  - feature
history:
  - type: activity
    user: Guy
    date: '2026-05-06T07:30:00.000Z'
    comment: Created ticket.
  - type: comment
    user: Agent
    date: '2026-05-06T07:30:00.000Z'
    comment: >-
      Fleshed this out with implementation approach. This is self-contained and
      ready to work on.
    id: c-2026-05-06t07-30-00-000z
  - type: activity
    user: Guy
    date: '2026-05-06T13:42:36.994Z'
    comment: Changed effort from None to L.
  - type: comment
    user: Guy
    date: '2026-05-07T01:52:14.835Z'
    comment: See flux-51
    id: c-2026-05-07t01-52-14-835z
  - type: status_change
    from: Todo
    to: Grooming
    user: Guy
    date: '2026-05-07T01:52:18.881Z'
  - type: comment
    user: Agent
    date: '2026-05-07T13:01:33.5429940+10:00'
    comment: >-
      This is close to ready, but the scope relationship with FLUX-51 is still
      unresolved. Should FLUX-9 stay as the focused first slice for ticket
      descriptions using rendered markdown plus an edit toggle, or do you want
      that work folded into FLUX-51's broader shared-editor refactor?
    id: c-2026-05-07t13-01-33-5429940-10-00-flux-9
  - type: status_change
    from: Grooming
    to: Require Input
    user: Agent
    date: '2026-05-07T13:01:33.5429940+10:00'
  - type: comment
    user: Guy
    date: '2026-05-07T03:17:53.275Z'
    comment: >-
      i think this is mostly implemented but we just need to ensure consistency
      across all product sections:


      1. always show a WYSIWYG display in full markdown formatting.

      2. pressing on the desciption section , the text, will switch to edit
      mode. dont need a dedicated button for that.

      3. have the same follower edit bar like in the docs section

      4. code and features should be unified across all 'description' editors to
      avoid unnecesary duplication: full screen ticket view, backlog, popup
      ticket view, docs section
    id: c-2026-05-07t03-17-53-275z
  - type: status_change
    from: Require Input
    to: Grooming
    user: Guy
    date: '2026-05-07T03:17:53.275Z'
    comment: Response submitted
  - type: comment
    user: Agent
    date: '2026-05-07T03:53:39.4816199Z'
    comment: >-
      Folded this narrower scope into FLUX-51 so the shared description surface
      lands as one canonical implementation ticket. Keeping FLUX-9 in hidden
      backlog for traceability only.
    id: c-2026-05-07t03-53-39-4816199z-flux-9
  - type: status_change
    from: Grooming
    to: Backlog
    user: Agent
    date: '2026-05-07T03:53:39.4816199Z'
  - type: status_change
    from: Backlog
    to: Archived
    user: Guy
    date: '2026-05-08T00:11:27.225Z'
order: 3
priority: Medium
effort: L
implementationLink: ''
subtasks: []
---
## Tracking Note

This narrower description-surface request is now tracked under FLUX-51 so the
shared editor and rendered-markdown behavior ship from one canonical ticket.
Keep FLUX-9 only for traceability of the original request.

## Summary

Change the default description view from a raw markdown textarea to a rendered markdown preview. When the user clicks "Edit" or enters fullscreen, switch to a WYSIWYG-style editor that shows formatted text while editing (not raw markdown syntax).

## Requirements

### 1. Rendered default view
- When opening a ticket, the description area shows **rendered markdown** (headers, bold, lists, links, code blocks, etc.)
- An "Edit" button switches to edit mode
- Double-clicking the rendered view also enters edit mode

### 2. WYSIWYG editing mode
- Instead of a plain textarea showing raw markdown, provide a rich-text editor
- Text appears formatted as you type (bold text shows bold, headers show large, etc.)
- Toolbar buttons (already exist) apply formatting inline
- Under the hood, the content is still stored as markdown in the `.md` file

### 3. Markdown rendering library
- Use a library like `react-markdown` for the read-only rendered view
- For WYSIWYG editing, consider:
  - **Option A:** `@tiptap/react` — popular, extensible, stores as markdown via `tiptap-markdown` extension
  - **Option B:** `milkdown` — markdown-native WYSIWYG editor
  - **Option C:** Simple toggle between rendered view (`react-markdown`) and raw textarea (simpler, not true WYSIWYG but functional)

### 4. Code block support
- Rendered view should syntax-highlight code blocks
- Editor should handle fenced code blocks gracefully

## Implementation Approach

**Recommended: Option C (Phase 1) → Option A (Phase 2)**

Start with a simple rendered/edit toggle using `react-markdown` + raw textarea. This gives immediate value with low risk. Later, upgrade to Tiptap for true WYSIWYG.

### Phase 1 — Rendered view + edit toggle
1. Install `react-markdown` and `remark-gfm`
2. Default state: render description with `<ReactMarkdown>`
3. "Edit" button switches to current textarea
4. "Preview" button switches back to rendered view
5. Fullscreen mode gets a split pane: editor left, preview right

### Phase 2 — True WYSIWYG (future ticket)
1. Replace textarea with Tiptap editor
2. Markdown ↔ Tiptap content conversion
3. Toolbar wired to Tiptap commands

## Acceptance Criteria

- [ ] Opening a ticket shows the description as rendered markdown (not raw text)
- [ ] "Edit" button switches to a markdown editing view
- [ ] Preview/rendered view supports: headings, bold, italic, lists, links, code blocks, tables
- [ ] Fullscreen mode works in both rendered and edit views
- [ ] Content round-trips correctly (render → edit → save → render produces same result)
- [ ] No regressions to existing markdown toolbar functionality

## Files to Modify

- `portal/src/components/TaskModal.tsx` — Add rendered view, edit toggle
- `portal/package.json` — Add `react-markdown`, `remark-gfm` dependencies

## Dependencies

- Related to: FLUX-4 (fullscreen editor fixes should land first)
- Related to: FLUX-5 (docs section will share the same markdown rendering)

