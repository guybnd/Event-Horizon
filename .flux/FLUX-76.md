---
title: Make workspace path configurable with CWD and CLI override
status: Todo
createdBy: Guy
updatedBy: Agent
assignee: Agent
tags:
  - feature
  - mvp
priority: Critical
effort: S
implementationLink: ''
subtasks: []
history:
  - type: activity
    user: Guy
    date: '2026-05-07T06:55:00.000Z'
    comment: Created ticket.
  - type: comment
    user: Agent
    date: '2026-05-07T06:55:00.000Z'
    comment: >-
      Split from FLUX-18. This is the single biggest blocker for portability —
      the engine currently hardcodes `.flux/` relative to its own source
      location.
    id: c-2026-05-07t06-55-00-000z-flux-76
order: 76
---
## Summary

The engine hardcodes the `.flux/` directory path as
`path.join(__dirname, '../../.flux')`, which only works inside the Event Horizon
repo itself. Change it to resolve from the current working directory by default,
with a `--workspace` CLI argument as an override.

## Current Behavior

```typescript
// engine/src/index.ts:13
const FLUX_DIR = path.join(__dirname, '../../.flux');
```

## Requirements

### 1. CWD-based resolution (default)
- Resolve `.flux/` from `process.cwd()` instead of `__dirname`
- Derive `REPO_ROOT`, `DOCS_DIR`, `TASK_ASSETS_DIR`, and `CONFIG_FILE` from the new base

### 2. CLI override
- Accept `--workspace <path>` as a command-line argument
- When provided, use that path as the repo root instead of CWD
- Validate that the path exists and is a directory

### 3. Startup validation
- On startup, check that `.flux/` exists at the resolved path
- If not found, exit with a clear error message explaining what's expected
  and how to initialize (pointing to the init command from FLUX-73)
- Print the resolved workspace path on successful startup for clarity

## Acceptance Criteria

- [ ] Engine resolves `.flux/` from CWD by default
- [ ] `--workspace /path/to/repo` overrides CWD-based resolution
- [ ] Engine exits with a clear message if `.flux/` is not found
- [ ] Engine prints the resolved workspace path on startup
- [ ] Existing dev workflow (`cd engine && npm run dev`) still works

## Likely Affected Areas

- `engine/src/index.ts` — `FLUX_DIR`, `REPO_ROOT`, `DOCS_DIR`, `CONFIG_FILE`, `TASK_ASSETS_DIR` constants

## Parent

- Subtask of FLUX-18
