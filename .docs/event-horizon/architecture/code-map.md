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
    
-   `engine/src/group.ts` is the **land-here-first** module for multi-repo groups. It loads the committed `group.json` (machine-independent member identity) plus an optional gitignored `group.local.json` (per-machine paths), resolves member checkout paths (default `../<name>`), validates the config, and scaffolds the canonical `.flux-group` docs store. It also projects the group for agents/portal (`summarizeGroup`, with live `pathExists`) and builds the always-on sibling-source scope args (`buildMemberScopeArgs` → `--add-dir`, consumed by both agent adapters). Purely additive — inert when no `group.json` is present (single-repo mode unchanged). Activated from `activateWorkspace` in `task-store.ts`. See [Multi-Repo Groups](multi-repo-groups.md).
    
-   `engine/src/group-setup.ts` is the **land-here-first** module for *creating* a group (recreatability). `planGroupSetup()` computes every intrusive action (write `group.json`, patch `.gitignore`, scaffold the store, register/clone each member) with **zero git mutation** and returns a structured plan; `applyGroupSetup()` performs the writes only when asked, with per-member isolation and an injectable git runner for testing. `validateGitRemote()` screens every member `remote` before it reaches git (rejects shell metacharacters, `ext::`/`fd::`, `--upload-pack`/`--receive-pack`). Surfaced headless via `engine/src/init-group.ts` (`npm run init-group`) and `engine/src/routes/group.ts` (`POST /api/group/plan` + `/apply`). The first slice registers existing checkouts; cloning is reported but not auto-performed. See [Multi-Repo Groups](multi-repo-groups.md).
    
-   `engine/src/group-sync.ts` is the **land-here-first** module for *fanning out* the canonical group docs (single-writer mirror). `syncGroup()` chains `ensureCanonicalBranch()` (promotes the plain `.flux-group` scaffold to a worktree on the `flux-group-docs` orphan branch — evacuate content → `worktree add [--orphan]` → restore, idempotent) → `commitCanonicalDocs()` (commits only when the worktree is dirty) → `fanOutGroupDocs()` (pushes the branch **by declared remote URL** to each member, fast-forward only, never `--force`). Every member is validated through `validateGitRemote` first; pushes are per-member isolated and a non-fast-forward rejection is reported as `diverged: true` rather than aborting the run. Injectable `GitRunner` for unit testing. Surfaced via `POST /api/group/sync`. See [Multi-Repo Groups](multi-repo-groups.md).
    
-   `engine/src/group-edit.ts` is the **land-here-first** module for *push-through-parent* sub-repo edits (FLUX-397). `submitGroupEdit()` applies a member's doc change into the canonical store and re-fans-out (`syncGroup`), **serialized** via an in-process promise chain so concurrent submissions never interleave on the shared worktree (the parent is the sole writer). The pure, security-critical core — `applyEditsToStore()` — validates every edit `path` (rejects absolute paths, `..` traversal, and writes into the worktree `.git`) up front so a bad edit aborts before any write, then applies create/update/delete. Surfaced via `POST /api/group/submit-edit`. Member-side fast-forward of the local mirror is deferred (decision C2). See [Multi-Repo Groups](multi-repo-groups.md).

-   Cross-project **group docs surface read-only in the portal** (FLUX-399) via `engine/src/task-store.ts`: `loadGroupDocs()` / `loadGroupDoc()` map the canonical group store into the docs cache under the `Product/` prefix (each `DocRecord` carries `readOnly: true` + `group: true`), and `startGroupDocsWatcher()` (chokidar) reloads them on change. Activated from `activateWorkspace`; a no-group repo no-ops. The docs routes (`engine/src/routes/docs.ts`) return **403** for any `POST` under `Product/` and for `PUT`/`DELETE` on a `readOnly` doc. Portal: `DocsScreen.tsx` renders the subtree read-only with a membership panel (`fetchGroupStatus`), and `DocsSidebar.tsx` takes a `readOnlyPrefix` prop that suppresses create + drag in the subtree. See [Multi-Repo Groups](multi-repo-groups.md).

-   The portal **feature-map landing** (FLUX-403) lives in `portal/src/components/DocsScreen.tsx`: on the docs landing with a configured group, `Product/features/*` docs render as a card grid (title + summary + per-feature member-role chips, participation inferred by member-name mention) instead of the empty state, with a "View feature map" button in the membership panel to return. Pure portal — no engine change. See [Multi-Repo Groups](multi-repo-groups.md).
    
-   `engine/src/group-integration.test.ts` is the **real-git** end-to-end check for the group flow (FLUX-400). Unlike the unit suites (which inject a fake `GitRunner`), it drives the default git runner against local bare repos (`allowLocalRemotes: true`, no network): fan-out (`syncGroup` → canonical worktree → commit → push, member reads docs offline, parent `master` untouched), push-through-parent (`submitGroupEdit` re-fan-out reaches the member), and fan-out safety (a diverged member branch is reported `diverged: true` / `ok: false`, never force-pushed). See [Multi-Repo Groups](multi-repo-groups.md).
    
-   `engine/src/session-store.ts` is the **land-here-first** module for CLI-session
	state and orchestration sequencing. Besides the session registries, it owns the
	**scatter-gather fan-in barrier**: a deferred combiner is registered against a
	run group's `groupId` (`registerPendingCombiner`), and `notifyGroupSessionTerminal`
	— called by each adapter when a session reaches a terminal state — spawns the
	combiner only once every worker (`patternPosition: 'step'`) in the group is
	terminal and at least `expectedWorkers` have registered. The actual launch is
	delegated through `setCombinerLauncher` (injected by `routes/cli-session.ts`) to
	avoid an import cycle. This is why scatter-gather combiners no longer race their
	workers (the FLUX-281 failure mode).
    
-   `engine/src/routes/cli-session.ts` owns the CLI-session REST routes. `spawnSession`
	is the single build-register-launch path shared by the `start` route and the
	deferred-combiner launcher. The `register-combiner` / `unregister-combiner` routes
	manage the fan-in barrier from the portal. Both `start` and `register-combiner`
	accept a `personaId` and resolve the prompt server-side via
	`resolvePersonaPrompt(...)`.

-   `engine/src/orchestration-personas.ts` is the **land-here-first** module for
	reviewer/orchestrator persona prompts. It owns the built-in persona catalog
	(`ORCHESTRATION_PERSONAS`, `ORCHESTRATOR_PERSONA`, each tagged with a `phase`
	and `builtIn: true`) — a curated roster spanning all phases: grooming
	(`context-scout`, `requirements-interrogator`, `planner`), implementation
	(`test-engineer`, `implementer`), review (`senior-dev`, `qa-correctness`,
	`security-auditor`, plus `angry-linus`/`architect`/`perf-expert`/`ux-expert`),
	and finalize (`finalizer`, `docs-auditor`, `committer`, `ticket-curator`,
	`pr-merger`) — and the resolver
	(`resolvePersonaPrompt(personaId, focusComment?)`). It also owns the
	**custom persona store**: user-authored personas persist as JSON under
	`<fluxDir>/personas/*.json` (`loadCustomPersonas` at startup,
	`saveCustomPersona` / `deleteCustomPersona` / `getEditablePersona`,
	`validatePersona`) and are merged with the built-ins by `getPersonaById` and
	`listSelectablePersonaMeta(phase?)`. Built-ins are **viewable but read-only**
	(`getEditablePersona` returns them so the UI can show the prompt and offer a
	fork); `saveCustomPersona` refuses ids that collide with a built-in, so the
	curated set stays owned by Event Horizon and is updated via app releases. The
	portal fetches metadata via `GET /api/orchestration/personas` and reads/edits
	full personas through the CRUD routes in `engine/src/routes/orchestration.ts`.

-   `engine/src/models/workflow.ts` owns reusable **workflow templates**
	(per-phase pattern + persona membership). It ships a code-defined roster
	(`BUILTIN_WORKFLOWS`, each `builtIn: true`): a single-agent and a multi-agent
	template per phase, keyed `builtin-<phase>-single` / `builtin-<phase>-multi`.
	Custom templates persist under `<fluxDir>/workflows/*.json`; `loadWorkflows`
	merges built-ins first, `isBuiltInWorkflow(id)` guards `saveWorkflow` /
	`deleteWorkflow` (built-ins are read-only, updated via releases — duplicate to
	customize). Exposed through `engine/src/routes/workflows.ts` (`/api/workflows`;
	PUT/DELETE return 400 for built-in ids). Per-phase launch defaults are stored on
	`config.phaseDefaults[phase].single` / `.multi` (each a template id; falls back
	to `builtin-<phase>-<variant>`). The legacy board-wide `config.defaultWorkflowId`
	still exists but is superseded by the per-phase defaults.
    
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
	Participants reference a persona by `personaId` (+ optional `focusComment`);
	prompt text is resolved server-side. `ReviewPersona` is metadata-only — fetch
	the catalog with `fetchOrchestrationPersonas()`.
	`runParallelReviews(...)` / `launchOrchestratedReview(...)` are thin code-review
	presets over it. Add new launch entry points here, not by calling
	`startTaskCliSessionEx` directly.

-   `portal/src/components/OrchestrationLauncher.tsx` is the **generic
	pattern-first launch modal**: pick an orchestration pattern (Scatter-gather /
	Parallel / Serialized / Hand-off), select participant roles from a catalog
	fetched from `GET /api/orchestration/personas?phase=<phase>` on open
	(phase-aware — grooming / implementation / review / finalize — and
	pattern-gated via `compatiblePatterns`), see a live `OrchestrationTopology`
	preview, and
	launch with partial-failure reporting. A **Template** dropdown lists every
	built-in and custom template defining a config for the current phase; selecting
	one re-applies its pattern + personas, and manual edits reset it to "Custom".
	On open it pre-populates from an `initialTemplateId` prop (the card's
	Single/Multi choice) or, failing that, the phase's single default
	(`resolvePhaseDefaultId(config.phaseDefaults, phase, 'single')`).
	When exactly **one** participant is selected the launcher treats it as a
	**standalone single agent**: the pattern selector is hidden and the run is
	always launchable (it bypasses orchestration gating). Consumers branch on
	`plan.personas.length === 1` → `runAgentAction({ action: { kind: 'persona', … } })`
	vs `launchOrchestration(...)` for teams, using `phaseCombiner(phase)` for the lead.
	Code review is one configuration of it.
	Claude Code is the only framework wired for now (no per-row framework picking);
	`serialized` / `handoff` are shown but gated (`launchable: false`) until the
	engine can sequence them. Opened from both `TaskModal` and `TaskCard`.

-   `portal/src/components/WorkflowBuilder.tsx` is the **Workflows screen** (backed
	by `/api/orchestration/personas`, `/api/workflows`, and `/api/config`). Three
	tabs: **Personas** (per-phase; built-ins are viewable read-only with a
	"Duplicate & Edit" fork, custom personas create/edit/delete),
	**Templates** (grouped by phase, each phase split into Single / Multi columns by
	persona count; a per-column star sets `config.phaseDefaults[phase].single` /
	`.multi` via `handleSetPhaseDefault`; cards show resolved pattern + ordered
	persona chips), and **Skills** (skills persist as docs under the
	`skills/` directory).

-   `portal/src/components/CodeReviewButton.tsx` owns the entry button (compact +
	full variants) that opens the `OrchestrationLauncher`. Used by both `TaskModal`
	and `TaskCard`.

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
	the create/move animation treatment for live board updates. Every card (and the
	"Ready" column) exposes **Single** / **Multi** agent controls that map the
	ticket status to a launch phase (`statusToPhase`) and open `OrchestrationLauncher`
	pre-set to `builtin-<phase>-single` / `builtin-<phase>-multi`; the multi launch
	adds the phase combiner (`planner` for grooming, else `orchestrator`).
    
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
    
-   Prompt or review workflow changes: check `engine/src/orchestration-personas.ts` (reviewer/orchestrator prompts + resolver), `portal/src/agentActions.ts` (launch helper + command registry), `portal/src/components/TaskModal.tsx`, `portal/src/components/Settings.tsx`, `.flux/config.json`, and the workflow asset templates under `.flux/skills/`.
    
-   Docs experience changes: check `portal/src/components/DocsScreen.tsx`, `portal/src/components/DocsSidebar.tsx`, and the docs endpoints in `engine/src/index.ts`.

## Related docs

-   [[Project Overview]]
    
-   [[Architecture Overview]]
    
-   [[Ticket Model]]
    
-   [[Ticket Interactions]]
    
-   [[Workflow Install]]
