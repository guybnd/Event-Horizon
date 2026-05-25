---
priority: High
effort: XS
tags:
  - bug
  - engine
id: FLUX-293
title: >-
  fix: portal static serving broken in dev mode on Node 26 (ESM require
  fallback)
status: Done
createdBy: Unknown
updatedBy: Agent
assignee: unassigned
history:
  - type: activity
    user: Unknown
    date: '2026-05-25T05:20:45.941Z'
    comment: Created ticket.
  - type: comment
    user: Agent
    date: '2026-05-25T05:24:26.199Z'
    comment: >-
      MCP smoke test: all 10 tools registered and responding. Read ops
      (get_ticket, list_tickets, get_board_config) confirmed working. Testing
      write op now.
    id: c-1779686666199-2
  - type: comment
    user: Agent
    comment: >-
      Fixed __dirname resolution across all entry points (workspace.ts,
      index.ts, skill-installer.ts, release.ts, docs-seeder.ts). Root cause:
      require('url') fails silently in ESM mode on Node 26. Replaced with static
      import of fileURLToPath. Also added safety net in normalizeHistoryEntries
      to inject missing date fields, and fixed MCP server comment handlers to
      always include timestamps.
    id: c-1779687290039-3
    date: '2026-05-25T05:34:50.070Z'
  - type: status_change
    from: In Progress
    to: Done
    user: Agent
    date: '2026-05-25T05:34:50.036Z'
implementationLink: 356a843
---
## Problem

`workspace.ts` uses `require("url")` inside a try/catch to resolve `import.meta.url` into a directory path. In Node 26 with `"type": "module"`, `require` is not available � the call throws silently, causing `__dirname_resolved` to fall through to an incorrect `process.cwd()` fallback. This breaks `resolvePortalDist()` and `resolveSkillSourceRoot()`, resulting in 404 for all portal routes.

Only affects dev mode (`npx tsx src/index.ts`). Built CJS bundles work because esbuild injects a proper absolute `__dirname`.

## Root Cause

`require("url")` ? ReferenceError in ESM ? caught by try/catch ? falls to `process.cwd()` ? wrong base for relative path resolution.

## Fix

Replace dynamic `require("url")` with static `import { fileURLToPath } from "url"` at the top of `workspace.ts`. This works in both ESM (tsx dev) and CJS (esbuild bundle, where the fallback is never reached).

## Files

- `engine/src/workspace.ts` � static import of `fileURLToPath`
- `engine/src/index.ts` � removed stale debug log
