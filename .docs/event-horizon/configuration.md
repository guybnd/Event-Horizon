---
title: Configuration Reference
order: 3
---

# Configuration Reference

Event Horizon relies on three separate configuration layers. This document explains where they live and what they control.

## 1. `event-horizon.config.json` (Engine Configuration)

This file sits directly next to your `event-horizon` binary or inside your source root if you're running via the CLI. It controls the core server settings.

| Field | Type | Description |
|-------|------|-------------|
| `port` | `number` | The local port the API and portal are served on (default: `3067`). |

*Note: Changes to this file require restarting the Event Horizon engine.*

## 2. `.flux/config.json` (Project Configuration)

This is your primary workspace configuration file. It is tracked in your repository and shared with your team. It defines the structure of your workflow, board, and metadata.

| Field | Type | Description |
|-------|------|-------------|
| `projects` | `string[]` | Project key prefixes for ticket IDs (e.g. `["WEB", "API"]`). |
| `columns` | `{ name, color? }[]` | The vertical columns displayed on the Kanban board view. |
| `hiddenStatuses` | `{ name, color? }[]` | Ticket statuses that are tracked but hidden from the main board. |
| `users` | `{ name }[]` | List of known team members or agents, shown in assignee dropdowns. |
| `tags` | `{ name, color? }[]` | Preset tag definitions with optional display colors. |
| `priorities` | `{ name, icon, color }[]` | Priority levels with associated Lucide icon names and text colors. |
| `enableBacklogScreen` | `boolean` | Toggles the visibility of the Backlog navigation item. |
| `requireInputStatus` | `string` | The exact status name agents use when they need clarification (default: `"Require Input"`). |
| `readyForMergeStatus` | `string` | The status name indicating a ticket is awaiting user review before merging (default: `"Ready"`). |
| `gatePolicy` | `object` | **FLUX-1261.** Per-gate autonomy policy — see below. Replaces the old `temperEnabled` boolean (migrated once via the `gatePolicyMigrated` marker). |
| `blockAgentPrMerges` | `boolean` | **FLUX-1290.** Gates the `finish_ticket` merge-lock's runtime "a human touched this" check — see below (default `false`). |
| `ci` | `object` | **FLUX-560.** CI gate policy for `finish_ticket` and the portal Merge action — see below (default `{ gate: 'block', allowPending: false }`). |
| `agents.honorScheduledWakeups` | `boolean` | **FLUX-1390.** Honor the `ScheduleWakeup` tool in dispatched (non-chat) phase sessions instead of blocking it — see below (default `false`). |
| `boardCardOpenMode` | `"full" \| "preview"` | Controls whether clicking a board card opens the full modal or the side preview. |
| `animationsEnabled` | `boolean` | Toggles micro-animations on the board interface. |
| `docsRoot` | `string` | The directory relative to the workspace root where documentation is stored (default: `.docs`). |
| `defaultAgent` | `string` | Which agent framework to use by default when launching sessions from the portal. Options: `claude`, `gemini`, `copilot`. |
| `worktreeByDefault` | `boolean` | Default state of the **portal/human** "dedicated worktree" choice on `POST /:id/branch` (default `false`). When on, the human "Start task" path also creates a git worktree so the agent runs isolated from `master` (FLUX-516). **Note (FLUX-741):** the **agent** `branch` (`action:'create'`) MCP tool no longer reads this — agent branch sessions are worktree-isolated **by default** regardless of this setting (pass `worktree: false` to opt a single agent session out into the shared main tree). This flag now governs only the human-manual portal path. A per-launch `worktree` param overrides it on either path. |
| `effortLevel` | `string` | Global effort level for agent sessions. Options: `low`, `medium`, `high`, `xhigh`, `max`. Can be overridden per-ticket or per-session. |
| `permissions` | `object` | Default permission mode per session surface — the workspace "risk tolerance" (FLUX-605, see below). |
| `integrations` | `object` | Per-framework agent configuration (see below). |

### Permission Risk Tolerance

The `permissions` object sets the default permission mode for each session surface. `gated` routes destructive ops (`change_status`, `branch` with `action:'delete'`, `finish_ticket`, `archive`, `Bash`) through a human **Allow/Deny** prompt via Claude Code's `--permission-prompt-tool`; `skip` runs ungated (`--dangerously-skip-permissions`). Configured in **Settings → Agent Integration → Permission Risk Tolerance**. The per-chat **Perms** picker overrides per turn; leaving it on *Default* inherits these values.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `permissions.boardDefault` | `"gated" \| "skip"` | `gated` | Default mode for orchestrator/board sessions (they have triage teeth and a human present to approve). |
| `permissions.ticketDefault` | `"gated" \| "skip"` | `skip` | Default mode for per-ticket chat sessions. |

> Delegated/headless sessions (combiner, relay) cannot block on a human and always run ungated, regardless of this setting.

### Gate Policy (per-gate autonomy dial)

**FLUX-1261.** `gatePolicy` sets the autonomy level for each workflow gate — `plan` (Grooming → Todo) and `review` (→ Ready) — replacing Temper's (FLUX-1071) single board-wide `temperEnabled` boolean. Edited from the ⚙ shown on the Grooming and Ready columns. `merge` is never a representable key — that's the structural half of the merge-lock. **FLUX-1264** adds the runtime half: `finish_ticket` independently refuses to merge a branch ticket unless a human-authored `comment`/`status_change` shows up somewhere in its history (`hasHumanGateTouch`, `models/gate-policy.ts`) — belt-and-suspenders in case a future code path ever reaches a merge call without going through this schema at all; the portal's own merge buttons are already human-gated REST routes, not MCP tools, so they don't need the same check.

**FLUX-1292 default boundary.** The real dividing line is "has this board's `gatePolicy` ever been migrated/configured at all" (`gatePolicyMigrated`, `config.ts`) — **not** "new install" vs. "existing install":

- **Never migrated** — a genuinely fresh workspace (no `config.json` yet) **or** an existing `config.json` that predates the `gatePolicy` field entirely (including a pre-FLUX-1261 Temper-era config, regardless of what `temperEnabled` was set to) — defaults to **`auto-then-you`/`auto`** the first time the engine loads it (FLUX-1497; was `auto`/`auto` Autonomous under FLUX-1292 — the plan gate now always stops for a human confirm on an unconfigured board), persisted once via `gatePolicyMigrated: true`. This mix matches no preset button (renders as "Custom" — legitimate).
- **Already migrated** — a board that has completed this migration once, on any resulting value (including landing on `you`/`you`), or that has an explicit `gatePolicy` choice on disk — is **never** retroactively touched.

**FLUX-1264 presets.** The same ⚙ modal opens with a "Presets — both gates" row above the per-gate control: **Manual** (`you`/`you`), **Guided** (`auto-then-you`/`auto-then-you`), **Autonomous** (`auto`/`auto`). Clicking one writes both `boardDefault.plan` and `boardDefault.review` in a single `saveConfig` call; a board default that doesn't exactly match one of the three shows no preset as active ("Custom" — a legitimate state, e.g. mixed `plan`/`review` values). Presets only ever touch `boardDefault` — a ticket's own `gatePolicyOverride` is untouched, and the modal surfaces a live "N tickets override this" count (`countGatePolicyOverrides`, `portal/src/lib/gatePolicyPresets.ts`) so a stale per-ticket override isn't silently confusing after a board-wide preset change. Custom presets are explicitly out of scope.

| Field | Type | Default (never-migrated board) | Description |
|-------|------|---------|-------------|
| `gatePolicy.boardDefault.plan` | `"auto" \| "auto-then-you" \| "you"` | `auto-then-you` | Autonomy level for the plan-review gate (Grooming → Todo). |
| `gatePolicy.boardDefault.review` | `"auto" \| "auto-then-you" \| "you"` | `auto` | Autonomy level for the code-review gate (→ Ready). `auto` drives the same loop `temperEnabled: true` used to (`temper.ts`). |

> `you`/`you` remains the ultra-safe hard-coded fallback (`DEFAULT_GATE_POLICY`) used only as a last resort if `gatePolicy` is somehow missing entirely on an already-migrated board — it is never the seed a never-migrated board actually lands on.

Values: `auto` clears the gate silently and loops to completion (re-tried up to the shared retry cap, then parks for a human); `you` always waits for a human. `auto-then-you` is asymmetric across gates (**FLUX-1288**): on the `plan` gate it loops review → revise the same way `auto` does, but an approved verdict always stops the loop and flags a human to confirm the move to Todo instead of moving it automatically — only the terminal action is manual, not the iteration; on the `review` gate it instead runs exactly one automated pass and always stops, win or lose (never loops on its own — that gate's own loop-then-confirm shape is a separate sibling ticket, the code-review-gate dial, still open). A ticket may also carry its own `gatePolicyOverride` (frontmatter, engine-internal in v1) that wins over the board default for that ticket only. **FLUX-1263:** the `plan` gate is now fully wired (`gate-runner.ts`) — all three values drive real behavior on the Grooming → Todo move (see [`change_status`](mcp-tools.md#change_status)'s plan-review gate redirect). `review`'s `auto` value drives Temper's existing loop unchanged.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `planReviewDepth` | `"auto" \| "quick" \| "standard" \| "thorough"` | `auto` | **FLUX-1263.** Column-level fixed override for the `plan` gate's review depth/breadth. `auto` picks Quick (XS/S effort, anchor-existence check only) / Standard (M effort, + reground + acceptance-criteria coverage) / Thorough (L/XL effort, + duplicate-ticket check + adversarial self-review) from the ticket's own `effort`; a fixed value forces that depth for every plan review regardless of effort. Dialed in the same Grooming-column ⚙ modal as `gatePolicy`. |

### Block agent PR merges

**FLUX-1290.** `blockAgentPrMerges` (default **`false`**) gates the `finish_ticket` merge-lock's runtime "a human touched this" check (`hasHumanGateTouch`, FLUX-1264 above) — the ONE runtime check, not the schema-level guarantee that `merge` is never a `gatePolicy` key, which is untouched. When `false` (the default), `finish_ticket` skips the check entirely: an agent session can merge a branch/PR ticket with no prior human-authored history touch — e.g. to carry out an explicitly-requested batch merge sweep. When `true`, behavior is byte-for-byte identical to the always-on lock described above. A deliberate default-behavior change for every board (previously there was no way to disable the lock at all) — flip it to `true` to keep the pre-FLUX-1290 always-human-gated merge behavior. Dialed as a plain on/off toggle in the same Ready-column ⚙ modal (review gate) as `gatePolicy`, since it isn't itself a `gatePolicy` key.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `blockAgentPrMerges` | `boolean` | `false` | Gates the `finish_ticket` merge-lock's `hasHumanGateTouch` runtime check. `false` skips it (agent-driven merges allowed); `true` restores the always-on refusal. |

### CI gate

**FLUX-560.** `ci` gates `finish_ticket` and the portal's `POST /:id/pr/merge` on the user's own CI, without EH ever knowing what that CI actually runs — it consumes GitHub's check-rollup verdict (`statusCheckRollup`, already read by `getPullRequestStatus` for the PR card) and, only for repos with no GitHub checks, an optional user-supplied `checkCommand` (the single-repo analog of the multi-repo group's per-member `testCommand`). EH never runs the project's build/test tooling itself — it only ever sees pass/fail.

- `checks.failed > 0` → refused. `checks.pending > 0` → refused **unless** `allowPending: true`. `checks.total === 0` (the repo has no GitHub CI) never gates by itself — this is what keeps a local-first/no-CI repo merging exactly as before.
- When there's no GitHub CI and `checkCommand` is set, it runs (cwd = the PR branch's worktree when one exists, falling back to the workspace root otherwise — FLUX-1564; 5 minute timeout) and its exit code decides; a non-zero exit refuses the same way a failing check does. Leave `checkCommand` unset (the default) for no gate on a no-CI repo.
- A refusal leaves the ticket's status **unchanged** and names the failing/pending count (or the command's exit detail) — re-run `finish_ticket` with `force: true` (the same param the shared-PR guard uses), or confirm the portal's merge prompt, to merge anyway.
- `gate: 'off'` restores the pre-FLUX-560 behavior (merge unconditionally, no gh check read at all). `gate: 'warn'` never refuses but still returns the reason, for boards that want visibility before turning the gate on.

Not yet surfaced in Settings; edit `.flux/config.json` directly.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `ci.gate` | `"off" \| "warn" \| "block"` | `block` | `off` = unconditional merge (pre-FLUX-560 behavior); `warn` = never refuses, reason still returned; `block` = refuses on failing/pending/non-zero. |
| `ci.allowPending` | `boolean` | `false` | When `true`, a pending (not yet completed) check no longer blocks — only an actual failure does. |
| `ci.checkCommand` | `string` | unset | Shell command run (cwd = the PR branch's worktree, falling back to the workspace root if none exists) when the repo has no GitHub checks; a non-zero exit blocks the same as a failing check. Unset = no gate for a no-CI repo. |

### Honor scheduled wakeups

**FLUX-1390** (follow-up to **FLUX-1389**). Every dispatched phase session (grooming/implementation/review/finalize) is a one-shot `claude -p` process that exits at turn end — a `ScheduleWakeup` call there used to silently no-op (no runtime left to honor it) and get the ticket parked as a false "no verdict" review/implementation (FLUX-1378). FLUX-1389 fixed that by unconditionally blocking `ScheduleWakeup` for every non-chat phase via `--disallowed-tools`. `agents.honorScheduledWakeups` (default **`false`**) makes that block conditional: when `false`, behavior is byte-identical to FLUX-1389 (blocked; no session ever enters the `scheduled` state). When `true`, the block is lifted and the wakeup is actually **honored** — the session enters a new resumable `scheduled` session state (distinct from `waiting-input`) instead of finalizing, and the engine's own background wake ticker (`scheduled-wake.ts`, 5s cadence) resumes it via `--resume` once the requested delay elapses, so an unattended agent can self-pace across a long wait (CI, a slow test suite) instead of blocking the whole turn. Bounded: the requested delay is clamped to the tool's own `[60, 3600]`s range, and a session may self-schedule at most 5 times before it fails closed to a normal terminal end. `decideTicketAction` (Furnace/Temper) treats `scheduled` as `wait`, never a park. Claude-only (`ScheduleWakeup` is a Claude Code native tool with no gemini/copilot equivalent). Not yet surfaced in Settings; edit `.flux/config.json` directly.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `agents.honorScheduledWakeups` | `boolean` | `false` | Honor `ScheduleWakeup` in dispatched (non-chat) phase sessions via the `scheduled` session state + background wake ticker, instead of blocking it. |

### Integration Settings

The `integrations` object configures model selection for each supported AI framework. Each has two fields:

| Field | Type | Description |
|-------|------|-------------|
| `integrations.claudeCode.groomingModel` | `string` | Model used for grooming tasks (e.g. `claude-sonnet-4`). Empty string uses the CLI default. |
| `integrations.claudeCode.implementationModel` | `string` | Model used for implementation tasks. |
| `integrations.geminiCli.groomingModel` | `string` | Model used for grooming tasks (e.g. `gemini-2.5-pro`). |
| `integrations.geminiCli.implementationModel` | `string` | Model used for implementation tasks. |
| `integrations.copilotCli.groomingModel` | `string` | Model used for grooming tasks. |
| `integrations.copilotCli.implementationModel` | `string` | Model used for implementation tasks. |

Example:

```json
{
  "defaultAgent": "claude",
  "effortLevel": "high",
  "integrations": {
    "claudeCode": {
      "groomingModel": "claude-sonnet-4",
      "implementationModel": "claude-sonnet-4"
    },
    "geminiCli": {
      "groomingModel": "",
      "implementationModel": ""
    },
    "copilotCli": {
      "groomingModel": "",
      "implementationModel": ""
    }
  }
}
```

## 3. `~/.event-horizon/settings.json` (Global User Settings)

This file is automatically managed by the system tray and portal. It is stored globally in your OS user directory and persists your application preferences across restarts.

| Field | Type | Description |
|-------|------|-------------|
| `lastWorkspace` | `string` | The absolute path to the last opened project directory. |

*You generally do not need to edit this file manually. Use the Workspace tab in Settings to change directories.*
