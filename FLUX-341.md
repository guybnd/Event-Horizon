---
id: FLUX-341
title: Harden ticket file integrity and add skill staleness detection
status: In Progress
priority: High
effort: M
assignee: unassigned
tags:
  - bug
  - engine
  - agent-workflow
createdBy: Guy
updatedBy: Guy
history:
  - type: activity
    user: Guy
    date: '2026-05-29T01:33:32.603Z'
    comment: Created ticket.
---
## Problem / Motivation

An agent session on FLUX-292 used the Write tool to directly edit `.flux-store/FLUX-292.md`, bypassing the engine. A race condition between `updateAgentSession` and the direct write caused the file to be read mid-truncation (empty), losing all frontmatter. The repair logic then stamped it as "FLUX-292 (recovered)" — corrupting an active ticket.

Root causes:
1. `fs.writeFile` is non-atomic on Windows (truncate → write has a gap)
2. `readTaskFromDisk` didn't detect empty/partial reads
3. `loadTask` repair logic would overwrite cached state with corrupt file content
4. Agent skills didn't explicitly prohibit Write/Edit on ticket files
5. Skills had broken markdown tables (rendered as one mangled line) making MCP tool list unreadable
6. No detection of stale/outdated installed skills

## Implementation

### Part 1: Atomic writes + read guards (engine)
- `atomicWriteFile()` — write to `.tmp` then rename (prevents partial reads)
- `readTaskFromDisk` guard — falls back to cache if file is empty or missing title
- `loadTask` guard — ignores incoming file changes that strip title+status from cached ticket
- Chokidar watchers ignore `.tmp` files

### Part 2: Skill staleness detection
- `extractSkillVersion()` — parses `Version: x.y.z` from skill content
- `checkSkillVersionStaleness()` — compares source vs installed version
- `checkSkillStaleness()` — fires notification if mismatched
- Runs at startup and after each agent session completes
- Exposed via `POST /api/notifications/check-health`

### Part 3: Skill overhaul (v2.0.0 → v2.2.0)
- Fixed markdown tables (pipe-delimited format that survives concatenation)
- Added explicit "NEVER use Write/Edit/Bash on ticket files" prohibition
- Added `.flux-store/` references throughout
- Tightened REST API fallback: "ONLY if MCP tools fail to load"
- Added "File Boundaries" section to implementation skill
- Bumped all modules to v2.2.0 and reinstalled
