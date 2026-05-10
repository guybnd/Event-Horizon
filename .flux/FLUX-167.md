---
assignee: unassigned
tags:
  - agent
  - ai
  - workflow
  - devx
priority: Medium
effort: S
implementationLink: ''
subtasks: []
history:
  - type: activity
    user: Guy
    date: '2026-05-10T05:09:57.678Z'
    comment: Created ticket.
  - type: activity
    user: Agent
    date: '2026-05-10T05:14:36.232Z'
    comment: Launched Claude Code session (d2ca4a6b).
  - type: status_change
    from: Grooming
    to: Require Input
    user: Agent
    date: '2026-05-10T05:15:31.467Z'
  - type: activity
    user: Agent
    date: '2026-05-10T05:15:31.467Z'
    comment: >-
      Updated tags to agent, ai, workflow, devx. Changed priority from None to
      Medium. Changed effort from None to S.
  - type: comment
    user: Agent
    date: '2026-05-10T05:21:37.890Z'
    comment: >-
      Grooming complete. One question before moving to Todo:


      **Thinking budget scope: global-only (Option A) or per-ticket override too
      (Option B)?**


      - Option A: global `thinkingBudget` + `contextWindowThreshold` in
      config/Settings only

      - Option B: same as A, plus per-ticket override field in ticket
      frontmatter + modal control


      Proposed default: Option A (simpler, covers most cases).


      Also: do you want the context compaction threshold
      (`--context-window-threshold`) exposed in Settings, or just the thinking
      budget knob for now?
    id: c-2026-05-10t05-21-37-890z
  - type: comment
    user: Guy
    date: '2026-05-10T05:23:56.734Z'
    comment: >-
      lets do B but we need to keep in mind that. this needs to be modular to
      support different integration types, so we need the architecture to
      account for different model and different provider behjaviours like what
      if we use codex or gemini ninstead of claude. how to handle that?
    replyTo: c-2026-05-10t05-21-37-890z
    id: c-2026-05-10t05-23-56-730z
  - type: status_change
    from: Require Input
    to: Grooming
    user: Guy
    date: '2026-05-10T05:23:56.734Z'
    comment: Response submitted
  - type: status_change
    from: Grooming
    to: Todo
    user: Agent
    date: '2026-05-10T05:34:00.955Z'
  - type: activity
    user: Agent
    date: '2026-05-10T05:34:00.955Z'
    comment: Updated description.
  - type: status_change
    from: Todo
    to: In Progress
    user: Agent
    date: '2026-05-10T05:34:06.505Z'
  - type: comment
    user: Agent
    date: '2026-05-10T05:34:06.505Z'
    comment: >-
      Starting implementation: PROVIDER_CAPABILITIES map, spawn arg injection,
      config fields, Settings page section, TaskModal per-ticket field.
    id: c-2026-05-10t05-34-06-505z
  - type: status_change
    from: In Progress
    to: Ready
    user: Agent
    date: '2026-05-10T05:37:44.539Z'
  - type: comment
    user: Agent
    date: '2026-05-10T05:37:44.540Z'
    comment: >-
      Implementation complete. PROVIDER_CAPABILITIES map added to engine
      (index.ts:98-121), spawn arg injection at ~line 1240 reads per-ticket
      thinkingBudget falling back to global config, then context threshold.
      config.json updated with thinkingBudget:5000 and
      contextWindowThreshold:0.8. Settings page Agent tab has new Session Cost
      Controls section. TaskModal has Thinking Budget Override field. Portal
      TypeScript clean.
    id: c-2026-05-10t05-37-44-540z
  - type: comment
    user: Guy
    date: '2026-05-10T05:44:42.688Z'
    comment: >-
      i dont see in the ticket modal where the selection is.. there should also
      be a dropdown menu on the right click menu with some popular options  (1.
      default setting, 2. this amount, 3. that emount. like h5 options)
    replyTo: c-2026-05-10t05-37-44-540z
    id: c-2026-05-10t05-44-42-681z
  - type: status_change
    from: Ready
    to: In Progress
    user: Guy
    date: '2026-05-10T05:44:42.688Z'
    comment: Returned to work
  - type: activity
    user: Agent
    date: '2026-05-10T05:44:42.732Z'
    comment: Launched Claude Code session (88c08470).
  - type: activity
    user: Agent
    date: '2026-05-10T05:44:43.383Z'
    comment: Claude Code session ended with code 1.
  - type: comment
    user: Agent
    date: '2026-05-10T05:45:50.551Z'
    comment: >-
      Rollback needed: --thinking-budget-tokens and --context-window-threshold
      are not valid Claude Code CLI flags. Need to verify actual supported flags
      from claude --help before re-implementing.
    id: c-2026-05-10t05-45-50-551z
  - type: status_change
    from: In Progress
    to: Ready
    user: Agent
    date: '2026-05-10T05:48:14.075Z'
  - type: comment
    user: Agent
    date: '2026-05-10T05:48:14.075Z'
    comment: >-
      Fixed: --thinking-budget-tokens doesn't exist in Claude CLI. Replaced with
      --effort (low/medium/high/xhigh/max). PROVIDER_CAPABILITIES map now maps
      'supportsEffort' + 'effortFlag'. config.json now has effortLevel:'high'.
      Settings Agent tab has effort dropdown. TaskModal has Effort Override
      dropdown (empty = use global). Portal TypeScript clean.
    id: c-2026-05-10t05-48-14-075z
  - type: comment
    user: Guy
    date: '2026-05-10T05:50:28.020Z'
    comment: >-
      the effort override should be a sidebutton dropdown on every instance of
      the 'launch agent' buttons


      so like in the top bar as well


      it should look like [Button | >] then if i press the > it will let me
      override the launch with a specific setting

      i also want this in the right lcick menu in the main board view
    replyTo: c-2026-05-10t05-48-14-075z
    id: c-2026-05-10t05-50-28-014z
  - type: status_change
    from: Ready
    to: In Progress
    user: Guy
    date: '2026-05-10T05:50:28.020Z'
    comment: Returned to work
  - type: activity
    user: Agent
    date: '2026-05-10T05:50:28.070Z'
    comment: Launched Claude Code session (b1f0dea7).
  - type: activity
    user: Agent
    date: '2026-05-10T06:00:53.646Z'
    comment: Launched Claude Code session (ef84109b).
  - type: comment
    user: Agent
    date: '2026-05-10T06:05:55.209Z'
    comment: >-
      Pausing — orphaned session (PID 3719) killed. New bug FLUX-172 filed for
      the SIGTERM/orphan issue. Split-button work will resume after 172 is
      fixed.
    id: c-2026-05-10t06-05-55-209z
  - type: activity
    user: Agent
    date: '2026-05-10T06:08:07.555Z'
    comment: Claude Code session lost (engine restarted).
  - type: status_change
    from: In Progress
    to: Done
    user: Agent
    date: '2026-05-10T06:52:02.069Z'
  - type: comment
    user: Agent
    date: '2026-05-10T06:52:02.070Z'
    comment: >-
      Shipped in 808ca3e. LaunchAgentSplitButton component added (sm + md
      variants). TaskModal both buttons replaced. ContextMenu gets inline effort
      submenu under Launch Agent. api.ts effortOverride param wired. Settings
      Session Cost Controls section live. All TypeScript clean.
    id: c-2026-05-10t06-52-02-070z
  - type: status_change
    from: Done
    to: Released
    user: Agent
    date: '2026-05-10T11:10:25.934Z'
title: Reduce Claude API token costs through prompt and caching optimizations
status: Released
createdBy: Guy
updatedBy: Agent
version: v0.3.0
releasedAt: '2026-05-10T11:10:25.934Z'
releaseDocPath: release-notes/v0.3.0
---
## Cost Optimizations — Thinking Budget + Context Compaction (Multi-Provider Architecture)

**Goal:** Reduce per-session token spend and give users fine-grained control over AI reasoning cost. Expose a global thinking budget + context compaction threshold, with optional per-ticket overrides. Architecture must be provider-agnostic so it extends cleanly to Codex, Gemini, or any future CLI-based agent.

---

## Decision: Option B selected

- Global defaults in `.flux/config.json` (`thinkingBudget`, `contextWindowThreshold`)
- Per-ticket frontmatter override (`thinkingBudget` only — context threshold is session-level)
- UI controls in Settings page (global) and TaskModal (per-ticket override)
- Multi-provider architecture: flags are defined per-provider in a capability map; only applicable flags are passed for a given framework

---

## Architecture: Provider Capability Map

The engine already has `type CliFramework = 'claude' | 'copilot'` (`engine/src/index.ts:96`). Extend this to a provider capability map that declares which flags each provider supports:

```typescript
// In engine/src/index.ts
interface ProviderCapabilities {
  supportsThinkingBudget: boolean;
  supportsContextWindowThreshold: boolean;
  thinkingBudgetFlag: string;       // e.g. '--thinking-budget-tokens'
  contextWindowFlag: string;        // e.g. '--context-window-threshold'
}

const PROVIDER_CAPABILITIES: Record<string, ProviderCapabilities> = {
  claude: {
    supportsThinkingBudget: true,
    supportsContextWindowThreshold: true,
    thinkingBudgetFlag: '--thinking-budget-tokens',
    contextWindowFlag: '--context-window-threshold',
  },
  copilot: {
    supportsThinkingBudget: false,
    supportsContextWindowThreshold: false,
    thinkingBudgetFlag: '',
    contextWindowFlag: '',
  },
  // Future: codex, gemini entries added here without touching call sites
};
```

Call sites just do `if (caps.supportsThinkingBudget) claudeArgs.push(caps.thinkingBudgetFlag, String(budget))`.

---

## Implementation Plan

### 1. Config schema — `.flux/config.json`
Add two optional fields:
```json
{
  "thinkingBudget": 5000,
  "contextWindowThreshold": 0.8
}
```
Defaults: `thinkingBudget = 5000`, `contextWindowThreshold` omitted (let provider default handle it).

### 2. Ticket frontmatter schema
Add optional `thinkingBudget?: number` to the ticket model. No default — absence means use global config value.

### 3. Engine spawn args — `engine/src/index.ts`
At the `claudeArgs` build site (~line 1213):
- Look up `PROVIDER_CAPABILITIES[framework]`
- Read `configCache.thinkingBudget` (global default)
- Read `task.thinkingBudget` (per-ticket override; takes precedence if set)
- If `caps.supportsThinkingBudget && budget > 0`: push `[caps.thinkingBudgetFlag, String(budget)]`
- If `caps.supportsContextWindowThreshold && threshold`: push `[caps.contextWindowFlag, String(threshold)]`

### 4. Settings page — `portal/src/components/Settings.tsx`
Add a new "Agent" section with:
- `thinkingBudget`: number input (label: "Thinking budget (tokens)", range hint 1000–16000)
- `contextWindowThreshold`: number input (label: "Context compaction threshold", range hint 0.1–1.0, step 0.05)
Wire to existing config save flow.

### 5. TaskModal — `portal/src/components/TaskModal.tsx`
Add `thinkingBudget` field alongside `effort`:
- Number input, label "Thinking budget override"
- Placeholder: "Uses global default"
- Empty/0 = use global; any positive int overrides for this ticket's sessions

---

## Files to Change

- `engine/src/index.ts`: `PROVIDER_CAPABILITIES` map + spawn arg injection (~line 96, ~line 1213)
- `.flux/config.json`: add `thinkingBudget`, `contextWindowThreshold`
- `portal/src/components/Settings.tsx`: Agent settings section
- `portal/src/components/TaskModal.tsx`: per-ticket `thinkingBudget` field

---

## Validation

1. Start a session on a ticket — confirm `--thinking-budget-tokens 5000` appears in process args
2. Set per-ticket `thinkingBudget: 2000` — confirm per-ticket value used instead of global
3. Set framework to `copilot` — confirm no thinking budget flags injected
4. Settings page saves and reloads `thinkingBudget` and `contextWindowThreshold` correctly
5. TaskModal renders and saves `thinkingBudget` per-ticket field
