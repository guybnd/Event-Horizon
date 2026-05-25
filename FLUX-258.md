---
title: 'Gemini quota exhaustion — model override, error surfacing, and session cleanup'
status: Todo
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
  - type: comment
    user: Guy
    date: '2026-05-14T00:00:00.000Z'
    comment: >
      Created. User reported: when Gemini hits token quota the session silently
      fails — no clear error message, session may stay dirty, no easy way to
      retry with a different model. Requirements: (1) ability to swap model, (2)
      proper error popup on launch failure, (3) session must end cleanly, (4)
      per-model control for Gemini since different models have different quotas.
    id: c-2026-05-14
  - type: comment
    user: Copilot
    date: '2026-05-14T12:00:00.000Z'
    comment: >
      Grooming complete. Codebase explored, all three parts have confirmed
      touchpoints. No unresolved choices. Implementation plan updated with
      specific files and line references. Moving to Todo.
    id: c-groom-2026-05-14
order: 7
updatedBy: Copilot
---

## Problem / Motivation

When the Gemini CLI hits a token quota limit (e.g. `gemini-2.0-flash` daily free tier), the session fails silently — the engine logs `"session ended with code 1"` with no human-readable cause, the portal shows a failed badge with no explanation, and there is no way to quickly retry with a different Gemini model without changing global settings. Because Gemini's free-tier quotas are per-model, exhausting one model's daily limit does not mean all Gemini models are unavailable, so a fast per-launch model override dramatically reduces friction.

---

## Implementation Plan

### Part 1 — Quota error detection and better outcome messages

**`engine/src/agents/types.ts`**
- Add `failureReason?: string` to `CliSessionRecord`.

**`engine/src/agents/gemini.ts`**
- In the stderr `data` handler (~line 511), before calling `appendSessionOutput`, check the chunk text against `/quota|RESOURCE_EXHAUSTED|429|rate.?limit/i`. If matched, set `session.failureReason = 'quota'`.
- In the `proc.on('exit', ...)` handler (~line 575), change the `outcome` string for non-zero exits:
  - If `session.failureReason === 'quota'`: `"Gemini session failed: token quota exhausted for this model. Try a different model."`
  - Otherwise: keep existing `"session ended with code N"` message.
- After closing the session history entry, emit `broadcastEvent('session_failed', { taskId: id, sessionId: session.sessionHistoryEntry?.sessionId, outcome, framework: session.framework })` for all failed (non-cancelled) exits.

### Part 2 — Surface failures as a portal notification

**`engine/src/events.ts`** — no changes needed; `broadcastEvent` is generic.

**`portal/src/AppContext.tsx`**
- Add state: `sessionFailedAlert: { taskId: string; title: string; outcome: string } | null` and `clearSessionFailedAlert`.
- In the SSE block (~line 659), add a listener for `session_failed` that sets the alert state with title `"Agent session failed"` and the `outcome` from the event payload.
- Expose `sessionFailedAlert` and `clearSessionFailedAlert` via context.

**`portal/src/components/SessionFailedToast.tsx`** (new file)
- Floating dismissible notification rendered when `sessionFailedAlert` is set.
- Shows the outcome string. Includes an "Open ticket" button calling `openTaskModal` with the task id, and a dismiss (×) button calling `clearSessionFailedAlert`.

**`portal/src/App.tsx`**
- Render `<SessionFailedToast />` inside `AppContent`, outside the main layout flow (fixed/absolute positioned).

### Part 3 — Per-launch model override (Gemini model picker)

**`engine/src/agents/types.ts`**
- Extend `AgentAdapter.start` signature: add `modelOverride?: string` parameter.

**`engine/src/agents/gemini.ts`**
- `startCliSession`: add `modelOverride?: string` parameter. When present, use it instead of the config-derived `selectedModel`.
- `GeminiAdapter.start`: pass `modelOverride` through.

**`engine/src/agents/claude-code.ts` / `copilot.ts`**
- Update their `start` implementations to accept (and ignore) the new `modelOverride` parameter to satisfy the interface.

**`engine/src/routes/cli-session.ts`**
- Read `req.body.modelOverride` (optional string) in the start route (~line 31).
- Pass it to `adapter.start(session, task, appendPrompt, effortOverrideRaw, workspaceRoot, modelOverride)`.

**`portal/src/api.ts`**
- Add `modelOverride?: string` to `startTaskCliSession`. Include it in the JSON body when present.

**`portal/src/hooks/useCliSession.ts`**
- Add `modelOverride` state (string, default `''`).
- Pass `modelOverride || undefined` to `startTaskCliSession` in `launchSession`.
- Expose `modelOverride` and `setModelOverride` from the hook.

**`portal/src/components/task-modal/CliSessionPanel.tsx`**
- Add `modelOverride` and `setModelOverride` to props.
- When `selectedCliFramework === 'gemini'`, render an inline combobox (`<input list="gemini-models">` or a small `<select>`) below the framework/launch row.
- Hard-coded suggestion list: `gemini-2.5-pro`, `gemini-2.0-flash`, `gemini-1.5-pro`, `gemini-1.5-flash`.
- Label: "Model override (optional)" — empty means use configured default.

**`portal/src/components/TaskModal.tsx`**
- Pass `modelOverride`/`setModelOverride` from `useCliSession` through to `CliSessionPanel`.
