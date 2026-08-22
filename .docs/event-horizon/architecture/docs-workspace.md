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
- Frontmatter stores `title` and `order`; any other key (`sources`,
  `last_verified`, `publish`, …) is retained verbatim across saves rather than
  being dropped (FLUX-1650) — `title`/`order` always override retained values.
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

## Rich text vs. Markdown mode (FLUX-1654)

The WYSIWYG editor always serializes its full document back to markdown via
TipTap → turndown on save, which reformats markdown it never touched (bullet
markers, emphasis delimiters, ordered-list renumbering, table padding) — a
one-word edit could otherwise produce a whole-file diff. To keep saves
diff-clean for docs-as-code content, the editor supports a second mode:

- **Rich text** — the existing WYSIWYG editor (TipTap). Unchanged behavior.
- **Markdown** — a plain textarea bound to the doc's body markdown with zero
  transformation on load or save. It never runs marked or turndown, so a no-op
  save round-trips to a byte-identical file and a single-line edit diffs only
  that line.
- The mode defaults per doc from front-matter: a doc carrying front-matter keys
  beyond `title`/`order` (the retained-extras signal from FLUX-1650, the
  docs-as-code population) opens in **Markdown**; other docs open in
  **Rich text**.
- A segmented toggle next to the Editor/History tabs lets any doc switch modes.
  Switching carries content across without loss (Rich text → Markdown mirrors
  the turndown-rendered markdown already kept in sync via edits; Markdown →
  Rich text renders the current markdown draft back into TipTap). Saving after
  a switch into Rich text re-applies turndown normalization by design — the
  byte-identical guarantee only holds for edits made entirely in Markdown mode.
- Front matter stays out of the body editor in both modes; it is rebuilt
  engine-side from the retained `extraFrontmatter` (FLUX-1650), independent of
  this toggle.

## Save as revision (FLUX-1655)

When `docsCommitOnSave` resolves true (see below), Save prompts for a short
message and turns the write into a git commit — pathspec-scoped to that one
file — so it shows up as its own entry in the doc's History tab (FLUX-1653)
instead of a silent overwrite.

- `docsCommitOnSave` has no static default: an explicit choice saved in
  Settings always wins; otherwise the engine resolves it to whether the
  workspace root is itself a git working tree (an orphan `.flux-store`
  workspace has no repo at its root to commit into). Off, or on a group doc,
  Save behaves exactly as before this ticket — no prompt, no commit.
- The commit author is the current portal user; the commit message is
  whatever the user typed in the prompt.
- **Conflict guard:** the doc's `hash` (a hash of the on-disk markdown as of
  load) is echoed back on save as `baseHash`. If the file changed on disk
  since the editor loaded it (an edit landed outside the viewer), the save is
  rejected with a "doc changed on disk" banner offering **Reload doc** instead
  of silently overwriting the other edit.

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
- [[Code Map]]
- [[Workflow Install]]