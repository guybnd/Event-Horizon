---
title: Code Map
order: 2
---
# Code Map

This page is the quick orientation guide for where behavior lives today — file by file. Pair it with [[Architecture Overview]] for the conceptual model and the subsystem table in the docs [[Documentation Index]].

## Product surfaces

-   `engine/src/index.ts` owns the main task, docs, and config API plus the repo watchers that keep the UI in sync with `.flux/` and `.docs/`.
    
-   `engine/src/workflow-installer.ts` owns workflow asset installation into a target repository.
    
-   `engine/src/skill-installer.ts` is the CLI entrypoint used by the workspace `install-skill` command.

-   `engine/src/branch-manager.ts` owns all git plumbing for per-ticket branches: create, status, delete (local + remote), PR creation via `gh`, and the `finish_ticket` diff capture (numstat summary + unified-diff sidecar at `<flux-dir>/<ID>.diff`).
    
-   `portal/src/App.tsx` wires the top-level screens.
    
-   `portal/src/AppContext.tsx` coordinates view state, routing-like context,
	and the shared live task polling plus change-event state used by board,
	backlog, and header surfaces.
    
-   `portal/src/api.ts` is the portal's client for engine endpoints.

-   `portal/src/agentActions.ts` is the **single composition layer** for
	launching agent CLI sessions. Every button that starts an agent (card
	context menu, card quick-actions, modal CLI panel, modal Finish/Grooming,
	Code Review picker) routes through `runAgentAction(...)`. For multi-agent
	runs, use the generic `launchOrchestration(...)` — it takes a pattern-first
	`OrchestrationMode` (from `ORCHESTRATION_MODES`) plus ordered participants and
	an optional combiner/lead, and stamps the shared `groupId` + pattern metadata.
	`runParallelReviews(...)` / `launchOrchestratedReview(...)` are thin code-review
	presets over it. Add new launch entry points here, not by calling
	`startTaskCliSessionEx` directly.

-   `portal/src/components/OrchestrationLauncher.tsx` is the **generic
	pattern-first launch modal**: pick an orchestration pattern (Scatter-gather /
	Parallel / Serialized / Hand-off), select participant roles from a catalog
	(review personas today), see a live `OrchestrationTopology` preview, and
	launch with partial-failure reporting. Code review is one configuration of it.
	Claude Code is the only framework wired for now (no per-row framework picking);
	`serialized` / `handoff` are shown but gated (`launchable: false`) until the
	engine can sequence them. Opened from both `TaskModal` and `TaskCard`.

-   `portal/src/components/CodeReviewButton.tsx` owns the entry button (compact +
	full variants) that opens the `OrchestrationLauncher`, and re-exports the
	review persona catalog. Used by both `TaskModal` and `TaskCard`.

-   `portal/src/orchestration.ts` is the **land-here-first** module for
	multi-agent run logic on the portal side. It groups a ticket's
	`cliSessions[]` into runs by shared `groupId`, aggregates per-run status,
	and derives the topology shape / labels. Pure functions, no React. Paired
	with `portal/src/components/OrchestrationTopology.tsx`, which renders the
	run shape as a compact glyph (cards/popover) or a per-agent node map
	(modal Run View).

-   `portal/src/components/task-modal/RunView.tsx` is the modal surface for a
	live multi-agent run: topology map header, per-agent collapsible output,
	per-session and group-level Stop, and the scatter-gather barrier banner.
	Single-session tickets still use `task-modal/CliSessionPanel.tsx`;
	`TaskModal` switches to `RunView` when an active 2+ session group exists.


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
    
-   Prompt or review workflow changes: check `portal/src/agentActions.ts` (launch helper + persona/command registries), `portal/src/components/TaskModal.tsx`, `portal/src/components/Settings.tsx`, `.flux/config.json`, and the workflow asset templates under `.flux/skills/`.
    
-   Docs experience changes: check `portal/src/components/DocsScreen.tsx`, `portal/src/components/DocsSidebar.tsx`, and the docs endpoints in `engine/src/index.ts`.

## Related docs

-   [[Project Overview]]
    
-   [[Architecture Overview]]
    
-   [[Ticket Model]]
    
-   [[Ticket Interactions]]
    
-   [[Workflow Install]]
