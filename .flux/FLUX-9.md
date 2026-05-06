---
title: 'Description view: rendered markdown with WYSIWYG editing'
status: Todo
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
order: 3
priority: Medium
effort: L
---
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

