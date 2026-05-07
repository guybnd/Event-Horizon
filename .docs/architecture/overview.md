---
title: Architecture Overview
order: 1
---
# Architecture Overview

Event Horizon is designed so the repository itself is the application's data store. The engine and portal sit on top of that filesystem state instead of replacing it with a remote service.

## Runtime layout

-   The engine is a local Node.js and TypeScript service that serves the API on `http://localhost:3001`.
    
-   The portal is a Vite and React app that serves the UI on `http://localhost:5173`.
    
-   Both runtime layers read from the same repository-backed sources: `.flux/` for tasks and workflow assets, and `.docs/` for project documentation.
    

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
    
3.  File watchers keep the UI state fresh when repo-backed content changes.
    

## Design implications

-   The fastest way to understand behavior is often to inspect the repo-backed source of truth first, not just the rendered UI.
    
-   Documentation, workflow rules, and product state are all versioned together, which makes ticket work easier to audit and easier for agents to continue.

## Related docs

-   [[Project Overview]]

-   [[Docs Workspace]]
    
-   [[Repository Map]]
    
-   [[Ticket Model]]
    
-   [[Workflow Install]]
