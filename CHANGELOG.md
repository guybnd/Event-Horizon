# Changelog

Notable changes are summarized here; detailed per-version notes for the dev line live in [`.docs/release-notes/`](.docs/release-notes/).

## [1.4.0] — the persona overhaul: server-composed prompts, new specialist agents, and structured handoffs

The headline is **the persona system**: prompts composed server-side from a shared phase contract, four new specialist personas, and a consolidated roster — plus machine-readable completion handoffs and first-class acceptance criteria. Full notes: [`.docs/release-notes/v1.4.0.md`](.docs/release-notes/v1.4.0.md).

### Personas — server-composed prompts + new specialists

- **Server-side prompt composition** — persona prompts are built from a shared phase contract plus a per-persona lens instead of hand-maintained parallel prompt files (#359's drift fixes made structural in FLUX-1170), with a new dedicated review-phase skill module (FLUX-1171) and shared invariants hoisted into the orchestrator module (FLUX-1172). The drift itself — commit-before-Ready, sole-reviewer `reviewState`, diff base — was fixed first (#359).
- **Four new specialists** — the Furnace Operator **"Smelter"**, a furnace-owning chat persona that curates, ignites, and shepherds batches (#373, #389); a **DRY / Reuse & Simplicity reviewer** (#366); the **Regrounder**, executing the FLUX-1048 reground as a delegable step (#368); and the **Epic Decomposer**, splitting L/XL tickets into Furnace-sized subtasks (#367).
- **Roster consolidation** — Coordinator merged into Supervisor (#370); finalize personas folded into a single **Shipper** (Ticket Curator absorbed, Committer + PR Merger merged, #369); retired-id aliases can no longer shadow same-named custom personas (#386); stale roster comment fixed (#384).

### Agent workflow — structured handoffs & first-class criteria

- **Machine-readable completion handoffs** — Ready/finish now carries a structured payload: changed files, validation results, decisions, residual risk (#381).
- **Acceptance criteria & Definition of Done** as first-class ticket fields with an advisory portal indicator (#385).
- **Agent-consumable release index** — `flux:release` appends every released ticket (with a completion gist) to `.docs/release-notes/INDEX.md`, the new first stop for "was this already done?" reground checks (#387).
- **Board-health triage** — a dynamic board-health prompt feeding `propose_board_rebase` (#388).

### Perf follow-through (FLUX-1135 epic closed)

- Heavy clicks profiled on a prod build and the top offender fixed (#375); FurnaceDrawer memoized so polls no longer re-render every batch/row (#378); event-loop-stall warnings confirmed gone after the yield fix (#376); board tee gap + per-turn git subprocess cost on resume (#365); `.eh-idle` ambient-animation pause locked in by a regression test (#377).

### Furnace & engine hardening

- Ready-transition guard no longer misattributes main-checkout dirty state to a ticket's isolated worktree (#371); concurrent forced `refreshWorktreePool()` clobber race fixed (#372); `isRegisteredWorktree` cache-invalidation race narrowed (#383); trigger editor no longer arms triggers on parked/done batches (#374); `info/exclude` writes guarded against concurrent-write races (#361); FurnaceReportModal cleanup (#357).
- **Agent boundaries** — the "ticket chat can't edit files unless In Progress" gate now covers Copilot and Gemini, not just Claude (#360), with wiring-level regression tests (#380).
- **Epics closed** — MCP token-footprint & agent-context optimization (FLUX-477) and Restore Stability (FLUX-996).
- **Tests & polish** — `useFocusTrap` Escape gap for non-modal traps (#364) + ESC typing-guard polish with coverage (#363); CardCommentBadge gating tests (#362); task-store-watcher incremental-burst test deflaked (#382); S10 telemetry follow-ups (#379).

## [1.3.0] — the performance overhaul, Furnace hardening, and a sturdier sync core

The headline is **performance**: a full instrumentation epic (FLUX-1128) that made the engine and portal measurable, then the fix wave it uncovered. Alongside it, a deep hardening pass over the Furnace's slot/worktree machinery and the sync layer. Full notes: [`.docs/release-notes/v1.3.0.md`](.docs/release-notes/v1.3.0.md).

### Performance — instrument first, then fix

- **Engine perf core** — metrics registry, request-timing middleware, and `GET /api/perf` (#330), an event-loop delay monitor that catches synchronous stalls (FLUX-1130), git/gh subprocess timing via the operation sink (FLUX-1131), and task-store rescan timing + watcher-storm detection + SSE broadcast counters (FLUX-1132). `[perf]` warnings broadcast as SSE events into the Engine Events tab (#346).
- **Portal instrumentation** — client-side refresh timings, SSE rates, `window.__ehPerf` (#340), and a perf debug panel showing engine + client snapshots in one surface (FLUX-1134).
- **The fix wave** — `/api/tasks` list payload slimmed from ~16MB per poll + conditional GET (#327); `/api/furnace` ground-truth reconciliation behind a short TTL (#331) and hot-poll endpoints serving stale-while-revalidate (#347); boot's duplicate full rescans deduped and watcher reloads made incremental (#348) with explicit yield/chunking in the rescan loop (#349); SSE → engineEvents buffering coalesced so the store isn't patched per token delta (FLUX-1138); memoized cheap rows for the Engine Events / Operations tabs (FLUX-1139); the idle board's continuous ~80fps rAF/CSS animation pipeline stopped (#355, FLUX-1140); artifact viewer no longer pays Tailwind JIT cost while hidden (FLUX-1136), and authoring guidance steers agents away from the Tailwind Play CDN (#326).

### Furnace — slot/worktree hardening + batch UX

- **Slot machinery** — the slot gauge no longer desyncs from the physical worktree cap (igniting into guaranteed spawn failures, #332); slot-holder undercounts + forced-refresh races under concurrent ignites fixed (#358); the auto-takeover race that flagged the Furnace's own spawns as human takeovers — wedging the queue, leaking slots, and killing the hand-back button — resolved (#287) with follow-ups for TOCTOU settling and mid-spawn ticket removal (#312, #313).
- **Failure visibility** — pre-spawn session failures leave a durable trace in ticket chat instead of burning silently (FLUX-1156); a clear signal when a session's assigned worktree has been reclaimed or vanished (#345); review verdicts no longer strand tickets when `reviewState` isn't set (#273), with member-ticket verdicts aggregated onto PR cards (#286) and stale review-nudge markers ignored (FLUX-1080).
- **Batch curation & control** — an intentional-selection contract for `furnace_build` (tag or explicit ids, drift accounting, one-active-batch guard, #292); MCP tools to discard/edit draft batches (#274), later consolidated into action-based `furnace_batch` / `furnace_ticket` tools plus hand-back (FLUX-1085, FLUX-1070); the burn report rendered in a per-batch modal (#335); drag-and-drop reorder of queued tickets (FLUX-1082); a trigger editor + informative trigger badge in the drawer (#344); raw-CRUD and PUT full-payload validation hardened (#268, #309, #321).
- **Test hardening** — slot-guard 409s, concurrent burns, merges, auto-ignite integration tests plus verdict-gating/rename/a11y units (#270), and a broad set of route-level and MCP-tool tests (#311, #333, #354, FLUX-1074/1083/1084/1104).

### Sync & reliability

- **Sync wedge hardening** — conflicted flux-data merges were silent and sticky; auto-repair emitted status-less stubs; the PR-scanner re-created conflicting stubs — all fixed (#272), with sync-conflict (#283) and auth (#298) notifications re-surfacing if dismissed while still unresolved.
- **Operation telemetry epic** — slow network ops moved off the spawn/HTTP response path (#285), an operation-telemetry layer (opId / kind / duration / outcome) over SSE (#306), failures surfaced on ticket/session cards (FLUX-1006), a dev ops console panel (FLUX-1007), and duplicate spawn events + mislabeled `pausedForInput` outcomes fixed (FLUX-1109).
- **Session/store correctness** — `updateAgentSession` no longer races the per-ticket write lock and silently drops swimlane/frontmatter changes (#295); failed merges prompt the user to launch a rebase/resolve agent session from the card (#300), with the merge-conflict CTA moved onto PR cards without bouncing status early (#301); the board no longer crashes on tickets with a missing/invalid status (#271) and off-board StatusBadges render a fallback (#282, #297); the deferred stability-audit findings (sync creds, subtask write-lock, gemini board notify) landed (#343).

### Guardrails & dev safety

- **Live-engine protection** — agent-run dev stacks can no longer tree-kill the real engine's ports mid-burn (FLUX-1117), and engine/portal children are shielded from an inherited `PORT` env var (#324).
- **Agent boundaries** — ticket chat can't edit files unless the ticket is In Progress (#322); permission-gate hardening + dead-reference cleanup (#323); `runHardened` errors redact raw stdout/stderr (#303).
- **Distribution** — the packaged Windows exe no longer serves 404 (SEA asset extraction fix, FLUX-1096); the Electron shell validates saved window bounds against displays so it can't restore off-screen (#302).
- **Worktree hygiene** — `*.tsbuildinfo` gitignored so clean worktrees stay reclaimable (#328); the Serena worktree override no longer leaves user-repo worktrees born-dirty (FLUX-1155); node_modules junctions excluded from live-worktree dirty checks (#334).
- **Code health** — the engine lint burndown (~711 errors, ~631 `no-explicit-any`) landed and engine lint joined the check gate (FLUX-1073, #317).

### UX & accessibility

- **Keyboard & focus** — Esc closes windows consistently (#341); FloatingPanel folded into the shared `useFocusTrap` hook (#305) with Escape/Tab scoped to the currently-relevant container in stacked dialogs (#315); keyboard-accessible session cards (#278, #299); the AttentionDock's persistent-ring treatment extended to questions (#307).
- **Board & panels** — a new default status color scheme with a distinct hue per status (FLUX-1093); terminal improvements (#325); "Stop agent session" on PR-card right-click (#314); the BacklogScreen status dropdown no longer silently fails on Ready/Require Input (#308); Engine Events badge overcount (#338) and auto-scroll deps (#353) fixed; swimlane clears take effect without a reload (#280).

## [1.2.0] — the Furnace, multi-CLI adapters, and a hardened core

The headline is **the Furnace** — an overnight autonomous ticket runner — landing alongside a CLI-agnostic adapter layer (Claude, Copilot, Gemini) and a from-the-ground-up hardening of the git/session core. Full notes: [`.docs/release-notes/v1.2.0.md`](.docs/release-notes/v1.2.0.md).

### The Furnace — overnight autonomous ticket runner

- **Curate a batch, walk away.** The Furnace builds a magazine of burn-approved tickets and stokes them unattended — implement → review → reimplement → leave a PR open at Ready, never merging (#249, and the S1–S7 build FLUX-1008→1015).
- **Batches are first-class**, driven from a board-anchored right-side drawer you drag tickets into — overlay (never squishing the board), closed-state pullout tab, click-to-rename with branch-rename, draft deletion, and enriched status chips (#262, #264, #255, #260, #261).
- **Burn control** — burn-rate/concurrency modes, hard stops, a per-session watchdog + circuit breaker, and a burn-report summary event (FLUX-1012/1013/1015).
- **Graceful under failure** — a reconciling controller with ownership handoff and a failure taxonomy (#267); park charges as *In Progress* + swimlane rather than a status move (#256); post a real `gh pr review --approve` on approval (FLUX-1033); detect token/context exhaustion and pause-then-retry instead of parking (#259); retry rate-limited burns on a configurable cooldown (FLUX-1063).
- **Magazine curation asks the orchestrator** and loads only burn-approved tickets instead of dumping the backlog (#258); grouped same-branch sequential mode burns overlapping tickets as one stacked PR (#255); first-class explicit group definitions with dependencies (#261).

### Multi-CLI — Claude, Copilot & Gemini adapter layer

- **Genericized every Claude-only surface into a CLI-agnostic adapter layer** routed per framework — the 8-part epic (FLUX-851): capability flags + lifecycle hooks (#213), `claudeSessionId`→`resumeSessionId` rename (#208), a cross-adapter contract test net (#214), the `BoardAdapter` interface lifting `__board__` out of `claude-code.ts` (#215), route/MCP defaults hygiene (#218), portal decoupling that gates UI off capabilities instead of `=== 'claude'` (#219), and the runtime↔installer reconciliation design (#221).
- **A ratcheting adapter-boundary CI guard** forbids per-CLI code outside `engine/src/agents/`, plus a PR CI workflow (typecheck + boundary + tests) (#209, FLUX-941).
- **Copilot/Gemini parity fixes** — durable-transcript writes so board chat shows replies (#225), workspace `.mcp.json` injected in non-interactive mode (#230), cached binary-path resolution (#226, #228), a capability-driven initial-prompt builder (#227), and a Copilot effort-default dispatch fix (#229).

### Stability & the hardened git runner

- **A unified hardened git/gh runner** (timeout + non-interactive env + kill-tree) with a guard, then routed across branch-manager / ticket-isolation / pr-cleanup, task-store remote-fetch, task-worktree, inline routes, and the multi-repo group fan-out — the S1–S8 hardening epic FLUX-996 (#239, #242, #243, #244, #245).
- **Async + cached binary resolution** and a bounded MCP/Serena handshake fetch de-gated from spawn (#240, #241); transient binary-check failures no longer poison a 30s negative cache (#250).
- Dev-watcher never hard-kills active sessions on `engine/src` churn (#235); the sync-watcher no longer hangs forever on a conflict race (#236); SSE heartbeat on `sync-status/stream` (FLUX-995); deterministic HITL durability on SIGTERM/SIGINT (#207).

### Worktree safety

- **Fail closed when a ticket's worktree is missing** so agents can't commit on `master` (#248); reclaim worktrees when a ticket reaches Ready/pr-open (#254); fix worktree re-entry when the branch is checked out outside `.eh-worktrees/` (#263); stop the reclaim sweep from deleting a live session's worktree after an engine restart (#265).

### MCP surface

- **Consolidated the MCP tool surface** (33→~23) with a forced reinstall (#203, **breaking**); server instructions + tool annotations (#212); MCP resources + templates (`ticket://`, `board://`, `docs://`) (#217); structured output (`outputSchema` + `structuredContent`) (#216); `update_ticket` can now (re)link `parentId` without a new tool (#266).

### Board performance & UX

- **Slimmed the `/api/tasks` list payload** with derived history signals + lazy full-detail fetch (#220); stopped polling terminal tickets every 3s (FLUX-970); kept the Board mounted across view switches to kill the remount stall (FLUX-982/983); redesigned the agent-management window (#233); Visual Recap artifact on the move to Ready (#232).

### Agent workflow & skills

- Agents now **lead every ticket body with a plain-language TL;DR** (FLUX-953); grooming gained visual-plan discipline (FLUX-978) and a "Reground before starting" convention for point-in-time-analysis tickets (FLUX-1048); a needs-action backstop when a ticket closes with a pending question (#211).

## [1.1.0] — artifacts, redesigned cockpit, rock-solid sessions

The first feature release on the 1.0 line. Full notes: [`.docs/release-notes/v1.1.0.md`](.docs/release-notes/v1.1.0.md).

### Grooming artifacts

- **Rich, annotatable grooming artifacts** — agents publish a self-contained HTML artifact (mockup, Mermaid diagram, SVG wireframe, clickable Tailwind prototype) rendered in a sandboxed, opaque-origin iframe (#173).
- **Annotate any region** — select text or right-click non-text controls; batch notes round-trip to the agent, which revises and republishes; a revision picker keeps history (#175, #185).
- **Layout-audit gate** masks the artifact until it passes overflow/off-canvas/clipped/overlap checks (#178).
- Artifacts render **inline in chat on publish** (no reload), with a "publishing…" indicator during the tool-input stream (#188, #192, #195).

### Notifications & pending surface

- **Redesigned notification panel**, unified with the require-input/pending surface into one cockpit (#196, #189).
- Activity log re-homed into a header panel next to the pending surface (#174).
- **Parked agent sessions** are visually differentiated from active ones (#190, #191).

### Human-in-the-loop

- Open-chat questions **draw inline** in the conversation, not just a separate window (#197).
- Require-Input / awaiting-input prompts render markdown and are scrollable/resizable with expand-collapse (#183, #184, #187).
- Prompts **survive an engine restart** (per-process binding secret); board-submitted answers appear in the chat transcript (#186, #165).

### Realtime & session reliability

- Orchestrator chat rides a **keepalived SSE stream** — no more silent stalls of messages, "working" state, prompts, or stop; **Stop sticks**; optimistic-bubble/working-window/double-dispatch fixes; dispatch-row flood fix; hot-restart hardening (#193).
- Chat-window geometry persists across minimize/reopen and reload (#194).

### Board activity & dispatch

- Durable, filterable **Board Activity / History view** of dispatch events (#170).
- **DispatchChip polish** — lifecycle color-coding, live pulse, duration, timestamps, hierarchy (#167); enriched rows with phase + title + prominent timestamp (#166).

### Agent experience (MCP)

- **Compact JSON** tool results (#171); contextual next-step hints (#180); definitive empty states (#179); machine-readable error codes (#172, #177).
- Oversized ticket bodies truncated in the agent view with a `fullBody` escape hatch (#181).
- `list_tickets` active-by-default + limit + search (#199); `get_board_config` strips Tailwind color classes (#198); `nextStepForStatus` case-insensitive + config-driven (#182).

### Engine & infrastructure

- **Stderr-only structured logger** + `console.log` sweep for MCP stdout safety (#200).
- Shared MCP servers **keyed per worktree** (one Serena per worktree) (#202).
- `copilot`/`gemini` `stop()` tree-kill parity (#164); cheaper model for delegated subagents (#201); shared adapter helpers extracted + blocking-HITL routing fix (#204); public-repo cleanup (#168).

## [1.0.1] — 1.0, hardened

A reliability batch on top of the 1.0 release (still the major release — revamped, not superseded). Full notes: [`.docs/release-notes/v1.0.1.md`](.docs/release-notes/v1.0.1.md).

### Reliability & sessions

- **Durable, resumable human-in-the-loop prompts** — a *Require Input* question survives an engine/session restart and no longer hits the ~300s ceiling; the durable store persists asynchronously (coalesced), prompts are re-bound to their session, and `open-prompts.json` is excluded from the flux-dir + sync watchers (#141, #156, #145, #155).
- **Process-tree teardown** — stopping an agent tree-kills the whole process tree so its MCP servers are reaped instead of leaking stale `node` processes (#163).
- **Active-sessions panel** — completed sessions no longer display as forever-"Working" with a runaway timer (#149).
- **Board orchestrator cold-resume** — a cold board offers "Resume conversation" vs "Start fresh," with re-prime bounded to the last N turns (#155, #142, #158).

### Orchestration & dispatch

- `delegate_parallel` no longer re-launches the entire fleet (~3× token cost) when the MCP transport drops after spawn (#144).
- Closed a delegate double-launch window with a pre-spawn reservation (#146); reopen dispatch re-fires on a modal `conversationId` switch (#147).
- Dispatched-session live output streams to the board, not just the ticket transcript (#154).

### Isolation & worktrees

- Agent dispatch isolates by default through a single canonical ticket-isolation path, hardened with a race guard + unit test (#150, #159).
- Serena binds to the per-task worktree (unique `project_name`) so symbol edits land in the worktree, never on `master` in the main checkout (#143).

### Surfaces & verbs

- Require-input tickets unified into one loud Pending bar: persistent chat-tab badge, auto-pop, dismiss, close-on-jump, and a taskbar require-input flag (#160, #161, #162).
- **Merge verb** — fold several chats/tickets into one effort (#151).
- **Engine-side branchless finish** (zero-token) via `POST /:id/finish` (#152).
- Ticket-modal diff + session-run panels default to collapsed (#153); a11y polish on chat orchestration surfaces (#148); floating panel no longer swallows minimize/close clicks while dragging (FLUX-836).

## [1.0.0] — first public release

Event Horizon's first public release. **Event Horizon is an IDE for the agent era** — a local-first board where you break work into tickets, hand each to an agent that carries full context and runs on its own git branch in parallel, and review every result as a real pull request. Tickets, plans, and history are plain markdown in your repo; it ships no LLM and orchestrates an agent CLI you already use (Claude Code, Gemini CLI, GitHub Copilot CLI) or a supported IDE.

1.0 consolidates the dev line since v0.12 into a hardened, first-run-ready build.

### Highlights

- **A board of agents, not one chat.** Run many tickets in parallel; each ticket is a persistent agent chat with full context (description, history, branch, attachments). Minimize it to the dock and the session keeps running in the background.
- **Isolated parallel runs.** Each ticket gets its own git worktree on its own branch — agents work at the same time with zero file collisions.
- **Inline PRs.** Moving a ticket to Ready pushes the branch and opens a pull request; `finish` squash-merges it and advances the ticket to Done.
- **Orchestration.** Hand a ticket to a specialist persona, fan work out scatter-gather under a supervisor that reviews and synthesizes, or talk to the board orchestrator to triage the whole project into tickets.
- **Local-first & yours.** Tickets are markdown + YAML frontmatter committed to your repo (or an orphan data branch via Git Sync). Works offline, travels with a `git clone`; no cloud, no account.
- **Multi-repo groups & release notes.** Map a feature across repositories with a shared knowledge base, and cut releases (changelog auto-generated from Done tickets) straight from the board.
- **Desktop app (opt-in).** A standalone Electron shell gives Event Horizon its own window + taskbar/dock entry + tray; prebuilt `.dmg`/`.exe` ship on each release.

### Agent workflow & orchestration

- In-process **MCP server over loopback HTTP** (stdio fallback) so every agent session shares one engine task-store; tools enforce workflow rules and validate every write.
- Branch/worktree **PR flow** with a commit-before-Ready guard, a shared-PR finish guard, and the board-rebase triage ritual.
- **Require Input** decision loop (a focused question with a sensible default), gated-tool approvals, and per-ticket agent / persona / effort selection.
- Solo-reviewer path now self-finalizes instead of dangling In Progress; `update_ticket` routes through the atomic, per-ticket-locked write path.

### Security & data durability

- The engine **binds to loopback** and rejects non-loopback `Host`/`Origin` requests by default, reflecting CORS only for loopback origins — a page you merely visit can neither drive the API nor read its responses. Opt into LAN exposure with `EH_ALLOW_REMOTE=1` (no auth — trusted networks only).
- **Atomic writes + corruption guards** for `config.json` and ticket files: a corrupt or conflict-markered `config.json` is preserved and reported, never silently overwritten with defaults.
- A malformed `.mcp.json` is **no longer silently rebuilt** — your other MCP servers are preserved.
- chokidar **file-watcher errors degrade gracefully** instead of crashing the engine; a top-level Express error handler returns clean JSON instead of an HTML stack.
- The editor launcher rejects shell metacharacters (closes a `/open-editor` injection).

### First-run experience

- Onboarding wizard, sensible empty states, and a **"Bootstrap with AI"** starter ticket that scans your repo and proposes work.
- Correct **per-user identity & attribution** — new users are no longer attributed as the maintainer, and a human user is seeded on first run.

### Portal & UX

- Overhauled **Settings** (tabbed, dirty-save) and **notifications** (action-vs-update taxonomy, tabbed filter, swipe-to-dismiss, plus a taskbar badge in the desktop app).
- **Responsive board** scaling for wide displays (1440p / 4K / MacBook Pro), typed statuses with an expanded color palette, and the Matrix / Cyber theme set.
- A blanket **prefers-reduced-motion** guard, a shared focus-trap for modals, and search / board-filter input that stays responsive on large boards.
- Click-to-open onboarding demo lightbox; a top-level React error boundary recovers from render errors instead of blanking the app.

### Requirements & install

- **Download the app** (tray binary or `.dmg`/`.exe` desktop installer) — zero dependencies, no Node required. Or **run from source** (Node 20+).
- Bring your own agent CLI (Claude Code / Gemini CLI / GitHub Copilot CLI) or a supported IDE (Cursor, Windsurf, Cline) — Event Horizon ships no LLM and needs no key of its own.
- The downloadable builds are **unsigned**, so macOS Gatekeeper and Windows Defender may show a first-launch false positive — see the README's first-run troubleshooting.

> Detailed per-version notes for the v0.13–v0.61 dev line live under [`.docs/release-notes/`](.docs/release-notes/).

## [v0.12.0] - 2026-05-29

### Portal Redesign

- **Geist font** with OpenType features for distinctive typography
- **Warm orange/teal palette** replacing generic AI-purple accent
- **Matrix theme promoted to default** — fully overhauled with CRT effects
- Subtle noise overlay, tinted shadows, and card inner glow for depth
- Notification dismiss animation (slide-out + blur via AnimatePresence)
- Fixed viewport (`min-h-dvh`), added meta/OG tags, removed Vite boilerplate

### Matrix CRT Effect

- Full-screen scanlines and vignette overlay
- Subtle flicker animation simulating CRT phosphor decay
- Scrolling beam highlight (electron gun refresh simulation)
- Phosphor glow radiating from screen center

### Per-Card Action Buttons

- **Grooming** → "Start grooming"
- **Todo** → "Implement"
- **In Progress** → "Continue"
- Compact, right-aligned, shown on card hover

### Ready Column — Split Actions

- **Review** — opens reviewer persona selector (Senior Dev, Angry Linus, Architect, Perf Expert, UX Expert)
- **Return** — prompts for reason, moves ticket back to In Progress
- **Finish** — sends finish command to agent

### Bug Fixes

- Fix startup migration: properly clean up stray `.flux/` ticket files in orphan mode
- Fix `ReadState` type mismatch causing CI build failure
- Launch Agent button now uses accent gradient (visible in dark themes)
- Board filter bar and comment badges styled for Matrix visibility

## [v0.8.1] - 2026-05-26

### Features

- **Workflow Builder UI** (FLUX-312) — Visual workflow editor with file-backed skills, plus agent and workflow engine REST routes
- **Multi-agent session store** (FLUX-283) — Extended session store to support multiple concurrent agent sessions
- **Epic cards** — New epic card display in the portal task board
- **Curated release notes CI** — GitHub Actions now extracts release body from `.docs/release-notes/`

### Bug Fixes

- **Notification bell for Ready/Done transitions** — Fixed notification bell not firing when tickets moved to Ready or Done status
- **Copilot.exe MCP tool loading** (FLUX-310) — Prefer `copilot.exe` over `node + entrypoint` to ensure MCP tools load correctly
- **Unread count badge and modal overlay** — Fixed unread count badge rendering and full-view modal overlay

## [v0.8.0] - 2026-05-25

### Features

- **MCP server for ticket operations** (FLUX-6) — Full Model Context Protocol tool server with 10 operations: `get_ticket`, `list_tickets`, `create_ticket`, `update_ticket`, `change_status`, `add_comment`, `log_progress`, `finish_ticket`, `create_subtask`, `get_board_config`
- **Notification panel with health checks** (FLUX-302) — Real-time notifications, update indicator, health checks on session completion
- **Ticket schema enforcement** (FLUX-289) — Validates ticket structure on read/write; rejects malformed frontmatter with actionable errors
- **Subtask creation endpoint** (FLUX-278) — `POST /api/tasks/:parentId/subtasks` atomically creates + links child tickets
- **Auto-create tickets from inline subtasks** (FLUX-277) — Engine materializes inline subtask objects as proper ticket files
- **First-run experience** (FLUX-267) — Fixed default config generation and added user name prompt

### Bug Fixes

- **Agent session persistence** (FLUX-274) — Updates during sessions no longer lost on completion
- **Agent session history drops** (FLUX-306) — Fixed sessions silently dropped from history
- **Legacy status_change normalization** (FLUX-287) — Auto-normalize `oldStatus/newStatus` to `from/to`
- **Portal static serving on Node 26** (FLUX-293) — Fixed ESM require fallback in dev mode
- **Windows console popups** (FLUX-279) — Hidden cmd.exe windows for git/PowerShell spawns

### Documentation

- **Orchestrator skill examples** (FLUX-288) — Pinned correct vs. incorrect history-entry shapes

### Multi-Agent Integration

- Verified MCP compatibility with Claude (FLUX-294), Gemini (FLUX-295), and Copilot CLI (FLUX-296)

## [v0.7.2] - 2026-05-19

- Schema enforcement and legacy normalization groundwork
- Release script improvements

## [v0.7.1] - 2026-05-19

- Windows console window hiding for child processes

## [v0.7.0] - 2026-05-19

- Copilot CLI agent integration (full rewrite with JSONL parsing)
- Cross-platform binary resolution
- Session logging and real-time progress for Gemini/Claude
