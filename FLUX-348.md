---
priority: Low
effort: L
tags:
  - refactor
  - agents
  - engine
assignee: unassigned
id: FLUX-348
title: 'Engine: extract BaseAdapter for agent integrations'
status: Grooming
createdBy: Agent
updatedBy: Agent
history:
  - type: activity
    user: Agent
    date: '2026-06-03T03:50:31.398Z'
    comment: Created ticket.
  - type: activity
    user: Agent
    date: '2026-06-22T11:32:29.354Z'
    comment: Updated description. Changed effort to L.
subtasks:
  - FLUX-366
---
## Problem

`agents/gemini.ts` (889), `copilot.ts` (728), and `claude-code.ts` (647) total 2,264 lines for three adapters. ~70% of each file is shared scaffolding: child-process lifecycle, stream-json parsing skeleton, token/cost accounting, SSE bridging, prompt building. The `AgentAdapter` interface in `types.ts` is too thin to host the shared concerns, and bugs (e.g. stderr filtering, heartbeat reset) have to be fixed in three places.

## Phased plan

### Phase 0 — Safety net (test coverage)

Tracked separately under a subtask. Must complete before Phase 1.

- Adapter parsers and lifecycle have **zero tests today**. A refactor without coverage is reckless.
- Captures real JSONL transcripts from each CLI, builds parser characterization tests against them, mocks `child_process.spawn` for lifecycle tests, and asserts the `AgentAdapter` contract holds across all three adapters.
- Acceptance: refactor in later phases can be verified byte-for-byte against the same fixtures.

### Phase 1 — Extract shared helpers

Pure mechanical extraction, no behavior change.
- Move `appendSessionOutput`, `enqueueSessionWrite`, `flushSessionOutput`, `buildInitialPrompt`, `cleanChildEnv`, `checkBinaryInstalled`, `TOOL_ACTIVITY_MAP` (split into per-CLI maps + shared lookup) into `agents/shared/`.
- Rename `claudeSessionId` → `resumeToken` on `CliSessionRecord`.
- Tests from Phase 0 must still pass without modification.

### Phase 2 — `BaseAdapter` lifecycle

- Introduce `agents/base-adapter.ts` covering spawn + stop, line-buffered stdout reader, stderr handling, exit handler, progress heartbeat, history bookkeeping.
- Each concrete adapter `extends BaseAdapter` and overrides only `buildArgs`, `parseEvent`, and `resolveBinary`.
- Acceptance: each adapter file < 300 lines; no duplicated lifecycle code.

### Phase 3 — Pluggable interfaces

- `EventNormalizer` per CLI: `parseLine(line) → NormalizedEvent | null`.
- `CommandBuilder` per CLI: `buildStartArgs(...)`, `buildResumeArgs(...)`.
- `BinaryResolver` strategy chain: PATH lookup → npm prefix → VS Code globalStorage → fallback.
- `CLI_CAPABILITIES` becomes the single source of truth, consumed by both the route layer and the adapter base class.

### Phase 4 — Docs refresh

- Update `.docs/event-horizon/reference/agent-adapter-contract.md` (FLUX-358 shipped the v1 doc) to describe `BaseAdapter`, `EventNormalizer`, `CommandBuilder`, `BinaryResolver`, and the new "adding a CLI" recipe.
- Update `.docs/event-horizon/architecture/code-map.md` to point new contributors at `agents/base-adapter.ts`.

## Acceptance

- Each adapter under 300 lines.
- No duplicated lifecycle code.
- Phase 0 test suite passes before and after each phase with no test modifications (parser behavior must be preserved byte-for-byte).
- Adding a hypothetical 4th CLI is a ~200-line task: one `EventNormalizer`, one `CommandBuilder`, one capability row, one manifest, one registry entry.
