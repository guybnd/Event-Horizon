---
assignee: unassigned
tags:
  - agent
  - ai
  - backend
  - architecture
priority: Medium
effort: M
implementationLink: ''
subtasks: []
history:
  - type: activity
    user: Guy
    date: '2026-05-09T04:30:00.000Z'
    comment: Created ticket.
  - type: comment
    user: Agent
    date: '2026-05-09T04:30:00.000Z'
    comment: >-
      Grooming complete. Plan written to ticket body.


      **Summary of changes:**

      1. History filter — strip `agent_message` entries, cap at 3 (was 6).
      One-liner in `engine/src/index.ts:1092`.

      2. Model routing — add `integrations.claudeCode.{groomingModel,
      implementationModel}` to config defaults + config.json; engine reads it at
      session start and passes `--model <model>` to spawn args based on ticket
      status group; Settings UI adds two inputs in the Agent tab to edit the
      model IDs.


      Moving to `Todo`.
    id: c-2026-05-09t04-30-00-000z
  - type: status_change
    from: Grooming
    to: Todo
    user: Agent
    date: '2026-05-09T04:30:01.000Z'
  - type: status_change
    from: Grooming
    to: Todo
    user: Agent
    date: '2026-05-09T04:27:48.758Z'
  - type: activity
    user: Agent
    date: '2026-05-09T04:27:48.758Z'
    comment: Updated description.
  - type: activity
    user: Agent
    date: '2026-05-10T14:16:49.025Z'
    comment: Launched Claude Code session (95d47eb5).
  - type: status_change
    from: Todo
    to: In Progress
    user: Agent
    date: '2026-05-10T14:17:05.565Z'
  - type: comment
    user: Agent
    date: '2026-05-10T14:17:05.566Z'
    comment: >-
      Starting implementation: (1) history filter one-liner, (2) config schema +
      engine model routing, (3) Settings UI inputs.
    id: c-2026-05-10t14-17-05-566z
  - type: activity
    user: Agent
    date: '2026-05-10T14:17:38.620Z'
    comment: Claude Code session stopped.
  - type: activity
    user: Agent
    date: '2026-05-10T14:22:57.097Z'
    comment: Launched Claude Code session (7e08c7b3).
  - type: activity
    user: Agent
    date: '2026-05-10T14:23:51.271Z'
    comment: Claude Code session stopped.
  - type: activity
    user: Agent
    date: '2026-05-10T14:30:08.590Z'
    comment: Launched Claude Code session (cdfecb32).
  - type: activity
    user: Agent
    date: '2026-05-10T14:31:05.886Z'
    comment: Claude Code session stopped.
  - type: status_change
    from: In Progress
    to: Ready
    user: Guy
    date: '2026-05-10T14:34:28.161Z'
  - type: status_change
    from: Ready
    to: In Progress
    user: Guy
    date: '2026-05-10T14:34:39.942Z'
  - type: activity
    user: Agent
    date: '2026-05-10T14:34:39.992Z'
    comment: Launched Claude Code session (c634e6c1).
  - type: agent_message
    user: Claude Code
    date: '2026-05-10T14:34:46.720Z'
    comment: >-
      API Error (claude-sonnet-4-6): 400 The provided model identifier is
      invalid.. Try --model to switch to
      us.anthropic.claude-sonnet-4-5-20250929-v1:0.
  - type: activity
    user: Agent
    date: '2026-05-10T14:35:48.806Z'
    comment: Claude Code session lost (engine restarted).
  - type: status_change
    from: In Progress
    to: Ready
    user: Guy
    date: '2026-05-10T14:36:16.959Z'
  - type: status_change
    from: Ready
    to: In Progress
    user: Guy
    date: '2026-05-10T14:36:23.003Z'
  - type: activity
    user: Agent
    date: '2026-05-10T14:36:23.048Z'
    comment: Launched Claude Code session (d8b22be4).
  - type: status_change
    from: In Progress
    to: Ready
    user: Agent
    date: '2026-05-10T14:37:51.099Z'
  - type: comment
    user: Agent
    date: '2026-05-10T14:37:51.100Z'
    comment: >-
      **Architectural review: approved.**


      Implementation is structurally sound across all three surfaces.


      **What holds up:**


      1. **History filter** (line 1250) — Filter-before-slice is the correct
      order: we want the 3 most recent non-`agent_message` entries, not the last
      3 of the last 6. One-liner, correct semantics, no helper abstraction
      needed at this scope.


      2. **Empty string → no `--model` flag** — The falsy guard `selectedModel ?
      [...] : []` correctly treats blank config as 'use Claude Code default'.
      Since `groomingModel` and `implementationModel` default to `''`, users who
      never configure this get clean pass-through with zero args change. This is
      the right graceful degradation.


      3. **`framework === 'claude'` guard** — Correct. By the time we reach line
      1288, `framework` is already resolved to `'claude'` or `'copilot'` by the
      API validator at line 1207. The UI's `targetFramework === 'auto'`
      visibility gate is also correct — `'auto'` can legitimately resolve to
      Claude.


      4. **Settings dirty-check symmetry** — `groomingModel` and
      `implementationModel` are present in both the current and original payload
      objects, consistent with how `releaseNotesPath` and other nested fields
      are handled. No drift risk.


      5. **Responsibility separation** — UI persists via `PUT /api/config`,
      engine reads from `configCache`, no direct coupling. Config schema default
      and `config.json` are in sync.


      **One thing to note for future work:** `groomingStatuses` hardcodes
      `'Grooming'` while using the configurable `requireInputStatus`. This is
      consistent with how the rest of the codebase treats grooming (it's not
      configurable today), but if a `groomingStatus` config key is ever added,
      this line would need updating alongside `requireInputStatus`. Not a
      current defect — just worth knowing the coupling exists.
    id: c-2026-05-10t14-37-51-100z
  - type: agent_message
    user: Claude Code
    date: '2026-05-10T14:37:56.832Z'
    comment: >-
      Architecture is sound. FLUX-150 is now **Ready**.


      **Review summary:** All three surfaces are correctly structured. Key
      points:


      - **Filter-before-slice** on the history window is the right order — gives
      the 3 most recent non-`agent_message` entries, not just the last 3 of the
      last 6

      - **Empty string → no `--model` flag** is correct graceful degradation;
      blank config cleanly falls through to Claude Code's own default

      - **`framework === 'claude'` guard** is properly placed; by the time line
      1288 is reached, `'auto'` has already been rejected by the API validator —
      no leakage

      - **Dirty-check symmetry** in Settings is maintained consistently with
      other nested config fields


      One future-facing note left in the ticket: `groomingStatuses` hardcodes
      `'Grooming'` alongside the configurable `requireInputStatus` — fine today,
      but worth knowing if a `groomingStatus` config key is ever added.
  - type: activity
    user: Agent
    date: '2026-05-10T14:38:49.530Z'
    comment: Launched Claude Code session (052025ca).
  - type: status_change
    from: Ready
    to: Done
    user: Agent
    date: '2026-05-10T14:39:21.271Z'
  - type: comment
    user: Agent
    date: '2026-05-10T14:39:21.274Z'
    comment: >-
      Shipped in commit 30424bd. History window now filters agent_message
      entries and caps at 3 (was 6). integrations.claudeCode config added with
      groomingModel/implementationModel fields; engine passes --model to Claude
      Code based on ticket phase. Settings UI shows Claude Code Models section
      for claude/auto framework targets. Validation: groomingStatuses filter and
      selectedModel logic confirmed; Settings dirty-check includes new fields.
    id: c-2026-05-10t14-39-21-274z
  - type: activity
    user: Agent
    date: '2026-05-10T14:39:26.565Z'
    comment: Claude Code session ended with code 0.
  - type: status_change
    from: Done
    to: Released
    user: Agent
    date: '2026-05-11T05:55:56.911Z'
title: token spend optimization
status: Released
createdBy: Guy
updatedBy: Agent
order: 0
tokenMetadata:
  inputTokens: 203382
  outputTokens: 1203
  costUSD: 0.122033
  costIsEstimated: false
version: v0.3.1
releasedAt: '2026-05-11T05:55:56.911Z'
releaseDocPath: release-notes/v0.3.1
---
## Token Spend Optimization

Two focused code changes to reduce cost per agent session start:

---

### 1. History window filtering — `engine/src/index.ts:1092`

The current prompt builder includes the last 6 history entries, which can include long `agent_message` blocks (raw session output). These add tokens without helping the agent.

**Change:** Filter out `agent_message` type entries from the history slice, and cap at **3** entries instead of 6.

```ts
// Before (line 1092):
task.history.slice(-6).map(...)

// After:
task.history.filter(e => e?.type !== "agent_message").slice(-3).map(...)
```

File: `engine/src/index.ts`, line 1092.

---

### 2. Model-per-phase routing — config + engine + settings UI

#### 2a. Config schema

Add an `integrations` key to `configCache` default (line 196) and to `.flux/config.json`:

```json
"integrations": {
  "claudeCode": {
    "groomingModel": "claude-haiku-4-5-20251001",
    "implementationModel": "claude-sonnet-4-6"
  }
}
```

Phase groups:
- **Grooming group** (statuses: `Grooming`, `Require Input`) → `groomingModel`
- **Implementation group** (all other statuses: `Todo`, `In Progress`, `Ready`, release) → `implementationModel`

#### 2b. Engine spawn — `engine/src/index.ts` ~line 1128

After `framework` is resolved, before building `claudeArgs`, add model selection:

```ts
const claudeIntegration = configCache.integrations?.claudeCode;
const groomingStatuses = [configCache.requireInputStatus || "Require Input", "Grooming"];
const selectedModel = claudeIntegration
  ? (groomingStatuses.includes(task.status) ? claudeIntegration.groomingModel : claudeIntegration.implementationModel)
  : null;
```

Then append to args when a model is set:
```ts
const claudeArgs = [
  ...(selectedModel ? ["--model", selectedModel] : []),
  "-p", initialPrompt,
  "--output-format", "stream-json",
  "--verbose",
  ...(skipPermissions ? ["--dangerously-skip-permissions"] : []),
];
```

#### 2c. Settings UI — `portal/src/components/Settings.tsx`, Agent tab

Add a "Claude Code Models" section in the Agent tab below the existing skill path info. Two text inputs (or selects) for `groomingModel` and `implementationModel`, persisted via `PUT /api/config` using the same pattern as other config fields in that component.

Only render this section when `targetFramework === "claude"` or `targetFramework === "auto"`.

---

### Validation

- Start a Grooming ticket session → confirm `--model claude-haiku-4-5-20251001` appears in `session.args`
- Start a Todo ticket session → confirm `--model claude-sonnet-4-6` appears
- Verify prompt no longer includes `agent_message` history entries
- Change model via Settings UI → confirm config saved and next session uses new model
- No regression on existing session start / resume flows
- No regression on existing session start / resume flows
