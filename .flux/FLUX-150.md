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
title: token spend optimization
status: Todo
createdBy: Guy
updatedBy: Agent
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
