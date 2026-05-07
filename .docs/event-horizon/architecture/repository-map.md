---
title: Repository Map
order: 2
---
# Repository Map

This page is the quick orientation guide for where behavior lives today.

## Product surfaces

-   `engine/src/index.ts` owns the main task, docs, and config API plus the repo watchers that keep the UI in sync with `.flux/` and `.docs/`.
    
-   `engine/src/workflow-installer.ts` owns workflow asset installation into a target repository.
    
-   `engine/src/skill-installer.ts` is the CLI entrypoint used by the workspace `install-skill` command.
    
-   `portal/src/App.tsx` wires the top-level screens.
    
-   `portal/src/AppContext.tsx` coordinates view state, routing-like context,
	and the shared live task polling plus change-event state used by board,
	backlog, and header surfaces.
    
-   `portal/src/api.ts` is the portal's client for engine endpoints.
    

## Portal components to check first

-   `portal/src/components/Board.tsx` and `Column.tsx` render the board lanes
	and consume the live ticket arrival cues.
    
-   `portal/src/components/TaskCard.tsx` handles card-level interactions and
	the create/move animation treatment for live board updates.
    
-   `portal/src/components/TaskModal.tsx` is the main full-ticket editing surface.
    
-   `portal/src/components/DocsScreen.tsx` is the primary docs workspace.
    
-   `portal/src/components/DocsSidebar.tsx` owns docs tree navigation.
    
-   `portal/src/components/Settings.tsx` owns workflow install and settings UI.
    

## Repo-backed data surfaces

-   `.flux/*.md` are the canonical ticket files.
    
-   `.flux/config.json` defines statuses, hidden statuses, tags, priorities, and workflow status names.
    
-   `.docs/**/*.md` are the project docs exposed inside the portal.
    
-   `.flux/skills/event-horizon-agent.md` is the source skill document.
    
-   `.flux/skills/event-horizon-copilot-instructions.md` is the source always-on Copilot instructions template.
    

## Common change paths

-   Ticket schema or workflow behavior: start in `engine/src/index.ts`, then check `portal/src/types.ts`, `portal/src/api.ts`, and the relevant UI screen.
    
-   Prompt or review workflow changes: check `portal/src/components/TaskModal.tsx`, `portal/src/components/Settings.tsx`, `.flux/config.json`, and the workflow asset templates under `.flux/skills/`.
    
-   Docs experience changes: check `portal/src/components/DocsScreen.tsx`, `portal/src/components/DocsSidebar.tsx`, and the docs endpoints in `engine/src/index.ts`.

## Related docs

-   [[Project Overview]]
    
-   [[Architecture Overview]]
    
-   [[Ticket Model]]
    
-   [[Ticket Interactions]]
    
-   [[Workflow Install]]
