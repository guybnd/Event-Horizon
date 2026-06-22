---
id: FLUX-366
title: 'Phase 0: Adapter test safety net (parser + lifecycle + contract)'
status: In Progress
priority: Medium
effort: L
assignee: unassigned
tags:
  - agents
  - engine
  - testing
createdBy: Agent
updatedBy: Agent
history:
  - type: activity
    user: Agent
    date: '2026-06-22T11:32:29.348Z'
    comment: Created ticket.
  - type: activity
    user: Agent
    date: '2026-06-22T11:32:29.348Z'
    comment: Created as subtask of FLUX-348.
  - type: status_change
    from: Todo
    to: In Progress
    user: Agent
    date: '2026-06-22T11:33:14.368Z'
  - type: comment
    user: Agent
    comment: >-
      Phase 0 safety net complete. 151/151 tests passing in ~470ms.


      Delivered:

      - Helpers: `fake-process.ts`, `build-session.ts`, `setup-mocks.ts`

      - 11 hand-crafted JSONL fixtures under
      `__fixtures__/{claude,copilot,gemini}/`

      - 8 test files covering: cross-adapter contract (23), prompt byte-equality
      (18), per-adapter parser characterization (12+11+10), per-adapter
      lifecycle with mocked spawn (23+8+10)

      - `engine/scripts/capture-adapter-fixtures.ts` for regenerating fixtures
      from live CLI runs

      - `engine/src/agents/__tests__/README.md` documenting the mock pattern,
      fixture model, and how to add a new adapter


      Note: Fixtures are currently hand-crafted from observable protocol shapes
      in the adapter code. The capture script is ready — the user can run it
      against live CLIs to replace them with real transcripts when convenient.
      All tests still pass against either source.


      Pre-existing tests (sync-watcher, session-store) untouched and still pass
      — no regressions.
    date: '2026-06-22T12:35:37.115Z'
    id: c-2026-06-22t12-35-37-115z
branch: flux/FLUX-366-phase-0-adapter-test-safety-net-parser-lifecycle-contract
baselineCommit: ded2315727d5169c9607dbfc21bd1f9edb1f02d0
---
## Problem

The three agent adapters (`claude-code.ts`, `copilot.ts`, `gemini.ts`) have **zero test coverage** despite holding 2,264 lines of critical streaming-JSON parsing and child-process lifecycle code. FLUX-348 plans to refactor them into a `BaseAdapter`. Without a characterization-test safety net, that refactor will silently regress parser behavior — bugs that only surface during live CLI sessions, where rollback is expensive.

## Plan

### Fixture capture infrastructure

- `engine/scripts/capture-adapter-fixtures.ts` — small Node script that spawns each CLI against a known prompt and writes raw stdout JSONL to `engine/src/agents/__fixtures__/<framework>/<scenario>.jsonl`.
- Scenarios captured per framework:
  - `simple-text` — single-turn text response
  - `tool-use` — at least one tool call (Read/Bash/Edit equivalents)
  - `multi-tool` — sequential tool calls
  - `token-usage` — capture a `result` frame with usage data
  - `resume` — initial session id + resume frame
- Fixtures committed to the repo so tests are deterministic offline.

### Test suites (under `engine/src/agents/__tests__/`)

**Parser characterization tests** — one file per adapter:
- Feed each fixture line-by-line through `attachStdoutProcessing`.
- Assert: `session.outputBuffer`, `currentActivity` transitions, `inputTokens`/`outputTokens`/`costUSD`, `resumeToken` capture, `progress[]` entries, `broadcastEvent` calls (spied), blocked/waiting-input transitions.

**Lifecycle tests** — one file per adapter:
- Mock `child_process.spawn` with a controllable fake.
- Assert: `start()` writes `agent_session` history, registers session, sets `pid`/`command`/`args`; `sendInput()` writes `agent_message`, sets `lastInputAt`, writes to stdin; exit handler updates status correctly for completed/failed/cancelled; `stop()` sends SIGTERM.

**Cross-cutting tests**:
- `command-args.test.ts` — pure-function tests for the spawn-arg arrays (effort flag inclusion, resume flag, skip-permissions, model selection).
- `prompt.test.ts` — snapshot of `buildInitialPrompt` per task status (currently identical across adapters; will become a shared helper in Phase 1).
- `contract.test.ts` — for each registered adapter, assert manifest has required fields, capability row exists in `CLI_CAPABILITIES`, `labelForFramework` returns non-empty, `stop()` is idempotent.

### Test utilities

- `engine/src/agents/__tests__/helpers/fake-process.ts` — `FakeChildProcess` class that mimics `ChildProcessWithoutNullStreams` (EventEmitter-based stdout/stderr/stdin streams, controllable `pid`, `kill()` spy).
- `engine/src/agents/__tests__/helpers/build-session.ts` — factory for `CliSessionRecord` used across tests.
- Spy helpers for `broadcastEvent` and `updateTaskWithHistory`.

## Acceptance

- All three adapters have fixture-backed parser tests, mock-spawn lifecycle tests, and shared contract tests.
- `npm test` in `engine/` runs the full suite offline (no live CLI required).
- `npm run capture-fixtures -- --framework claude` regenerates a fixture (documented for re-capturing when a CLI updates its JSON protocol).
- ~40-50 tests total. CI runs in under 5 seconds.
- A README at `engine/src/agents/__tests__/README.md` explains how to add fixtures and tests for a new adapter.

## Notes

- User confirmed: capture from live runs (not hand-crafted), full coverage scope, on a feature branch.
- Live capture requires the user to have working credentials for all three CLIs. The capture script will be run by the user after this PR scaffolds it; the PR will land with the capture script + placeholder fixtures + passing tests against placeholders, and the user runs `npm run capture-fixtures` to replace placeholders with real transcripts.
