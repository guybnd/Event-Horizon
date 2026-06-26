# Changelog

Notable changes are summarized here; detailed per-version notes for the dev line live in [`.docs/release-notes/`](.docs/release-notes/).

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
