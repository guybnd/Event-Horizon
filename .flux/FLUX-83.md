---
title: Provide a robust mechanism for agent ticket edits to prevent ticket corruption
status: Ready
createdBy: User
updatedBy: Agent
assignee: unassigned
tags:
  - reliability
  - agent-workflow
priority: High
effort: M
implementationLink: ''
subtasks: []
history:
  - type: activity
    user: User
    date: '2026-05-09T08:20:00.000Z'
    comment: Created ticket.
  - type: status_change
    from: In Progress
    to: Ready
    user: Agent
    date: '2026-05-09T08:20:00.000Z'
  - type: comment
    user: Agent
    date: '2026-05-09T08:20:00.000Z'
    comment: >-
      Implementation complete. All three deliverables were already in place from
      a prior session:


      1. **Validation hook** (`engine/src/index.ts` `loadTask()`): wraps
      `gray-matter` parsing in a try/catch and also checks for missing `title`
      field. On either failure, emits `[FLUX VALIDATION ERROR]` to stderr with
      the filename and error, removes the ticket from `tasksCache`, and returns
      without caching. Verified: a corrupt test file dropped into `.flux/` never
      entered the cache.


      2. **`patch-ticket.ts` CLI** (`engine/src/patch-ticket.ts`): supports
      `--status`, `--comment`, `--assignee`, `--priority`, `--effort`,
      `--workspace`. Uses `gray-matter` for safe round-trip YAML edits. `npm run
      patch-ticket` script added to `engine/package.json`. Smoke-tested against
      FLUX-83 successfully.


      3. **Docs updated** (`.docs/skills/event-horizon-implementation.md`):
      `Ticket Editing — MANDATORY` section already present, mandating
      `patch-ticket` CLI for all frontmatter edits with usage examples.


      4. **FLUX-159 created**: `Show corrupted ticket indicator in the portal
      UI` — the complementary UX feature for surfacing parse errors in the
      portal, as requested by Guy.


      Awaiting `finish FLUX-83` to commit.
    id: c-2026-05-09t08-20-00-000z
  - type: activity
    user: Agent
    date: '2026-05-09T07:54:22.936Z'
    comment: Launched Claude Code session (8e79ad1a).
order: 83
---
## Implementation Plan

Two-part implementation: (1) a YAML validation hook in the existing `loadTask()` in `engine/src/index.ts`, and (2) a `patch-ticket.ts` CLI script in `engine/src/` using `gray-matter` for safe round-trip edits.

### Part 1 — Validation Hook

In `loadTask()`, `gray-matter` does not throw on malformed YAML — it silently returns empty `data`. Detect corruption by checking `Object.keys(parsed.data).length === 0` after parsing. When corrupt:
- Remove the ticket from `tasksCache` (so it disappears cleanly from the board)
- Emit a `console.error` banner with ANSI red prefix `[FLUX VALIDATION ERROR]`, naming the file

### Part 2 — CLI Script (`engine/src/patch-ticket.ts`)

Usage:
```
npx tsx engine/src/patch-ticket.ts FLUX-83 --status "In Progress"
npx tsx engine/src/patch-ticket.ts FLUX-83 --comment "Work started."
npx tsx engine/src/patch-ticket.ts FLUX-83 --status "Done" --comment "Closed."
```

- Resolves ticket file from `--workspace` arg or `$FLUX_WORKSPACE` env var (default: cwd)
- Reads and parses with `gray-matter`, applies changes, stringifies back with `matter.stringify()`
- Appends proper `status_change` or `comment` history entries with ISO timestamps
- Exits 1 with a clear error on YAML parse failure
- Add `flux:patch` script to `engine/package.json`

### Part 3 — Docs Update

Update `.docs/skills/event-horizon-implementation.md` to note `patch-ticket.ts` usage for ticket metadata edits.

### Part 4 — UI Indicator Ticket

Create a separate ticket for the corrupted-file UI indicator (FLUX-83 acceptance criteria).

## Validation

- Corrupt a ticket YAML and confirm engine logs `[FLUX VALIDATION ERROR]`
- Run the CLI script against FLUX-83 and verify the comment appears
