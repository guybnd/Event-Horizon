---
title: 'Global app settings: dedicated install location with first-boot config'
status: Grooming
priority: Medium
effort: M
assignee: unassigned
tags:
  - feature
  - engine
  - settings
createdBy: Guy
updatedBy: Agent
history:
  - type: activity
    user: Guy
    date: '2026-05-26T00:43:01.140Z'
    comment: Created ticket.
  - type: activity
    user: Agent
    date: '2026-05-26T00:43:59.426Z'
    comment: Updated description.
  - type: activity
    user: Guy
    date: '2026-05-26T00:48:42.146Z'
    comment: Updated description.
  - type: agent_session
    sessionId: b748815f-89e8-4062-96ef-c6e24d015b9c
    startedAt: '2026-05-26T00:48:43.319Z'
    status: cancelled
    progress: []
    user: Claude Code
    date: '2026-05-26T00:48:43.319Z'
    outcome: Session abandoned (engine restarted).
    endedAt: '2026-05-26T00:48:56.408Z'
implementationLink: ''
subtasks: []
id: FLUX-324
---
## Problem / Motivation

Currently `~/.event-horizon/settings.json` is a hardcoded path that stores the workspace list and last-active pointer. User preferences (theme, default username, preferred CLI framework) are scattered across localStorage, hardcoded defaults, and per-project config. There's no formal "install" concept — the directory just appears on first use with no user awareness or control.

For a multi-project tool that lives permanently on a user's machine, we need:

-   A well-defined, platform-appropriate global data directory
    
-   User-level preferences that persist across projects
    
-   First-boot configuration that lets the user choose or confirm the storage location
    
-   Future version upgrades should be able to locate the existing data directory without re-setup
    
-   A clear project bootstrapping strategy — what gets scaffolded into every new project workspace (skills, agent configs, default doc structure, config templates)
    

## Open Questions

1.  **Storage location strategy** — use platform conventions (`%APPDATA%/EventHorizon` on Windows, `~/Library/Application Support/EventHorizon` on Mac, `~/.config/event-horizon` on Linux) vs current `~/.event-horizon`? Platform-native is more "proper" but `~/.event-horizon` is simpler and cross-platform consistent.  
      
    we should use platform conventions
    
2.  **First-boot flow** — should the app show a one-time dialog letting the user confirm/change the data directory? Or just default to the platform path and surface it in Settings?  
      
    yes and to notify if one has been found already in the default location so he doesnt move it on accident and delete his progress or settings  
    
3.  **Discovery on upgrade** — if the location is configurable, how do future versions find it? Options: always check a known sentinel path first (e.g. `~/.event-horizon-pointer`), or rely on the binary being co-located with a config file (current `event-horizon.config.json` next to the exe).  
    check the known path according to platform convensions, im not sure what the implications of what you suggested if its better or not  
    
4.  **What belongs in global settings** — proposed: `workspaces[]`, `lastWorkspace`, `theme`, `defaultUser`, `preferredFramework`, `port`, `dataDir` (self-referential for migration). Anything else?  
    probably agent settings like whats the default agent to use in the project, various settings from preferences menu like board click behaviour, animations, timeouts, but NOT require comments and enable backlog, those should be maybe in the workspace setting now idk  
      
    
5.  **Migration** — need to migrate existing `~/.event-horizon/settings.json` users seamlessly on first boot of the new version.  
      
    yea  
    
6.  **Project bootstrapping** — when a user points at a new folder (no `.flux/`), what gets scaffolded automatically?
    
    -   Default `config.json` (statuses, columns, project key derived from folder name)
        
    -   Default agent skill files (`.claude/rules/`, copilot instructions, etc.) — currently handled by skill installer but only on explicit install
        
    -   Starter docs structure (`.docs/` with project overview, INDEX)
        
    -   Should bootstrapping be a guided wizard (pick which agents, customize statuses) or opinionated defaults with post-setup editing? should be highly opinionated but allow editing
        
    -   Should the global settings store a "project template" that users can customize once and have applied to all new projects? maybe add sub task for this to do later
