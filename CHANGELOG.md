# Changelog

All notable changes to Event Horizon are documented here.

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
