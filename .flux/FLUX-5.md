---
title: Docs section
status: Todo
createdBy: Guy
updatedBy: Guy
assignee: Agent
tags:
  - feature
  - mvp
history:
  - type: comment
    user: Agent
    date: '2026-05-06T07:28:00.000Z'
    comment: >-
      I've fleshed this out into a proper spec. I have a few questions for you
      before we start implementation — see the Open Questions section in the
      description.
    id: c-2026-05-06t07-28-00-000z
  - type: comment
    user: Guy
    date: '2026-05-06T07:35:41.321Z'
    comment: >-
      1. top level

      2. yes

      3. WISYWIG single page editor

      4. have a setting for this, default is all can edit as its just files
      after all

      5. idk
    id: c-2026-05-06t07-35-41-321z
  - type: status_change
    from: Require Input
    to: Todo
    user: Guy
    date: '2026-05-06T07:35:50.341Z'
  - type: comment
    user: Agent
    date: '2026-05-06T07:36:00.000Z'
    comment: >-
      Updated the spec with Guy's answers. Docs will be a top-level screen with
      a WYSIWYG single-page editor, a "New Doc" button, and a config setting for
      edit permissions.
    id: c-2026-05-06t07-36-00-000z
order: 4
priority: High
---
## Summary

Add a full documentation section to Event Horizon that reads from a `.docs` directory, displays docs in a navigable hierarchy, supports inter-doc linking, and provides a WYSIWYG editor for authoring.

## Design Decisions (from Guy's input)

- ✅ **Top-level screen** — Docs will be a new screen accessible from the header nav (like Board/Backlog)
- ✅ **"New Doc" button** — Users can create docs from the sidebar UI
- ✅ **WYSIWYG single-page editor** — Not a split-pane; one editor view that shows formatted text while editing
- ✅ **Edit permissions configurable** — Settings toggle for who can edit; default: everyone can edit
- ✅ **Minimal frontmatter** — Just `title` and `order` for now; keep it simple

## Requirements

### 1. File-based docs from `.docs/` directory
- Engine watches the `.docs/` directory (sibling to `.flux/`) using chokidar
- Supports nested directories for hierarchy (e.g. `.docs/architecture/overview.md`)
- Each doc is a markdown file with YAML frontmatter for metadata (`title`, `order`)
- New API endpoints: `GET /api/docs`, `GET /api/docs/:path`, `PUT /api/docs/:path`, `POST /api/docs`, `DELETE /api/docs/:path`

### 2. Hierarchical sidebar navigation
- Left sidebar shows a tree view of all docs grouped by directory
- Expandable/collapsible folders
- Active doc highlighted
- Sortable via `order` frontmatter field or alphabetical fallback
- Search/filter bar at the top to quickly find docs by title
- "New Doc" button at the top of the sidebar

### 3. Inter-doc linking
- Support `[[doc-name]]` wiki-style links that resolve to other docs in the hierarchy
- Clicking a link navigates to that doc within the docs viewer
- Show broken link indicators for links that don't resolve

### 4. WYSIWYG editor (single page)
- Default view shows the doc as formatted/rendered text
- Editing is WYSIWYG — text appears formatted as you type
- Use a library like Tiptap, Milkdown, or similar
- Full markdown toolbar (bold, italic, code, list, link, headings)
- Content stored as markdown in `.md` files
- Dirty state tracking and save confirmation

### 5. Edit permissions
- Config setting: `docsEditPermissions: "all" | "specified"` with a list of allowed users
- Default: `"all"` — everyone can edit
- Configurable from the Settings panel

## Acceptance Criteria

- [ ] `.docs/` directory is watched by the engine and served via API
- [ ] Portal has a new "Docs" screen accessible from the header
- [ ] Sidebar shows doc hierarchy with expand/collapse
- [ ] Clicking a doc opens it in a WYSIWYG editor
- [ ] "New Doc" button creates a new document
- [ ] `[[links]]` between docs work and navigate correctly
- [ ] Dirty state tracking and save confirmation
- [ ] Edit permissions configurable in Settings

## Files to Create/Modify

### Engine
- `engine/src/index.ts` — Add docs API endpoints and `.docs/` watcher

### Portal
- `portal/src/components/DocsScreen.tsx` — **[NEW]** Main docs viewer/editor with WYSIWYG
- `portal/src/components/DocsSidebar.tsx` — **[NEW]** Hierarchical navigation tree
- `portal/src/components/Header.tsx` — Add "Docs" navigation tab
- `portal/src/api.ts` — Add docs API client functions
- `portal/src/types.ts` — Add `Doc` interface
- `portal/src/components/Settings.tsx` — Add docs permission setting

### Dependencies to install
- WYSIWYG editor library (e.g. `@tiptap/react`, `@tiptap/starter-kit`, `tiptap-markdown`)

## Dependencies

- Shares rendering approach with FLUX-9 (description WYSIWYG)

