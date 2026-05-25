# Changelog

All notable changes to Event Horizon are documented here.

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
