// Shared per-adapter helpers (FLUX-900, audit A.3/A.4/A.6/A.7).
//
// These were duplicated across claude-code.ts / copilot.ts / gemini.ts when the
// Copilot and Gemini adapters were forked off the original Claude-only adapter.
// The transport-side behaviour (write into the same `session` record, emit SSE,
// clean the spawn env, probe the binary) is identical across frameworks; only the
// per-CLI stdout *parsing* genuinely differs (that stays in each adapter — audit A.1).
import { execFile, exec } from 'child_process';
import type { ChildProcess } from 'child_process';
import { promisify } from 'util';
import * as path from 'path';
import * as fs from 'fs';
import { log } from '../log.js';
import { broadcastEvent } from '../events.js';
import { getTaskAssetsDir, getActiveFluxDir } from '../workspace.js';
import { isPathInsideRoot } from '../file-utils.js';
import { signConversation } from '../session-binding.js';
import { getConfig } from '../config.js';
import { INTEGRATION_TIER_DEFAULTS, MODEL_POLICY_PRESETS } from '../config.js';
import { getModulePromptFragments } from '../modules.js';
import { updateAgentSession, updateTaskWithHistory } from '../task-store.js';
import { getWorkspace } from '../workspace-context.js';
import { buildActivityEntry } from '../history.js';
import { raiseNeedsAction } from '../parked-ticket.js';
import type { CliSessionRecord, CliFramework, TaskKey, Tier, PatternPosition, LaunchPhase } from './types.js';
import { CLI_CAPABILITIES, INTEGRATION_CONFIG_KEYS } from './types.js';
import type { ChatAttachment } from '../projection.js';
import { isInjectablePhaseModule, loadSkillModuleBodySync, skillModuleFallback } from '../skill-modules.js';
import { resolveSoloChatPersona, renderPersonaTemplate, buildCommunicationBlocks } from '../orchestration-personas.js';
import { getChatSessionForTask } from '../session-store.js';

// ---- FLUX-1373: resolveModel — the one shared task-tier -> concrete-model resolver ----
// Minimal structural shape of the pieces of `Config` (config.ts, kept `any` there) this needs —
// mirrors the CliTask/CliTaskHistoryEntry pattern below (no canonical Config type in this codebase).
export interface ResolveModelConfig {
  integrations?: Record<string, { tiers?: Partial<Record<Tier, string>> } | undefined> | undefined;
  modelPolicy?: { assignments?: Partial<Record<TaskKey, Tier>> } | undefined;
}

/**
 * FLUX-1373: resolve a session's dispatch model from its stamped `taskKey` + the board's
 * task->tier policy + that CLI's tier definitions — `tiers[assignments[taskKey]]`. Every adapter's
 * fallback (`session.model || resolveModel(...)`) and the delegate route call this so there is one
 * place the tier indirection is resolved. Falls back sanely at each level so a partially-migrated
 * or hand-edited config.json never throws: missing/invalid assignment -> the shipped Balanced
 * preset's tier for this key; missing/blank tier model-id -> the shipped per-CLI default for that tier.
 */
export function resolveModel(taskKey: TaskKey, framework: CliFramework, config: ResolveModelConfig | undefined): string {
  const cliKey = INTEGRATION_CONFIG_KEYS[framework] as keyof typeof INTEGRATION_TIER_DEFAULTS;
  const shippedTiers = INTEGRATION_TIER_DEFAULTS[cliKey];
  const tier: Tier = config?.modelPolicy?.assignments?.[taskKey] ?? MODEL_POLICY_PRESETS.balanced[taskKey];
  const configuredModel = config?.integrations?.[cliKey]?.tiers?.[tier];
  return (typeof configuredModel === 'string' && configuredModel.trim()) || shippedTiers[tier];
}

// ---- A.4 Effort levels (accepted by the `--effort` CLI flag, ascending order) ----
export const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type EffortLevel = typeof EFFORT_LEVELS[number];

// ---- A.6 cleanChildEnv — unified across every adapter ----
// Cleans the parent env before spawning a CLI: strips NODE_OPTIONS (V8 flags crash
// pkg-built CLIs), tags the spawning framework, and pins the canonical ticket store
// so a worktree agent's event-horizon MCP binds to the real workspace (FLUX-516).
//
// FLUX-662/841 + audit A.6: when a `conversationId` is supplied (the ticket id for a
// per-ticket session, the board sentinel for the orchestrator) the function sets
// `EH_CONVERSATION_ID` so the event-horizon MCP tools (permission_prompt,
// ask_user_question, propose_board_rebase) can route their parked request back to the
// originating chat surface, plus `EH_CONVERSATION_TOKEN` (HMAC of the conversationId)
// so the route can verify a session only routes events into its own ticket. Previously
// ONLY the Claude adapter accepted `conversationId`, so HITL picker routing silently
// degraded on Copilot/Gemini — passing it here for every framework is the A.6 fix.
export function cleanChildEnv(framework?: string, conversationId?: string): NodeJS.ProcessEnv {
  const env = { ...process.env };
  // Fully REMOVE NODE_OPTIONS rather than blanking it to '': the Gemini adapter documented
  // that pkg-built CLIs may still parse an empty value, and an absent var is functionally
  // identical (no V8 flags) for the node-based Claude/Copilot binaries. (Was: claude set '';
  // copilot/gemini deleted — unified on the safer delete.)
  for (const key of Object.keys(env)) {
    if (key.toUpperCase() === 'NODE_OPTIONS') delete env[key];
  }
  if (framework) env.EVENT_HORIZON_FRAMEWORK = framework;
  // CRITICAL (FLUX-903 review): a child with no conversationId must be provably UNROUTED. The
  // spawning agent's OWN process carries EH_CONVERSATION_ID/TOKEN, and `{ ...process.env }` copies
  // them — so always CLEAR them first, then set fresh ones only when routed. Without this an
  // unrouted subagent (a delegate, a binary probe) inherits the parent's conversationId and
  // mis-routes its HITL prompts (permission_prompt / ask_user_question) into the parent's chat.
  delete env.EH_CONVERSATION_ID;
  delete env.EH_CONVERSATION_TOKEN;
  if (conversationId) {
    env.EH_CONVERSATION_ID = conversationId;
    env.EH_CONVERSATION_TOKEN = signConversation(conversationId);
  }
  return env;
}

const execFileAsync = promisify(execFile);
// `exec` (not `execFile`) — matches the shell-based `execSync` these replace. `npm` resolves to
// `npm.cmd` on Windows, which `execFile`/`spawn` can't invoke directly without `shell:true`
// (a well-known Windows Node gotcha: `spawn npm ENOENT`); `exec`/`execSync` already run via a
// shell, so preserving that family (not switching to execFile) avoids a Windows regression here.
const execAsync = promisify(exec);

// ---- A.7 checkBinaryInstalled — pre-flight existence check for the CLI binary ----
//
// FLUX-1003 (epic FLUX-996): this ran via `execFileSync` — fully SYNCHRONOUS — on every single
// spawn AND every reply, for every framework. `execFileSync` blocks the whole Node event loop for
// the entire `which`/`where` duration, stalling every other concurrent request (board polls, other
// sessions' spawns) — not just this one. Converted to async `execFile` so it never blocks the loop,
// plus a cache (mirrors FLUX-975's resolveClaudeExePath philosophy): a POSITIVE result is cached
// forever (a binary already found on PATH isn't going anywhere without a restart), a NEGATIVE
// result is cached for a short TTL so repeated turns in a "not installed" state don't re-spawn
// `which`/`where` every message, while still recovering — without an engine restart — once the
// user installs the binary and the TTL expires.
const BINARY_CHECK_NEGATIVE_TTL_MS = 30_000;
const binaryInstalledCache = new Map<string, { ok: boolean; at: number }>();

// Minimal shape of a `which`/`where` checker failure inspected below — mirrors Node's
// ExecFileException fields (killed/signal/code) without requiring a full Error object, since
// shared.test.ts exercises isDefinitiveNotInstalled with plain object literals.
export interface ExecCheckerFailure {
  killed?: boolean;
  signal?: NodeJS.Signals | string | null;
  code?: number | string | null;
}

// Distinguish a DEFINITIVE "not installed" from a TRANSIENT checker failure, mirroring
// resolveClaudeExePath's transient-not-cached rule (FLUX-985). Only a clean non-zero exit of
// `which`/`where` — the genuine "binary not found on PATH" signal — is worth negative-caching:
// `err.code` is the numeric exit status, and the process was neither killed by our 10s timeout
// (`err.killed`) nor terminated by a signal (`err.signal`). A timeout (killed / signal set) or a
// spawn error of the checker ITSELF (`err.code` a string like 'ENOENT') is transient — under the
// system-load conditions FLUX-996 targets, a normally sub-ms `which` can hit the 10s cap — so we
// throw WITHOUT caching, letting the next turn retry rather than serving a false "not installed"
// for the whole 30s TTL.
export function isDefinitiveNotInstalled(err: ExecCheckerFailure): boolean {
  return err?.killed !== true && err?.signal == null && typeof err?.code === 'number';
}

export async function checkBinaryInstalled(binaryName: string): Promise<void> {
  const cached = binaryInstalledCache.get(binaryName);
  const now = Date.now();
  if (cached && (cached.ok || now - cached.at < BINARY_CHECK_NEGATIVE_TTL_MS)) {
    if (cached.ok) return;
    throw new Error(`"${binaryName}" is not installed or not on PATH. Please install it before starting an agent session.`);
  }
  const checker = process.platform === 'win32' ? 'where' : 'which';
  try {
    await execFileAsync(checker, [binaryName], { env: cleanChildEnv(), timeout: 10_000, windowsHide: true });
    binaryInstalledCache.set(binaryName, { ok: true, at: now });
  } catch (err: unknown) {
    // Only negative-cache a definitive "not installed" (clean non-zero exit of the checker); a
    // timeout or spawn-error of the checker itself is transient and must NOT poison the cache —
    // see isDefinitiveNotInstalled above.
    if (isDefinitiveNotInstalled(err as ExecCheckerFailure)) {
      binaryInstalledCache.set(binaryName, { ok: false, at: now });
    }
    throw new Error(`"${binaryName}" is not installed or not on PATH. Please install it before starting an agent session.`, { cause: err });
  }
}

// ---- A.3 serialized session-output writer chain ----
// Accumulate assistant text into `session.cumulativeOutput` — the fallback source for the session's
// captured `output` when `outputData` is unset (session-store.ts). FLUX-932: this used to take a
// `trackCumulative` flag that Gemini alone passed `false`, so a Gemini session's captured output was
// ALWAYS '' (a latent bug carried verbatim through the FLUX-900 extraction). The flag is now gone —
// every adapter accumulates, so Gemini delegate/session output is captured like Claude/Copilot.
export function appendSessionOutput(session: CliSessionRecord, chunk: Buffer | string, source: 'stdout' | 'stderr', isAssistantText = false) {
  const text = String(chunk ?? '').replace(/\r\n/g, '\n');
  if (!text.trim()) return;

  // Filter out noise from Windows ConPTY/AttachConsole failures
  if (source === 'stderr' && (
    text.includes('AttachConsole failed') ||
    text.includes('conpty_console_list_agent.js') ||
    text.includes('Shared memory agent failed')
  )) {
    return;
  }

  const prefix = source === 'stderr' ? '[stderr] ' : '';
  session.liveOutputBuffer += `${prefix}${text}`;
  if (source === 'stderr') {
    // Accumulate stderr for failure-message surfacing (capped at 500 chars, most-recent wins).
    const MAX_STDERR = 500;
    session.stderrCapture = ((session.stderrCapture ?? '') + text).slice(-MAX_STDERR);
  }
  if (isAssistantText) {
    session.outputBuffer += text;
    session.cumulativeOutput += text;
  }
  session.lastOutputAt = new Date().toISOString();
}

export function enqueueSessionWrite(session: CliSessionRecord, writer: () => Promise<void>) {
  session.writeQueue = session.writeQueue
    .then(writer)
    .catch((error) => {
      console.error(`CLI session ${session.id} failed to append task history:`, error);
    });
}

// `narrationType` preserves a per-adapter divergence the audit missed: Claude flushed
// text progress with no `type` (renders as a compact one-liner), while Copilot/Gemini
// flushed `type:'text'` (renders as a styled "Narration" block — HistoryList.tsx). The
// caller passes 'text' to keep that block rendering; omitting it keeps the compact form.
export function flushSessionOutput(session: CliSessionRecord, force = false, narrationType?: 'text') {
  if (!session.outputBuffer.trim()) return;

  const flushNow = async () => {
    const bufferedText = session.outputBuffer.trim();
    session.outputBuffer = '';
    if (!bufferedText) return;

    const timestamp = new Date().toISOString();
    const maxLength = 2000;
    const clippedText = bufferedText.length > maxLength
      ? `${bufferedText.slice(0, maxLength)}...`
      : bufferedText;

    // Broadcast progress immediately via SSE (UI gets live updates)
    broadcastEvent('progress', {
      taskId: session.taskId,
      sessionId: session.sessionHistoryEntry?.sessionId,
      timestamp,
      message: clippedText,
    });

    // Accumulate progress in memory only — do NOT write to the ticket file
    // during an active session. Writing continuously causes the agent to see
    // the file changing and back off from editing it. The full progress is
    // flushed to the ticket file once when the session ends.
    if (session.sessionHistoryEntry) {
      session.sessionHistoryEntry.progress.push(
        narrationType
          ? { timestamp, message: clippedText, type: narrationType }
          : { timestamp, message: clippedText },
      );
    }
  };

  if (session.flushTimer) {
    clearTimeout(session.flushTimer);
    session.flushTimer = undefined;
  }

  if (force) {
    enqueueSessionWrite(session, flushNow);
    return;
  }

  session.flushTimer = setTimeout(() => {
    session.flushTimer = undefined;
    enqueueSessionWrite(session, flushNow);
  }, 1000);
}

// ---- FLUX-981: surface agent failures inline in the chat/progress stream ----
// Every failure path (nonzero exit, spawn error, non-permission is_error, rate limiting,
// tool errors, pre-spawn exceptions) used to land ONLY in collapsed session metadata or the
// history activity feed — never in the live chat the user watches, so a dead session looked
// identical to a slow one. This routes each failure through the SAME pipeline that renders
// assistant text: appendSessionOutput(..., isAssistantText=true) feeds session.outputBuffer,
// and flushSessionOutput(force=true) broadcasts a `progress` SSE AND pushes to
// session.sessionHistoryEntry.progress[] (persisted to history when the session ends).
// No new infra, no portal changes — just one visible ⚠️ line per failure.
export function appendErrorToSession(session: CliSessionRecord, message: string) {
  appendSessionOutput(session, `\n⚠️ ${message}\n`, 'stdout', true);
  flushSessionOutput(session, true);
}

// ---- FLUX-1120: surface a RESUME-time pre-spawn failure as clearly as a fresh-spawn one ----
// `resolveResumeExecutionRoot` (task-worktree.ts) throws BEFORE a child process is spawned — e.g.
// the assigned worktree has been reclaimed — so unlike a spawn-time `proc.on('error')`, there is no
// process event to hang the existing FLUX-981 surfacing off of. Left uncaught, the throw propagated
// no further than the HTTP route's try/catch, which only turns it into a 500 JSON body — a portal
// toast at best, invisible to the chat and the ticket's durable history. This mirrors the spawn-time
// failure bookkeeping (terminal status, inline chat error, needsAction, updating the session's OWN
// `agent_session` entry in place rather than minting a duplicate) so a reused/resumed session that
// can no longer run gets the same clear, durable signal — then rethrows so the route's existing
// error response is unchanged. Deliberately terminal (`status: 'failed'`, not `'waiting-input'`):
// unlike a transient reply-spawn error (`terminalizeResumedExit`, which stays resumable because a
// retry might succeed), `resolveResumeExecutionRoot` never self-heals a reclaimed worktree — only a
// FRESH spawn does — so leaving this session resumable would just let the user retry into the same
// wall. The thrown message's own guidance ("restart the session") means start a NEW one.
export async function surfaceResumeFailure(session: CliSessionRecord, taskId: string, error: unknown): Promise<never> {
  const message = error instanceof Error ? error.message : String(error);
  // FLUX-1120 review: a Stop already in flight (or just processed) owns this session's terminal
  // state — the stop route already set status:'cancelled'+requestedStop and killed the proc.
  // Mirror the `if (session.requestedStop) return;` guard used elsewhere (cli-session.ts's
  // prepareAndLaunchSession) so a resume failure racing that Stop can't clobber 'cancelled' back
  // to 'failed', or append a confusing inline error after the user already stopped the session.
  if (!session.requestedStop) {
    session.status = 'failed';
    session.endedAt = new Date().toISOString();
    appendErrorToSession(session, message);
    flushSessionOutput(session, true);
    await session.writeQueue;
    void raiseNeedsAction(taskId, message);
    // Best-effort durable surfacing (mirrors cli-session.ts's pre-spawn-failure catch, FLUX-981)
    // — a persistence failure here must never mask the ORIGINAL error with a store-layer one.
    try {
      if (session.sessionHistoryEntry?.sessionId) {
        const accumulatedProgress = session.sessionHistoryEntry.progress || [];
        await updateAgentSession(taskId, session.sessionHistoryEntry.sessionId, (entry) => {
          entry.status = 'failed';
          entry.outcome = message;
          entry.endedAt = session.endedAt;
          entry.progress = accumulatedProgress;
        });
      } else {
        await updateTaskWithHistory(taskId, {
          updatedBy: 'Agent',
          entries: [buildActivityEntry(message, 'Agent', session.endedAt)],
        });
      }
    } catch (persistError) {
      log.error(`surfaceResumeFailure: failed to record resume failure for ${taskId}:`, persistError);
    }
  }
  throw error instanceof Error ? error : new Error(message);
}

// ---- C.1 (FLUX-904): image-attachment resolution ----
// Shared by claude-code.ts (per-ticket), claude-board.ts (orchestrator), and the route layer
// (routes/cli-session.ts resolves before dispatch) — moved here so the route no longer
// deep-imports a concrete adapter file.
export function resolveAttachmentAbsPaths(attachments: ChatAttachment[] | undefined): string[] {
  if (!Array.isArray(attachments) || attachments.length === 0) return [];
  let assetsRoot: string;
  let fluxDir: string;
  try {
    assetsRoot = getTaskAssetsDir();
    fluxDir = getActiveFluxDir();
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const a of attachments) {
    const rel = typeof a?.path === 'string' ? a.path.trim() : '';
    if (!rel) continue;
    const abs = path.resolve(fluxDir, rel);
    if (!isPathInsideRoot(assetsRoot, abs)) continue;
    if (!fs.existsSync(abs)) continue;
    out.push(abs);
  }
  return out;
}

/**
 * FLUX-674: the prompt suffix that makes the agent see pasted images. The `claude` CLI is
 * driven via `-p "<prompt>"` (not a stream-json content-block stdin), so an image reaches the
 * model by referencing its absolute path and asking the agent to open it with the Read tool —
 * which renders images visually. Returns '' when there are no attachments.
 */
export function attachmentReadInstruction(absPaths: string[]): string {
  if (absPaths.length === 0) return '';
  const n = absPaths.length;
  const list = absPaths.map((p) => `- ${p}`).join('\n');
  return `\n\n[The user attached ${n} image${n === 1 ? '' : 's'}. Use the Read tool to view ${n === 1 ? 'it' : 'them'} before responding:\n${list}\n]`;
}

// ---- A.2 (FLUX-960): shared, capability-gated buildInitialPrompt ----
//
// Replaces the three near-identical per-adapter builders (claude-code.ts / copilot.ts /
// gemini.ts). The three diverged in two ways the original A.2 audit underestimated:
//   1. Claude switched on `opts.phase` (chat/grooming/implementation/review/finalize) with
//      richer per-phase instructions; Copilot/Gemini switched on `task.status` instead, even
//      though their own callers already compute the identical `taskPhase` and pass it in —
//      they just never used it. That's a parity GAP, not an intentional divergence: fixed by
//      using the same phase-switch for everyone.
//   2. Claude stopped echoing `task.body` (FLUX-498: the workflow already requires calling
//      `get_ticket` first, so echoing both double-counts ~2.3k tokens per spawn); Copilot/Gemini
//      still echoed it. FLUX-498's rationale is not Claude-specific — every adapter has the same
//      `get_ticket` MCP tool and the same "read the ticket first" workflow rule — so this is now
//      the universal default, not a capability difference.
// What's left IS genuinely capability-gated, via the existing FLUX-901 `CLI_CAPABILITIES` B.1–B.7
// table (`types.ts`) rather than a framework literal check:
//   - The subagent-fleet ORCHESTRATION PROPOSALS paragraph (chat phase) requires the `supervisor`
//     capability — an adapter that can't run the supervisor pattern shouldn't be told it can
//     propose one.
//   - The closing "STOP after Require Input" instruction assumes `selfPause` (a mid-turn
//     change_status('Require Input') keeps the session explicitly resumable the way Claude's
//     does); frameworks without it get an equivalent instruction that doesn't overclaim that
//     mechanism.
// Everything else is universal EH workflow guidance (the end-of-turn action contract, the
// ask_user_question routing rule) that was previously Claude-only by omission, not by design —
// giving it to Copilot/Gemini too is the actual parity fix, per the decision in FLUX-960.
export interface BuildInitialPromptOptions {
  phase?: string | undefined;
  /** Pre-computed diff block injected into the initial prompt (scatter-gather reviews). Framework-agnostic — included whenever provided, regardless of adapter. */
  diffBlock?: string | undefined;
  /** Defaults to 'claude' for backward compatibility with existing callers/tests that predate this option. */
  framework?: CliFramework | undefined;
  /** FLUX-926: true when this is a chat session and file-mutation tools are disallowed for this turn (ticket not In Progress) — appends a note so the agent doesn't burn a turn discovering the block. */
  editsGated?: boolean | undefined;
  /** FLUX-1377: the spawning session's pattern position, used ONLY to exclude delegate
   * ('assistant') and relay-pipeline ('step') spawns from phase-skill-module injection below —
   * their `phase` is derived from the persona/ticket status, not a genuine phase dispatch (see
   * cli-session.ts's delegate route), so injecting a module there would be the role-vs-phase
   * mismatch the ticket's plan flags as a risk. Omit for a true phase dispatch (Furnace,
   * gate-runner, temper, portal "Start" button) — those want the injection. */
  patternPosition?: PatternPosition | undefined;
  /** FLUX-1383: for phase:'batch-grooming' — the eligible sibling ticket ids this session grooms
   *  in one sitting, substituted into the persona template's `{{batchMembersList}}` token. */
  batchTicketIds?: string[] | undefined;
  /** FLUX-1383: members the route excluded from `batchTicketIds` (+why), substituted into the
   *  persona template's `{{batchExcludedNote}}` token. Empty/absent renders no note. */
  batchExcluded?: { id: string; reason: string }[] | undefined;
}

// FLUX-1073: tickets are gray-matter-parsed YAML frontmatter validated at RUNTIME by schema.ts —
// there is no single canonical Task type in this codebase. This covers only the fields the
// CLI-adapter prompt/spawn helpers (buildInitialPrompt here, startCliSession in each adapter)
// actually read.
export interface CliTaskHistoryEntry {
  type?: string;
  date?: string;
  user?: string;
  comment?: string;
  from?: string;
  to?: string;
}

export interface CliTask {
  id?: string;
  title?: string;
  status?: string;
  tags?: string[];
  branch?: string;
  effortLevel?: string;
  kind?: string;
  history?: CliTaskHistoryEntry[];
}

// FLUX-926 / FLUX-1123: is file mutation policy-disallowed for THIS turn? True only for a ticket
// `chat` session (dispatched phase sessions are unaffected) whose ticket isn't `In Progress`.
// Framework-agnostic — reads only session.phase / task.status — so every adapter (claude/copilot/
// gemini) shares one source of truth instead of drifting. Structural param types (not a hard
// CliSessionRecord/CliTask dependency) so tests can pass minimal literals.
export function isChatEditGated(
  session: { phase?: CliSessionRecord['phase'] | undefined },
  task: { status?: string | undefined } | undefined,
): boolean {
  return session.phase === 'chat' && task?.status !== 'In Progress';
}

// FLUX-1443: a Scratch ticket (`task.kind === 'scratch'`) is a conversation surface, never an
// implementation surface — its outcome must be PROMOTED (extract_ticket / board-rebase `promote`)
// into a real, groomed card before any code gets written. Deliberately independent of
// `session.phase`/`task.status`: unlike isChatEditGated (which unlocks once the ticket flips to
// 'In Progress'), a scratch session must stay gated even if it flips its own status — that
// self-unlock is exactly the hole this ticket closes. Checked live per call, so a scratch ticket
// whose `kind` gets cleared (e.g. by a rebase) immediately falls back under normal rules.
export function isScratchSession(task: { kind?: string | undefined } | undefined): boolean {
  return task?.kind === 'scratch';
}


// FLUX-1479 (FLUX-1226 Phase E): a persistent per-ticket chat session's (FLUX-602) `phase` field
// always stays `'chat'` by design — session-store.ts's `reapStaleParkedSessions` relies on that to
// keep it alive across status moves. `handoffPhase` is the separate, mutable field a status-change
// handoff (mcp-server.ts's `change_status`) stamps with the destination phase so the SAME chat
// picks up that phase's persona/skill-fragment/deny-list on its next turn. Callers that want the
// session's CURRENT logical phase (persona resolution, deny-list recompute) go through this;
// callers about session LIFECYCLE (ScheduleWakeup eligibility, reaping) keep reading raw `phase`.
export function resolveEffectivePhase(session: { phase?: LaunchPhase | undefined; handoffPhase?: LaunchPhase | undefined }): LaunchPhase | undefined {
  return session.handoffPhase ?? session.phase;
}

// FLUX-1479 (FLUX-1226 Phase E): status -> phase derivation, extracted from what was previously
// duplicated inline in copilot.ts/gemini.ts (`taskPhase = session.phase ?? (...)`) so the SAME
// mapping drives both (a) a session with no explicit launch phase guessing its phase from status,
// and (b) the chat phase-handoff computed on a status transition (mcp-server.ts).
export function derivePhaseFromStatus(status: string | undefined, groomingStatuses: string[], readyStatus: string): LaunchPhase | undefined {
  if (status === undefined) return undefined;
  if (groomingStatuses.includes(status)) return 'grooming';
  if (status === 'In Progress' || status === 'Todo') return 'implementation';
  if (status === readyStatus) return 'review';
  return undefined;
}


/**
 * FLUX-1479 (FLUX-1226 Phase E): apply a phase->persona HANDOFF to a ticket's persistent chat
 * session (if one exists) on a status transition — called from mcp-server.ts's `change_status`
 * handler after a status move actually commits. No-op when the ticket has no chat session, or the
 * newly-derived phase is unchanged from the session's current `handoffPhase` (avoids re-arming the
 * one-time announcement note on a status move that doesn't cross a phase boundary, e.g. a lateral
 * Require Input -> Grooming bounce).
 *
 * Deliberately framework-agnostic and adapter-boundary-clean: this only mutates `handoffPhase` /
 * `handoffPhaseAnnounced` on the session record. It does NOT eagerly re-stamp Claude's
 * `disallowedEhTools` (that would require importing claude-code.ts here, which
 * check-adapter-boundary.mjs forbids for anything outside a concrete adapter file) — every
 * dispatched-per-turn `claude -p` session already calls `stampDisallowedEhTools` fresh on its next
 * spawn/resume (FLUX-1389), reading `resolveEffectivePhase(session)`, so the recompute happens for
 * real on the very next turn regardless. "Hot-swap" (mutate the existing session record) was chosen
 * over relaunching into a new session for the same reason: the per-turn respawn architecture makes
 * a plain field mutation here nearly free.
 */
export function handoffChatSessionPhase(taskId: string, newStatus: string): void {
  const session = getChatSessionForTask(taskId);
  if (!session) return;
  const groomingStatuses = [getConfig().requireInputStatus || 'Require Input', 'Grooming'];
  const readyStatus = getConfig()?.readyForMergeStatus || 'Ready';
  const newPhase = derivePhaseFromStatus(newStatus, groomingStatuses, readyStatus);
  if (newPhase === session.handoffPhase) return;
  session.handoffPhase = newPhase;
  session.handoffPhaseAnnounced = false;
}

// FLUX-1123: only Claude Code can actually ENFORCE the FLUX-926 gate — `--disallowed-tools` has no
// equivalent in the Copilot/Gemini CLIs (see CLI_CAPABILITIES.chatEditGateEnforced and the
// copilot-board.ts / gemini-board.ts FLUX-959 comments). Copilot/Gemini chat still gets a note so a
// well-behaved agent avoids the tools voluntarily, but the wording must not overclaim a block that
// doesn't exist — hence the framework branch here instead of one shared string.
// FLUX-1443: `reason` picks the wording — 'scratch' explains the promote-first rule (independent of
// ticket status), 'status' is the original FLUX-926 not-In-Progress wording.
export function chatEditGateNote(framework: CliFramework, reason: 'status' | 'scratch' = 'status'): string {
  const enforced = CLI_CAPABILITIES[framework].chatEditGateEnforced;
  if (reason === 'scratch') {
    return enforced
      ? 'FLUX-1443: this is a Scratch ticket — a conversation surface, not an implementation surface. File-mutation tools (Write/Edit/etc.) are disabled for this turn regardless of ticket status — the CLI will refuse them. When the discussion concludes "let\'s build it", call extract_ticket (or propose a board-rebase "promote") to seed a real, groomed card — that card then flows through Grooming -> Todo -> implementation normally. Discussion, planning, and read-only tools work as normal.'
      : 'FLUX-1443 / FLUX-1123: this is a Scratch ticket — a conversation surface, not an implementation surface. Unlike Claude Code, this CLI has no enforced file-edit block — treat file-mutation tools (Write/Edit/etc.) as off-limits on your own judgment, regardless of ticket status. When the discussion concludes "let\'s build it", call extract_ticket (or propose a board-rebase "promote") to seed a real, groomed card instead of implementing here. Discussion, planning, and read-only tools work as normal.';
  }
  return enforced
    ? 'FLUX-926: this ticket is not In Progress, so file-mutation tools (Write/Edit/etc.) are disabled for this turn — the CLI will refuse them. Move the ticket to "In Progress" (or ask the user to) before making changes; discussion, planning, and read-only tools work as normal.'
    : 'FLUX-926 / FLUX-1123: this ticket is not In Progress. Unlike Claude Code, this CLI has no enforced file-edit block — treat file-mutation tools (Write/Edit/etc.) as off-limits for this turn on your own judgment and do not use them. Move the ticket to "In Progress" (or ask the user to) before making changes; discussion, planning, and read-only tools work as normal.';
}

// FLUX-926 / FLUX-1123 / FLUX-1443: prepend the edit-gate note to a RESUMED turn's prompt when
// gated, shared by every adapter's sendCliSessionInput. (The initial-spawn path goes through
// buildInitialPrompt's `editsGated` option instead, below — chat's opening turn there has no
// separate user message to prepend onto.) Scratch takes priority over the status-based note since
// it's the more specific, unconditional reason.
export function prependEditGateNote(
  session: { phase?: CliSessionRecord['phase'] | undefined },
  task: { status?: string | undefined; kind?: string | undefined } | undefined,
  framework: CliFramework,
  message: string,
): string {
  if (isScratchSession(task)) return `${chatEditGateNote(framework, 'scratch')}\n\n---\n\n${message}`;
  return isChatEditGated(session, task) ? `${chatEditGateNote(framework)}\n\n---\n\n${message}` : message;
}

/**
 * FLUX-1226 composition seam for FLUX-1229 ("per-phase project prompt overlay"): a single named
 * hook, applied after role+module assembly and before session mechanics (`requireInputStopInstruction`
 * etc. in `buildInitialPrompt`'s `lines` array below), where 1229 can inject an additive,
 * per-project per-phase overlay. Deliberately a no-op today (always '') — 1229 replaces this body
 * with the real resolver; every other caller only ever sees `phaseOverlay` omitted from `lines`
 * when it's empty, so today's byte-compat gates (FLUX-1226 C1/C2) hold unchanged.
 */
function resolvePhaseOverlay(_task: CliTask, _phase: string | undefined): string {
  return '';
}

// FLUX-1479 (FLUX-1226 Phase E): the three cross-cutting mission-block locals below were inline
// consts in buildInitialPrompt until this ticket needed to replay the SAME persona-mission
// rendering mid-conversation (buildPhaseHandoffNote, further down) — factored out here so both
// call sites share one copy of the literal text instead of drifting.
function buildMcpNote(): string {
  return 'CRITICAL: Use the "event-horizon" MCP tools (change_status, update_ticket, add_note) for ALL ticket updates. Do NOT edit .flux/ files directly — direct edits corrupt session tracking.';
}

// FLUX-1389: every dispatched phase session is a one-shot process that exits at turn end — a
// scheduled wakeup (ScheduleWakeup / /loop dynamic mode) can never be honored, so deferring the
// turn on it silently drops the session and the ticket gets parked as if review/implementation
// never finished (real incident: FLUX-1378). Claude gets a real `--disallowed-tools` block
// (disallowedToolsArgs in claude-code.ts); Gemini/Copilot have no equivalent flag (FLUX-1123), so
// this text note is their only enforcement — hence it is added here, framework-agnostically, for
// every framework's review/implementation dispatch.
function buildNoDeferNote(): string {
  return 'You are a one-shot unattended session — you will NOT be resumed by a scheduled wakeup. Run any verification (tests, background checks) to completion within this turn, then record your verdict/status before ending. Never defer via ScheduleWakeup, and never end the turn saying you will "wait for" a background task or notification — background tasks are killed the instant this turn ends, so nothing will ever wake you to continue; finish with what you have now.';
}

function buildOrchestrationProposalsParagraph(framework: CliFramework): string {
  return CLI_CAPABILITIES[framework].supervisor
    ? '\n\nORCHESTRATION PROPOSALS (FLUX-805): you can spawn a fleet of subagents from this chat (list_available_agents to discover specialists, then delegate to run them). When the user expresses an orchestratable intent in plain language — "let\'s do a review", "groom this", "implement it with a few agents", "split this up" — do NOT silently launch a fleet: that spends tokens with no confirmation. Instead PROPOSE the run. Reply with one short line saying what you\'d run (intent + roughly how many agents), and end your turn with this marker on its own final line:\n' +
      '    <!-- eh-run intent="INTENT" label="BUTTON LABEL" -->\n' +
      'where INTENT is exactly one of review | groom | implement | split, and BUTTON LABEL is what the confirm button should read (e.g. "Run review (3 agents)"). The marker is invisible in the chat — it renders as a one-click confirm button below the composer. ONLY after the user clicks it (their next message will explicitly confirm the launch) do you actually call delegate with the fleet you proposed (one delegation per specialist) — use list_available_agents to pick specialists fitting the intent and the ticket. That click is the cost guard: never launch a fleet without it. If the user instead asks a question or changes course, simply drop the proposal and carry on. Emit the marker only when genuinely proposing a multi-agent run — keep it conservative so you never offer a run the user didn\'t gesture at.'
    : '';
}

/**
 * FLUX-1479 (FLUX-1226 Phase E): resolve + render a phase's persona Mission block, factored out of
 * buildInitialPrompt's `actionInstruction` closure so `buildPhaseHandoffNote` (below) can replay
 * the identical rendering mid-conversation, for a DIFFERENT phase than the one the session opened
 * with, without duplicating the placeholder wiring. Returns undefined when no persona resolves for
 * `phase` — buildInitialPrompt's status-derived fallback text is intentionally NOT part of this;
 * that fallback only ever applies to the very first, opening-turn prompt.
 */
function renderPhasePersonaMission(
  phase: LaunchPhase,
  task: { id?: string | number | undefined; kind?: string | undefined },
  opts: {
    framework: CliFramework;
    editsGated?: boolean | undefined;
    explicitPersonaId?: string | undefined;
    batchTicketIds?: string[] | undefined;
    batchExcluded?: { id: string; reason: string }[] | undefined;
  },
): string | undefined {
  const persona = resolveSoloChatPersona(phase, opts.explicitPersonaId, isScratchSession(task));
  if (!persona) return undefined;
  const editGateBlock = opts.editsGated
    ? `\n\n${chatEditGateNote(opts.framework, isScratchSession(task) ? 'scratch' : 'status')}`
    : '';
  // FLUX-1383: batch-grooming's mission lists its member tickets and names any excluded sibling —
  // every other phase's template has no {{batchMembersList}}/{{batchExcludedNote}} token, so these
  // render to '' there (renderPersonaTemplate leaves unmatched tokens untouched, but there are none
  // to match in that case).
  const batchMembersList = (opts.batchTicketIds ?? []).map((memberId) => `- ${memberId}`).join('\n');
  const batchExcludedNote =
    opts.batchExcluded && opts.batchExcluded.length > 0
      ? `\nExcluded from this batch (left in Grooming for individual attention): ${opts.batchExcluded.map((e) => `${e.id} (${e.reason})`).join(', ')}.\n`
      : '';
  return renderPersonaTemplate(persona.prompt, {
    taskId: String(task.id),
    readyStatus: getConfig()?.readyForMergeStatus || 'Ready',
    mcpNote: buildMcpNote(),
    noDeferNote: buildNoDeferNote(),
    editGateBlock,
    orchestrationProposalsParagraph: buildOrchestrationProposalsParagraph(opts.framework),
    batchMembersList,
    batchExcludedNote,
  });
}

/**
 * FLUX-1479 (FLUX-1226 Phase E): a persistent chat session's Mission-block persona is only ever
 * delivered once, in the opening turn's `buildInitialPrompt` call — `sendCliSessionInput` never
 * replays it on later turns (there is no separate "system" channel; `--resume` continues the same
 * conversation from the model's point of view). So a phase HANDOFF (`session.handoffPhase`, set by
 * mcp-server.ts's `change_status` on a status transition) needs its own one-time announcement
 * injected into the NEXT resumed turn's prompt for "the destination persona takes over the same
 * chat" to be true in practice, not just in the session record. Returns '' (nothing to prepend)
 * once already announced (`handoffPhaseAnnounced`) or when there is no pending handoff — callers
 * are expected to set `handoffPhaseAnnounced = true` after actually sending a non-empty result.
 */
export function buildPhaseHandoffNote(
  session: { handoffPhase?: LaunchPhase | undefined; handoffPhaseAnnounced?: boolean | undefined; personaId?: string | undefined },
  task: { id?: string | number | undefined; kind?: string | undefined; tags?: string[] | undefined },
  framework: CliFramework,
): string {
  if (!session.handoffPhase || session.handoffPhaseAnnounced) return '';
  const mission = renderPhasePersonaMission(session.handoffPhase, task, { framework, editsGated: false, explicitPersonaId: session.personaId });
  if (!mission) return '';
  const moduleFragments = getModulePromptFragments(session.handoffPhase, Array.isArray(task.tags) ? task.tags : undefined, isScratchSession(task));
  const header = `PHASE HANDOFF (FLUX-1226 Phase E): this ticket's status changed and this chat now continues as the "${session.handoffPhase}" phase — the following supersedes any earlier phase instructions given in this conversation.\n\n`;
  return `${header}${mission}${moduleFragments ? `\n\n${moduleFragments}` : ''}`;
}

export function buildInitialPrompt(task: CliTask, appendPrompt: string, opts?: BuildInitialPromptOptions): string {
  const framework = opts?.framework ?? 'claude';
  const caps = CLI_CAPABILITIES[framework];
  const readyStatus = getConfig()?.readyForMergeStatus || 'Ready';
  const taskStatus = task.status || 'Unknown';
  const mcpNote = buildMcpNote();

  const requireInputStopInstruction = caps.selfPause
    ? 'IMPORTANT: If you call change_status to "Require Input", STOP immediately after. Do not continue working — the user will reply and you will be resumed with their answer.'
    : 'IMPORTANT: If you call change_status to "Require Input", end your turn there — do not continue working. The user\'s reply starts a new turn that resumes this conversation.';

  const actionInstruction = (() => {
    // Phase-aware instructions take priority when the caller tells us the intent — every
    // framework's caller computes this identically, so every framework uses it identically.
    if (opts?.phase) {
      // FLUX-1226: role text for every launch phase now lives in the persona catalog
      // (orchestration-personas.ts, `PHASE_DEFAULT_PERSONAS`) as that phase's default built-in
      // persona — this used to be a hardcoded `switch (opts.phase)` of Mission-block literals
      // right here, a second, undiscoverable copy of "what does this phase's agent get told to
      // do" alongside the persona catalog (which, until now, only ever powered DELEGATED runs).
      // Only the Mission-block TEXT migrated: cross-cutting mechanics (this whole function's
      // other locals — mcpNote, noDeferNote, requireInputStopInstruction,
      // orchestrationProposalsParagraph, the FLUX-926 edit gate, the get_ticket/history/
      // moduleFragments scaffolding below) stay computed here and are substituted into the
      // resolved template's `{{placeholder}}` tokens — never folded into a persona.
      //
      // The resolved persona's id is deliberately never stamped onto `session.personaId` — that
      // would thread it into the FLUX-1434 EH tool-scoping path (disallowedEhToolsForPersona,
      // keyed on session.personaId), which must stay byte-identical to before this migration.
      // Role resolution here is prompt-text-only, so that path is untouched by construction.
      // FLUX-1479: the actual rendering (persona resolution + placeholder substitution) now lives
      // in the shared `renderPhasePersonaMission` helper above, so `buildPhaseHandoffNote` can
      // replay it mid-conversation for a phase handoff without a second copy of this wiring.
      const rendered = renderPhasePersonaMission(opts.phase as LaunchPhase, task, {
        framework,
        editsGated: opts?.editsGated,
        explicitPersonaId: undefined,
        batchTicketIds: opts?.batchTicketIds,
        batchExcluded: opts?.batchExcluded,
      });
      if (rendered !== undefined) return rendered;
    }
    // Fallback: derive intent from ticket status (backwards compat for direct API / child sessions).
    if (taskStatus === 'Grooming' || taskStatus === 'Require Input') {
      return `The ticket is in ${taskStatus}. Your job is to GROOM this ticket:\n` +
        `1. Use update_ticket to fill metadata (priority, effort, tags) and rewrite the body with a Problem/Motivation section and Implementation Plan.\n` +
        `2. If questions are unresolved, use change_status to move to "Require Input" with a comment containing your question.\n` +
        `3. When grooming is complete, use change_status to move to "Todo".\n` +
        mcpNote;
    }
    if (taskStatus === 'In Progress') {
      return `The ticket is currently In Progress. If the implementation is already complete, use change_status to move it to "${readyStatus}" with a completion summary comment. If work remains, complete it then move to "${readyStatus}". Do not exit without updating the ticket status.\n${mcpNote}`;
    }
    if (taskStatus === 'Todo') {
      return `The ticket is in Todo. Begin implementation: use change_status to move to "In Progress", complete the work, then use change_status to move to "${readyStatus}" when done.\n${mcpNote}`;
    }
    if (taskStatus === readyStatus) {
      return `The ticket is in ${readyStatus} awaiting user review. Do not move it further — wait for the user to say "finish ${task.id}".`;
    }
    return 'Respond with implementation progress updates and blockers. Keep updates concise.';
  })();

  const moduleFragments = getModulePromptFragments(opts?.phase, Array.isArray(task.tags) ? task.tags : undefined, isScratchSession(task));
  const phaseOverlay = resolvePhaseOverlay(task, opts?.phase);

  // FLUX-1377: Claude agent spawns get their phase's skill module appended here instead of
  // relying on the (now-trimmed) installed .claude/rules/event-horizon.md core to carry every
  // phase's guidance. Gated to: Claude only (copilot/gemini keep their full static install —
  // injecting there would double-load, see workflow-installer.ts); a phase that actually has a
  // module (grooming/implementation/review — release/mapping stay Read-on-demand, chat/finalize
  // get core only); and NOT a delegate/relay spawn (patternPosition 'assistant'/'step' — see
  // BuildInitialPromptOptions.patternPosition doc).
  const isDelegateOrRelaySpawn = opts?.patternPosition === 'assistant' || opts?.patternPosition === 'step';
  const injectablePhase = opts?.phase;
  const phaseSkillModule = framework === 'claude' && !isDelegateOrRelaySpawn && isInjectablePhaseModule(injectablePhase)
    ? (loadSkillModuleBodySync(injectablePhase) ?? skillModuleFallback(injectablePhase))
    : null;

  // FLUX-1502: config-driven communication blocks (user-facing style + inter-agent protocol,
  // both default on). Skipped when the assembled prompt already carries them — a persona-launched
  // session's `appendPrompt` arrives pre-composed by resolvePersonaPrompt, which injects the same
  // blocks under the same settings (heading literals are the guard).
  const communicationStyleBlock =
    appendPrompt.includes('## Communication style') || appendPrompt.includes('## Inter-agent protocol')
      ? null
      : buildCommunicationBlocks();

  const lines = [
    `You are working on ticket ${task.id}.`,
    `Title: ${task.title || 'Untitled ticket'}`,
    `Current status: ${taskStatus}`,
    '',
    // Body single-source (FLUX-498, now universal per FLUX-960): don't echo the full body
    // here — it's also returned by get_ticket, which the workflow already requires every
    // agent to call first, regardless of framework. Echoing both double-counts fresh spawn
    // tokens for every adapter equally, not just Claude.
    `Read the full description and plan with get_ticket("${task.id}") — that is the source of truth; it is not echoed here to save context.`,
    '',
    'Latest activity:',
    ...(Array.isArray(task.history) ? task.history.filter((e) => e?.type !== 'agent_message').slice(-3).map((entry) => {
      if (entry?.type === 'status_change') {
        return `- [${entry.date || ''}] ${entry.user || 'Unknown'} moved ${entry.from || '?'} -> ${entry.to || '?'}`;
      }
      return `- [${entry?.date || ''}] ${entry?.user || 'Unknown'}: ${entry?.comment || entry?.type || 'activity'}`;
    }) : ['- (No history)']),
    '',
    ...(opts?.diffBlock ? [opts.diffBlock, ''] : []),
    ...(appendPrompt ? [appendPrompt, ''] : []),
    ...(moduleFragments ? [moduleFragments, ''] : []),
    ...(phaseSkillModule ? [`## Phase Skill: ${injectablePhase}`, '', phaseSkillModule, ''] : []),
    actionInstruction,
    // FLUX-1229 seam (see resolvePhaseOverlay above) — empty today, so this never adds a line.
    ...(phaseOverlay ? ['', phaseOverlay] : []),
    ...(communicationStyleBlock ? ['', communicationStyleBlock] : []),
    '',
    requireInputStopInstruction,
  ];
  // Node's spawn rejects strings containing null bytes; strip them to prevent
  // ticket content (e.g. bad escape sequences) from breaking the spawn call.
  return lines.join('\n').replace(/\0/g, '');
}

// ---- A.5 (FLUX-932): shared tool→activity lookup. Each adapter keeps its OWN TOOL_ACTIVITY_MAP
// (the tool names differ per CLI) but the lookup-with-'Working'-fallback was duplicated everywhere.
export function activityFor(map: Record<string, string>, toolName: string): string {
  return map[toolName] ?? 'Working';
}

// ---- FLUX-1378 (absorbing FLUX-1375 step 6): shared token-flush delta computation ----
// Compute the ticket-level `tokenMetadata` delta to persist for this session, and advance the
// session's flushed baselines so a LATER flush (e.g. a resumed turn's exit handler) only adds what
// accumulated SINCE this flush — session.inputTokens/etc. keep accumulating for the session's whole
// lifetime (they also drive the live per-session cost badge), so flushing the raw cumulative value a
// second time would double-count everything the first flush already persisted. Returns null when
// nothing new accumulated (nothing to write). Originally claude-code.ts-only; moved here (FLUX-1375)
// so gemini.ts/copilot.ts's resume/reply exit handlers can flush too instead of dropping every
// resumed turn's tokens (each previously used its own non-delta tokenUpdate computation that only
// ran on the INITIAL spawn's exit handler).
export function buildTokenMetadataUpdate(taskId: string, session: CliSessionRecord) {
  const deltaInput = (session.inputTokens ?? 0) - (session.flushedInputTokens ?? 0);
  const deltaOutput = (session.outputTokens ?? 0) - (session.flushedOutputTokens ?? 0);
  if (deltaInput <= 0 && deltaOutput <= 0) return null;
  const deltaCost = (session.costUSD ?? 0) - (session.flushedCostUSD ?? 0);
  const deltaCacheRead = (session.cacheReadTokens ?? 0) - (session.flushedCacheReadTokens ?? 0);
  const deltaCacheCreation = (session.cacheCreationTokens ?? 0) - (session.flushedCacheCreationTokens ?? 0);
  const prev = getWorkspace().tasks[taskId]?.tokenMetadata || { inputTokens: 0, outputTokens: 0, costUSD: 0 };
  session.flushedInputTokens = session.inputTokens ?? 0;
  session.flushedOutputTokens = session.outputTokens ?? 0;
  session.flushedCostUSD = session.costUSD ?? 0;
  session.flushedCacheReadTokens = session.cacheReadTokens ?? 0;
  session.flushedCacheCreationTokens = session.cacheCreationTokens ?? 0;
  return {
    inputTokens: (prev.inputTokens ?? 0) + deltaInput,
    outputTokens: (prev.outputTokens ?? 0) + deltaOutput,
    costUSD: parseFloat(((prev.costUSD ?? 0) + deltaCost).toFixed(6)),
    costIsEstimated: prev.costIsEstimated || session.costIsEstimated || false,
    cacheReadTokens: (prev.cacheReadTokens ?? 0) + deltaCacheRead,
    cacheCreationTokens: (prev.cacheCreationTokens ?? 0) + deltaCacheCreation,
  };
}

// ---- FLUX-921: shared stop-terminalization for a resumed/reply turn ----
// The `if (session.requestedStop) { status='cancelled'; endedAt=… } else { status='waiting-input' }`
// block was duplicated across the reply error/exit handlers of claude-code.ts / copilot.ts /
// gemini.ts (PR #193 review, senior-dev + qa-correctness). A stop racing a spawn error or process
// exit stays 'cancelled' (matches the synchronous stop route so Stop never un-sticks back to
// active); otherwise the resumable conversation reverts to 'waiting-input'. `blockedReason` lets
// the claude-code.ts error handler keep flagging a crashed (non-stopped) reply as "Needs your
// input" (FLUX-918) without re-duplicating the branch.
export function terminalizeResumedExit(session: CliSessionRecord, opts?: { blockedReason?: string }): void {
  if (session.requestedStop) {
    session.status = 'cancelled';
    session.endedAt = new Date().toISOString();
  } else {
    if (opts?.blockedReason) session.blockedReason = opts.blockedReason;
    session.status = 'waiting-input';
  }
}

// ---- A.1 (FLUX-932): shared stdout transport skeleton ----
// The three adapters each parse a DIFFERENT JSONL schema, but the TRANSPORT around the parse was
// byte-identical and duplicated: buffer stdout into lines, JSON.parse each non-empty line, dispatch
// to the parser, fall back on a parse error. Only that skeleton lives here; each adapter supplies its
// own per-CLI `onEvent` (the schema-specific body) and `onParseError` (the plain-text fallback).
//
// `commitPendingAssistantText` is built here and passed INTO `onEvent` (named identically so adapter
// bodies move verbatim) and returned to the caller. `narrationType` preserves the one real divergence
// the audit flagged: Claude flushes progress with no `type` (compact one-liner) while Copilot/Gemini
// pass 'text' (a styled "Narration" block — HistoryList.tsx). Claude omits the arg; the others pass 'text'.
// Generic over the per-CLI JSONL event shape (`TEvent`, default `unknown`) — Claude, Copilot, and
// Gemini each emit a different schema on this line, so this shared skeleton can't know it; each
// adapter instantiates `attachStdoutProcessing<ItsEventType>(...)` to get its own shape typed
// through `onEvent`, narrowing from `unknown` only where an adapter doesn't specialize it.
export interface StdoutHandlers<TEvent = unknown> {
  onEvent: (evt: TEvent, trimmed: string, commitPendingAssistantText: () => void) => void;
  onParseError: (trimmed: string) => void;
}

export function attachStdoutProcessing<TEvent = unknown>(
  proc: ChildProcess,
  session: CliSessionRecord,
  handlers: StdoutHandlers<TEvent>,
  narrationType?: 'text',
): () => void {
  const commitPendingAssistantText = () => {
    if (session.pendingAssistantText) {
      appendSessionOutput(session, session.pendingAssistantText, 'stdout', true);
      flushSessionOutput(session, false, narrationType);
      // FLUX-911: do NOT tee per-narration 'working' rows to the board — that flooded the orchestrator
      // chat/Activity, forced an O(file) board re-projection per narration, and could starve real
      // dialogue out of the bounded cold-resume re-prime. Live progress stays on the `activity` SSE +
      // the dispatched ticket's own chat; the board keeps only the one-shot 'started' + terminal brackets.
      session.pendingAssistantText = '';
    }
  };

  let lineBuf = '';
  proc.stdout!.on('data', (chunk: Buffer) => {
    lineBuf += chunk.toString();
    const lines = lineBuf.split('\n');
    lineBuf = lines.pop() ?? '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const evt = JSON.parse(trimmed) as TEvent;
        handlers.onEvent(evt, trimmed, commitPendingAssistantText);
      } catch {
        handlers.onParseError(trimmed);
      }
    }
  });

  return commitPendingAssistantText;
}

// ---- FLUX-975: resolveClaudeExePath — cached across every Claude spawn ----
// Three separate call sites (claude-code.ts's per-ticket start, its resume/reply path, and
// claude-board.ts's board spawn — used for both board start and board resume) each ran the same
// `npm prefix -g` execSync + existsSync check on EVERY spawn, even though the resolved path can't
// change without an engine restart (same class of waste as FLUX-974's Copilot fix; `npm prefix -g`
// alone measured ~1s in this environment). Cached at module scope after the first resolution.
// `undefined` = not yet resolved; `null` = DEFINITIVELY resolved to "not found" (npm prefix -g
// succeeded but claude.exe isn't on disk) — safe to cache, since that can't change without a
// reinstall + restart. A *transient* resolution failure (npm prefix -g timeout, global-lock
// contention, AV/disk stall) is deliberately NOT cached (FLUX-985): caching it would short-circuit
// resolveClaudeExePath forever and dead-spawn every Claude session until an engine restart, even
// though `claude` is installed and `where claude` still passes. On a caught error we return null
// for this call only and leave the cache unset so the next spawn re-attempts resolution.
let cachedClaudeExePath: string | null | undefined;

// FLUX-1003 (epic FLUX-996): was `execSync` — SYNCHRONOUS, blocking the whole event loop for the
// `npm prefix -g` duration on every cold-spawn/cache-miss call. Converted to async `exec` (kept in
// the shell-based family, not `execFile` — `npm` resolves to `npm.cmd` on Windows); the caching
// semantics above (positive/definitive-negative cached forever, transient NOT cached) are
// unchanged — this only removes the event-loop stall.
export async function resolveClaudeExePath(): Promise<string | null> {
  if (cachedClaudeExePath !== undefined) return cachedClaudeExePath;
  if (process.platform !== 'win32') {
    cachedClaudeExePath = null;
    return null;
  }
  try {
    const { stdout } = await execAsync('npm prefix -g', { timeout: 10_000, windowsHide: true });
    const npmPrefix = stdout.trim();
    const candidateExe = path.join(npmPrefix, 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe');
    // Only a SUCCESSFUL `npm prefix -g` yields a definitive answer worth caching.
    cachedClaudeExePath = fs.existsSync(candidateExe) ? candidateExe : null;
    if (cachedClaudeExePath) {
      log.info(`[claude] Found claude.exe at: ${cachedClaudeExePath}`);
    } else {
      log.info(`[claude] claude.exe not found at ${candidateExe}`);
    }
    return cachedClaudeExePath;
  } catch (err) {
    // Transient failure — do NOT poison the module-scoped cache; retry on the next spawn (FLUX-985).
    log.info('[claude] Failed to resolve claude.exe path (transient; will retry next spawn):', err);
    return null;
  }
}
