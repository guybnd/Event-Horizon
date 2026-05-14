---
title: 'Gemini quota exhaustion — model override, error surfacing, and session cleanup'
status: Grooming
priority: High
effort: Medium
tags:
  - bug
  - ux
  - agents
  - gemini
project: PROJECT-1
history:
  - type: activity
    user: Unknown
    date: '2026-05-14T00:00:00.000Z'
    comment: Created ticket.
  - date: '2026-05-14'
    user: Guy
    type: comment
    comment: >
      Created. User reported: when Gemini hits token quota the session silently
      fails — no clear error message, session may stay dirty, no easy way to
      retry with a different model. Requirements: (1) ability to swap model, (2)
      proper error popup on launch failure, (3) session must end cleanly, (4)
      per-model control for Gemini since different models have different quotas.
    id: c-2026-05-14
order: 7
updatedBy: Guy
---

## Problem / Motivation

When the Gemini CLI hits a token quota limit (e.g. `gemini-2.0-flash` daily free tier), the session fails silently:

- Gemini exits non-zero; the engine records `"session ended with code 1"` — indistinguishable from any other crash
- No UI feedback explains what went wrong; the user sees a failed session badge but no actionable reason
- There is no quick way to retry the same ticket with a different model (e.g. swap to `gemini-1.5-pro`) without going to Settings, changing the global model, saving, and re-launching
- The global `groomingModel`/`implementationModel` fields apply to every ticket — you cannot target a single ticket at a different model

Users hit this frequently because Gemini's free-tier quotas are per-model: exhausting one model's daily quota does not mean all Gemini models are unavailable.

---

## Implementation Plan

### Part 1 — Quota error detection and session cleanup

In `engine/src/agents/gemini.ts`, inside `attachStdoutProcessing`, scan the parsed JSON stream for quota/rate-limit errors:

- Gemini CLI emits errors as `{ type: 'result', is_error: true, error: '...' }` or as a non-JSON line on stderr (e.g. `"RESOURCE_EXHAUSTED"`, `"429"`, `"quota"`)
- Add a stderr data handler that checks for quota-related patterns:
  ```
  /quota|RESOURCE_EXHAUSTED|429|rate.?limit/i
  ```
- When detected, set `session.failureReason = 'quota'` (add this field to `CliSessionRecord`)
- In the `proc.on('exit', ...)` handler, incorporate `session.failureReason` into the outcome string:
  - Quota: `"Gemini session failed: token quota exhausted for this model. Try a different model."`
  - Generic non-zero: existing `"session ended with code N"`
- This ensures the session entry in the ticket file carries a human-readable cause

### Part 2 — Surface launch failures as a UI error notification

The portal receives all session lifecycle events via SSE. Currently a failed session shows a badge but no proactive alert.

**Engine side** (`engine/src/events.ts` / exit handler in `gemini.ts`):
- When a session ends as `failed`, emit a `session_failed` SSE event (or reuse the existing `progress` event with a `failed: true` flag and the `outcome` string)

**Portal side**:
- In the SSE/event handler, when a session transitions to `failed` within the first ~60 seconds of starting (fast failure = launch error), show a toast/popup:
  - Title: `"Agent session failed to start"`
  - Body: the `outcome` string from the session entry (e.g. quota message, auth error, binary-not-found)
  - Action: `"Open ticket"` button that navigates to the failed ticket

### Part 3 — Per-launch model override (model picker on session start)

Currently the engine uses `integrations.geminiCli.groomingModel` / `.implementationModel` globally. Add a per-launch model override.

**Engine side** (`engine/src/routes/cli-session.ts` or the session launch route):
- Accept an optional `modelOverride` field in the start-session request body
- Pass it into `startCliSession` as a new argument
- When present, use it instead of the config-derived `selectedModel`

**Portal side** — model picker in the "Start Agent" dialog:
- When the selected agent is `gemini`, show a `<select>` (or editable combobox) pre-populated with the configured model for that ticket status
- Show a short list of known Gemini models as suggestions (e.g. `gemini-2.5-pro`, `gemini-2.0-flash`, `gemini-1.5-pro`, `gemini-1.5-flash`) plus freeform input
- Selecting a different model passes `modelOverride` in the launch request
- Keep global settings as the default; the per-launch override does not persist

**Design note**: The model picker should also be available on the "Retry" / re-launch path so the user can immediately retry with a different model after a quota failure.
