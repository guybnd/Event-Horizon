---
assignee: unassigned
tags:
  - feature
priority: Medium
effort: M
implementationLink: f598ec7
subtasks: []
history:
  - type: activity
    user: Guy
    date: '2026-05-12T03:29:45.011Z'
    comment: Created ticket.
  - type: activity
    user: Agent
    date: '2026-05-12T03:32:07.400Z'
    comment: Launched Claude Code session (595026da).
  - type: status_change
    from: Grooming
    to: Require Input
    user: Agent
    date: '2026-05-12T03:33:41.478Z'
  - type: comment
    user: Agent
    date: '2026-05-12T03:33:41.478Z'
    comment: >-
      Root cause identified: sync-watcher.ts uses a pure 30s debounce with no
      max-wait ceiling. Under sustained write activity (e.g. active agent
      session), every change resets the timer and syncs are indefinitely
      deferred.


      Scope question: the title says "test commit sync time" (implying a test)
      but the description says syncs are not happening regularly enough
      (implying a fix). Which do you want?


      (A) Fix only — replace pure debounce with debounce + max-wait so syncs
      fire at most every N seconds regardless of ongoing activity (e.g. 30s
      debounce, 5min max-wait ceiling).

      (B) Test only — write a test that validates sync timing behavior and
      reveals the existing bug.

      (C) Both — fix the debounce pattern AND add a test to validate it.


      Proposed default: (A) Fix only, with 30s debounce and 5min max-wait
      ceiling.
    id: c-2026-05-12t03-33-41-478z
  - type: agent_message
    user: Claude Code
    date: '2026-05-12T03:33:45.371Z'
    comment: >-
      Ticket is now in **Require Input**. The question is posted.


      **Summary:** Root cause is a pure debounce in `sync-watcher.ts:9` —
      sustained activity keeps resetting the 30s timer indefinitely. Ticket is
      now awaiting your input on scope: (A) fix the debounce, (B) write a test,
      or (C) both. Default proposal is (A) with 30s debounce + 5min max-wait
      ceiling.
  - type: activity
    user: Agent
    date: '2026-05-12T03:33:45.375Z'
    comment: Claude Code session ended with code 0.
  - type: comment
    user: Guy
    date: '2026-05-12T03:35:16.818Z'
    comment: >-
      C and make the max bounce and the debounce timer configurable in settings
      for the sync mode. maybe it need its own setting panel for the whole thing
      including the selection and migration button etc
    replyTo: c-2026-05-12t03-33-41-478z
    id: c-2026-05-12t03-35-16-813z
  - type: status_change
    from: Require Input
    to: Grooming
    user: Guy
    date: '2026-05-12T03:35:16.818Z'
    comment: Response submitted
  - type: activity
    user: Agent
    date: '2026-05-12T03:35:19.144Z'
    comment: Launched Claude Code session (572e0f11).
  - type: status_change
    from: Grooming
    to: Todo
    user: Agent
    date: '2026-05-12T03:38:46.193Z'
  - type: activity
    user: Agent
    date: '2026-05-12T03:38:46.193Z'
    comment: >-
      Updated description. Updated tags to feature. Changed priority from None
      to Medium. Changed effort from None to M.
  - type: status_change
    from: Todo
    to: In Progress
    user: Agent
    date: '2026-05-12T03:38:50.341Z'
  - type: status_change
    from: In Progress
    to: Ready
    user: Agent
    date: '2026-05-12T03:42:35.813Z'
  - type: agent_message
    user: Claude Code
    date: '2026-05-12T03:42:44.521Z'
    comment: >-
      All done. Here's a summary of what was implemented:


      **`engine/src/sync-watcher.ts`** — Pure debounce replaced with debounce +
      max-wait. On first change, a deadline is recorded at `now + maxWaitMs`.
      Each subsequent change resets the debounce timer but never schedules past
      the deadline. Both values are read from `configCache.syncSettings` on
      every call, so settings changes take effect without restarting the engine.
      Exported `createScheduler` factory for unit testing.


      **`engine/src/config.ts`** — Added `syncSettings` default: `{ debounceMs:
      30000, maxWaitMs: 300000 }`.


      **`portal/src/types.ts`** — Added `syncSettings` to the `Config`
      interface.


      **`portal/src/components/settings/WorkspaceSection.tsx`** — Storage Mode
      card renamed to **Git Sync** with a new *Sync Timing* subsection
      containing Debounce delay and Max wait number inputs. Max wait is
      constrained to ≥ debounce to prevent invalid configs.


      **`portal/src/components/Settings.tsx`** — Wired
      `syncDebounceMs`/`syncMaxWaitMs` state, save payload, discard, and
      dirty-check.


      **`engine/src/sync-watcher.test.ts`** — 5 vitest tests covering: debounce
      fire, debounce reset, max-wait ceiling (changes every second for 6 min →
      fires once at 5 min), multi-burst reset, and cancel.


      Ticket is `Ready` — say `finish FLUX-212` when you'd like to commit.
  - type: activity
    user: Agent
    date: '2026-05-12T03:42:44.525Z'
    comment: Claude Code session ended with code 0.
  - type: status_change
    from: Ready
    to: In Progress
    user: Agent
    date: '2026-05-12T03:47:04.430Z'
  - type: activity
    user: Agent
    date: '2026-05-12T03:47:04.458Z'
    comment: Launched Claude Code session (b474c14b).
  - type: comment
    user: Agent
    comment: >-
      **Code Review — Linus Mode**


      Tests pass. The max-wait ceiling logic is correct. The UI constraints (min
      debounce 5s, max-wait >= debounce) are sensible. Fine.


      Now for the problems:


      **1. You wrote the same logic twice.** `scheduleSync` and
      `createScheduler` are parallel implementations of the identical
      debounce+max-wait algorithm. Module-level globals in one, closure state in
      the other. The tests only run `createScheduler`. The actual production
      code path — `scheduleSync` using `maxWaitDeadline` and `debounceTimer`
      module globals — is completely untested. If someone touches `scheduleSync`
      tomorrow, your test suite tells you nothing. That defeats the entire point
      of writing tests.


      The fix is obvious: `scheduleSync` should CALL `createScheduler`
      internally (or equivalent), so the tested code IS the production code.
      Instead you wrote a testable mirror and shipped the real thing untested.


      **2. `(configCache as any).syncSettings` — why is there a cast?**
      `configCache` is already declared as `any` in config.ts. `(any as any)` is
      noise. Either type `configCache` properly or just write
      `configCache.syncSettings`. Pick one.


      **3. `DEFAULT_DEBOUNCE_MS` and `DEFAULT_MAX_WAIT_MS` at the top of the
      file are redundant.** `configCache` is already initialized with those same
      values in config.ts. You have two sources of truth for the same defaults.
      If someone changes the default in config.ts, these constants silently lie.
      Delete them and just initialize `configCache` properly.


      The real logic is correct. The structural problems are not. Fix #1.
    date: '2026-05-12T03:48:19.117Z'
    id: c-2026-05-12t03-48-19-117z
  - type: agent_message
    user: Claude Code
    date: '2026-05-12T03:48:24.549Z'
    comment: >-
      Review posted. Ticket is back to In Progress.


      Three problems found:


      1. **Duplicate logic** — `scheduleSync` and `createScheduler` implement
      the same debounce+max-wait algorithm independently. The tests exercise
      `createScheduler` only. The actual production code path is completely
      untested. `scheduleSync` should call into `createScheduler` so tests cover
      the real code.


      2. **Pointless cast** — `(configCache as any).syncSettings` where
      `configCache` is already typed as `any`. That's `(any as any)`. Just write
      `configCache.syncSettings`.


      3. **Duplicate defaults** — `DEFAULT_DEBOUNCE_MS` / `DEFAULT_MAX_WAIT_MS`
      constants duplicate the same values already set in `configCache`
      initialization in `config.ts`. Two sources of truth that can silently
      diverge.
  - type: activity
    user: Agent
    date: '2026-05-12T03:48:24.553Z'
    comment: Claude Code session ended with code 0.
  - type: activity
    user: Agent
    date: '2026-05-12T03:50:58.369Z'
    comment: Launched Claude Code session (37e7b513).
  - type: status_change
    from: In Progress
    to: Ready
    user: Agent
    date: '2026-05-12T03:53:40.405Z'
  - type: agent_message
    user: Claude Code
    date: '2026-05-12T03:53:47.680Z'
    comment: >-
      The ticket is now Ready. Here's a summary of the three structural fixes
      made to `sync-watcher.ts`:


      1. **Eliminated the duplicate** — `scheduleSync` (module-global state,
      untested) is gone. `startSyncWatcher` now creates a `scheduler` instance
      via `createScheduler` and delegates to it. The code the tests exercise is
      now the production code path.


      2. **`createScheduler` now takes getter lambdas** (`() => number`) instead
      of plain values — so it reads `configCache` live on every schedule call,
      preserving the original intent of picking up config changes without a
      restart.


      3. **Removed `DEFAULT_DEBOUNCE_MS` / `DEFAULT_MAX_WAIT_MS`** —
      `configCache` in `config.ts` already initializes those defaults; having
      them duplicated here was a second source of truth waiting to drift.


      All 5 tests pass.
  - type: activity
    user: Agent
    date: '2026-05-12T03:53:47.683Z'
    comment: Claude Code session ended with code 0.
  - type: activity
    user: Agent
    date: '2026-05-12T03:56:17.204Z'
    comment: Launched Claude Code session (3803d293).
  - type: status_change
    from: Ready
    to: Done
    user: Agent
    date: '2026-05-12T03:57:59.196Z'
  - type: activity
    user: Agent
    date: '2026-05-12T03:57:59.196Z'
    comment: Updated implementation link.
  - type: agent_message
    user: Claude Code
    date: '2026-05-12T03:58:02.941Z'
    comment: >-
      FLUX-212 is closed. Here's the summary:


      - **Commit `f598ec7`** — vitest config + test file (5 tests, all passing)

      - **Commit `6999ead`** — all logic changes (sync-watcher
      debounce+max-wait, config defaults, portal types, Git Sync settings panel)

      - Ticket moved to **Done** with `implementationLink: f598ec7`
  - type: activity
    user: Agent
    date: '2026-05-12T03:58:02.945Z'
    comment: Claude Code session ended with code 0.
  - type: status_change
    from: Done
    to: Released
    user: Agent
    date: '2026-05-12T09:11:15.174Z'
  - type: comment
    user: Agent
    date: '2026-05-12T09:11:15.175Z'
    comment: Migrated from .flux to .flux-store. Released under v0.4.0.
    id: c-2026-05-12t09-11-15-175z
title: test commit sync time for sync mode
status: Released
createdBy: Guy
updatedBy: Agent
tokenMetadata:
  inputTokens: 4058560
  outputTokens: 47957
  costUSD: 2.446679
  costIsEstimated: false
  cacheReadTokens: 3911811
  cacheCreationTokens: 139859
---
## Implementation Plan

### Problem
`sync-watcher.ts` uses a pure 30-second debounce (`DEBOUNCE_MS = 30_000`). Under sustained write activity (e.g. an active agent session), every file change resets the timer — syncs are indefinitely deferred. There is no max-wait ceiling.

### Solution
Replace the pure debounce with a debounce + max-wait pattern:
- On the first change, record a `maxWaitDeadline = now + maxWaitMs`
- On each subsequent change, reset the debounce timer — but never past `maxWaitDeadline`
- When the deadline is reached, fire the sync immediately

Both `debounceMs` and `maxWaitMs` must be read from `config.syncSettings` at the time each schedule call runs, so that changes to settings take effect without restarting the engine.

### Configuration
Add `syncSettings` to `config.json` (and `Config` type):
```json
{
  "syncSettings": {
    "debounceMs": 30000,
    "maxWaitMs": 300000
  }
}
```
Defaults: 30s debounce, 5min max-wait.

### Settings Panel
The Storage Mode card currently lives in `WorkspaceSection.tsx`. Expand it into a dedicated **Git Sync** sub-panel within the Workspace tab containing:
1. Current mode badge + Enable/Restore buttons (moved, not duplicated)
2. Debounce delay input (seconds, min 5s)
3. Max wait input (seconds, min debounce value)
4. Inline description of what each knob does

These settings must wire into `Settings.tsx` state + `handleSave`.

### Test
Add `engine/src/sync-watcher.test.ts` using `vitest` (to be added as a dev dependency). The test:
- Mocks `setTimeout`/`clearTimeout` using fake timers
- Verifies that with a 30s debounce and 5min max-wait, scheduling 200 changes over 6 minutes fires sync at the 5-min mark (not at 30s+200 resets)
- Verifies that if activity stops, sync fires after 30s debounce

### Files to Change
1. `engine/src/sync-watcher.ts` — debounce + max-wait logic, read settings from configCache
2. `engine/src/config.ts` — add `syncSettings` default
3. `portal/src/types.ts` — add `syncSettings` to `Config` interface
4. `portal/src/components/settings/WorkspaceSection.tsx` — Git Sync settings panel
5. `portal/src/components/Settings.tsx` — wire syncSettings state + save
6. `engine/src/sync-watcher.test.ts` — new vitest test file
7. `engine/package.json` — add vitest dev dependency

### Validation
- Run vitest test and confirm it passes
- Manually verify settings panel shows and saves debounce/max-wait values
- Check that the hardcoded `30s debounce` log message is updated to reflect configured values
