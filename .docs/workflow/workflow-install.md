---
title: Workflow Install
order: 2
---
# Workflow Install

Event Horizon installs two Copilot-facing assets into a target repository so the workflow is both discoverable and always on.

## Source assets in this repo

-   `.flux/skills/event-horizon-agent.md` is the reusable skill document.
    
-   `.flux/skills/event-horizon-copilot-instructions.md` is the always-on instructions template used to patch Copilot instructions.
    

## Installed assets in a target repo

-   `.github/skills/event-horizon/SKILL.md`
    
-   `.github/copilot-instructions.md`
    

## Install paths

-   From the portal Settings screen with the workflow install action.
    
-   From the CLI with `npm.cmd run install-skill -- --target <repo> --framework copilot`.
    

## Why both assets matter

-   The skill explains the workflow in detail and gives agents a discoverable reference surface.
    
-   The Copilot instructions block makes the critical ticket rules always apply, even if the agent never reads the skill file explicitly.
    

## When to refresh the install

-   After changing either source workflow file under `.flux/skills/`.
    
-   After changing installer behavior or status-related workflow semantics.
    
-   Before validating a workflow documentation change end to end.

## Related docs

-   [[Project Overview]]
    
-   [[Repository Map]]
    
-   [[Ticket Lifecycle]]
