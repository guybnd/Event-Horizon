---
title: Architecture Overview
order: 1
---
# Architecture Overview

Event Horizon is designed so the repository itself is the application's data store. The engine and portal sit on top of that filesystem state instead of replacing it with a remote service.

## Runtime layout

Event Horizon is distributed as a single executable that bundles both the engine API and the portal UI.

- The binary starts a local server (defaulting to `http://localhost:3067`). The UI is served directly from this same origin.
- A **System Tray** manager keeps the service running in the background. Closing your browser does not stop the engine; you must explicitly quit from the tray or the portal header.
- Both runtime layers read from the same repository-backed sources: `.flux/` for tasks and workflow assets, and `.docs/` for project documentation.

## IDE Workspace Model

Event Horizon uses a dynamic workspace model similar to a code editor, allowing a single background process to manage multiple projects:

- **`workspaceRoot`**: The engine maintains the currently active workspace directory in memory.
- **`requireWorkspace` middleware**: API endpoints interacting with repo state use this middleware, which returns a `503 NO_WORKSPACE` status if a project hasn't been selected. The portal intercepts this and displays a workspace picker.
- **Settings persistence**: Your selected workspace is remembered across application restarts in `~/.event-horizon/settings.json`.
- **Port config**: Core networking settings are read from `event-horizon.config.json` located next to the executable.

## Storage model

### Tickets

-   Each ticket is a markdown file in `.flux/` with YAML frontmatter and a body.
    
-   Ticket history is append-only and records comments, status changes, and other activity entries.
    
-   The engine API is responsible for reading and persisting ticket changes.
    

### Documentation

-   Project docs are markdown files under `.docs/` with lightweight frontmatter such as `title` and `order`.
    
-   The docs tree is intended to be edited in-product and stored directly in the repo, so it stays close to the code and ticket work it describes.
    

### Workflow guidance

-   Reusable workflow source files live in `.flux/skills/`.
    
-   Installed workspace copies live under `.github/` and are refreshed through the workflow installer so source and installed behavior stay aligned.
    

## Request flow

1.  The portal calls the engine API for tasks, docs, and config.
    
2.  The engine reads or writes markdown files in the repository.
    
3.  File watchers keep the engine caches current, and the portal uses
	visibility-aware task polling against that API so board and backlog views
	update without a manual page refresh.

4.  When task data changes, the portal emits short-lived live-update events so
	newly created and moved tickets can animate into place instead of feeling
	like a hard rerender.
    

## Design implications

-   The fastest way to understand behavior is often to inspect the repo-backed source of truth first, not just the rendered UI.
    
-   Documentation, workflow rules, and product state are all versioned together, which makes ticket work easier to audit and easier for agents to continue.

## Related docs

-   [[Project Overview]]

-   [[Docs Workspace]]
    
-   [[Repository Map]]
    
-   [[Ticket Model]]
    
-   [[Workflow Install]]
