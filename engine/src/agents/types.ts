import type { ChildProcessWithoutNullStreams } from 'child_process';
import type { ChatAttachment } from '../projection.js';
import type { AgentSessionEntry } from '../history.js';
import type { AuthDiagnosis } from './auth-diagnostics.js';

/** FLUX-674: optional per-turn extras for a chat reply (pasted image attachments). */
export interface SendInputOptions {
  attachments?: ChatAttachment[];
  /**
   * FLUX-1175: a server-resolved persona prompt (via `resolvePersonaPrompt`) to use as this
   * board turn's identity block instead of the default board-orchestrator identity. Read only on
   * the opening turn (`startBoardSession`) — a persona's identity is established once, same as a
   * per-ticket chat launch; later turns in the same conversation are plain user input.
   */
  personaPrompt?: string;
  /**
   * FLUX-1390: this `sendInput` call is the engine's own wake ticker resuming a `scheduled` session
   * (not a human chat reply) — the exit handler finalizes a clean, no-further-sleep turn as
   * `completed`/`failed` (mirroring a fresh dispatch) instead of the interactive
   * `terminalizeResumedExit` fallback (always `waiting-input`), which would otherwise misreport an
   * unattended phase session as needing a human and get it parked by `decideTicketAction`.
   */
  wakeResume?: boolean;
  /**
   * FLUX-1437: this `sendInput` call is the claude adapter's own stale-wait catch-and-resume (a
   * dispatched turn ended narrating a dead background-task wait promise) — same finalization
   * rationale as `wakeResume` above: the exit handler must finalize a clean, no-further-sleep turn
   * as `completed`/`failed` (mirroring a fresh dispatch), not `terminalizeResumedExit`'s always-
   * `waiting-input` fallback, or this corrective resume would itself misreport as needing a human.
   */
  staleWaitResume?: boolean;
}

export type CliSessionStatus = 'pending' | 'running' | 'waiting-input' | 'scheduled' | 'completed' | 'failed' | 'cancelled';
export type CliFramework = 'claude' | 'copilot' | 'gemini' | 'codex';
export type ExecutionPattern = 'relay' | 'scatter-gather' | 'supervisor';
export type PatternPosition = 'lead' | 'assistant' | 'combiner' | 'step' | 'standalone';
export type LaunchPhase = 'grooming' | 'implementation' | 'review' | 'finalize' | 'chat' | 'fast-path' | 'batch-grooming';

// FLUX-1373: the three model tiers a board's per-CLI `integrations.<cli>.tiers` config resolves —
// replaces the old binary ModelTier ('cheap'|'strong'). A CLI-agnostic "how much do I want to spend
// on this task" dial; each CLI maps it to a concrete model id (config.ts's tiers defaults).
export type Tier = 'smart' | 'efficient' | 'cheap';

// FLUX-1373: the stable, persisted task taxonomy every dispatched session is stamped with
// (`session.taskKey`) — the key `modelPolicy.assignments` maps to a Tier. Exactly 9 keys, pinned
// by the ticket plan: per-dimension review keys (correctness/style/security) collapse into ONE
// `review.workers`; the old `review.synthesizer` concept is `review.lead`. A key must be
// mechanically derivable at every dispatch site from what the session record carries (phase ×
// position) — see deriveTaskKey in routes/cli-session.ts.
export type TaskKey =
  | 'grooming.lead' | 'grooming.workers'
  | 'planReview'
  | 'implementation.lead' | 'implementation.workers'
  | 'review.lead' | 'review.workers'
  | 'finalize'
  | 'chat';

// FLUX-1373: the full 9-key set, for route-body validation (an explicit `taskKey` override must be
// one of these) and for iterating every key (e.g. building the default `modelPolicy.assignments`).
export const TASK_KEYS: readonly TaskKey[] = [
  'grooming.lead', 'grooming.workers',
  'planReview',
  'implementation.lead', 'implementation.workers',
  'review.lead', 'review.workers',
  'finalize',
  'chat',
];
// Run-group classification: every session launched in one orchestration run shares
// these so any surface can render the topology without inspecting sibling sessions.
export type GroupVariant = 'combiner' | 'headless';

export interface CliCapabilities {
  resume: boolean;
  background: boolean;
  supervisor: boolean;
  scatter: boolean;
  toolGating: boolean;
  structuredOutput: boolean;
  // A.8 (FLUX-900): folded in from the per-adapter PROVIDER_CAPABILITIES tables, which
  // disagreed with each other. `flag` is a BARE CLI literal (e.g. '--effort') that a generic
  // caller may safely do `args.push(flag, level)` with — it is only meaningful when `supported`
  // is true. FLUX-1629: `configKey` is a config-override KEY for CLIs with no bare-flag form
  // (Codex takes `-c model_reasoning_effort="<level>"` — a key=value config override, not
  // `<flag> <level>`); codex.ts composes that `-c key=value` shape itself rather than exposing a
  // bare `flag` a generic consumer could misuse as `args.push(flag, level)` and emit an invalid
  // `-c high`. Exactly one of `flag`/`configKey` must be set when `supported` is true.
  effort: { supported: boolean; flag?: string; configKey?: string };
  // FLUX-901 (audit B.1–B.7): per-framework OPTIONAL behaviors, verified against current
  // master. Mostly Claude-only; the exceptions are spawnTimeMcpConfig (FLUX-984: Copilot too) and
  // selfPause (FLUX-985: copilot/gemini now honor a Require-Input pause as waiting-input). Shipped to
  // the portal via /api/config so the UI gates features off capability instead of `=== 'claude'`
  // (FLUX-906 consumes these). Distinct from `resume` (any CLI can --resume a session): persistentChat
  // is the narrower "a clean CHAT-turn exit stays 'waiting-input' instead of 'completed'" — copilot/
  // gemini go 'completed' on the first turn (still resumable via resumeSessionId, but not persistent).
  persistentChat: boolean;     // B.1: chat-exit → 'waiting-input' (not 'completed') so the next message resumes the same session
  selfPause: boolean;          // B.2: agent change_status('Require Input') mid-turn keeps the session explicitly resumable
  partialDeltas: boolean;      // B.3: emits token-level assistant deltas (--include-partial-messages → assistantDelta SSE)
  permissionGating: boolean;   // B.4: supports the EH permission-prompt protocol (gated vs skip); others spawn --yolo
  nativeAskBlocked: boolean;   // B.5: the CLI's native AskUserQuestion must be disabled (--disallowed-tools) — a `claude -p` limitation
  spawnTimeMcpConfig: boolean; // B.6: accepts a per-spawn MCP config file (--mcp-config) with phase/tag profile filtering
  imageAttachments: boolean;   // B.7: resolves pasted image attachments into the resumed prompt
  // FLUX-1123: can this CLI actually ENFORCE the FLUX-926 chat file-edit gate (a real
  // --disallowed-tools-equivalent block), as opposed to only receiving an advisory prompt note?
  // Neither Copilot nor Gemini expose a per-tool disallow flag (confirmed against the live CLIs —
  // see the copilot-board.ts / gemini-board.ts FLUX-959 comments), so for them this is false: the
  // ticket-chat gate degrades to a best-effort instruction in the prompt (chatEditGateNote in
  // shared.ts) rather than a real block. Distinct from `toolGating` (generic tool restriction
  // capability, unused today) — this one specifically drives which wording buildInitialPrompt uses.
  chatEditGateEnforced: boolean;
  // (B.9): does the WORKSPACE INSTALLER need to bake a static, project-committed
  // "trust the event-horizon MCP server unconditionally" config into this framework at install
  // time? Without it, a restrictive local default (Claude Code's `dontAsk` permission mode is the
  // confirmed case) can silently deny every EH tool call from an unattended/orchestrator session —
  // no prompt (there's no user to ask), no error anywhere but the denied session's own transcript.
  // The per-CLI mechanism differs and only Claude's needs a DEDICATED installer step:
  //  - claude: true  — installClaudeSettingsPermissions (workflow-installer.ts) merges
  //    `permissions.allow: ["mcp__event-horizon"]` into the project's committed .claude/settings.json.
  //  - gemini: false — Gemini CLI's fix is a `trust: true` field on the SAME mcpServers.event-horizon
  //    entry every Gemini/Antigravity install already writes (buildGeminiMcpServerEntry) — solved by
  //    construction, no separate capability-gated step needed, so this stays false to avoid a second,
  //    redundant install path for it.
  //  - copilot: false — confirmed (GitHub Copilot CLI docs, 2026-07-22) there is NO project-level
  //    committable permission config: approvals persist only to the user's own home-dir
  //    `~/.copilot/permissions-config.json`, which an installer must not write (that's personal
  //    global state, not project state, and copilot has no `.claude/settings.json`-equivalent
  //    project file). Engine-DISPATCHED Copilot sessions are unaffected regardless — they always
  //    spawn with `--yolo`/`--allow-all-tools` (see copilot.ts) — this gap only affects a Copilot
  //    CLI session a human runs manually in the project outside the engine.
  bakesPermissionAllowlist: boolean;
}

// ─── Adapter verification checklist (FLUX-1626, epic FLUX-1625) ──────────────
//
// The `CLI_CAPABILITIES` row below is the choke point for adding a framework: tsc will not let a
// new `CliFramework` compile until the row is complete. So the checklist for HOW to fill it in
// lives here, adjacent to it, rather than in a reference doc — `agent-adapter-contract.md` has
// said "when you add a new framework, add a row here too" for a while, and that is precisely the
// instruction nobody reads while staring at a red `Record<CliFramework, …>`.
//
// Every entry is settled by running the probe against the LIVE CLI, never by reading its docs.
// That is not pedantry: FLUX-959 (Copilot captured a resume id the resume flag does not accept —
// every resumed turn failed, silently), FLUX-977 (Copilot rejects `--effort` outright unless
// `--model` is also set), and FLUX-984 (Copilot never auto-loads workspace `.mcp.json` in `-p`
// mode, and no permission flag changes that) were each discovered by a live spawn contradicting a
// reasonable reading of the documentation.
//
// GROUP B entries are not capability flags. They are the cross-cutting preflight concerns that
// have each broken a shipping adapter at least once; the `origin` field is the receipt.
// A runtime const rather than a bare union: the FLUX-1626 exhaustiveness gate needs to iterate
// these to spot an orphaned probe (one whose id matches neither a capability flag nor a preflight
// concern), and a type alone erases at compile time. `PreflightId` is derived from it so the two
// can never drift.
export const PREFLIGHT_IDS = [
  'loopback-mcp',
  'mcp-write-tools',
  'resume-id-semantics',
  'prompt-over-stdin',
  'cwd-and-worktree-commits',
  'terminal-reason-strings',
  'effort-preconditions',
  'windows-binary-resolution',
  'cache-and-context-reporting',
  'silent-spawn-behavior',
  'cost-model',
  'spawn-vs-resume-flag-divergence',
] as const;

export type PreflightId = typeof PREFLIGHT_IDS[number];

export interface CapabilityProbe {
  /** The `CliCapabilities` field this settles, or a Group B preflight concern. */
  id: keyof CliCapabilities | PreflightId;
  /** What EH actually LOSES when this is false — the consequence, not the flag's definition. */
  impact: string;
  /** The exact invocation that settles it against the live CLI. */
  probe: string;
  /** What counts as a pass. Vagueness here is how FLUX-959 happened — "it emits an id" was true. */
  pass: string;
  /** The ticket that paid for this entry, when it was learned the hard way. */
  origin?: string;
}

export const CAPABILITY_PROBES: readonly CapabilityProbe[] = [
  // ── Group A: one per CliCapabilities flag ──
  {
    id: 'resume',
    impact: 'Without it every turn is a cold spawn: no ticket chat continuity, no scatter-gather combiner resume, and `resumeOrDispatchSession` degrades to always-fresh.',
    probe: 'Run a turn, capture the id the stream emits, then feed that exact value back to the resume invocation and ask a question that can only be answered from the prior turn.',
    pass: 'The follow-up answers from prior context. A clean exit alone is NOT a pass — a CLI that silently starts a fresh session also exits 0.',
    origin: 'FLUX-959',
  },
  {
    id: 'background',
    impact: 'A detachable child survives an engine restart; otherwise every in-flight session dies with the engine and the Furnace loses its slot.',
    probe: 'Spawn a long turn, restart the engine, check whether the child is still alive and still writing.',
    pass: 'Process survives and its output is still attachable.',
  },
  {
    id: 'supervisor',
    impact: 'Gates whether this CLI can lead a supervisor/worker orchestration run.',
    probe: 'Confirm the CLI can spawn and coordinate its own sub-agents within one session.',
    pass: 'Sub-agent output is observable in the parent stream.',
  },
  {
    id: 'scatter',
    impact: 'Gates whether this CLI can be a parallel worker in scatter-gather review.',
    probe: 'Launch N concurrent sessions in separate worktrees; confirm no shared-state collision (auth cache, session db, temp dirs).',
    pass: 'All N complete independently with distinct resume ids.',
  },
  {
    id: 'toolGating',
    impact: 'Generic allow/deny tool list support. Unused today — `chatEditGateEnforced` is the flag that actually drives behavior.',
    probe: 'Check for any per-tool allow/deny flag.',
    pass: 'A named tool can be withheld from the model.',
  },
  {
    id: 'structuredOutput',
    impact: 'Without a parseable stream there is no progress SSE, no activity indicator, no token counters, and no cost — the session is an opaque box.',
    probe: 'Capture a full session with the JSON/JSONL output flag to a fixture file and commit it under `agents/__snapshots__/`.',
    pass: 'Assistant text, tool calls, and usage are all recoverable from the stream. The fixture then drives the parser tests in `adapter-contract.test.ts`.',
  },
  {
    id: 'effort',
    impact: 'One of only two cost dials (the other is the model tier). If a CLI exposes a single model, effort is the ONLY dial — a no-op here means grooming burns what review burns.',
    probe: 'Run the same prompt at the lowest and highest effort; diff output tokens and wall-clock.',
    pass: 'Materially different numbers. Identical numbers mean the flag is accepted and ignored, which is worse than rejected — see `effort-preconditions`.',
  },
  {
    id: 'persistentChat',
    impact: 'A clean chat-turn exit staying `waiting-input` rather than `completed` is what makes the next message resume the same conversation.',
    probe: 'This is adapter-side exit-handler logic, not a CLI feature — Copilot/Gemini are `false` by effort, not impossibility. Confirm only that the CLI can be resumed at all (see `resume`).',
    pass: '`resume` passes; the rest is ours to implement.',
  },
  {
    id: 'selfPause',
    impact: "Without it a mid-turn `change_status('Require Input')` posts the agent's question as a bogus completion comment and can trip the scatter-gather barrier early.",
    probe: 'Adapter-side, like `persistentChat`. All three shipping adapters have it as of FLUX-985.',
    pass: 'Session can be parked `waiting-input` and later resumed.',
    origin: 'FLUX-985',
  },
  {
    id: 'partialDeltas',
    impact: 'Token-level `assistantDelta` SSE — live typing in the portal. Absent means text appears in complete blocks. Cosmetic, never correctness.',
    probe: 'Inspect the captured fixture for events below whole-message granularity.',
    pass: 'Incremental text deltas present. Degrade gracefully — the parser must handle complete blocks either way.',
    origin: 'FLUX-691',
  },
  {
    id: 'permissionGating',
    impact: 'Whether EH can route each tool decision to a portal approval prompt. Absent means the session runs in bypass and the git worktree is the only boundary.',
    probe: 'Look for a flag that delegates the approval decision to an EXTERNAL tool or callback. Built-in approval MODES are not the same thing — they prompt a human on a TTY that a dispatched session does not have.',
    pass: 'An arbitrary MCP tool (or equivalent hook) can be named as the approval authority.',
    origin: 'FLUX-605',
  },
  {
    id: 'nativeAskBlocked',
    impact: "Not a capability you want — a quirk marker. Claude's native AskUserQuestion cannot be fulfilled in `-p` print mode, so it must be disallowed or the agent silently degrades to prose.",
    probe: 'Check whether the CLI ships an interactive-only ask tool that is unreachable in non-interactive mode.',
    pass: 'True when such a tool exists AND can be disabled. Agents ask via the EH `ask_user_question` MCP tool instead.',
    origin: 'FLUX-662',
  },
  {
    id: 'spawnTimeMcpConfig',
    impact: 'Per-phase MCP profiles — the lever that keeps thousands of tokens of tool schemas out of grooming and review sessions.',
    probe: 'Inject an MCP server via a per-invocation flag and confirm the spawned agent can call it. Crucially: verify it does NOT require writing user-global config — an installer must never write personal global state (see `bakesPermissionAllowlist`).',
    pass: 'A server named only at spawn time is callable, and nothing outside the project was mutated.',
    origin: 'FLUX-984',
  },
  {
    id: 'imageAttachments',
    impact: 'Pasted screenshots in ticket chat resolve into the prompt instead of being dropped.',
    probe: 'Pass an image by absolute path and ask the model to describe it.',
    pass: 'The description matches the image.',
    origin: 'FLUX-674',
  },
  {
    id: 'chatEditGateEnforced',
    impact: 'Whether the FLUX-926 gate (chat turns must not mutate the repo outside In Progress) is a real block or only an advisory prompt note.',
    probe: 'Withhold write access by whatever mechanism exists — a per-tool deny list, or a read-only sandbox mode — then instruct the agent to edit a file.',
    pass: 'The write genuinely fails. A coarse read-only sandbox counts: it is stronger than a per-tool deny list for this gate\'s actual purpose.',
    origin: 'FLUX-926 / FLUX-1123',
  },
  {
    id: 'bakesPermissionAllowlist',
    impact: 'Whether the workspace installer must commit a project-level "trust the event-horizon MCP server" config. Without one, a restrictive local default can deny every EH tool call in an unattended session with no prompt and no error anywhere but the transcript.',
    probe: 'Determine whether the CLI has a PROJECT-level committable permission file. A home-directory-only config does not qualify — that is personal global state an installer must not write.',
    pass: 'True only when a project-committable file exists.',
    origin: 'FLUX-901 B.9',
  },

  // ── Group B: preflight concerns that are not capability flags ──
  {
    id: 'loopback-mcp',
    impact: 'THE make-or-break item. The `event-horizon` server is the engine\'s own in-process Streamable-HTTP mount on 127.0.0.1. A CLI that cannot reach loopback cannot read or mutate a single ticket, and every other capability is moot.',
    probe: 'Spawn the CLI in its most restrictive sandbox mode and have it call a read-only EH tool such as `get_board_config`.',
    pass: 'The tool result comes back with real board data. Run this FIRST — it can cancel the whole adapter. NOTE: a read passing proves nothing about writes — see `mcp-write-tools` below (FLUX-1631: this exact probe passed for Codex while every mutating call was silently cancelled).',
    origin: 'FLUX-645',
  },
  {
    id: 'mcp-write-tools',
    impact: 'A read succeeding proves nothing about writes. FLUX-1631: Codex\'s `loopback-mcp` probe passed with `get_board_config` (a read) while every mutating event-horizon call — `add_note`, `change_status` — was silently auto-cancelled ("user cancelled MCP tool call") by the CLI\'s own approval elicitation, in BOTH sandbox modes. An adapter that only clears `loopback-mcp` can ship able to read a ticket but unable to ever record a decision on one — exactly the failure this preflight exists to catch before shipping.',
    probe: 'In the SAME sandbox/approval configuration the adapter actually spawns with, have the CLI call a MUTATING event-horizon tool — `add_note` or `change_status` — against a real ticket, non-interactively (no human present to answer an approval prompt).',
    pass: 'The call completes and the ticket history shows the write. A cancelled, elicited, or pending result is a FAIL even when the process exits 0 — that is precisely how FLUX-1631 shipped undetected.',
    origin: 'FLUX-1631',
  },
  {
    id: 'resume-id-semantics',
    impact: 'Distinct from the `resume` flag. A stream can emit several ids (thread, turn, parent, rollout) and only one is the token the resume path accepts.',
    probe: 'Enumerate every id-shaped field in the captured fixture, then try each one against the resume invocation.',
    pass: 'Exactly one round-trips. Record WHICH field in the adapter, with a comment — this is the single most expensive mistake in this layer.',
    origin: 'FLUX-959',
  },
  {
    id: 'prompt-over-stdin',
    impact: "Windows caps a command line at 32,767 chars. A scatter-gather reviewer's inlined PR diff blows past that, so the prompt must go over stdin, not argv.",
    probe: 'Send a >40 KB prompt over stdin and confirm it arrives intact. Then check the CLI\'s behavior when BOTH an argv prompt and an open stdin are present.',
    pass: 'Large prompt round-trips. Note carefully whether the CLI blocks waiting for stdin EOF — if so the adapter must close stdin, or every session hangs with zero output and gets reaped by the `hungSpawnKilledAt` watchdog.',
    origin: 'FLUX-1444 / FLUX-1625',
  },
  {
    id: 'cwd-and-worktree-commits',
    impact: 'A branch-bearing ticket must run in its own worktree. A one-shot CLI that never checks the branch out will commit straight to master.',
    probe: 'Spawn with cwd set to a worktree, have the agent commit, and verify which branch received it.',
    pass: 'The commit lands on the ticket branch. Also confirm the adapter asserts `assertIsolatedSpawnRoot` — fail closed, never degrade to the main checkout.',
    origin: 'FLUX-972 / FLUX-1018',
  },
  {
    id: 'terminal-reason-strings',
    impact: 'Drives `terminalReason`, which drives the Furnace stoker. An unmapped rate limit is classified as a generic failure, so the ticket is PARKED instead of cooled down and retried — it looks like an EH bug, not a provider limit.',
    probe: 'Collect the verbatim error text for: quota/rate limit, expired or invalid credentials, and context-window overflow.',
    pass: 'All three literals recorded and matched by the adapter\'s classifiers. These predicates are pure and unit-testable — add fixtures.',
    origin: 'FLUX-1047 / FLUX-1063 / FLUX-1397',
  },
  {
    id: 'effort-preconditions',
    impact: 'An effort flag may be conditionally rejected. Copilot rejects `--effort` outright unless `--model` is also set, which crashed every Copilot session for users who never configured one.',
    probe: 'Send the effort flag with and without every other flag it might depend on.',
    pass: 'Preconditions documented in the adapter. When dropping a requested effort, LOG the drop — replacing a crash with a silent no-op just makes "why did effort do nothing" unanswerable.',
    origin: 'FLUX-977',
  },
  {
    id: 'windows-binary-resolution',
    impact: 'npm bin shims are shell scripts; spawning one instead of the real executable mangles stdio and the JSON stream never parses.',
    probe: 'Resolve and spawn the actual executable on Windows, not the PATH shim. Cache the resolution — it must not re-run per spawn.',
    pass: 'Stream parses identically on Windows and POSIX.',
    origin: 'FLUX-975',
  },
  {
    id: 'cache-and-context-reporting',
    impact: 'Feeds `lastTurnContextTokens` / `contextWindow`, which decide whether to resume a session or cold-spawn. Missing data must not be read as "unlimited".',
    probe: 'Inspect the terminal usage event for cache-read, cache-write, and any context-window figure.',
    pass: 'Whatever is present is mapped; whatever is absent falls back conservatively.',
    origin: 'FLUX-1378',
  },
  {
    id: 'silent-spawn-behavior',
    impact: 'A CLI that is installed but not logged in may hang forever without writing a byte. The watchdog kills it, but the failure reads as a mystery.',
    probe: 'Spawn with credentials deliberately absent or invalid.',
    pass: 'It exits with a diagnosable error rather than hanging. If it hangs, say so in the adapter so the watchdog kill is expected rather than alarming.',
  },
  {
    id: 'cost-model',
    impact: 'Wrong per-MTok rates make every cost badge, session estimate, and Furnace budget wrong by a constant — and plausible enough that nobody notices.',
    probe: 'Look up current published pricing for each model the tiers resolve to.',
    pass: 'Rates recorded in the manifest with the date checked.',
    origin: 'FLUX-1375',
  },
  {
    id: 'spawn-vs-resume-flag-divergence',
    impact: 'The resume path may accept a NARROWER flag set than the spawn path. EH rebuilds args on every resume, so a flag valid at spawn can hard-fail the reply.',
    probe: 'Take the full spawn arg list and replay it verbatim against the resume invocation.',
    pass: 'Either it is accepted, or every rejected flag has a documented equivalent (typically a generic config-override flag). Verify the equivalent actually applies — do not assume.',
    origin: 'FLUX-1625',
  },
] as const;

export const CLI_CAPABILITIES: Record<CliFramework, CliCapabilities> = {
  claude: { resume: true, background: true, supervisor: true, scatter: true, toolGating: true, structuredOutput: true, effort: { supported: true, flag: '--effort' }, persistentChat: true, selfPause: true, partialDeltas: true, permissionGating: true, nativeAskBlocked: true, spawnTimeMcpConfig: true, imageAttachments: true, chatEditGateEnforced: true, bakesPermissionAllowlist: true },
  gemini: { resume: true, background: true, supervisor: true, scatter: true, toolGating: true, structuredOutput: true, effort: { supported: false }, persistentChat: false, selfPause: true, partialDeltas: false, permissionGating: false, nativeAskBlocked: false, spawnTimeMcpConfig: false, imageAttachments: false, chatEditGateEnforced: false, bakesPermissionAllowlist: false },
  // FLUX-984: Copilot never auto-loads workspace .mcp.json in non-interactive (-p) mode — confirmed
  // live, no permission flag changes it. spawnTimeMcpConfig:true here means "copilot.ts explicitly
  // injects the event-horizon server via --additional-mcp-config", a different flag/JSON-shape than
  // Claude's --mcp-config but the same capability concept (B.6).
  copilot: { resume: true, background: false, supervisor: false, scatter: true, toolGating: true, structuredOutput: false, effort: { supported: true, flag: '--effort' }, persistentChat: false, selfPause: true, partialDeltas: false, permissionGating: false, nativeAskBlocked: false, spawnTimeMcpConfig: true, imageAttachments: false, chatEditGateEnforced: false, bakesPermissionAllowlist: false },
  // FLUX-1625 Phase 0 (live probe, codex-cli 0.146.0, Windows): resume / structuredOutput /
  // spawnTimeMcpConfig / imageAttachments / partialDeltas / permissionGating /
  // bakesPermissionAllowlist are all CONFIRMED against the live CLI (see the ticket's Phase 0 note).
  // The rest were NOT probed and carry a conservative default rather than a guess — flip each only
  // once a live probe confirms it (CAPABILITY_PROBES entries above name the exact invocation):
  //  - effort: verified via `-c model_reasoning_effort="<level>"`; Codex accepts the same five
  //    levels Event Horizon exposes (some accounts also advertise an intentionally unreachable ultra).
  //    No bare flag form exists, so `flag` stays undefined and `configKey` carries the config-override
  //    key instead (see the `effort` field comment above) — codex.ts's buildCodexEffortArgs composes
  //    the `-c key=value` shape itself.
  //  - scatter: true (FLUX-1633, live probe) — three concurrent `codex exec` runs in separate
  //    directories all exited 0 with three distinct thread_ids and each wrote its own correct
  //    output; no shared-state collision (auth cache, session db, temp dirs).
  //  - background: true (FLUX-1633, live probe) — spawned `codex exec`, killed the parent shell,
  //    codex.exe stayed alive and kept streaming output.
  //  - toolGating: FALSE — probed and genuinely absent, not unprobed: no allow/deny tool surface
  //    exists anywhere in `--help`, `codex features list`, or the config keys (FLUX-1633).
  //  - supervisor/nativeAskBlocked: never probed at all. (`codex features list` reports
  //    `multi_agent` as stable/true — a strong supervisor lead, but leave false until someone
  //    drives a sub-agent through `exec` and observes it in the parent stream.)
  //  - persistentChat: true (FLUX-1630) — resume is live-verified (`codex exec resume <thread_id>`,
  //    CAPABILITY_PROBES) and the adapter's exit-handler now routes a clean `phase:'chat'` turn to
  //    'waiting-input' (codex.ts), matching claude-code.ts, instead of forcing 'completed' and
  //    posting the reply as a ticket comment.
  //  - chatEditGateEnforced: FALSE (FLUX-1631 — flipped from Phase 0's `true`). Phase 0 confirmed a
  //    read-only sandbox genuinely blocks a raw file write in isolation, which is a real capability —
  //    but FLUX-1631 found that BOTH sandbox modes ALSO silently cancel every mutating event-horizon
  //    MCP call ("user cancelled MCP tool call"): non-interactive `exec` can never satisfy codex's
  //    approval elicitation for a tool call, and only `--dangerously-bypass-approvals-and-sandbox`
  //    clears it — which lifts the sandbox too. codex.ts and codex-board.ts now spawn with that flag
  //    unconditionally (mirrors Copilot's `--yolo` / Gemini's `--yolo --skip-trust`), so the sandbox
  //    is never actually in force in the shipped configuration. This must reflect what's enforced by
  //    the real spawn, not what the CLI can enforce in principle — see `mcp-write-tools` above.
  codex: { resume: true, background: true, supervisor: false, scatter: true, toolGating: false, structuredOutput: true, effort: { supported: true, configKey: 'model_reasoning_effort' }, persistentChat: true, selfPause: true, partialDeltas: false, permissionGating: false, nativeAskBlocked: false, spawnTimeMcpConfig: true, imageAttachments: true, chatEditGateEnforced: false, bakesPermissionAllowlist: false },
};

// FLUX-905 (audit C.17): model-family name fragments per framework, for detecting whether a
// ticket-history author string represents an agent (a session may post under a model display name
// like "Claude (Opus 4.8)", not the canonical 'Agent'). Centralized + type-checked so a new model
// family is a one-line edit here, not a buried regex in history.ts. Drives AGENT_AUTHOR_PATTERN.
// FLUX-1625: 'codex' fragment removed from copilot's list — it used to be copilot's own alias for
// a gpt-5-codex model, but is now the literal name of a DISTINCT framework below, so leaving it on
// copilot's list would misattribute a real Codex CLI session's history author to Copilot. 'gpt'
// stays on both (both are genuinely OpenAI-model-family CLIs; the overlap predates this ticket).
export const MODEL_FAMILIES: Record<CliFramework, string[]> = {
  claude: ['claude', 'opus', 'sonnet', 'haiku'],
  copilot: ['copilot', 'gpt'],
  gemini: ['gemini'],
  codex: ['codex', 'gpt'],
};

// FLUX-931: framework -> its config key under `integrations.*` (config.ts: claudeCode/geminiCli/
// copilotCli). Lets callers outside agents/ (e.g. the delegate route) read a framework's own
// integration config generically instead of a hardcoded per-framework literal at each call site.
export const INTEGRATION_CONFIG_KEYS: Record<CliFramework, string> = {
  claude: 'claudeCode',
  gemini: 'geminiCli',
  copilot: 'copilotCli',
  codex: 'codexCli',
};

export interface AgentProcess {
  proc: ChildProcessWithoutNullStreams;
  sessionId: string;
  taskId: string;
}

export interface AgentAdapter {
  readonly manifest: ProviderManifest;
  labelForFramework(): string;
  start(session: CliSessionRecord, task: unknown, appendPrompt: string, effortOverride: string, workspaceRoot: string): Promise<void>;
  sendInput(session: CliSessionRecord, message: string, user: string, workspaceRoot: string, opts?: SendInputOptions): Promise<void>;
  stop(session: CliSessionRecord): void;
}

export interface CliSessionSummary {
  id: string;
  taskId: string;
  framework: CliFramework;
  status: CliSessionStatus;
  command: string;
  args: string[];
  startedAt: string;
  endedAt?: string;
  pid?: number | undefined;
  label: string;
  lastOutputAt?: string;
  lastInputAt?: string;
  blockedReason?: string;
  /**
   * FLUX-1047 / FLUX-1063 / FLUX-1397: structured classification of WHY a terminal session ended, when
   * the raw exit is otherwise an opaque nonzero-exit `failed`:
   *   - `'context-exhausted'` — the single session ran out of context ("prompt is too long" /
   *     context_length_exceeded). Recoverable — re-driven with a FRESH session (no `--resume`).
   *   - `'rate-limited'` — a usage/quota/rate limit (5-hour session limit, HTTP 429, `rate_limit_event`).
   *     Transient: it clears at the provider's reset window, so the stoker cools the ticket down and
   *     auto-retries on a cadence instead of parking it. A fresh session at retry time (no `--resume`).
   *   - `'auth-expired'` — a revoked/expired API key or OAuth token (401/403, "OAuth token has expired").
   *     Transient in the sense that a human re-auth (`claude login` / refreshed key) fixes it, but NOT
   *     something the Furnace can recover from on its own — every ticket sharing the CLI's credential
   *     would fail identically, so the stoker halts the whole batch and asks for re-auth instead of
   *     parking each ticket independently (see furnace-stoker.decideTicketAction).
   * An extensible enum — the durable seam FLUX-996's hardened runner can build on.
   */
  terminalReason?: 'context-exhausted' | 'rate-limited' | 'auth-expired';
  /** FLUX-1599: structured self-diagnosis attached whenever `terminalReason` is 'auth-expired' —
   *  which binary was spawned vs. what the login shell resolves, duplicate installs, and
   *  settings/env credential shadowing. See `agents/auth-diagnostics.ts`. Portal-visible (the
   *  chat error card, FLUX-1601, reads this instead of the raw provider error). */
  authDiagnosis?: AuthDiagnosis;
  liveOutput?: string;
  /** FLUX-1685: original `liveOutput` length before detail-payload truncation was applied to a
   *  terminal session — present only when truncation actually happened. */
  liveOutputChars?: number;
  currentActivity?: string | undefined;
  skipPermissions?: boolean;
  inputTokens?: number;
  outputTokens?: number;
  costUSD?: number;
  costIsEstimated?: boolean;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  role?: string;
  phase?: LaunchPhase;
  /** FLUX-1383: for phase:'batch-grooming', the eligible member ticket ids this session grooms in
   *  one sitting (the anchor `taskId` is always included). Absent/empty for every other phase. */
  batchTicketIds?: string[];
  /** FLUX-1373: the task-tier policy key this session resolves its model through — stamped once at
   *  creation (see deriveTaskKey, routes/cli-session.ts). */
  taskKey?: TaskKey;
  pattern?: ExecutionPattern;
  patternPosition?: PatternPosition;
  /** Shared by all sessions launched in one orchestration run. */
  groupId?: string;
  /** Order within a relay pipeline (0,1,2...). */
  groupSeq?: number;
  /** Total expected sessions in the group (for relay: total steps). Lets the UI
   *  render placeholder slots before all sessions have spawned. */
  groupTotal?: number;
  /** Authoritative orchestration type of the whole group. */
  groupType?: ExecutionPattern;
  /** Disambiguates the two scatter-gather visuals: fan-in vs swarm of peers. */
  groupVariant?: GroupVariant;
  lockedPaths?: string[];
  outputData?: string;
  /** True when this session can be continued via `claude --resume` — terminal-or-active
   *  with a known `resumeSessionId`. Lets the chat continue a dispatched (now-completed)
   *  phase session's thread instead of spawning a fresh, amnesiac chat (FLUX-606). The raw
   *  `resumeSessionId` is intentionally not exposed to the client; a boolean is enough. */
  resumable?: boolean;
  /** FLUX-1390: ISO time this `scheduled` (sleeping) session will be auto-resumed via `--resume`. */
  wakeAt?: string;
  /** FLUX-1390: the agent's own `reason` for the pending wakeup, if it gave one — surfaced next to `wakeAt`. */
  wakeReason?: string;
  /** FLUX-1434: the `event-horizon` MCP tool names (bare) actually disallowed for this session at
   *  its last spawn/resume — the deny-list model's own computed output, so a gap (a session
   *  missing a tool its mission needs) is a one-glance diagnosis instead of a re-derivation.
   *  Portal-visible, read-only. Empty/absent means unscoped (lead/flex/no-persona/chat). */
  disallowedEhTools?: string[] | undefined;
  /** FLUX-1531: the workspace root this session was spawned under (multi-board, epic FLUX-1230
   *  S13) — stamped once at creation from `getWorkspaceRoot()`, mirroring `FurnaceBatch.workspaceRoot`
   *  (FLUX-1513). Absent on legacy/rehydrated sessions, which fall back to the default workspace —
   *  see `sessionBelongsToWorkspaceRoot` (session-store.ts). */
  workspaceRoot?: string;
}

export interface CliSessionRecord extends CliSessionSummary {
  proc?: ChildProcessWithoutNullStreams;
  resumeSessionId?: string;
  blockedReason?: string;
  outputBuffer: string;
  liveOutputBuffer: string;
  pendingAssistantText: string;
  /** Cumulative assistant text — never flushed, used for relay handoff. */
  cumulativeOutput: string;
  flushTimer?: NodeJS.Timeout | undefined;
  requestedStop: boolean;
  writeQueue: Promise<void>;
  skipPermissions: boolean;
  sessionHistoryEntry?: AgentSessionEntry;
  progressHeartbeat?: NodeJS.Timeout | undefined;
  lastProgressLog?: string | undefined;
  role?: string;
  pattern?: ExecutionPattern;
  patternPosition?: PatternPosition;
  lockedPaths?: string[];
  outputData?: string;
  /** Pre-computed diff block injected into the initial prompt (scatter-gather reviews). */
  diffBlock?: string;
  /** FLUX-1383: for phase:'batch-grooming', the members the route excluded from `batchTicketIds`
   *  (ineligible effort/epic-parent/status) + why — folded into the initial mission text's
   *  "excluded and named" note. Internal (not part of CliSessionSummary — never exposed to the
   *  client); a one-time launch computation, not re-derived on resume. */
  batchExcluded?: { id: string; reason: string }[];
  /** FLUX-1385: the launched persona id, if any — feeds disallowedEhToolsForPersona so a
   *  worker-role delegate's `event-horizon` MCP toolset is scoped down at spawn. Internal
   *  (not part of CliSessionSummary — never exposed to the client). */
  personaId?: string;
  /** FLUX-1385: this launch's focus text — checked for the sole-reviewer-of-record signal that
   *  restores a scoped-down worker's full write toolset. Internal, same as personaId above. */
  focusComment?: string;
  /** FLUX-1434: explicit per-launch `event-horizon` MCP tool grant (dispatch.enableTools in the
   *  deny-list model — see disallowedEhToolsForPersona in orchestration-personas.ts). Re-stamped
   *  on resume so a resumed session's toolset always matches its current mission. Internal, same
   *  as personaId/focusComment above. */
  enableTools?: string[] | undefined;
  /** Set when the session paused itself via change_status('Require Input'). */
  pausedForInput?: boolean;
  /**
   * FLUX-1479 (FLUX-1226 Phase E): the destination phase of a phase->persona HANDOFF applied to a
   * persistent per-ticket chat session (`phase === 'chat'`, FLUX-602) on a ticket status
   * transition — e.g. a Scratch chat promoted then moved Grooming -> Todo. Deliberately a
   * SEPARATE field from `phase` (never overwritten): `phase` staying `'chat'` is what
   * `reapStaleParkedSessions`/session-store rely on to keep this the SAME persistent conversation
   * across status moves (session-store.ts's FLUX-602 comment) — mutating it directly would make
   * the session look like a stale dispatched session and eligible for reaping. Consumers that want
   * the session's CURRENT logical phase (persona/prompt resolution in buildInitialPrompt's callers,
   * deny-list recompute in disallowedToolsArgs/stampDisallowedEhTools) read `handoffPhase ?? phase`;
   * consumers about the session's LIFECYCLE model (ScheduleWakeup eligibility, reaping) keep
   * reading raw `phase` unchanged. Cleared back to `undefined` when a transition derives no phase
   * for the new status (falls back to the plain chat persona). Internal — not part of
   * CliSessionSummary, never exposed to the client. */
  handoffPhase?: LaunchPhase | undefined;
  /** FLUX-1479: whether `handoffPhase`'s one-time announcement note (`buildPhaseHandoffNote`) has
   *  already been delivered into the conversation. Reset to `false` whenever `handoffPhase` changes
   *  to a new value; consumed (set `true`) by the adapter that actually sends the note. */
  handoffPhaseAnnounced?: boolean | undefined;
  /**
   * The agent EXECUTION root this session spawned in (its worktree, or the engine
   * root) — FLUX-519. Captured at start so a later reply (sendInput) resumes in the
   * SAME tree, and so we can refuse to resume on master if the worktree was removed.
   */
  executionRoot?: string;
  /** Per-conversation model + effort override from the chat picker (FLUX-604). */
  model?: string;
  effortOverride?: string;
  /** FLUX-605: 'gated' = route tool decisions through EH approval (--permission-prompt-tool);
   *  'skip' = --dangerously-skip-permissions. Undefined falls back to skipPermissions. */
  permissionMode?: 'gated' | 'skip';
  /** FLUX-651: ticket status + subtask count captured at the START of the current turn,
   *  so the turn-end backstop can tell whether the agent actually took a board action
   *  (status moved / Require Input raised / subtask created) or just parked. */
  statusAtTurnStart?: string | undefined;
  subtaskCountAtTurnStart?: number;
  /** FLUX-826: agent-comment count at turn start + whether the agent raised a structured
   *  `ask_user_question` this turn — feed the SOFT resting-status backstop (a fresh comment
   *  with no board action and no structured prompt surfaces a needs-action nudge). */
  commentCountAtTurnStart?: number;
  askedThisTurn?: boolean;
  /** FLUX-981: last surfaced rate-limit key (`${status}:${rateLimitType}`) — de-dups the inline
   *  ⚠️ rate-limit line so a stream that re-emits `rate_limit_event` on every retry/backoff while
   *  throttled produces ONE chat line, not one per event. Cleared when status returns to 'allowed'. */
  lastRateLimitKey?: string | undefined;
  /** FLUX-981: tool_use id → tool name, captured from Claude `assistant` tool_use blocks so a later
   *  `user` `tool_result` carrying `is_error` can be labeled with the tool that failed (the result
   *  block itself carries only the id). Bounded — cleared at result/turn end. */
  toolNamesById?: Record<string, string> | undefined;
  /** Last ≤500 chars of stderr output — appended to the ⚠️ failure message so errors like
   *  "GitHub Copilot extension is not installed" that arrive on stderr rather than stdout
   *  are surfaced in the chat log instead of silently dropped. */
  stderrCapture?: string;
  /** Stamped when the silent-spawn watchdog (reconcileDeadSessions, session-store.ts) killed this
   *  session's child because it produced zero output for the whole watchdog window — a spawned CLI
   *  that hangs without ever writing a byte (e.g. `claude` installed but never onboarded/logged in
   *  on a fresh machine). One-shot latch so the lazy reaper never re-kills the same session while
   *  the exit event is still in flight. Internal — not part of CliSessionSummary. */
  hungSpawnKilledAt?: string;
  /** FLUX-1378: the session's live context size as of the LAST `result` event (non-cumulative —
   *  overwritten every turn, unlike inputTokens/etc. which accumulate). Used by
   *  `resumeOrDispatchSession`'s viability check: a session sitting near its context window is
   *  worse to resume (large cache-read bill, close to auto-compaction) than to cold-spawn fresh. */
  lastTurnContextTokens?: number;
  /** FLUX-1378: the resolved model's context window (from the CLI result event's `modelUsage`),
   *  captured alongside `lastTurnContextTokens`. Undefined when the adapter/CLI doesn't report it —
   *  callers fall back to a conservative default rather than treating undefined as "unlimited". */
  contextWindow?: number;
  /** FLUX-1378 (absorbing FLUX-1375 step 6): running total of inputTokens/etc. already flushed into
   *  the ticket's `tokenMetadata`, since `session.inputTokens` etc. accumulate for the WHOLE session
   *  (never reset — they also drive the live per-session cost badge) across every resumed turn. Each
   *  flush point computes the delta against these baselines — not the raw cumulative counters — so a
   *  second (resume-turn) flush doesn't double-count tokens the first (initial-spawn) flush already
   *  persisted. Internal bookkeeping only; never exposed on CliSessionSummary. */
  flushedInputTokens?: number;
  flushedOutputTokens?: number;
  flushedCostUSD?: number;
  flushedCacheReadTokens?: number;
  flushedCacheCreationTokens?: number;
  /** FLUX-1378: count of successful `resumeOrDispatchSession` resumes since this session was COLD
   *  spawned (a fresh spawn always starts a new session object, so this is inherently scoped to "since
   *  last cold spawn" with no explicit reset needed). Fallback viability signal for a session with no
   *  recorded `lastTurnContextTokens` (pre-upgrade stub / a non-reporting adapter) — capped at 8. */
  resumeTurnCount?: number;
  /**
   * FLUX-1390: honored-ScheduleWakeup bookkeeping (agents.honorScheduledWakeups, claude-only — the
   * tool is a Claude Code native, not something gemini/copilot expose).
   *   - `pendingWakeAt`/`pendingWakeReason` — staged mid-turn when the assistant calls ScheduleWakeup;
   *     consumed at turn-end by `tryEnterScheduledWake`, which commits them to `wakeAt`/`wakeReason`
   *     (and clears the pending pair) if the turn is honoring a sleep, or drops them otherwise.
   *   - `wakeAt`/`wakeReason` — the ACTIVE sleep: when a `status: 'scheduled'` session should next be
   *     resumed via `--resume`, and why (inherited from `CliSessionSummary` above). Cleared once the
   *     wake ticker (scheduled-wake.ts) picks it up.
   *   - `scheduledResumeCount` — how many times this session has already self-scheduled a resume;
   *     `tryEnterScheduledWake` fails closed once it reaches MAX_SCHEDULED_WAKE_RESUMES.
   */
  pendingWakeAt?: string;
  pendingWakeReason?: string;
  scheduledResumeCount?: number;
  /**
   * FLUX-1437: how many times the claude adapter's stale-wait catch-and-resume has already
   * resumed THIS session — a dispatched (non-chat) turn that ended narrating an unarmed "I'll wait
   * for X" promise (`WAIT_PROMISE_RE`) with no board action taken. Capped at 1 (mirrors
   * `scheduledResumeCount`'s bound precedent): a session that stalls on the same failure mode twice
   * falls through to the normal `flagIfParked` park instead of resuming again.
   */
  staleWaitResumes?: number;
}

export interface AgentEvent {
  type: 'assistant_text' | 'tool_use' | 'permission_request' | 'token_usage' | 'done' | 'error';
  payload: unknown;
}

export interface FieldSchema {
  type: 'string' | 'boolean' | 'select';
  label: string;
  options?: string[];
}

export interface ProviderManifest {
  id: string;
  displayName: string;
  configSchema: Record<string, FieldSchema>;
  costModel: { inputPerMToken: number; outputPerMToken: number; currency: 'usd' };
  capabilities: {
    compacting: boolean;
    effortLevels: string[];
    memoryFiles: boolean;
  };
}
