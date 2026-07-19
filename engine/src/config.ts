import { log } from './log.js';
import fs from 'fs/promises';
import { renameSync } from 'fs';
import { getConfigFile } from './workspace.js';
import { getWorkspace } from './workspace-context.js';
import { DEFAULT_GATE_POLICY, UNMIGRATED_GATE_POLICY_DEFAULT } from './models/gate-policy.js';
import type { Tier, TaskKey } from './agents/types.js';

/**
 * Minimal shape of the raw config.json payload this loader touches directly before merging
 * it into the workspace config (which intentionally stays `any` — see getConfig below — out of
 * scope for this typing pass). Only the migrated array fields are narrowed; every other key
 * round-trips untyped through the index signature.
 */
interface LoadedConfig {
  columns?: unknown[];
  hiddenStatuses?: unknown[];
  users?: unknown[];
  tags?: unknown[];
  priorities?: unknown[];
  [key: string]: unknown;
}

/** Extract a human-readable message from a caught value of unknown shape. */
function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Narrow a caught value to a Node-style errno exception (has a `.code`). */
function isErrnoException(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && 'code' in err;
}

/** Minimal shape of a config tag entry (see the `tags` default above). */
interface ConfigTagEntry {
  name?: unknown;
}

// FLUX-1492: keys the GET /api/config handler computes and appends to the response for portal
// convenience (routes/config.ts) — none of these are ever legitimately part of config.json.
// The portal caches the full GET response and PUTs it back wholesale on Settings save
// (GatePolicyModal.tsx and others), which without stripping would persist these computed values
// as if they were real config — freezing a stale snapshot (e.g. an old cliCapabilities table)
// that silently diverges from the engine's actual capabilities on next boot. Stripped from every
// PUT body (routes/config.ts) and swept from any already-polluted config.json on load below.
export const GET_COMPUTED_CONFIG_KEYS = [
  'cliCapabilities',
  'defaultFramework',
  'boardConversationId',
  'furnaceConversationId',
  'runtimeFrameworks',
] as const;

// FLUX-1373: shipped per-CLI Tier -> model-id defaults, seeded into `integrations.<cli>.tiers`
// below and reused by the migration (the "shipped defaults" a blank/legacy field falls back to).
// Claude uses the CLI's short model aliases (matches the pre-1373 TIER_MODELS convention);
// Gemini's ids are validated elsewhere against KNOWN_GEMINI_MODELS (agents/gemini.ts); Copilot has
// no known-model validation list today, so its ids are the plain gpt-5 family.
export const INTEGRATION_TIER_DEFAULTS: Record<'claudeCode' | 'geminiCli' | 'copilotCli', Record<Tier, string>> = {
  claudeCode: { smart: 'opus', efficient: 'sonnet', cheap: 'haiku' },
  geminiCli: { smart: 'gemini-2.5-pro', efficient: 'gemini-2.5-flash', cheap: 'gemini-2.5-flash-lite' },
  copilotCli: { smart: 'gpt-5', efficient: 'gpt-5-mini', cheap: 'gpt-4.1' },
};

// FLUX-1373: the three pinned task->tier presets (ticket plan's Layer 3 table) — single source of
// truth shared by the migration default below and any 'apply preset' logic (portal UI reads the
// same table via /api/config). Splurge = judgment everywhere; Balanced = the leverage tree (smart
// where judgment compounds, efficient where token volume lives, cheap for mechanics); Frugal =
// cost floor. Exactly the 9 pinned TaskKeys.
export const MODEL_POLICY_PRESETS: Record<'splurge' | 'balanced' | 'frugal', Record<TaskKey, Tier>> = {
  splurge: {
    'grooming.lead': 'smart', 'grooming.workers': 'smart',
    planReview: 'smart',
    'implementation.lead': 'smart', 'implementation.workers': 'smart',
    'review.lead': 'smart', 'review.workers': 'smart',
    finalize: 'smart',
    chat: 'smart',
  },
  balanced: {
    'grooming.lead': 'smart', 'grooming.workers': 'efficient',
    planReview: 'smart',
    'implementation.lead': 'efficient', 'implementation.workers': 'efficient',
    'review.lead': 'smart', 'review.workers': 'efficient',
    finalize: 'cheap',
    chat: 'efficient',
  },
  frugal: {
    'grooming.lead': 'efficient', 'grooming.workers': 'cheap',
    planReview: 'efficient',
    'implementation.lead': 'efficient', 'implementation.workers': 'cheap',
    'review.lead': 'efficient', 'review.workers': 'cheap',
    finalize: 'cheap',
    chat: 'cheap',
  },
};

// FLUX-343: no longer an exported mutable singleton — the live config lives on the Workspace
// object (workspace-context.ts) and is read via getConfig(). This literal is only the defaults
// seed; it keeps the pre-refactor semantics of "one defaults object per process, merged over by
// loadConfig and mutated in place by the one-time migrations below".
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- see doc comment above: narrowing cascades widely (FLUX-1073)
const CONFIG_DEFAULTS: any = {
  columns: [
    { name: 'Grooming', color: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300' },
    { name: 'Todo', color: 'bg-sky-100 text-sky-700 dark:bg-sky-900/30 dark:text-sky-300' },
    { name: 'In Progress', color: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300' },
    { name: 'Ready', color: 'bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-300' },
    { name: 'Done', color: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300' },
    { name: 'Archived', color: 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300' },
  ],
  hiddenStatuses: [
    { name: 'Backlog', color: 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300' },
    { name: 'Released', color: 'bg-teal-100 text-teal-700 dark:bg-teal-900/30 dark:text-teal-300' }
  ],
  projects: ['FLUX'],
  users: [],
  tags: [
    { name: 'bug', color: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400' },
    { name: 'feature', color: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400' },
    { name: 'docs', color: 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400' }
  ],
  priorities: [
    { name: 'Critical', icon: 'AlertCircle', color: 'text-red-500' },
    { name: 'High', icon: 'ChevronUp', color: 'text-orange-500' },
    { name: 'Medium', icon: 'Equal', color: 'text-amber-500' },
    { name: 'Low', icon: 'ChevronDown', color: 'text-emerald-500' },
    { name: 'None', icon: 'Equal', color: 'text-gray-400' }
  ],
  enableBacklogScreen: true,
  requireCommentOnStatusChange: true,
  boardCardOpenMode: 'chat',
  animationsEnabled: true,
  enableFireworks: true,
  requireInputStatus: 'Require Input',
  readyForMergeStatus: 'Ready',
  archiveStatus: 'Archived',
  swimlanes: [
    { id: 'require-input', label: 'Require Input', color: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300', commentRequired: true },
    { id: 'open-pr', label: 'Open PRs', color: 'bg-violet-100 text-violet-700 dark:bg-violet-900/30 dark:text-violet-300', commentRequired: false },
    { id: 'changes-requested', label: 'Changes Requested', color: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300', commentRequired: false },
    // FLUX-986: set by the engine (not the agent) when a PR merge fails on a real git conflict —
    // never on auth/network failures (see isMergeConflict, branch-manager.ts). Drives the "Launch
    // Rebase Session" CTA in the portal; commentRequired is false because there's nothing for the
    // agent to say, only a state to flag.
    { id: 'merge-conflict', label: 'Merge Conflict', color: 'bg-rose-100 text-rose-700 dark:bg-rose-900/30 dark:text-rose-300', commentRequired: false },
  ],
  // Portal-side UX gate only (DocsScreen `canEditDocs`); NOT enforced
  // server-side by routes/docs.ts — see the trust-model note there (FLUX-418).
  docsEditPermissions: 'all',
  docsAllowedUsers: [],
  releaseSettings: {
    generateDistinctFiles: true,
    releaseNotesPath: 'release-notes'
  },
  defaultAgent: 'claude',
  // FLUX-521: default state of the per-launch "dedicated worktree" choice. Off by
  // default; a per-launch param (create_branch / POST /:id/branch `worktree`)
  // overrides it. When on, creating a ticket branch also spins up a git worktree
  // so the agent runs isolated (FLUX-516).
  worktreeByDefault: false,
  defaultWorkflowId: '',
  phaseDefaults: {
    grooming: { single: 'builtin-grooming-single', multi: 'builtin-grooming-multi' },
    implementation: { single: 'builtin-implementation-single', multi: 'builtin-implementation-multi' },
    review: { single: 'builtin-review-single', multi: 'builtin-review-multi' },
    finalize: { single: 'builtin-finalize-single', multi: 'builtin-finalize-multi' },
  },
  // FLUX-1373: per-CLI Tier -> model-id definitions, resolved at dispatch via resolveModel
  // (agents/shared.ts) against the task's stamped taskKey + modelPolicy.assignments below.
  // Replaces the old groomingModel/implementationModel/delegateModel fields (migrated once in
  // loadConfig, see the modelPolicyMigrated block).
  integrations: {
    claudeCode: {
      tiers: { ...INTEGRATION_TIER_DEFAULTS.claudeCode },
    },
    geminiCli: {
      tiers: { ...INTEGRATION_TIER_DEFAULTS.geminiCli },
    },
    copilotCli: {
      tiers: { ...INTEGRATION_TIER_DEFAULTS.copilotCli },
    }
  },
  // FLUX-1373: task -> tier assignment policy. `preset` is 'splurge'|'balanced'|'frugal'|'custom'
  // (portal flips to 'custom' the moment any assignment diverges from its preset — derived state,
  // not stored separately). Seeded to Balanced so a fresh/unmigrated board no longer implicitly
  // runs all-Opus (the prior empty-string default silently inherited each CLI's own default model).
  modelPolicy: {
    preset: 'balanced',
    assignments: { ...MODEL_POLICY_PRESETS.balanced },
  },
  syncSettings: {
    debounceMs: 30000,
    maxWaitMs: 300000,
  },
  // FLUX-1063: global defaults for the Furnace rate-limit cooldown. A burn session that dies from a
  // transient usage/rate limit (5-hour session limit / 429 / quota) is not parked — the ticket cools
  // down and auto-retries every `rateLimitRetryIntervalMs` up to `rateLimitMaxWaitMs`, then fails
  // outright. New batches inherit these as their per-batch defaults (overridable via furnace_update).
  furnaceSettings: {
    rateLimitRetryIntervalMs: 20 * 60 * 1000, // 20 min
    rateLimitMaxWaitMs: 5 * 60 * 60 * 1000,   // 5 h
    // FLUX-1431: global default for the Furnace per-session watchdog. New batches inherit this
    // unless an explicit per-batch sessionTimeoutMs is given (overridable via furnace_update).
    sessionTimeoutMs: 90 * 60 * 1000,         // 90 min
    // FLUX-1175: the Smelter persona's authority mode — 'drafting' (default, manual: every
    // real burn-lifecycle action needs ask_user_question confirmation) vs 'operator' (autonomous:
    // full ignite/stop/resume/retry authority once asked to manage a burn). See
    // SMELTER_MODE_CONTRACTS in orchestration-personas.ts for the composed prompt text.
    smelterMode: 'drafting',
  },
  // FLUX-1261: per-gate autonomy policy — `plan` (Grooming) and `review` (Ready) each dial
  // Auto / Auto→You / You. Replaces Temper's (FLUX-1071) board-wide `temperEnabled` boolean
  // (migrated once via `gatePolicyMigrated`, see loadConfig below); `review: 'auto'` drives the
  // exact same loop `temperEnabled: true` used to (temper.ts). `merge` is never a representable
  // key here — the merge-lock is structural, not a runtime check.
  // FLUX-1292: seeded to UNMIGRATED_GATE_POLICY_DEFAULT (auto-then-you/auto since FLUX-1497), not
  // DEFAULT_GATE_POLICY —
  // this literal is the ONE in-memory value a board whose gatePolicy has never been migrated ever
  // sees (a fresh install's ENOENT path, and an existing config.json that predates the `gatePolicy`
  // field, both leave this seed untouched all the way into the migration block below). A board with
  // an explicit, already-migrated gatePolicy on disk overrides this via the `{...getConfig(), ...loaded}`
  // spread in loadConfig() and never observes the seed at all.
  gatePolicy: { boardDefault: { ...UNMIGRATED_GATE_POLICY_DEFAULT.boardDefault } },
  // FLUX-1263: column-level fixed override for the `plan` gate's review depth/breadth ('auto' — the
  // default — picks Quick/Standard/Thorough from the ticket's effort; a fixed value forces that depth
  // for every plan review regardless of effort). Dialed in the same Grooming-column ⚙ modal as the
  // gate policy itself (FLUX-1261).
  planReviewDepth: 'auto',
  // FLUX-1379: deterministic pre-gate plan lint (`models/plan-lint.ts`) — runs in the `change_status`
  // guard on every agent Grooming -> Todo move, ahead of `evaluatePlanGateTrigger`, for ALL gate
  // values including 'you'. Default on: bounces mechanical plan defects for free before any LLM
  // session spawns. A plain boolean, not a `gatePolicy` key — same idiom as `blockAgentPrMerges`
  // below. Dialed in the same Grooming-column ⚙ modal as `gatePolicy`/`planReviewDepth`.
  planLint: true,
  // FLUX-1379: XS/S tickets auto-skip the automatic plan gate (`evaluatePlanGateTrigger` in
  // mcp-server.ts) by default — a plan review can't pay for itself on a ticket that small. Lint
  // (above) still runs regardless. Orthogonal to `planReviewDepth`: this decides WHETHER an auto
  // gate fires; depth decides how deep a run goes when it does. Independent of FLUX-1373's model-
  // tier presets. Dialed in the same Grooming-column ⚙ modal.
  planGateSkipSmall: true,
  // FLUX-1290: gates the `finish_ticket` merge-lock's `hasHumanGateTouch` runtime check
  // (mcp-server.ts, backed by models/gate-policy.ts). Default `false` — an agent session can merge
  // a branch/PR ticket with no prior human touch; a user who wants today's always-on lock back can
  // flip this to `true`. Deliberately a plain boolean, not a `gatePolicy` key — `merge` stays
  // structurally unrepresentable in `GateValue` per the FLUX-1247 decision, this is a separate
  // on/off switch in front of the one runtime check, not a new gate.
  blockAgentPrMerges: false,
  // FLUX-560: CI gate policy — refuses `finish_ticket`/the portal Merge action on a failing or
  // (by default) pending GitHub check-rollup verdict. Agnostic by construction: EH only reads
  // gh's statusCheckRollup (already surfaced via getPullRequestStatus), never runs the user's
  // stack itself. `checkCommand` is the opt-in bring-your-own-command primitive for repos with no
  // GitHub checks (mirrors the multi-repo group's per-member `testCommand`, group.ts) — omitted
  // by default so a no-CI repo never gets an invented blocker. `gate: 'off'` restores the
  // pre-FLUX-560 unconditional-merge behavior.
  ci: {
    gate: 'block',
    allowPending: false,
  },
  // FLUX-1502: communication-style prompt injection (canonical text in the orchestrator skill
  // module's "Communication Style" section; blocks defined in orchestration-personas.ts and
  // composed onto persona prompts + solo session prompts via buildCommunicationBlocks). Two axes:
  // `user` is TASTE — a selectable style for user-facing writing ('concise' | 'detailed' |
  // 'custom' + `customText` | 'off'); `interAgent` is PROTOCOL — one fixed contract for
  // agent-to-agent handoffs/delegations, on/off only (a style menu there would invite
  // degradation). Both read fresh at launch time; the skill-module conventions remain as docs
  // regardless of these switches. Replaces the short-lived `injectCommunicationStyle` boolean
  // (never released or persisted, so no migration).
  communicationStyle: {
    user: 'concise',
    customText: '',
    interAgent: true,
  },
  agentProgress: {
    enabled: true,
    inlineDelay: 2,
  },
  // FLUX-605: per-surface default permission mode (the user's "risk tolerance"). The
  // per-chat Perms picker inherits these when set to "Default"; an explicit per-chat
  // choice overrides. 'gated' = destructive ops route through human approval
  // (--permission-prompt-tool); 'skip' = --dangerously-skip-permissions. Orchestrator
  // defaults to gated (it has triage teeth + a human present); per-ticket sessions skip.
  permissions: {
    boardDefault: 'gated',
    ticketDefault: 'skip',
  },
  // FLUX-1390: opt-in honoring of the agent-native ScheduleWakeup tool for unattended dispatched
  // (non-chat) phase sessions. Off by default — FLUX-1389's unconditional block stays byte-identical
  // until a user flips this on. When on, a session that calls ScheduleWakeup enters the `scheduled`
  // session state instead of going terminal, and the engine wakes it via `--resume` at wakeAt.
  agents: {
    honorScheduledWakeups: false,
  },
  // FLUX-1434: NOT seeded here deliberately — `undefined` means "use the shipped per-role
  // defaults" (CATEGORY_DENY_DEFAULTS in orchestration-personas.ts). An operator who wants to
  // tune or disable worker-persona MCP toolset scoping sets `toolScoping.categoryDeny.worker`
  // (and/or `.lead`/`.flex`) to a full replacement tool-name array for that role — read via
  // `resolveCategoryDeny` (orchestration-personas.ts). Shape:
  //   toolScoping: { categoryDeny: { worker: ['tool_a', 'tool_b', ...] } }
  // Seeding an empty object here would be indistinguishable from "no override" anyway, so it's
  // left absent rather than adding a no-op key to every board's config.json.
  modules: [],
  terminalCommands: [
    { id: 'restart-dev', label: 'Restart dev server', command: 'npm run dev', runMode: 'current' },
    { id: 'run-tests', label: 'Run tests', command: 'npm test', runMode: 'new' },
    { id: 'git-status', label: 'Git status', command: 'git status', runMode: 'current' },
  ] as Array<{ id: string; label: string; command: string; runMode: 'current' | 'new' }>,
};

/**
 * FLUX-343: the active workspace's merged config (defaults + config.json + saved changes).
 * Replaces the old `export let configCache` mutable singleton — state now lives on the
 * Workspace object; this accessor lazily seeds the defaults on first read.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- same FLUX-1073 rationale as the defaults literal above
export function getConfig(): any {
  const ws = getWorkspace();
  // FLUX-1445: seed from a deep copy, not the module-level singleton — CONFIG_DEFAULTS is
  // shared across every workspace in this process, so a by-reference seed here let any
  // in-place mutation before loadConfig() replaces ws.config leak into (and permanently
  // pollute) every other workspace's defaults.
  if (ws.config === null) ws.config = structuredClone(CONFIG_DEFAULTS);
  return ws.config;
}

/**
 * FLUX-889/1263: the status immediately after `name` in the configured column order (case-insensitive
 * name match), or `undefined` if `name` isn't found / is the last column. Single source of truth for the
 * "what comes after Grooming/Todo" derivation duplicated ad hoc elsewhere (mcp-server's `change_status`,
 * furnace-stoker's `inProgressStatus`) — new callers should use this rather than re-deriving it locally.
 */
export function nextColumnAfter(name: string): string | undefined {
  const columnNames: string[] = (getConfig().columns || [])
    .map((c: { name?: unknown }) => c?.name)
    .filter((n: unknown): n is string => typeof n === 'string');
  const i = columnNames.findIndex((c) => c.toLowerCase() === name.toLowerCase());
  return i >= 0 && i + 1 < columnNames.length ? columnNames[i + 1] : undefined;
}

export async function loadConfig() {
  try {
    const data = await fs.readFile(getConfigFile(), 'utf-8');

    // A 0-byte / whitespace-only file is a truncated or interrupted write, not a
    // valid empty config. Treat it like corruption: preserve it, run on defaults,
    // and crucially do NOT let the migration block below overwrite it (FLUX-781).
    if (!data.trim()) {
      console.error(`\n[FLUX CONFIG ERROR] ${getConfigFile()}\n  config.json is empty (0 bytes) — likely a truncated/interrupted write.\n  The engine is running on in-memory DEFAULTS and will NOT overwrite your file. Restore it from git/backup and restart.\n`);
      return;
    }

    let loaded: LoadedConfig;
    try {
      loaded = JSON.parse(data);
    } catch (parseErr: unknown) {
      // Most plausible corruption is a synced-in unresolved git conflict marker
      // (FLUX-703) or a partial write. Surface it explicitly and — critically —
      // return WITHOUT saving, so the migration block can't clobber a recoverable
      // file with engine defaults (which would lose every column/project/tag/user).
      const hasConflictMarkers = /^<{7} /m.test(data) && /^>{7} /m.test(data);
      const detail = hasConflictMarkers
        ? 'contains unresolved git conflict markers (<<<<<<< / ======= / >>>>>>>) — a sync merge committed an unresolved conflict. Resolve the markers and save again.'
        : `is not valid JSON: ${errMessage(parseErr)}`;
      console.error(`\n[FLUX CONFIG ERROR] ${getConfigFile()}\n  config.json ${detail}\n  The engine is running on in-memory DEFAULTS and will NOT overwrite your file. Fix it and restart.\n`);
      return;
    }

    if (loaded.columns?.length && typeof loaded.columns[0] === 'string') loaded.columns = loaded.columns.map((s) => ({ name: s as string }));
    if (loaded.hiddenStatuses?.length && typeof loaded.hiddenStatuses[0] === 'string') loaded.hiddenStatuses = loaded.hiddenStatuses.map((s) => ({ name: s as string }));
    if (loaded.users?.length && typeof loaded.users[0] === 'string') loaded.users = loaded.users.map((s) => ({ name: s as string }));
    if (loaded.tags?.length && typeof loaded.tags[0] === 'string') {
      loaded.tags = loaded.tags.map((s) => ({
        name: s as string,
        color: 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300'
      }));
    }
    if (!loaded.priorities || !Array.isArray(loaded.priorities) || loaded.priorities.length === 0) {
      loaded.priorities = getConfig().priorities;
    }
    if (loaded.priorities?.length && typeof loaded.priorities[0] === 'string') {
      loaded.priorities = loaded.priorities.map((name) => ({
        name: name as string,
        icon: 'Equal',
        color: 'text-gray-400'
      }));
    }

    getWorkspace().config = { ...getConfig(), ...loaded };
    log.info('Loaded config');
  } catch (error: unknown) {
    if (isErrnoException(error) && error.code === 'ENOENT') {
      // No file yet (fresh install) — write the defaults out. This is the ONLY
      // path that legitimately creates config.json from defaults.
      await saveConfig(getConfig());
    } else {
      // Read failed for another reason (permissions, I/O). Preserve whatever is on
      // disk and run on defaults; do NOT save over a file we couldn't read (FLUX-781).
      console.error('[FLUX CONFIG ERROR] Failed to read config.json; running on in-memory defaults WITHOUT overwriting it:', errMessage(error));
      return;
    }
  }

  // FLUX-1492: sweep any GET-computed keys (see GET_COMPUTED_CONFIG_KEYS) that leaked into
  // config.json via the portal's echo-back full-config PUT, before the migrations below run.
  // Uses applyConfigPatch (not a raw mutate-then-saveConfig) purely for its undefined-deletes-the-
  // key semantics — this runs immediately after a fresh disk read so getConfig() is already fresh.
  {
    const config = getConfig();
    const polluted = GET_COMPUTED_CONFIG_KEYS.filter((k) => k in config);
    if (polluted.length > 0) {
      const patch: Record<string, unknown> = {};
      for (const k of polluted) patch[k] = undefined;
      await applyConfigPatch(patch);
      log.info('[config] stripped GET-computed keys from config.json:', polluted.join(', '));
    }
  }

  // FLUX-744: one-time migration of the board-open default. The default changed from 'full' to 'chat',
  // but existing boards eagerly persisted the OLD 'full' default (saveConfig writes the whole config),
  // so without this an updating user would keep opening cards in the modal. Flip a persisted 'full'
  // (or an absent value) to 'chat' exactly ONCE, recorded via `chatOpenDefaultMigrated` so a later
  // DELIBERATE 'full'/'popup' choice is preserved and never re-flipped. The PUT /api/config handler
  // merges over the live config, so this marker survives portal Settings saves (which don't echo it back).
  // FLUX-781: only reached after a successful load or a legitimate ENOENT create — every parse/read
  // failure above returns early, so this can never overwrite a corrupt-but-recoverable config.json.
  {
    const config = getConfig();
    if (!config.chatOpenDefaultMigrated) {
      const boardCardOpenMode = (!config.boardCardOpenMode || config.boardCardOpenMode === 'full') ? 'chat' : config.boardCardOpenMode;
      // FLUX-1492: patch only the keys this migration actually changes instead of writing the
      // full in-memory snapshot — see applyConfigPatch doc for why this (not patchConfig) is
      // the right helper from inside loadConfig.
      await applyConfigPatch({ boardCardOpenMode, chatOpenDefaultMigrated: true });
      log.info('[config] applied chat-open-default migration (boardCardOpenMode →', boardCardOpenMode + ')');
    }
  }

  // FLUX-1261: one-time migration of Temper's board-wide `temperEnabled` boolean into
  // `gatePolicy.boardDefault.review` (the generalized per-gate autonomy dial). `true` maps to
  // `'auto'` (the same loop-forever behavior `temper.ts` already drives); `false`/absent maps to
  // `'you'` (the safe default — matches a board that never turned Temper on). Guarded by
  // `gatePolicyMigrated` so a later deliberate dial change is never re-clobbered, mirroring the
  // `chatOpenDefaultMigrated` idiom above. Runs exactly once, and only past the corrupt/unreadable
  // config early-returns above, so it can never overwrite a recoverable file with a bad migration.
  {
    const config = getConfig();
    if (!config.gatePolicyMigrated) {
      const legacyTemperOn = config.temperEnabled === true;
      const priorBoardDefault = config.gatePolicy?.boardDefault as { plan?: unknown; review?: unknown } | undefined;
      const gatePolicy = {
        boardDefault: {
          plan: priorBoardDefault?.plan ?? DEFAULT_GATE_POLICY.boardDefault.plan,
          review: legacyTemperOn ? 'auto' : (priorBoardDefault?.review ?? DEFAULT_GATE_POLICY.boardDefault.review),
        },
      };
      await applyConfigPatch({ gatePolicy, temperEnabled: undefined, gatePolicyMigrated: true });
      log.info(`[config] migrated temperEnabled (${legacyTemperOn}) → gatePolicy.boardDefault.review='${gatePolicy.boardDefault.review}'`);
    }
  }

  // FLUX-1373: one-time migration seeding integrations.<cli>.tiers + top-level modelPolicy. Must
  // run even for a board with NO legacy model fields set: `integrations` is an object value, and
  // the `{...getConfig(), ...loaded}` merge above is SHALLOW — any existing config.json that has
  // its own `integrations` key (every board does) REPLACES the whole object wholesale, dropping
  // the shipped `tiers` defaults CONFIG_DEFAULTS just seeded. This migration restores them (and
  // seeds modelPolicy) exactly once, guarded by `modelPolicyMigrated` so a later deliberate policy
  // edit is never re-clobbered — same idiom as chatOpenDefaultMigrated/gatePolicyMigrated above.
  // Legacy `groomingModel`/`implementationModel`/`delegateModel` are read tolerantly off the merged
  // config (CONFIG_DEFAULTS no longer declares them, but an old config.json on disk still can) and
  // dropped from the persisted shape going forward; a non-empty value seeds the matching tier,
  // pinned per the ticket's mapping (grooming→smart, implementation→efficient, delegate→cheap).
  {
    const config = getConfig();
    if (!config.modelPolicyMigrated) {
      const cliKeys = Object.keys(INTEGRATION_TIER_DEFAULTS) as Array<keyof typeof INTEGRATION_TIER_DEFAULTS>;
      const integrations: Record<string, unknown> = { ...(config.integrations || {}) };
      for (const cliKey of cliKeys) {
        const shippedTiers = INTEGRATION_TIER_DEFAULTS[cliKey];
        const legacy = (integrations[cliKey] || {}) as { groomingModel?: unknown; implementationModel?: unknown; delegateModel?: unknown; tiers?: unknown };
        const legacyGrooming = typeof legacy.groomingModel === 'string' ? legacy.groomingModel.trim() : '';
        const legacyImplementation = typeof legacy.implementationModel === 'string' ? legacy.implementationModel.trim() : '';
        const legacyDelegate = typeof legacy.delegateModel === 'string' ? legacy.delegateModel.trim() : '';
        integrations[cliKey] = {
          tiers: {
            smart: legacyGrooming || shippedTiers.smart,
            efficient: legacyImplementation || shippedTiers.efficient,
            cheap: legacyDelegate || shippedTiers.cheap,
          },
        };
      }
      const modelPolicy = { preset: 'balanced', assignments: { ...MODEL_POLICY_PRESETS.balanced } };
      await applyConfigPatch({ integrations, modelPolicy, modelPolicyMigrated: true });
      log.info('[config] applied model-policy migration (integrations.*.tiers + modelPolicy seeded, legacy model fields dropped)');
    }
  }
}

/**
 * Persist config.json atomically (temp-file + rename), mirroring task-store.ts's
 * atomicWriteFile (FLUX-290) — config.json is the single highest-value file and was
 * the only one left on the unsafe plain-write path (FLUX-781). A crash or concurrent
 * read mid-write can no longer leave a truncated file that later fails to parse.
 * Inlined rather than importing atomicWriteFile to avoid a config<->task-store cycle.
 */
export async function saveConfig(newConfig: Record<string, unknown>) {
  getWorkspace().config = newConfig;
  const target = getConfigFile();
  const content = JSON.stringify(newConfig, null, 2);
  const tmpPath = target + '.tmp';
  await fs.writeFile(tmpPath, content, 'utf-8');
  try {
    renameSync(tmpPath, target);
  } catch {
    // rename can fail on some FS setups (cross-device, transient locks) — fall back.
    await fs.writeFile(target, content, 'utf-8');
    await fs.unlink(tmpPath).catch(() => {});
  }
}

/** Read+parse config.json fresh from disk, or `null` if missing/empty/unreadable/corrupt. */
async function readConfigFileRaw(): Promise<Record<string, unknown> | null> {
  try {
    const data = await fs.readFile(getConfigFile(), 'utf-8');
    if (!data.trim()) return null;
    return JSON.parse(data);
  } catch {
    return null;
  }
}

/** Shallow-merge `patch` over `base`; a patch value of `undefined` deletes that key from the result (mirrors `delete config[key]`). */
function mergeConfigPatch(base: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...base, ...patch };
  for (const key of Object.keys(patch)) {
    if (patch[key] === undefined) delete merged[key];
  }
  return merged;
}

/**
 * FLUX-1492: merge `patch` over the CURRENT in-memory config and persist. Safe ONLY where
 * getConfig() is already known-fresh — i.e. from within loadConfig()'s own one-time migrations,
 * which run synchronously right after loadConfig's own disk read merges `loaded` over whatever
 * was in memory before (so getConfig() here already reflects disk ∪ in-memory-only defaults for
 * keys the file doesn't have yet, e.g. a fresh/never-migrated gatePolicy seed). Re-reading disk
 * again at this point (as patchConfig below does) would DISCARD that in-memory defaults fallback
 * for any key genuinely absent from disk. Any OTHER caller (i.e. one not immediately downstream
 * of a loadConfig disk read) must use patchConfig instead, since its getConfig() may be stale.
 */
async function applyConfigPatch(patch: Record<string, unknown>) {
  await saveConfig(mergeConfigPatch(getConfig(), patch));
}

/**
 * FLUX-1492: merge-on-save. Re-reads config.json fresh from disk and shallow-merges `patch`
 * over THAT — not over the in-memory getConfig(), which may be stale (two engine processes can
 * bind the same store — dev stack + desktop app — or a config-watcher reload event can be
 * missed; either leaves a process's in-memory copy behind whatever another process wrote most
 * recently). A whole-file `saveConfig(getConfig())` from that stale copy silently reverts every
 * key changed since it loaded. `patchConfig` scopes the write to only the keys the caller
 * actually intends to change, so unrelated keys (e.g. `gatePolicy`) can never be clobbered by a
 * stale writer. Falls back to the in-memory config if disk is unreadable (fresh-install race /
 * permissions) — same degradation saveConfig already tolerated. Also replaces `ws.config` with
 * the merged (disk + patch) result, so the writing process's own view heals to match disk instead
 * of staying stale. Use this for any runtime write path OUTSIDE loadConfig(); loadConfig's own
 * migrations use the lighter applyConfigPatch above instead (see its doc for why).
 */
export async function patchConfig(patch: Record<string, unknown>): Promise<Record<string, unknown>> {
  return patchConfigChain = patchConfigChain.then(() => patchConfigUnlocked(patch), () => patchConfigUnlocked(patch));
}

/**
 * FLUX-1534: serializes patchConfig's own read-modify-write against itself. Without this, two
 * concurrent in-process patches to different keys (e.g. autoRegisterUnknownTags overlapping a
 * PUT /api/config) each read the same disk snapshot before either writes — the later save wins
 * and silently drops the earlier patch's key. A single promise chain forces overlapping calls to
 * apply sequentially, each over the previous one's result, so no in-process patch is lost. This
 * does not protect against a genuinely different OS process racing the same file (patchConfig's
 * own disk re-read already degrades that case gracefully, per its doc above).
 */
let patchConfigChain: Promise<Record<string, unknown>> = Promise.resolve({});

async function patchConfigUnlocked(patch: Record<string, unknown>): Promise<Record<string, unknown>> {
  const onDisk = (await readConfigFileRaw()) ?? getConfig();
  const merged = mergeConfigPatch(onDisk, patch);
  await saveConfig(merged);
  return merged;
}

export async function autoRegisterUnknownTags(tags: string[]) {
  if (!tags || !Array.isArray(tags) || tags.length === 0) return;

  const existingTags: Array<ConfigTagEntry & { color?: unknown }> = Array.isArray(getConfig().tags) ? getConfig().tags : [];
  const existingTagsLower = new Set(existingTags.map((t) => (t.name as string | undefined)?.toLowerCase() || ''));
  const newTags = [...existingTags];
  let configChanged = false;

  for (const tag of tags) {
    if (tag && typeof tag === 'string' && !existingTagsLower.has(tag.toLowerCase())) {
      newTags.push({
        name: tag,
        color: 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300'
      });
      existingTagsLower.add(tag.toLowerCase());
      configChanged = true;
    }
  }

  // FLUX-1492: patch only `tags` (merge-on-save over a fresh disk read) instead of writing the
  // full in-memory config — this fires on every ticket carrying an unknown tag, making it the
  // single most frequent whole-file saveConfig call and the most likely to run from a stale copy.
  if (configChanged) {
    await patchConfig({ tags: newTags });
  }
}
