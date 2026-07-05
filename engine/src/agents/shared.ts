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
import { workspaceRoot as canonicalWorkspaceRoot, getTaskAssetsDir, getActiveFluxDir } from '../workspace.js';
import { isPathInsideRoot } from '../file-utils.js';
import { signConversation } from '../session-binding.js';
import { configCache } from '../config.js';
import { getModulePromptFragments } from '../modules.js';
import { updateAgentSession, updateTaskWithHistory } from '../task-store.js';
import { buildActivityEntry } from '../history.js';
import { raiseNeedsAction } from '../parked-ticket.js';
import type { CliSessionRecord, CliFramework } from './types.js';
import { CLI_CAPABILITIES } from './types.js';
import type { ChatAttachment } from '../projection.js';

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
  if (canonicalWorkspaceRoot) env.EH_CANONICAL_WORKSPACE = canonicalWorkspaceRoot;
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
  history?: CliTaskHistoryEntry[];
}

export function buildInitialPrompt(task: CliTask, appendPrompt: string, opts?: BuildInitialPromptOptions): string {
  const framework = opts?.framework ?? 'claude';
  const caps = CLI_CAPABILITIES[framework];
  const readyStatus = configCache?.readyForMergeStatus || 'Ready';
  const taskStatus = task.status || 'Unknown';
  const mcpNote = 'CRITICAL: Use the "event-horizon" MCP tools (change_status, update_ticket, add_note) for ALL ticket updates. Do NOT edit .flux/ files directly — direct edits corrupt session tracking.';

  const requireInputStopInstruction = caps.selfPause
    ? 'IMPORTANT: If you call change_status to "Require Input", STOP immediately after. Do not continue working — the user will reply and you will be resumed with their answer.'
    : 'IMPORTANT: If you call change_status to "Require Input", end your turn there — do not continue working. The user\'s reply starts a new turn that resumes this conversation.';

  const orchestrationProposalsParagraph = caps.supervisor
    ? '\n\nORCHESTRATION PROPOSALS (FLUX-805): you can spawn a fleet of subagents from this chat (list_available_agents to discover specialists, then delegate to run them). When the user expresses an orchestratable intent in plain language — "let\'s do a review", "groom this", "implement it with a few agents", "split this up" — do NOT silently launch a fleet: that spends tokens with no confirmation. Instead PROPOSE the run. Reply with one short line saying what you\'d run (intent + roughly how many agents), and end your turn with this marker on its own final line:\n' +
      '    <!-- eh-run intent="INTENT" label="BUTTON LABEL" -->\n' +
      'where INTENT is exactly one of review | groom | implement | split, and BUTTON LABEL is what the confirm button should read (e.g. "Run review (3 agents)"). The marker is invisible in the chat — it renders as a one-click confirm button below the composer. ONLY after the user clicks it (their next message will explicitly confirm the launch) do you actually call delegate with the fleet you proposed (one delegation per specialist) — use list_available_agents to pick specialists fitting the intent and the ticket. That click is the cost guard: never launch a fleet without it. If the user instead asks a question or changes course, simply drop the proposal and carry on. Emit the marker only when genuinely proposing a multi-agent run — keep it conservative so you never offer a run the user didn\'t gesture at.'
    : '';

  const actionInstruction = (() => {
    // Phase-aware instructions take priority when the caller tells us the intent — every
    // framework's caller computes this identically, so every framework uses it identically.
    if (opts?.phase) {
      switch (opts.phase) {
        case 'chat':
          // FLUX-602: free-form conversational session bound to a ticket. The user's
          // message arrives via appendPrompt above — do NOT inject a mission.
          // FLUX-651: but if the user asks for WORK (groom/implement/review/fix) and you DO it,
          // you must end the turn on a board action — never finish work and just narrate it.
          return `## Conversational session\n\n` +
            `This is a free-form chat about ticket ${task.id}. Respond conversationally to the user's message above — answer questions, discuss, and help.\n` +
            `For pure discussion or Q&A, do NOT change the ticket status, edit files, or commit unless asked — the user drives. Read-only tools (get_ticket, list_tickets, get_board_config) and add_note are always fine.\n\n` +
            `END-OF-TURN ACTION CONTRACT (FLUX-651): if in THIS turn you actually performed grooming, implementation, or review work on the ticket, you MUST end the turn by taking the board action that reflects the outcome — do not finish the work and merely summarize it in chat:\n` +
            `- Groomed it → change_status to "Todo" (or "Require Input" with your question).\n` +
            `- Implemented it → change_status to "${readyStatus}" with a completion summary (or "Require Input" if blocked).\n` +
            `- Reviewed it → change_status to "${readyStatus}", or back to "In Progress" with what to fix, or create_ticket with parentId for follow-ups, or "Require Input".\n` +
            `Leaving the ticket parked in a working status with only a chat summary is a defect: the board flags it "Needs Action" and the user is notified. If you genuinely cannot decide, that itself is a "Require Input" — raise it, don't sit on it.\n\n` +
            `To ask the user a structured question mid-turn, call the ask_user_question tool — it shows an interactive picker in this chat and returns their choice so you continue immediately. Never assume when a quick question would resolve ambiguity; ask.\n` +
            `This holds REGARDLESS of the ticket's status (FLUX-826): even on a Done/Ready/closed ticket, any decision ("file a ticket / commit / leave it?") goes through ask_user_question — never as chat prose. A decision typed only into chat on a resting ticket has no picker, no notification, and no board flag, so it is lost if the user isn't watching live. (If ask_user_question times out unanswered on a ticket, the engine now leaves a persistent "Needs Action" flag as a backstop — but route it structurally, don't rely on the backstop.)` +
            (opts?.editsGated ? `\n\nFLUX-926: this ticket is not In Progress, so file-mutation tools (Write/Edit/etc.) are disabled for this turn — the CLI will refuse them. Move the ticket to "In Progress" (or ask the user to) before making changes; discussion, planning, and read-only tools work as normal.` : '') +
            orchestrationProposalsParagraph + `\n\n` +
            mcpNote;
        case 'grooming':
          return `## Your Mission: GROOM this ticket\n\n` +
            `1. Use update_ticket to fill metadata (priority, effort, tags) and rewrite the body with a Problem/Motivation section and Implementation Plan.\n` +
            `2. If questions are unresolved, use change_status to move to "Require Input" with a comment containing your question.\n` +
            `3. When grooming is complete, use change_status to move to "Todo".\n\n` +
            mcpNote;
        case 'implementation':
          return `## Your Mission: IMPLEMENT this ticket\n\n` +
            `Write code to fulfill the ticket's plan. Move to "In Progress" if not already, complete the work, validate it, then use change_status to move to "${readyStatus}" with a completion summary.\n` +
            `Do not exit without updating the ticket status.\n\n` +
            mcpNote;
        case 'review':
          return `## Your Mission: REVIEW this ticket's implementation\n\n` +
            `Assess the code changes for correctness, quality, edge cases, and alignment with the ticket's requirements. ` +
            `Delegate to specialist reviewers if you are a supervisor — do NOT skip the review just because the work looks done.\n\n` +
            `If you find issues:\n` +
            `- Minor issues that don't block merging: create a follow-up ticket as a subtask using create_ticket with parentId set to this ticket (do NOT just suggest one — actually create it), then note the subtask ID in your review summary.\n` +
            `- Blocking issues: use change_status to move back to "In Progress" with a comment explaining what needs fixing.\n\n` +
            `If the implementation passes review, use change_status to move to "${readyStatus}" with a summary of what you reviewed and your findings.\n\n` +
            mcpNote;
        case 'finalize':
          return `## Your Mission: FINALIZE this ticket\n\n` +
            `Stage all relevant files (code + docs), create a focused commit, then use finish_ticket with the commit hash or PR URL as implementationLink. ` +
            `The ticket will be moved to Done atomically. If the ticket has a branch, the engine will push and create a PR automatically.\n\n` +
            mcpNote;
      }
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

  const moduleFragments = getModulePromptFragments(opts?.phase, Array.isArray(task.tags) ? task.tags : undefined);

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
    actionInstruction,
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
