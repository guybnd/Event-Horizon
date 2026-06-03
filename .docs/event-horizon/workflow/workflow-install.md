---
title: Workflow Install
order: 2
---
# Workflow Install

Event Horizon installs agent-facing workflow assets into a target repository so the workflow is both discoverable and always on. All supported frameworks receive the same workflow rules tailored to their configuration format.

## Source assets in this repo

-   `.flux/skills/event-horizon-agent.md` is the reusable skill document.
    
-   `.flux/skills/event-horizon-copilot-instructions.md` is the always-on instructions template used to patch instructions files.
    

## Installed assets by framework

| Framework | Skill Path | Instructions Patch |
|-----------|-----------|-------------------|
| GitHub Copilot | `.github/skills/event-horizon/SKILL.md` | `.github/copilot-instructions.md` |
| Claude Code | `.claude/rules/event-horizon.md` | Embedded in skill file |
| Gemini | `.gemini/skills/event-horizon.md` | Embedded in skill file |
| Cursor | `.cursor/rules/event-horizon.mdc` | Embedded in skill file |
| Windsurf | `.windsurf/rules/event-horizon.md` | Embedded in skill file |
| Generic | `.ai/skills/event-horizon.md` | Embedded in skill file |
    

## Install paths

-   From the portal Settings screen with the workflow install action.
    
-   From the CLI with `npm.cmd run install-skill -- --target <repo> --framework <copilot|cursor|cline|windsurf|claude|gemini|generic|auto>`.
    

## Settings-driven workflow controls

-   The Settings screen also shows the current workflow source paths, installed target paths, and a framework selector to choose your IDE/agent target (e.g. Cursor vs GitHub Copilot).
    
-   The Settings screen also surfaces a copyable CLI command so refresh behavior stays visible from the product.
    
-   The same workflow settings area lets the user choose which status acts as the user-input stage and which status acts as the ready-for-merge review stage.
    
-   Those selectors are backed by the existing board or hidden statuses. If a configured workflow status is missing, Settings surfaces that mismatch and offers a restore action instead of silently leaving the workflow half-configured.

## Why both assets matter

-   The skill explains the workflow in detail and gives agents a discoverable reference surface.
    
-   The Copilot instructions block makes the critical ticket rules always apply, even if the agent never reads the skill file explicitly.
    

## When to refresh the install

-   After changing either source workflow file under `.flux/skills/`.
    
-   After changing installer behavior or status-related workflow semantics.
    
-   Before validating a workflow documentation change end to end.

## Related docs

-   [[Project Overview]]
    
-   [[Code Map]]
    
-   [[Ticket Lifecycle]]
