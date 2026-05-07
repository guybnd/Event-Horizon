---
title: Docs section
status: Released
createdBy: Guy
updatedBy: Agent
assignee: Agent
tags:
  - feature
  - mvp
history:
  - type: activity
    user: Guy
    date: '2026-05-06T07:28:00.000Z'
    comment: Created ticket.
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
      after all 5. idk
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
  - type: activity
    user: Guy
    date: '2026-05-06T13:42:22.429Z'
    comment: Changed effort from L to M.
  - type: comment
    user: Agent
    date: '2026-05-06T14:15:33.918Z'
    comment: >-
      Plan: 1) add .docs indexing and CRUD APIs in the engine, 2) wire a Docs
      top-level view with tree navigation and API client/types, 3) add
      authoring, save flow, and wiki-link navigation, then validate portal and
      engine builds.
    id: c-2026-05-06t14-15-33-918z
  - type: status_change
    from: Todo
    to: In Progress
    user: Agent
    date: '2026-05-06T14:15:33.918Z'
  - type: comment
    user: Guy
    date: '2026-05-06T14:35:53.521Z'
    comment: >-
      new input:


      I want to have like a wiki layout,

      docs hierarchy will show on the left side taking like 20% of the page

      with nested hierarchies and ability to create new file under each
      hierarchy from there 


      then on the right side we have a full blown WISYWIG editor, not the
      preview\edit shit
    id: c-2026-05-06t14-35-53-521z
  - type: comment
    user: Agent
    date: '2026-05-06T14:41:26.976Z'
    comment: >-
      Committed the first docs phase in ac9f8e6: `.docs` watching and CRUD APIs,
      the top-level Docs screen, tree navigation, wiki-link resolution, and docs
      permissions. Re-scoping the next pass to match Guy's latest note: a
      persistent wiki layout with an approximately 20/80 split, create actions
      from the hierarchy itself, and an always-on WYSIWYG editor. Additional
      docs features worth fleshing out here are breadcrumbs, rename/move flows,
      backlinks, and a heading outline.
    id: c-2026-05-06t14-41-26-976z
  - type: comment
    user: Agent
    date: '2026-05-07T01:06:32.493Z'
    comment: >-
      Next docs pass is tightening the wiki rail and editor chrome: order should
      come from drag-and-drop in the left hierarchy, the right pane should drop
      the standalone `order` field, and title editing should happen inline from
      the header instead of separate inputs.
    id: c-2026-05-07t01-06-32-493z
  - type: comment
    user: Agent
    date: '2026-05-07T01:12:17.064Z'
    comment: >-
      Implemented the next docs UI slice: the left wiki rail now exposes
      drag-and-drop ordering that persists back to doc metadata, the right pane
      no longer shows separate title/order form fields, and the header title is
      now the inline editing affordance. Validated with `npm.cmd run build -w
      portal`, live browser checks on `/docs`, inline title activation, and a
      drag reorder that persisted through the docs API.
    id: c-2026-05-07t01-12-17-064z
  - type: comment
    user: Agent
    date: '2026-05-07T01:19:08.633Z'
    comment: >-
      Next FLUX-5 pass is stabilizing the editor itself: fix the false dirty
      state on doc load, wire a real Tiptap link mark so wiki and external links
      survive inside the WYSIWYG surface, and add explicit editor content
      styling so headings, lists, code, and links actually render as formatted
      content instead of looking like plain text.
    id: c-2026-05-07t01-19-08-633z
  - type: comment
    user: Guy
    date: '2026-05-07T01:23:59.817Z'
    comment: add links to trelevant docs in the relevant pages
    id: c-2026-05-07t01-23-59-817z
  - type: comment
    user: Agent
    date: '2026-05-07T11:25:50.1063925+10:00'
    comment: >-
      Following up on the cross-linking note by wiring wiki links between the
      current docs pages themselves so readers can move between overview,
      architecture, ticket-model, interaction, lifecycle, and workflow-install
      pages without going back to the sidebar each time. After the markdown
      updates I will validate that the docs still parse through the live docs
      API.
    id: c-2026-05-07t11-25-50-1063925-10-00
  - type: comment
    user: Agent
    date: '2026-05-07T01:50:24.669Z'
    comment: >-
      Stabilized the docs editor pass. Dirty tracking now compares against the
      loaded editor document snapshot instead of markdown byte equality, which
      removed the false `Unsaved` state on clean loads. The docs editor also now
      renders formatted content with explicit heading/list/code/link styling,
      supports wiki and external links in the Tiptap link mark, and internal
      article links navigate correctly from the live editor surface. Validated
      with `npm.cmd run build -w portal`, a clean `/docs` load showing no
      `Unsaved` badge, and live navigation from `Architecture Overview` to
      `Project Overview` through a wiki link.
    id: c-2026-05-07t01-50-24-669z
  - type: comment
    user: Agent
    date: '2026-05-07T12:13:27.3068907+10:00'
    comment: >-
      Completed the docs section across focused implementation slices: `ac9f8e6`
      added repo-backed docs APIs, the top-level Docs screen, and permissions;
      `3070431` refined drag-ordering and inline title editing in the wiki rail;
      `f6d640b` stabilized dirty tracking and WYSIWYG link rendering; and
      `14850b0` added cross-links between the core docs pages. Validated across
      those passes with repeated `npm.cmd run build -w portal`, live docs API
      checks, drag-order persistence, clean `/docs` loads, and live wiki-link
      navigation. The later docs-architecture follow-up was split out and
      completed separately under FLUX-49.
    id: c-2026-05-07t12-13-27-3068907-10-00-flux-5
  - type: status_change
    from: In Progress
    to: Done
    user: Agent
    date: '2026-05-07T12:13:27.3068907+10:00'
  - type: status_change
    from: Done
    to: Released
    user: Agent
    date: '2026-05-07T13:54:26.955Z'
order: 4
priority: High
effort: M
implementationLink: 14850b0
subtasks: []
version: v0.1.0
releasedAt: '2026-05-07T13:54:26.955Z'
releaseDocPath: release-notes/v0.1.0
---
## Summary

Add a full documentation section to Event Horizon that reads from a `.docs` directory, displays docs in a navigable hierarchy, supports inter-doc linking, and provides a WYSIWYG editor for authoring.

## Design Decisions (from Guy's input)

- ✅ **Top-level screen** — Docs will be a new screen accessible from the header nav (like Board/Backlog)
- ✅ **"New Doc" button** — Users can create docs from the sidebar UI
- ✅ **Wiki-style layout** — Desktop docs view should behave like a wiki with a left hierarchy rail and the editor open on the right
- ✅ **Hierarchy-first creation** — Users should be able to create docs from the relevant hierarchy/folder in the sidebar, not only from a global action
- ✅ **Always-on WYSIWYG editor** — No preview/edit toggle; the main right-hand pane stays in the editor experience
- ✅ **Rail-based ordering** — Ordering should come from drag-and-drop in the left wiki rail rather than a manual form field
- ✅ **Inline title editing** — The doc title should edit from the header/title chrome itself instead of a separate input block
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
- Sidebar behaves like the wiki navigation rail and takes roughly 20% of the page on desktop
- Expandable/collapsible folders
- Active doc highlighted
- Sortable via drag-and-drop in the left rail, persisted back to the `order` frontmatter field
- Search/filter bar at the top to quickly find docs by title
- Global "New Doc" affordance at the top of the sidebar
- Each folder/hierarchy level can create a new child doc directly from that spot in the tree

### 3. Inter-doc linking
- Support `[[doc-name]]` wiki-style links that resolve to other docs in the hierarchy
- Clicking a link navigates to that doc within the docs viewer
- Show broken link indicators for links that don't resolve

### 4. WYSIWYG editor (single page)
- The editor remains open in the right-hand pane; do not gate editing behind a preview/edit mode toggle
- Editing is WYSIWYG — text appears formatted as you type
- Use a library like Tiptap, Milkdown, or similar
- Full markdown toolbar (bold, italic, code, list, link, headings)
- Content stored as markdown in `.md` files
- Remove the standalone `order` field from the right pane
- Remove the standalone title input; clicking the header title should edit it inline
- Dirty state tracking and save confirmation

## Additional Features To Flesh Out

- Breadcrumbs/path header above the editor so deep docs remain orienting inside the hierarchy
- Rename and move flows for docs and folders directly from the wiki rail
- Backlinks or linked references so each doc can show who points to it
- Heading outline or table-of-contents panel for long docs

### 5. Edit permissions
- Config setting: `docsEditPermissions: "all" | "specified"` with a list of allowed users
- Default: `"all"` — everyone can edit
- Configurable from the Settings panel

## Acceptance Criteria

- [ ] `.docs/` directory is watched by the engine and served via API
- [ ] Portal has a new "Docs" screen accessible from the header
- [ ] Sidebar shows doc hierarchy with expand/collapse in a wiki-style left rail
- [ ] Sidebar supports creating a child doc from the relevant hierarchy/folder
- [ ] Sidebar supports drag-and-drop ordering and persists it via doc order metadata
- [ ] Clicking a doc keeps an always-on WYSIWYG editor open in the right pane
- [ ] Global and hierarchy-local doc creation flows create new documents
- [ ] Title editing happens inline from the header and the right pane no longer shows separate title/order fields
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

