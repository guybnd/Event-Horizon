---
title: Docs Workspace
order: 4
---

# Docs Workspace

Event Horizon's docs experience is a repo-backed wiki over the `.docs/` tree.
The portal is not storing separate editor state in a remote system; it is
rendering and editing files that live beside the rest of the project.

## Storage model

- Each page is a markdown file under `.docs/`.
- Nested folders define the wiki hierarchy.
- Lightweight frontmatter stores `title` and `order`.
- Markdown remains the durable source of truth even though authoring happens in
  a WYSIWYG editor.

## Runtime flow

1. The engine watches `.docs/` alongside `.flux/`.
2. The docs API serves the tree and individual pages.
3. The portal renders the hierarchy in the left rail and the active page in the
   editor pane.
4. Saving writes markdown back to the selected file.

## Docs screen behavior

- The left rail is the wiki navigation surface.
- Folder structure comes from the directory layout under `.docs/`.
- Users can create pages globally or directly within a folder.
- Sibling page order is controlled from the left rail by drag-and-drop and is
  persisted back to the `order` field.
- The formatting toolbar stays sticky while the page scrolls so primary editing
  actions remain available deeper in long documents.
- The right pane keeps the editor open at all times instead of switching
  between preview and edit modes.

## Linking model

- Internal article references use wiki-style links such as `[[Project Overview]]`.
- The editor resolves those references by path, slug, or title.
- Broken wiki links are surfaced as broken references instead of disappearing.
- External URLs use the normal link mark and open outside the portal.

## Editing and save behavior

- The page title is edited inline from the header area.
- Toolbar buttons only render as active when the editor has an active text
  selection, which avoids stale pressed states when the cursor is collapsed or
  the editor is blurred.
- Dirty tracking is based on the editor document state rather than markdown byte
  equality, which avoids false unsaved markers caused by markdown
  normalization.
- Reset restores the editor to the last loaded file state.
- Save writes the current title and markdown body back to the selected doc.

## Permissions

- Docs editing is controlled from Settings.
- `docsEditPermissions` can allow everyone to edit or restrict editing to a
  configured user list.
- Users without edit access can still browse the wiki and follow links, but the
  editor becomes read-only.

## Main code touchpoints

- `engine/src/index.ts` owns docs loading, watching, and CRUD endpoints.
- `portal/src/components/DocsScreen.tsx` owns the editor, save flow, dirty
  tracking, and link behavior.
- `portal/src/components/DocsSidebar.tsx` owns hierarchy rendering, create
  affordances, and drag-ordering.
- `portal/src/components/Settings.tsx` owns docs permission configuration.

## Related docs

- [[Project Overview]]
- [[Architecture Overview]]
- [[Repository Map]]
- [[Workflow Install]]