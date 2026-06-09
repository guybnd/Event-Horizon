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
    
-   `engine/src/group.ts` is the **land-here-first** module for multi-repo groups. It loads the committed `group.json` (machine-independent member identity) plus an optional gitignored `group.local.json` (per-machine paths), resolves member checkout paths (default `../<name>`), validates the config, and scaffolds the canonical `.flux-group` docs store. It also projects the group for agents/portal (`summarizeGroup`, with live `pathExists`) and builds the always-on sibling-source scope args (`buildMemberScopeArgs` → `--add-dir`, consumed by both agent adapters). For the **member side (FLUX-405, Case 1)** it owns the reverse-lookup binding: `activateMemberBinding()` scans the registered workspaces for a parent whose `group.json` lists this repo's `origin` remote — compared via `normalizeRemoteForCompare()` (collapses https/ssh/scp spellings) and discovered without scaffolding via `peekGroupMembers()` — and binds the parent's `GroupContext` (`getMemberBinding()`); a repo that is itself a parent never binds. The same reverse-lookup, applied across the **whole** registry, powers `resolveWorkspaceGroups(roots)` (FLUX-415) — it tags each registered root as a group `parent`/`member` so `GET /api/workspaces` (`engine/src/routes/workspaces.ts`) can attach a `group` descriptor and the portal can render grouped repos nested together. `groupDocPathToStoreRelative(path, prefix)` maps a `<label>/<…>` doc path back to a store-relative file for edits (the prefix defaults to the active group's label). The docs label is **configurable per group** (`group.json` `docsLabel`, default `Product`) — resolve it with `groupDocsLabel(group)` / `activeGroupDocsLabel()`; it's a display prefix only, so changing it never moves files (FLUX-414). `summarizeGroup` carries an optional `membership` descriptor (`{ role: 'parent' | 'member', groupName, parentRoot, memberName?, memberRole? }`, **FLUX-412**) plus `docsLabel`, attached by `GET /api/group` and the `get_project_group` MCP tool from `getGroupContext()` (parent) or `getMemberBinding()` (member) so a member workspace can show it belongs to a group while keeping `configured: false`. Purely additive — inert when no `group.json` is present (single-repo mode unchanged). Activated from `activateWorkspace` in `task-store.ts`. See [Multi-Repo Groups](multi-repo-groups.md).
    
-   `engine/src/group-setup.ts` is the **land-here-first** module for *creating* a group (recreatability). `planGroupSetup()` computes every intrusive action (write `group.json`, patch `.gitignore`, scaffold the store, register/clone each member) with **zero git mutation** and returns a structured plan; `applyGroupSetup()` performs the writes only when asked, with per-member isolation and an injectable git runner for testing. `validateGitRemote()` screens every member `remote` before it reaches git (rejects shell metacharacters, `ext::`/`fd::`, `--upload-pack`/`--receive-pack`). It also owns the **Case-1 registration guardrail (FLUX-408)**: plan + apply register the dedicated parent and every present member as EH workspaces (injectable `listWorkspaces`/`registerWorkspace`, defaulting to `getWorkspacesList`/`addWorkspaceEntry`) so the member binding (FLUX-405) can reverse-look-up the parent; `ensureGroupRegistered(parentRoot, { dryRun })` is the idempotent **backfill** that brings an already-configured group's registry up to Case 1 without rewriting `group.json` (`dryRun` reports the gap without writing — drives the detect-on-activation consent prompt). Surfaced headless via `engine/src/init-group.ts` (`npm run init-group`) and `engine/src/routes/group.ts` (`POST /api/group/plan` + `/apply` + `/ensure-registered`). The first slice registers existing checkouts; cloning is reported but not auto-performed. See [Multi-Repo Groups](multi-repo-groups.md).
    
-   `engine/src/group-discovery.ts` is the **land-here-first** module for the **onboarding/migration wizard (FLUX-407)** — the read-only discovery + one-shot creation that the portal `GroupWizard` drives. `scanFolderForRepos(folder)` enumerates the *immediate* child git repos of a folder (no recursion, skips `node_modules`/`.git`/`.flux-group`/etc.), reading each repo's `origin` remote, whether it's already a registered EH workspace, and whether it's itself a group parent (via `peekGroupMembers`); `discoverFromRegistry()` projects the existing workspace registry the same way. `createDedicatedParent()` is the **dedicated-parent constructor**: it validates the group name + members (reusing `validateGitRemote` from `group-setup.ts`), **refuses to clobber an existing `group.json`**, then `mkdir`s the parent, `git init`s it (skipped if already a repo), scaffolds the `.flux-group` store, writes `group.json`, pins each member's discovered local `path` into a gitignored `group.local.json` (so the parent resolves members regardless of where it sits), registers the parent as an EH workspace labeled with the group name, and **registers every member whose checkout exists on disk** (labeled with the member name) — returning a `memberRegistrations[]` report that flags any member with no supplied path or a path that isn't checked out (registration failures are non-fatal). Git + registry are injectable for testing. Surfaced via `engine/src/routes/group.ts` (`GET /api/group/discover/registry`, `POST /api/group/discover/folder`, `POST /api/group/create-parent`). Repairing/appending to an *already-configured* group routes through `ensureGroupRegistered` (FLUX-408) instead, since `createDedicatedParent` only creates new parents. See [Multi-Repo Groups](multi-repo-groups.md).
    
-   `engine/src/group-promote.ts` is the **land-here-first** module for **promoting existing `.docs/` into the group store (FLUX-404)** — the bridge between a repo's main-branch docs and the `flux-group-docs` canonical store, with **move semantics** (mirrors the ticket-migration precedent in `storage-sync.ts`). `planDocsPromotion(parentRoot)` walks `.docs/` (zero mutation) and proposes a store-relative target per file (default `features/<basename>`, retargetable). `collectPromotions(sourceRoot, selections, storeDir?)` is the pure, unit-testable core: it validates every source is under `.docs/` and every target is inside the store (rejecting `..`/absolute/`.git`), reads content, and aborts the batch up front on a bad path — `storeDir` defaults to the source repo's own store but a member passes the **parent's** store. `applyDocsPromotion(group, selections, { gitRunner? })` performs the **parent-origin** move — write into the `.flux-group` worktree, `git rm` each source from main, commit the removals, then `syncGroup` to commit on `flux-group-docs` and fan out. `applyMemberDocsPromotion(memberRoot, parentGroup, selections, { gitRunner? })` performs the **member-origin** move (FLUX-406, push-through-parent): read the member's own `.docs/`, write the content into the store *through the parent* (`submitGroupEdit`), then `git rm` each source from the member's own main; the doc returns as a read-only group doc. Both share `removeSourceFromMain`/`commitDocsRemovals` helpers and an injectable `GitRunner`. The route resolves origin via `getGroupContext()` (parent) ?? `getMemberBinding()` (member). Surfaced via `POST /api/group/promote-docs/plan` + `/apply` and the portal `DocsPromotionPanel`. See [Multi-Repo Groups](multi-repo-groups.md).
    
-   `engine/src/group-sync.ts` is the **land-here-first** module for *fanning out* the canonical group docs (single-writer mirror). `syncGroup()` chains `ensureCanonicalBranch()` (promotes the plain `.flux-group` scaffold to a worktree on the `flux-group-docs` orphan branch — evacuate content → `worktree add [--orphan]` → restore, idempotent) → `commitCanonicalDocs()` (commits only when the worktree is dirty) → `fanOutGroupDocs()` (pushes the branch **by declared remote URL** to each member, fast-forward only, never `--force`) → `refreshMemberWorktrees()` (local same-machine fast-forward, see below). Every member is validated through `validateGitRemote` first; pushes are per-member isolated and a non-fast-forward rejection is reported as `diverged: true` rather than aborting the run. Injectable `GitRunner` for unit testing. Surfaced via `POST /api/group/sync`. See [Multi-Repo Groups](multi-repo-groups.md).

-   `engine/src/group-member-worktree.ts` is the **land-here-first** module for *member-local group docs worktrees* (FLUX-422). `attachMemberWorktree(memberRoot, parentRoot)` fetches `flux-group-docs` from the parent's local git repo by filesystem path (no internet or configured remote needed), creates a worktree at `memberRoot/.flux-group/` on a local branch, and ensures `/.flux-group/` in the member's `.gitignore`. Idempotent — a subsequent call fast-forwards the existing worktree via `reset --hard`. `refreshMemberWorktrees(group)` loops over all present members and calls `attachMemberWorktree` for each; called by `syncGroup` after every canonical commit. `detachMemberWorktree(memberRoot)` removes the worktree + tracking ref on unbind. `buildGroupDocsScopeArg(memberRoot)` returns `['--add-dir', <storeDir>]` when the local worktree exists AND the workspace is a bound member (not a parent whose cwd already covers `.flux-group`); spread into agent spawn args in `copilot.ts` and `claude-code.ts` (FLUX-422). Tested in `group-member-worktree.test.ts` (12 tests against real git). See [Multi-Repo Groups](multi-repo-groups.md).

-   `engine/src/group-edit.ts` is the **land-here-first** module for *push-through-parent* sub-repo edits (FLUX-397). `submitGroupEdit()` applies a member's doc change into the canonical store and re-fans-out (`syncGroup`), **serialized** via an in-process promise chain so concurrent submissions never interleave on the shared worktree (the parent is the sole writer). The pure, security-critical core — `applyEditsToStore()` — validates every edit `path` (rejects absolute paths, `..` traversal, and writes into the worktree `.git`) up front so a bad edit aborts before any write, then applies create/update/delete. Surfaced via `POST /api/group/submit-edit`, which (FLUX-406) accepts either the active parent group **or** a bound member's `parentGroup` as the writer. In Case 1 a member never produces a diff — `docs.ts` calls `submitGroupEdit(parentContext, …)` directly in-process. **MCP write tools** `submit_group_doc` and `delete_group_doc` (FLUX-420) in `mcp-server.ts` wrap the same transport so agents can write/delete group docs from any workspace. See [Multi-Repo Groups](multi-repo-groups.md).

-   Cross-project **group docs surface in the portal** (FLUX-399) via `engine/src/task-store.ts`: `loadGroupDocs()` / `loadGroupDoc()` map the canonical group store into the docs cache under the group docs label (`activeGroupDocsLabel()`, default `Product/`; each `DocRecord` carries `group: true`, `readOnly: true` **only when no writer resolves at all** (`getGroupContext() == null && getMemberBinding() == null`), and `viaParent: true` on a bound member so the editor knows the write routes through the parent — both the parent's own group docs *and* a bound member's load editable, FLUX-414/FLUX-419), and `startGroupDocsWatcher()` (chokidar) reloads them on change. The store dir is resolved by `activeGroupStoreDir()`, which (FLUX-405) falls back from the active parent group to a bound member's `parentGroup.groupStoreDir` — so a **member workspace surfaces the parent's group docs in place** with no worktree of its own. Activated from `activateWorkspace` (after `activateMemberBinding`); a no-group, non-member repo no-ops. The docs routes (`engine/src/routes/docs.ts`) route **all** group-doc writes (POST/PUT/DELETE, gated on `doc.group`) through one writer context — `getGroupContext() ?? getMemberBinding()?.parentGroup` — mapping the path via `groupDocPathToStoreRelative()` and calling `submitGroupEdit()` (write → commit → fan-out), so the **parent edits in place** (FLUX-414) and a **member pushes through the parent** (FLUX-406/FLUX-419) over the same path; a `403` now only fires when no writer resolves. Portal: `DocsScreen.tsx` derives the label from `groupStatus.docsLabel` for the feature filter + explanation, and uses the pure `resolveDocEditability(doc, canEditDocs)` helper (in `utils.ts`, unit-tested) to make a bound member's group doc editable and show a "saved through the parent" banner; the member-only `readOnlyPrefix` is dropped so create/reorder match editing (FLUX-419). See [Multi-Repo Groups](multi-repo-groups.md).

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
