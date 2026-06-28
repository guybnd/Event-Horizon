import { spawn, execSync, execFileSync, type ChildProcessWithoutNullStreams } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import { configCache } from '../config.js';
import { buildActivityEntry, buildCommentEntry, buildAgentMessageEntry, buildAgentSessionEntry, appendSessionProgress, closeAgentSession, type AgentSessionEntry } from '../history.js';
import { updateTaskWithHistory, updateAgentSession, tasksCache, estimateCostUSD } from '../task-store.js';
import { resolveTaskExecutionRoot } from '../task-worktree.js';
import { workspaceRoot as canonicalWorkspaceRoot, getActiveFluxDir, getTaskAssetsDir } from '../workspace.js';
import { isPathInsideRoot } from '../file-utils.js';
import { cliSessionsById, cliSessionIdByTaskId, notifyGroupSessionTerminal, notifyDelegationComplete, checkAutoRestart } from '../session-store.js';
import { broadcastEvent } from '../events.js';
import { appendTranscriptLine, appendTranscriptEvent } from '../transcript.js';
import { signConversation } from '../session-binding.js';
import { killProcessTree } from '../kill-process-tree.js';
import { checkFrameworkHealth, checkSkillStaleness, generateOrchestratorReplyNotification } from '../notifications.js';
import { captureTurnStartState, clearNeedsActionIfSet, flagIfParked } from '../parked-ticket.js';
import { buildMemberScopeArgs } from '../group.js';
import { buildGroupDocsScopeArg } from '../group-member-worktree.js';
import { getModulePromptFragments, getModuleMcpServers, getActiveModules, getWorkspaceMcpServers } from '../modules.js';
import { getProbeStatus } from '../module-probe.js';
import { getSharedServerUrl, isSharedHttpPlatformProven } from '../shared-mcp-server.js';
import { buildBoardDigest } from '../board-digest.js';
import { buildResumePreamble } from '../resume-preamble.js';
import { buildBoardReprime } from '../board-reprime.js';
import type { AgentAdapter, CliSessionRecord, ProviderManifest, CliFramework, SendInputOptions } from './types.js';
import type { ChatAttachment } from '../projection.js';

function checkBinaryInstalled(binaryName: string): void {
  const checker = process.platform === 'win32' ? 'where' : 'which';
  try {
    execFileSync(checker, [binaryName], { stdio: 'ignore', env: cleanChildEnv(), timeout: 10_000, windowsHide: true });
  } catch {
    throw new Error(`"${binaryName}" is not installed or not on PATH. Please install it before starting an agent session.`);
  }
}

function cleanChildEnv(conversationId?: string): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.toUpperCase() === 'NODE_OPTIONS') delete env[key];
  }
  env.NODE_OPTIONS = '';
  env.EVENT_HORIZON_FRAMEWORK = 'claude';
  // Pin the canonical ticket store so a worktree agent's event-horizon MCP binds
  // to the real workspace, not its cwd worktree (FLUX-516).
  if (canonicalWorkspaceRoot) env.EH_CANONICAL_WORKSPACE = canonicalWorkspaceRoot;
  // FLUX-662: tag the conversation so the event-horizon MCP tools (permission_prompt,
  // ask_user_question) can route their parked request back to the originating chat/board
  // surface in the portal. Per-ticket sessions pass the ticket id; the board passes its
  // sentinel. Absent (e.g. a delegated subagent) → unrouted, handled by the global overlay.
  if (conversationId) {
    env.EH_CONVERSATION_ID = conversationId;
    // FLUX-841: mint this session's binding token — an HMAC of its OWN conversationId. The MCP
    // tools forward it on every HITL POST; the route requires it to match the claimed
    // conversationId, so a session can only route a transcript event into its own ticket (it can't
    // forge a sibling's token). Closes the same-shape cross-ticket injection isSafeStreamId can't.
    env.EH_CONVERSATION_TOKEN = signConversation(conversationId);
  }
  return env;
}

// Build --mcp-config JSON string for active module MCP servers.
// Prefers an engine-managed shared HTTP server when one is ready (so all sessions
// reuse one language-server process); otherwise falls back to a per-session stdio
// spawn. Skips modules whose probe status is 'error' to avoid cascading failures.
function buildModuleServerMap(phase?: string, tags?: string[]): Record<string, any> {
  const stdioServers = getModuleMcpServers(phase, tags);
  const filtered: Record<string, any> = {};
  for (const m of getActiveModules(phase, tags)) {
    // Shared HTTP path: one server for all sessions, on proven platforms.
    if (m.sharedHttp && isSharedHttpPlatformProven()) {
      const url = getSharedServerUrl(m.id);
      if (url) filtered[m.id] = { type: 'http', url };
      // Not ready yet (still starting / failed) → omit; don't stdio-fallback on a
      // proven platform, which would defeat the point and spawn N stacks.
      continue;
    }
    // Stdio path (no sharedHttp, or unproven platform): keep prior behavior.
    const server = stdioServers[m.id];
    if (server && getProbeStatus(m.id).status !== 'error') {
      filtered[m.id] = { type: 'stdio', ...server };
    }
  }
  return filtered;
}

function buildModuleMcpConfigArgs(phase?: string, tags?: string[]): string[] {
  const filtered = buildModuleServerMap(phase, tags);
  if (Object.keys(filtered).length === 0) return [];
  return ['--mcp-config', JSON.stringify({ mcpServers: filtered })];
}

// Build the MCP-config args for a spawn, honoring opt-in per-phase server
// profiles (FLUX-490). Default (no `mcpServerPhases` config) is unchanged: merge
// in module servers only, no --strict. When profiles are configured, EH takes
// ownership of the full set — workspace .mcp.json servers ∪ module servers —
// drops any server whose `mcpServerPhases[id]` excludes the current phase, and
// spawns with --strict-mcp-config so Claude Code uses ONLY this set. event-horizon
// is never filtered (agents need ticket tools).
// Pure: drop servers whose `serverPhases[id]` excludes the current phase.
// event-horizon is never dropped. Empty/absent serverPhases → passthrough.
export function filterMcpServersByPhase(
  servers: Record<string, any>,
  serverPhases: Record<string, string[]> | undefined,
  phase?: string,
): Record<string, any> {
  if (!serverPhases || Object.keys(serverPhases).length === 0) return { ...servers };
  const out: Record<string, any> = {};
  for (const [id, cfg] of Object.entries(servers)) {
    const phases = serverPhases[id];
    if (id !== 'event-horizon' && phase && Array.isArray(phases) && phases.length > 0 && !phases.includes(phase)) {
      continue; // scoped to other phases — drop
    }
    out[id] = cfg;
  }
  return out;
}

function buildSpawnMcpConfigArgs(phase?: string, tags?: string[]): string[] {
  const serverPhases = (configCache as any).mcpServerPhases as Record<string, string[]> | undefined;
  const hasProfiles = !!serverPhases && typeof serverPhases === 'object' && Object.keys(serverPhases).length > 0;
  if (!hasProfiles) return buildModuleMcpConfigArgs(phase, tags);

  const merged: Record<string, any> = { ...getWorkspaceMcpServers() };
  for (const [id, cfg] of Object.entries(buildModuleServerMap(phase, tags))) {
    if (!(id in merged)) merged[id] = cfg;
  }

  const filtered = filterMcpServersByPhase(merged, serverPhases, phase);
  if (!('event-horizon' in filtered)) {
    // Strict mode would strip the agent's OWN ticket tools — e.g. the workspace
    // .mcp.json is missing/malformed so event-horizon never made it into the set.
    // Fail open to merge mode rather than spawn an agent that can't manage the
    // ticket. (Review finding alongside FLUX-490.)
    console.warn('[mcp] strict profile would omit event-horizon — falling back to merge mode');
    return buildModuleMcpConfigArgs(phase, tags);
  }
  if (Object.keys(filtered).length === 0) return [];
  // FLUX-604: keep the agent's OWN ticket tools loaded directly — no tool-search
  // deferral loop (the orchestrator was re-searching get_ticket ~10x before calling
  // it). Requires Claude Code >= 2.1.121.
  if (filtered['event-horizon']) filtered['event-horizon'] = { ...filtered['event-horizon'], alwaysLoad: true };
  return ['--strict-mcp-config', '--mcp-config', JSON.stringify({ mcpServers: filtered })];
}

// Debug/visibility: which MCP servers would be injected for a given phase, and
// whether strict mode is active. In merge mode the list is only EH-injected
// module servers (.mcp.json/user/global also load, not enumerated). In strict
// mode the list is exactly what the agent gets.
export function getEffectiveSpawnServers(phase?: string, tags?: string[]): { strict: boolean; servers: string[]; note: string } {
  const serverPhases = (configCache as any).mcpServerPhases as Record<string, string[]> | undefined;
  const hasProfiles = !!serverPhases && typeof serverPhases === 'object' && Object.keys(serverPhases).length > 0;
  if (!hasProfiles) {
    return {
      strict: false,
      servers: Object.keys(buildModuleServerMap(phase, tags)),
      note: 'Merge mode: EH-injected module servers only; workspace .mcp.json + user/global servers also load (not listed).',
    };
  }
  const merged: Record<string, any> = { ...getWorkspaceMcpServers() };
  for (const id of Object.keys(buildModuleServerMap(phase, tags))) if (!(id in merged)) merged[id] = {};
  const filtered = filterMcpServersByPhase(merged, serverPhases, phase);
  if (!('event-horizon' in filtered)) {
    // Mirror buildSpawnMcpConfigArgs: strict would strip event-horizon (e.g.
    // .mcp.json missing/malformed) → the real spawn fails open to merge, so the
    // visibility must report merge too, not a misleading "strict".
    return {
      strict: false,
      servers: Object.keys(buildModuleServerMap(phase, tags)),
      note: 'Merge mode (strict profile would omit event-horizon, so the spawn falls back). .mcp.json + user/global servers also load (not listed).',
    };
  }
  return {
    strict: true,
    servers: Object.keys(filtered),
    note: 'Strict mode: exactly the server set the agent gets for this phase (.mcp.json/user/global ignored).',
  };
}

// Effort levels accepted by the --effort CLI flag, in ascending order.
export const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
type EffortLevel = typeof EFFORT_LEVELS[number];

export const PROVIDER_CAPABILITIES: Partial<Record<CliFramework, { supportsEffort: boolean; effortFlag: string }>> = {
  claude: { supportsEffort: true, effortFlag: '--effort' },
  copilot: { supportsEffort: false, effortFlag: '' },
};

export function cliLabelForFramework(framework: 'claude' | 'copilot') {
  return framework === 'claude' ? 'Claude Code' : 'Copilot CLI';
}

const TOOL_ACTIVITY_MAP: Record<string, string> = {
  Bash: 'Running command',
  Edit: 'Editing',
  Write: 'Editing',
  Read: 'Reading',
  WebFetch: 'Researching',
  WebSearch: 'Researching',
  Agent: 'Delegating',
  TodoWrite: 'Planning',
};

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

export function flushSessionOutput(session: CliSessionRecord, force = false) {
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
      session.sessionHistoryEntry.progress.push({ timestamp, message: clippedText });
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

/**
 * FLUX-674: resolve chat image attachments (paste/drop in the composer) to absolute on-disk
 * paths under the per-ticket asset sidecar. Each attachment's `path` is flux-dir-relative
 * (`assets/<id>/foo.png`, as returned by the asset-upload route). We resolve against the active
 * flux dir and hard-guard that the result stays inside the assets root (defense-in-depth against
 * path traversal) and actually exists on disk; anything that fails is dropped. Returns the
 * absolute paths the agent will `Read`.
 */
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

export function buildInitialPrompt(task: any, appendPrompt: string, opts?: { diffBlock?: string | undefined; phase?: string | undefined }): string {
  const readyStatus = (configCache as any)?.readyForMergeStatus || 'Ready';
  const taskStatus = (task as any).status || 'Unknown';
  const mcpNote = 'CRITICAL: Use the "event-horizon" MCP tools (change_status, update_ticket, add_comment, log_progress) for ALL ticket updates. Do NOT edit .flux/ files directly — direct edits corrupt session tracking.';
  const actionInstruction = (() => {
    // Phase-aware instructions take priority when the portal tells us the intent.
    if (opts?.phase) {
      switch (opts.phase) {
        case 'chat':
          // FLUX-602: free-form conversational session bound to a ticket. The user's
          // message arrives via appendPrompt above — do NOT inject a mission.
          // FLUX-651: but if the user asks for WORK (groom/implement/review/fix) and you DO it,
          // you must end the turn on a board action — never finish work and just narrate it.
          return `## Conversational session\n\n` +
            `This is a free-form chat about ticket ${task.id}. Respond conversationally to the user's message above — answer questions, discuss, and help.\n` +
            `For pure discussion or Q&A, do NOT change the ticket status, edit files, or commit unless asked — the user drives. Read-only tools (get_ticket, list_tickets, get_board_config) and add_comment / log_progress are always fine.\n\n` +
            `END-OF-TURN ACTION CONTRACT (FLUX-651): if in THIS turn you actually performed grooming, implementation, or review work on the ticket, you MUST end the turn by taking the board action that reflects the outcome — do not finish the work and merely summarize it in chat:\n` +
            `- Groomed it → change_status to "Todo" (or "Require Input" with your question).\n` +
            `- Implemented it → change_status to "${readyStatus}" with a completion summary (or "Require Input" if blocked).\n` +
            `- Reviewed it → change_status to "${readyStatus}", or back to "In Progress" with what to fix, or create_subtask for follow-ups, or "Require Input".\n` +
            `Leaving the ticket parked in a working status with only a chat summary is a defect: the board flags it "Needs Action" and the user is notified. If you genuinely cannot decide, that itself is a "Require Input" — raise it, don't sit on it.\n\n` +
            `To ask the user a structured question mid-turn, call the ask_user_question tool — it shows an interactive picker in this chat and returns their choice so you continue immediately. Never assume when a quick question would resolve ambiguity; ask.\n` +
            `This holds REGARDLESS of the ticket's status (FLUX-826): even on a Done/Ready/closed ticket, any decision ("file a ticket / commit / leave it?") goes through ask_user_question — never as chat prose. A decision typed only into chat on a resting ticket has no picker, no notification, and no board flag, so it is lost if the user isn't watching live. (If ask_user_question times out unanswered on a ticket, the engine now leaves a persistent "Needs Action" flag as a backstop — but route it structurally, don't rely on the backstop.)\n\n` +
            `ORCHESTRATION PROPOSALS (FLUX-805): you can spawn a fleet of subagents from this chat (list_available_agents to discover specialists, then delegate_parallel to run them). When the user expresses an orchestratable intent in plain language — "let's do a review", "groom this", "implement it with a few agents", "split this up" — do NOT silently launch a fleet: that spends tokens with no confirmation. Instead PROPOSE the run. Reply with one short line saying what you'd run (intent + roughly how many agents), and end your turn with this marker on its own final line:\n` +
            `    <!-- eh-run intent="INTENT" label="BUTTON LABEL" -->\n` +
            `where INTENT is exactly one of review | groom | implement | split, and BUTTON LABEL is what the confirm button should read (e.g. "Run review (3 agents)"). The marker is invisible in the chat — it renders as a one-click confirm button below the composer. ONLY after the user clicks it (their next message will explicitly confirm the launch) do you actually call delegate_parallel with the fleet you proposed — use list_available_agents to pick specialists fitting the intent and the ticket. That click is the cost guard: never launch a fleet without it. If the user instead asks a question or changes course, simply drop the proposal and carry on. Emit the marker only when genuinely proposing a multi-agent run — keep it conservative so you never offer a run the user didn't gesture at.\n\n` +
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
            `- Minor issues that don't block merging: create a follow-up ticket as a subtask using create_subtask with this ticket as the parent (do NOT just suggest one — actually create it), then note the subtask ID in your review summary.\n` +
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
    // Body single-source (FLUX-498): don't echo the full body here — it's also
    // returned by get_ticket, which the workflow already requires the agent to
    // call first. Echoing both double-counts ~2.3k of fresh spawn tokens.
    `Read the full description and plan with get_ticket("${task.id}") — that is the source of truth; it is not echoed here to save context.`,
    '',
    'Latest activity:',
    ...(Array.isArray(task.history) ? task.history.filter((e: any) => e?.type !== 'agent_message').slice(-3).map((entry: any) => {
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
    'IMPORTANT: If you call change_status to "Require Input", STOP immediately after. Do not continue working — the user will reply and you will be resumed with their answer.',
  ];
  // Node's spawn rejects strings containing null bytes; strip them to prevent
  // ticket content (e.g. bad escape sequences) from breaking the spawn call.
  return lines.join('\n').replace(/\0/g, '');
}

/**
 * FLUX-849: a "dispatched" session is an unattended ticket work session — launched via
 * `start_session`, a board-rebase dispatch, or a portal phase button (Groom / Implement / Review /
 * Finalize) — as opposed to the interactive per-ticket `chat`. A dispatched session runs skip-perm
 * with no human reading the ticket transcript, so its live activity is teed to the board
 * orchestrator thread (`__board__`) where a user watching the board sees `started / working /
 * needs-input / completed / failed` without opening the ticket. Ordinary ticket chats
 * (`phase: 'chat'`) and the board session itself are excluded so the thread isn't flooded by
 * conversations the user is already reading.
 *
 * The gate is the *absence* of a chat — NOT the presence of a work phase. `session.phase` is only
 * populated when the launcher passes one explicitly: `start_session` and board-rebase dispatch
 * forward `phase` only when present (its derivation from ticket status shapes the prompt, never the
 * record), and ad-hoc API launches set none. So requiring a truthy phase would silently no-op the
 * primary agent dispatch path (`start_session` with no explicit phase). An interactive chat always
 * carries `phase: 'chat'`, so any non-board session whose phase is not `'chat'` (including
 * `undefined`) is an unattended dispatch and belongs on the board thread.
 */
function isDispatchedSession(session: CliSessionRecord, taskId: string): boolean {
  return taskId !== BOARD_CONVERSATION_ID && session.phase !== 'chat';
}

export type DispatchLifecycle =
  | 'started'
  | 'working'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'waiting-input';

/** FLUX-849: short human label for a dispatched session's lifecycle marker on the board chip. */
const DISPATCH_LIFECYCLE_LABEL: Record<Exclude<DispatchLifecycle, 'working'>, string> = {
  started: 'started',
  completed: 'completed',
  failed: 'failed',
  cancelled: 'stopped',
  'waiting-input': 'needs input',
};

/**
 * FLUX-849: tee a dispatched session's live activity to the board orchestrator thread as a quiet
 * `dispatch-activity` note (projected to a non-bubble chip; filtered out of board cold-resume
 * dialogue, so the orchestrator's own working context is untouched). `lifecycle: 'working'` carries
 * an in-flight narration message; the other lifecycles are bracketing markers. Best-effort: a
 * transcript-append or broadcast hiccup must never disturb the session it is narrating.
 */
function teeDispatchActivityToBoard(
  session: CliSessionRecord,
  taskId: string,
  lifecycle: DispatchLifecycle,
  text: string,
): void {
  if (!isDispatchedSession(session, taskId)) return;
  const trimmed = text.trim();
  if (!trimmed) return;
  try {
    appendTranscriptEvent(BOARD_CONVERSATION_ID, {
      type: 'dispatch-activity',
      sourceTask: taskId,
      phase: session.phase,
      lifecycle,
      text: trimmed,
      timestamp: new Date().toISOString(),
    });
    broadcastEvent('taskUpdated', { id: BOARD_CONVERSATION_ID });
  } catch {
    /* best-effort: board narration must never break the dispatched session */
  }
}

export function attachStdoutProcessing(
  proc: ReturnType<typeof spawn>,
  session: CliSessionRecord,
  taskId: string,
) {
  const commitPendingAssistantText = () => {
    if (session.pendingAssistantText) {
      appendSessionOutput(session, session.pendingAssistantText, 'stdout', true);
      flushSessionOutput(session);
      // FLUX-849: a completed narration message — tee it to the board thread for dispatched sessions.
      teeDispatchActivityToBoard(session, taskId, 'working', session.pendingAssistantText);
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
        const evt = JSON.parse(trimmed);
        if (!session.claudeSessionId && evt.session_id) {
          session.claudeSessionId = evt.session_id;
        }
        // FLUX-691: token-by-token live streaming. With `--include-partial-messages` the CLI
        // emits `stream_event` lines wrapping the raw Anthropic SSE events. Surface text deltas
        // as a lightweight `assistantDelta` SSE for the live chat node, then STOP: partial events
        // must NOT be teed to the durable transcript (it stays complete-messages-only, so the
        // taskUpdated/progress-driven refetch path is untouched) and must NOT touch the output
        // buffers (the complete `assistant` message — handled below — still owns those).
        if (evt.type === 'stream_event') {
          const inner = evt.event;
          if (inner?.type === 'content_block_delta'
            && inner.delta?.type === 'text_delta'
            && typeof inner.delta.text === 'string'
            && inner.delta.text) {
            broadcastEvent('assistantDelta', {
              taskId,
              sessionId: session.sessionHistoryEntry?.sessionId,
              text: inner.delta.text,
            });
          }
          continue;
        }
        // FLUX-602: tee every raw stream-json line to the durable per-ticket transcript.
        appendTranscriptLine(taskId, trimmed);
        if (evt.type === 'assistant' && Array.isArray(evt.message?.content)) {
          const toolBlock = evt.message.content.find((b: any) => b.type === 'tool_use');
          if (toolBlock) {
            session.pendingAssistantText = '';
            const newActivity = TOOL_ACTIVITY_MAP[toolBlock.name] ?? 'Working';
            const activityChanged = session.currentActivity !== newActivity;
            session.currentActivity = newActivity;

            // Reset last progress log when activity changes
            if (activityChanged) {
              session.lastProgressLog = undefined;
            }

            // Log progress when activity changes or for significant tools
            if (activityChanged && session.sessionHistoryEntry?.sessionId) {
              const toolName = toolBlock.name;
              let progressMsg = session.currentActivity;

              // Add context for specific tools if available
              if (toolBlock.input) {
                if (toolName === 'Read' && toolBlock.input.file_path) {
                  progressMsg = `Reading ${path.basename(toolBlock.input.file_path)}`;
                } else if (toolName === 'Edit' && toolBlock.input.file_path) {
                  progressMsg = `Editing ${path.basename(toolBlock.input.file_path)}`;
                } else if (toolName === 'Write' && toolBlock.input.file_path) {
                  progressMsg = `Writing ${path.basename(toolBlock.input.file_path)}`;
                } else if (toolName === 'Bash' && toolBlock.input.command) {
                  const cmd = String(toolBlock.input.command).slice(0, 50);
                  progressMsg = `Running: ${cmd}${cmd.length >= 50 ? '...' : ''}`;
                }
              }

              // Accumulate tool progress in memory only — written to file at session end
              if (session.sessionHistoryEntry) {
                session.sessionHistoryEntry.progress.push({
                  timestamp: new Date().toISOString(),
                  message: progressMsg,
                  type: 'tool',
                  data: { toolName, parameters: toolBlock.input }
                });
              }
            }
          } else {
            commitPendingAssistantText();
            session.currentActivity = 'Thinking';
          }
          broadcastEvent('activity', { taskId, activity: session.currentActivity });
          for (const block of evt.message.content) {
            if (block.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
              session.liveOutputBuffer += block.text;
              if (!toolBlock) {
                session.pendingAssistantText += block.text;
              }
            }
          }
        } else {
          if (evt.type !== 'tool_use' && evt.type !== 'tool_result') {
            commitPendingAssistantText();
          } else {
            session.pendingAssistantText = '';
          }
          appendSessionOutput(session, trimmed, 'stdout', false);
        }
        if (evt.type === 'result') {
          session.currentActivity = undefined;
          broadcastEvent('activity', { taskId, activity: null });
        }
        if (evt.type === 'result' && evt.usage) {
          const cacheRead = evt.usage?.cache_read_input_tokens ?? 0;
          const cacheCreation = evt.usage?.cache_creation_input_tokens ?? 0;
          const freshInput = evt.usage?.input_tokens ?? 0;
          const inputTok = freshInput + cacheRead + cacheCreation;
          const outputTok = evt.usage?.output_tokens ?? 0;
          session.inputTokens = (session.inputTokens ?? 0) + inputTok;
          session.outputTokens = (session.outputTokens ?? 0) + outputTok;
          session.cacheReadTokens = (session.cacheReadTokens ?? 0) + cacheRead;
          session.cacheCreationTokens = (session.cacheCreationTokens ?? 0) + cacheCreation;
          if (typeof evt.total_cost_usd === 'number') {
            session.costUSD = (session.costUSD ?? 0) + evt.total_cost_usd;
          } else {
            session.costUSD = (session.costUSD ?? 0) + estimateCostUSD(session.claudeSessionId, inputTok, outputTok);
            session.costIsEstimated = true;
          }
        }
        if (evt.type === 'tool_use_blocked' || (evt.type === 'result' && evt.is_error && /permission|not allowed|denied/i.test(String(evt.error || '')))) {
          const reason = evt.tool_name
            ? `Blocked: ${evt.tool_name}${evt.error ? ` — ${evt.error}` : ''}`
            : String(evt.error || 'Permission denied');
          session.blockedReason = reason;
          session.status = 'waiting-input';
          flushSessionOutput(session, true);
          enqueueSessionWrite(session, async () => {
            await updateTaskWithHistory(taskId, {
              updatedBy: 'Agent',
              nextStatus: configCache.requireInputStatus || 'Require Input',
              entries: [buildActivityEntry(`${session.label} blocked: ${reason}`, 'Agent', new Date().toISOString())],
            });
          });
        }
      } catch {
        appendSessionOutput(session, trimmed, 'stdout', false);
      }
    }
  });

  return commitPendingAssistantText;
}

// FLUX-604: per-conversation --model/--effort args from the chat picker, read off
// the session record. `defaultEffort` applies only when the user hasn't picked one.
function modelEffortArgs(session: CliSessionRecord, defaultEffort?: string): string[] {
  const args: string[] = [];
  if (session.model) args.push('--model', session.model);
  const picked = session.effortOverride && (EFFORT_LEVELS as readonly string[]).includes(session.effortOverride)
    ? session.effortOverride
    : defaultEffort;
  if (picked) args.push('--effort', picked);
  return args;
}

// FLUX-605: permission flag per session. 'gated' routes tool decisions through the EH
// permission_prompt MCP tool; 'skip' (or legacy skipPermissions) uses
// --dangerously-skip-permissions. Mutually exclusive.
function permissionArgs(session: CliSessionRecord): string[] {
  if (session.permissionMode === 'gated') return ['--permission-prompt-tool', 'mcp__event-horizon__permission_prompt'];
  if (session.permissionMode === 'skip' || session.skipPermissions) return ['--dangerously-skip-permissions'];
  return [];
}

// FLUX-662: the native AskUserQuestion tool can't be fulfilled in `claude -p` print mode (no
// interactive TTY surface — the harness silently denies it, degrading the agent to prose).
// Disallow it everywhere so it can never be reached; agents ask via the event-horizon
// `ask_user_question` MCP tool instead, which surfaces a real portal picker. (Flag verified
// against the installed CLI: `--disallowedTools, --disallowed-tools <tools...>`.)
const DISALLOW_NATIVE_ASK = ['--disallowed-tools', 'AskUserQuestion'];

export async function startCliSession(session: CliSessionRecord, task: any, appendPrompt: string, effortOverrideRaw: string, workspaceRoot: string) {
  const framework = session.framework;
  const binaryName = framework === 'claude' ? 'claude' : 'copilot';
  const label = session.label;
  const id = session.taskId;
  // FLUX-519: run the agent in this task's worktree when one exists (else engine root).
  const executionRoot = await resolveTaskExecutionRoot(task, workspaceRoot);
  session.executionRoot = executionRoot;

  checkBinaryInstalled(binaryName);

  const claudeIntegration = (configCache as any).integrations?.claudeCode;
  const groomingStatuses = [(configCache as any).requireInputStatus || 'Require Input', 'Grooming'];
  const selectedModel = claudeIntegration && framework === 'claude'
    ? (groomingStatuses.includes(task.status) ? claudeIntegration.groomingModel : claudeIntegration.implementationModel)
    : null;

  const initialPrompt = buildInitialPrompt(task, appendPrompt, { diffBlock: session.diffBlock, phase: session.phase });

  const modelToUse = session.model || selectedModel;
  const claudeArgs = [
    ...(modelToUse ? ['--model', modelToUse] : []),
    '-p', initialPrompt,
    '--output-format', 'stream-json',
    '--verbose',
    // FLUX-691: emit partial assistant deltas for token-by-token live streaming in the chat.
    '--include-partial-messages',
    ...DISALLOW_NATIVE_ASK,
    ...permissionArgs(session),
    // Multi-repo group: put every checked-out member repo in scope (no-op single-repo).
    ...buildMemberScopeArgs(),
    // Member worktree: add local .flux-group/ so the agent reads shared group docs (FLUX-422).
    ...buildGroupDocsScopeArg(workspaceRoot),
    // Inject enabled module MCP servers dynamically (phase+tag gated, skips errored probes).
    ...(framework === 'claude' ? buildSpawnMcpConfigArgs(session.phase, Array.isArray(task.tags) ? task.tags : undefined) : []),
  ];

  const caps = PROVIDER_CAPABILITIES[framework] ?? PROVIDER_CAPABILITIES['copilot']!;
  const globalEffort = (configCache as any).effortLevel as string | undefined;
  const taskEffort = (task as any).effortLevel as string | undefined;
  const effectiveEffort = (session.effortOverride || effortOverrideRaw || taskEffort || globalEffort || '') as string;
  if (caps.supportsEffort && EFFORT_LEVELS.includes(effectiveEffort as EffortLevel)) {
    claudeArgs.push(caps.effortFlag, effectiveEffort);
  }

  let proc: ReturnType<typeof spawn>;
  if (process.platform === 'win32') {
    // On Windows, find the actual .exe instead of using cmd.exe wrapper
    // The npm bin wrapper is a bash script that execs claude.exe
    // Direct spawn of .exe preserves stdio streams for JSON output
    let exePath: string | null = null;
    try {
      const npmPrefix = execSync('npm prefix -g', { encoding: 'utf8', timeout: 10_000, windowsHide: true }).trim();
      const candidateExe = path.join(npmPrefix, 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe');
      if (fs.existsSync(candidateExe)) {
        exePath = candidateExe;
        console.log(`[${id}] Found claude.exe at: ${exePath}`);
      } else {
        console.log(`[${id}] claude.exe not found at ${candidateExe}`);
      }
    } catch (err) {
      console.log(`[${id}] Failed to resolve claude.exe path:`, err);
    }

    if (!exePath) {
      throw new Error('claude.exe not found. Please install @anthropic-ai/claude-code globally: npm install -g @anthropic-ai/claude-code');
    }

    console.log(`[${id}] Windows spawn: ${exePath} with ${claudeArgs.length} args`);
    console.log(`[${id}] Prompt length: ${initialPrompt.length} chars`);
    proc = spawn(exePath, claudeArgs, {
      cwd: executionRoot,
      env: cleanChildEnv(id),
      stdio: 'pipe',
      windowsHide: true,
    });
  } else {
    proc = spawn(binaryName, claudeArgs, {
      cwd: executionRoot,
      env: cleanChildEnv(id),
      stdio: 'pipe',
    });
  }
  session.proc = proc as ChildProcessWithoutNullStreams;
  session.pid = proc.pid;
  session.status = 'running';
  session.args = claudeArgs;
  // FLUX-651: snapshot the ticket state at turn start; clear any stale "parked" flag now that
  // work is (re)starting so the board stops showing Needs Action mid-turn.
  captureTurnStartState(session, id);
  void clearNeedsActionIfSet(id);

  // FLUX-849: announce a dispatched session's start on the board orchestrator thread so a user
  // watching the board sees it spin up without opening the ticket (no-op for interactive chats).
  teeDispatchActivityToBoard(session, id, 'started', `${session.phase ?? 'work'} session started`);

  const commitPending = attachStdoutProcessing(proc, session, id);

  proc.stderr!.on('data', (chunk) => {
    appendSessionOutput(session, chunk, 'stderr', false);
  });

  proc.on('error', async (error) => {
    // Clear heartbeat timer
    if (session.progressHeartbeat) {
      clearInterval(session.progressHeartbeat);
      session.progressHeartbeat = undefined;
    }

    session.status = 'failed';
    session.endedAt = new Date().toISOString();
    commitPending();
    flushSessionOutput(session, true);
    await session.writeQueue;

    const outcome = `${label} session failed to start: ${error.message}`;

    // FLUX-849: a spawn failure after the 'started' tee would otherwise leave the board chip
    // dangling — bracket it with a terminal 'failed' marker so the lifecycle is symmetric.
    teeDispatchActivityToBoard(session, id, 'failed', DISPATCH_LIFECYCLE_LABEL['failed']);

    if (session.sessionHistoryEntry && session.sessionHistoryEntry.sessionId) {
      const accumulatedProgress = session.sessionHistoryEntry.progress || [];
      await updateAgentSession(id, session.sessionHistoryEntry.sessionId, (sessionEntry) => {
        sessionEntry.status = 'failed';
        sessionEntry.outcome = outcome;
        sessionEntry.endedAt = session.endedAt;
        sessionEntry.progress = accumulatedProgress;
      });
    } else {
      await updateTaskWithHistory(id, {
        updatedBy: 'Agent',
        entries: [buildActivityEntry(outcome, 'Agent', session.endedAt)],
      });
    }

    console.error(`[${id}] Failed to spawn ${binaryName}:`, error.message);
  });

  // Create agent_session history entry
  const sessionEntry = buildAgentSessionEntry(session.id, session.startedAt, label, {
    groupId: session.groupId,
    role: session.role,
    pattern: session.groupType,
  });
  session.sessionHistoryEntry = sessionEntry;

  await updateTaskWithHistory(id, {
    updatedBy: 'Agent',
    entries: [sessionEntry],
  });

  // Start progress heartbeat - accumulate activity in memory every 15 seconds
  session.progressHeartbeat = setInterval(() => {
    if (session.currentActivity && session.sessionHistoryEntry) {
      const now = new Date().toISOString();
      // Only log if we haven't logged this same activity recently
      if (session.lastProgressLog !== session.currentActivity) {
        session.lastProgressLog = session.currentActivity;
        // Accumulate in memory only — written to file when session ends
        session.sessionHistoryEntry.progress.push({
          timestamp: now,
          message: session.currentActivity,
          type: 'info',
        });
      }
    }
  }, 15000);

  proc.on('exit', async (code, signal) => {
    // Clear heartbeat timer
    if (session.progressHeartbeat) {
      clearInterval(session.progressHeartbeat);
      session.progressHeartbeat = undefined;
    }

    commitPending();
    flushSessionOutput(session, true);
    await session.writeQueue;

    let finalStatus: 'completed' | 'failed' | 'cancelled' | 'waiting-input';
    if (session.requestedStop) {
      session.endedAt = new Date().toISOString();
      session.status = 'cancelled';
      finalStatus = 'cancelled';
    } else if (session.pausedForInput) {
      // Agent moved ticket to Require Input and was told to stop — stay resumable.
      // Do NOT set endedAt — session is still alive, waiting for user reply.
      finalStatus = 'waiting-input';
    } else if (code === 0) {
      if (session.phase === 'chat') {
        // FLUX-602: per-ticket chat is a persistent conversation — a finished turn
        // stays resumable (waiting-input) instead of going terminal, so the next
        // message --resumes the same session (one session, one history entry,
        // full memory) rather than spawning a fresh, amnesiac one.
        session.status = 'waiting-input';
        finalStatus = 'waiting-input';
      } else {
        session.endedAt = new Date().toISOString();
        session.status = 'completed';
        finalStatus = 'completed';
      }
    } else {
      session.endedAt = new Date().toISOString();
      session.status = 'failed';
      finalStatus = 'failed';
    }

    // Paused for user input — session stays alive and resumable. Flush tokens
    // but do NOT mark as terminal, notify barriers, or log an "ended" activity.
    if (finalStatus === 'waiting-input') {
      const tokenUpdate = (session.inputTokens ?? 0) > 0 || (session.outputTokens ?? 0) > 0
        ? (() => {
            const prev = tasksCache[id]?.tokenMetadata || { inputTokens: 0, outputTokens: 0, costUSD: 0 };
            return {
              inputTokens: (prev.inputTokens ?? 0) + (session.inputTokens ?? 0),
              outputTokens: (prev.outputTokens ?? 0) + (session.outputTokens ?? 0),
              costUSD: parseFloat(((prev.costUSD ?? 0) + (session.costUSD ?? 0)).toFixed(6)),
              costIsEstimated: prev.costIsEstimated || session.costIsEstimated || false,
              cacheReadTokens: (prev.cacheReadTokens ?? 0) + (session.cacheReadTokens ?? 0),
              cacheCreationTokens: (prev.cacheCreationTokens ?? 0) + (session.cacheCreationTokens ?? 0),
            };
          })()
        : null;
      if (tokenUpdate) {
        await updateTaskWithHistory(id, { updatedBy: 'Agent', entries: [], tokenMetadata: tokenUpdate });
      }
      if (session.sessionHistoryEntry?.sessionId) {
        await updateAgentSession(id, session.sessionHistoryEntry.sessionId, (sessionEntry) => {
          sessionEntry.status = 'waiting-input';
          sessionEntry.outcome = `${label} paused — waiting for user input.`;
          sessionEntry.progress = session.sessionHistoryEntry.progress || [];
        });
      }
      // FLUX-651: a chat turn that ends without the agent moving the ticket = "sat on its
      // hands". Don't flag a turn the agent itself paused for Require Input (pausedForInput).
      if (!session.pausedForInput) await flagIfParked(session, id);
      // FLUX-849: a dispatched session paused for input — mark it on the board thread.
      teeDispatchActivityToBoard(session, id, 'waiting-input', DISPATCH_LIFECYCLE_LABEL['waiting-input']);
      broadcastEvent('taskUpdated', { id });
      return;
    }

    const outcome = session.requestedStop
      ? `${label} session stopped by user.`
      : `${label} session ended with ${signal ? `signal ${signal}` : `code ${code ?? 'unknown'}`}.`;

    // FLUX-849: bracket the dispatched session's board narration with a terminal marker.
    // `finalStatus` here is one of completed / failed / cancelled (waiting-input returns above).
    teeDispatchActivityToBoard(session, id, finalStatus, DISPATCH_LIFECYCLE_LABEL[finalStatus]);

    const tokenUpdate = (session.inputTokens ?? 0) > 0 || (session.outputTokens ?? 0) > 0
      ? (() => {
          const prev = tasksCache[id]?.tokenMetadata || { inputTokens: 0, outputTokens: 0, costUSD: 0 };
          return {
            inputTokens: (prev.inputTokens ?? 0) + (session.inputTokens ?? 0),
            outputTokens: (prev.outputTokens ?? 0) + (session.outputTokens ?? 0),
            costUSD: parseFloat(((prev.costUSD ?? 0) + (session.costUSD ?? 0)).toFixed(6)),
            costIsEstimated: prev.costIsEstimated || session.costIsEstimated || false,
            cacheReadTokens: (prev.cacheReadTokens ?? 0) + (session.cacheReadTokens ?? 0),
            cacheCreationTokens: (prev.cacheCreationTokens ?? 0) + (session.cacheCreationTokens ?? 0),
          };
        })()
      : null;

    // Close the session entry with outcome and flush accumulated progress
    if (session.sessionHistoryEntry && session.sessionHistoryEntry.sessionId) {
      const accumulatedProgress = session.sessionHistoryEntry.progress || [];
      await updateAgentSession(id, session.sessionHistoryEntry.sessionId, (sessionEntry) => {
        sessionEntry.status = finalStatus;
        sessionEntry.outcome = outcome;
        sessionEntry.endedAt = session.endedAt;
        // Merge in-memory progress accumulated during the session
        sessionEntry.progress = accumulatedProgress;
      });

      // Save the agent's final message as a comment on the ticket
      const textEntries = accumulatedProgress.filter((p: any) => p.type === 'text' && p.message?.trim());
      const lastText = textEntries.length > 0 ? textEntries[textEntries.length - 1].message : '';
      if (lastText && finalStatus === 'completed') {
        const maxCommentLen = 3000;
        const commentBody = lastText.length > maxCommentLen ? lastText.slice(0, maxCommentLen) + '...' : lastText;
        await updateTaskWithHistory(id, {
          updatedBy: 'Agent',
          entries: [buildCommentEntry(label, commentBody, session.endedAt!)],
          tokenMetadata: tokenUpdate ?? undefined,
        });
      } else if (tokenUpdate) {
        await updateTaskWithHistory(id, {
          updatedBy: 'Agent',
          entries: [],
          tokenMetadata: tokenUpdate,
        });
      }
    } else {
      // Fallback to old behavior
      await updateTaskWithHistory(id, {
        updatedBy: 'Agent',
        entries: [buildActivityEntry(outcome, 'Agent', session.endedAt!)],
        tokenMetadata: tokenUpdate ?? undefined,
      });
    }

    if (finalStatus === 'completed') {
      checkFrameworkHealth(session.framework).catch(() => {});
      checkSkillStaleness(session.framework).catch(() => {});
      // FLUX-651: a phase session that ended cleanly but left the ticket in a working status
      // without taking a board action gets flagged Needs Action (surface, don't auto-resume).
      await flagIfParked(session, id);
    }

    // Notify delegation awaiters (supervisor pattern).
    notifyDelegationComplete(session);

    // Fan-in: if this session belongs to a run group, a deferred combiner may
    // be waiting for every worker to finish. Notify the barrier.
    if (session.groupId) {
      notifyGroupSessionTerminal(session.taskId, session.groupId).catch(() => {});
    }

    checkAutoRestart();
  });}

export class ClaudeCodeAdapter implements AgentAdapter {
  readonly manifest: ProviderManifest = {
    id: 'claude-code',
    displayName: 'Claude Code',
    configSchema: {},
    costModel: { inputPerMToken: 3, outputPerMToken: 15, currency: 'usd' },
    capabilities: {
      compacting: true,
      effortLevels: [...EFFORT_LEVELS],
      memoryFiles: true,
    },
  };

  labelForFramework(): string {
    return 'Claude Code';
  }

  async start(session: CliSessionRecord, task: unknown, appendPrompt: string, effortOverride: string, workspaceRoot: string): Promise<void> {
    return startCliSession(session, task, appendPrompt, effortOverride, workspaceRoot);
  }

  async sendInput(session: CliSessionRecord, message: string, user: string, workspaceRoot: string, opts?: SendInputOptions): Promise<void> {
    return sendCliSessionInput(session, message, user, workspaceRoot, opts);
  }

  stop(session: CliSessionRecord): void {
    // Tree-kill so the agent's MCP servers (serena, context7, …) are reaped too, not orphaned —
    // the stale-node-process leak. See kill-process-tree.ts.
    killProcessTree(session.proc);
  }
}

export async function sendCliSessionInput(session: CliSessionRecord, message: string, user: string, workspaceRoot: string, opts?: SendInputOptions) {
  const id = session.taskId;
  const binaryName = session.command;
  // FLUX-519 review: resume in the SAME root the session started in; refuse to fall
  // back onto master if the worktree was removed (e.g. the ticket was finished).
  const executionRoot = session.executionRoot ?? await resolveTaskExecutionRoot(tasksCache[id], workspaceRoot);
  if (executionRoot !== workspaceRoot && !fs.existsSync(executionRoot)) {
    throw new Error(`Worktree for ${id} no longer exists (ticket likely finished) — refusing to resume the agent on master.`);
  }

  checkBinaryInstalled(binaryName);

  const inputAt = new Date().toISOString();
  // FLUX-655: "since you last spoke" basis for the resume preamble — captured BEFORE we overwrite
  // lastInputAt below, so it reflects the PRIOR turn (last agent output, else last user input).
  const sinceIso = session.lastOutputAt ?? session.lastInputAt;
  session.lastInputAt = inputAt;
  session.status = 'running';
  session.pausedForInput = false;
  // FLUX-651: new turn — snapshot ticket state and drop any stale "parked" flag.
  captureTurnStartState(session, id);
  void clearNeedsActionIfSet(id);

  // FLUX-674: pasted-image attachments for this turn. Resolve to absolute sidecar paths the
  // agent can Read; keep the metadata for the durable transcript so the bubble re-renders.
  const attachments = opts?.attachments ?? [];
  const attachmentAbsPaths = resolveAttachmentAbsPaths(attachments);

  const task = tasksCache[id] as any;

  // FLUX-655: on a RESUMED turn, re-ground the agent in the moved tree. If the world actually
  // changed (branch fell behind, master rewrote files underneath us, sibling tickets merged), build
  // a compact situational update to prepend to the prompt below. Computed BEFORE the user event is
  // recorded so the `resume-preamble` transcript event is ordered ahead of the `user` event for this
  // turn (FLUX-716 item 3). Fully best-effort: a null assemble (no delta / git hiccup) is a no-op.
  let resumePreamble: string | null = null;
  if (session.claudeSessionId) {
    resumePreamble = await buildResumePreamble({
      taskId: id,
      branch: typeof task?.branch === 'string' ? task.branch : undefined,
      workspaceRoot: canonicalWorkspaceRoot ?? workspaceRoot,
      sinceIso,
    });
    if (resumePreamble) {
      appendTranscriptEvent(id, { type: 'resume-preamble', text: resumePreamble, timestamp: inputAt });
    }
  }

  // FLUX-602: record the user's turn in the durable transcript (raw tier). The image refs ride
  // on the turn (FLUX-674) so a reload / cold resume re-presents them.
  appendTranscriptEvent(id, { type: 'user', text: message, attachments, timestamp: inputAt });

  // History comment shows the user's words plus a note of any attached files.
  const fileNote = attachments.length
    ? `\n\n📎 ${attachments.map((a) => a.fileName || 'image').join(', ')}`
    : '';
  const historyComment = `${message}${fileNote}`.trim();
  await updateTaskWithHistory(id, {
    updatedBy: user,
    entries: [buildCommentEntry(user, historyComment, inputAt)],
  });

  // Effective prompt to the CLI = the user's text + a Read-the-image instruction (FLUX-674).
  const safeMessage = `${message.replace(/\0/g, '')}${attachmentReadInstruction(attachmentAbsPaths)}`;
  const memberScopeArgs = [...buildMemberScopeArgs(), ...buildGroupDocsScopeArg(workspaceRoot)];

  // FLUX-655: prepend the situational update (computed above) to the prompt sent to the CLI. The CLI
  // takes a single `-p` and with --resume there is no separate system channel, so prepending is the
  // mechanism. The preamble is recorded as its OWN durable transcript event above (NOT folded into
  // the user's message — FLUX-716 item 3 orders it before the user event).
  const promptForCli = resumePreamble ? `${resumePreamble}\n\n---\n\n${safeMessage}` : safeMessage;

  const moduleMcpArgs = buildSpawnMcpConfigArgs(session.phase, Array.isArray(task?.tags) ? task.tags : undefined);
  const meArgs = modelEffortArgs(session);
  // FLUX-691: `--include-partial-messages` → token-by-token live streaming on the resume/send path.
  const resumeArgs = session.claudeSessionId
    ? ['-p', promptForCli, '--resume', session.claudeSessionId, '--output-format', 'stream-json', '--verbose', '--include-partial-messages', ...meArgs, ...DISALLOW_NATIVE_ASK, ...permissionArgs(session), ...memberScopeArgs, ...moduleMcpArgs]
    : ['-p', promptForCli, '--output-format', 'stream-json', '--verbose', '--include-partial-messages', ...meArgs, ...DISALLOW_NATIVE_ASK, ...permissionArgs(session), ...memberScopeArgs, ...moduleMcpArgs];

  let replyProc: ReturnType<typeof spawn>;
  if (process.platform === 'win32') {
    // On Windows, find the actual .exe instead of using cmd.exe wrapper
    let exePath: string | null = null;
    try {
      const npmPrefix = execSync('npm prefix -g', { encoding: 'utf8', timeout: 10_000, windowsHide: true }).trim();
      const candidateExe = path.join(npmPrefix, 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe');
      if (fs.existsSync(candidateExe)) {
        exePath = candidateExe;
      }
    } catch (err) {
      console.log(`[${id}] Failed to resolve claude.exe path for reply:`, err);
    }

    if (!exePath) {
      throw new Error('claude.exe not found. Please install @anthropic-ai/claude-code globally: npm install -g @anthropic-ai/claude-code');
    }

    console.log(`[${id}] Windows reply spawn: ${exePath} --resume ${session.claudeSessionId || '(new)'}`);
    replyProc = spawn(exePath, resumeArgs, {
      cwd: executionRoot,
      env: cleanChildEnv(id),
      stdio: 'pipe',
      windowsHide: true,
    });
  } else {
    replyProc = spawn(binaryName, resumeArgs, {
      cwd: executionRoot,
      env: cleanChildEnv(id),
      stdio: 'pipe',
      windowsHide: true,
    });
  }
  session.proc = replyProc as ChildProcessWithoutNullStreams;
  session.pid = replyProc.pid;

  const commitReplyPending = attachStdoutProcessing(replyProc, session, id);

  replyProc.stderr!.on('data', (chunk) => {
    appendSessionOutput(session, chunk, 'stderr', false);
  });

  replyProc.on('error', async (error) => {
    session.status = 'waiting-input';
    commitReplyPending();
    flushSessionOutput(session, true);
    // FLUX-849: a crashed resumed turn (reply spawn error) was previously invisible on the board —
    // the only tee on this path was the Require-Input pause. Bracket it with a 'failed' marker so a
    // board-watcher sees the crash even though the session itself stays resumable.
    teeDispatchActivityToBoard(session, id, 'failed', DISPATCH_LIFECYCLE_LABEL['failed']);
    await updateTaskWithHistory(id, {
      updatedBy: 'Agent',
      entries: [buildActivityEntry(`${session.label} reply failed: ${error.message}`, 'Agent', new Date().toISOString())],
    });
    console.error(`[${id}] Failed to spawn ${binaryName} for reply:`, error.message);
  });

  replyProc.on('exit', async (code, signal) => {
    commitReplyPending();
    flushSessionOutput(session, true);
    session.status = 'waiting-input';
    // FLUX-651: resumed chat turn ended — flag if the agent parked without acting. Skip when
    // it paused itself for Require Input (that IS an action and keeps the session resumable).
    if (!session.pausedForInput) await flagIfParked(session, id);
    // FLUX-849: bracket the dispatched session's board narration on this resumed path.
    // - Require-Input pause → 'needs input'.
    // - User-requested stop → 'stopped'.
    // - Non-zero/signalled crash → 'failed' (previously silent — the only resumed-path tee was the
    //   pause, so a crashed resumed turn left no board signal at all).
    // A clean turn-end (code 0) already narrated via the 'working' tee and stays resumable, so it
    // gets no terminal marker here (a finish that moves the ticket surfaces via the status path).
    if (session.pausedForInput) {
      teeDispatchActivityToBoard(session, id, 'waiting-input', DISPATCH_LIFECYCLE_LABEL['waiting-input']);
    } else if (session.requestedStop) {
      teeDispatchActivityToBoard(session, id, 'cancelled', DISPATCH_LIFECYCLE_LABEL['cancelled']);
    } else if (code !== 0 || signal) {
      teeDispatchActivityToBoard(session, id, 'failed', DISPATCH_LIFECYCLE_LABEL['failed']);
    }
    broadcastEvent('taskUpdated', { id });
  });
}

// ===========================================================================
// FLUX-604: board-level orchestrator session — a persistent chat for the whole
// board, NOT bound to any ticket. Isolated from the per-ticket path on purpose
// (no regression risk). It deliberately has NO sessionHistoryEntry, so every
// ticket-history write in the per-ticket lifecycle (all guarded by
// `if (session.sessionHistoryEntry)`) is naturally skipped — the durable record
// is the transcript (<fluxDir>/transcripts/__board__.jsonl) via attachStdoutProcessing.
// ===========================================================================

export const BOARD_CONVERSATION_ID = '__board__';

function spawnClaudeForBoard(claudeArgs: string[], executionRoot: string): ReturnType<typeof spawn> {
  if (process.platform === 'win32') {
    let exePath: string | null = null;
    try {
      const npmPrefix = execSync('npm prefix -g', { encoding: 'utf8', timeout: 10_000, windowsHide: true }).trim();
      const candidateExe = path.join(npmPrefix, 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe');
      if (fs.existsSync(candidateExe)) exePath = candidateExe;
    } catch (err) {
      console.log('[board] Failed to resolve claude.exe path:', err);
    }
    if (!exePath) {
      throw new Error('claude.exe not found. Please install @anthropic-ai/claude-code globally: npm install -g @anthropic-ai/claude-code');
    }
    return spawn(exePath, claudeArgs, { cwd: executionRoot, env: cleanChildEnv(BOARD_CONVERSATION_ID), stdio: 'pipe', windowsHide: true });
  }
  return spawn('claude', claudeArgs, { cwd: executionRoot, env: cleanChildEnv(BOARD_CONVERSATION_ID), stdio: 'pipe', windowsHide: true });
}

function buildBoardPrompt(firstMessage: string, priorContext?: string): string {
  const key = configCache.projects?.[0] || 'PROJECT';
  const digest = buildBoardDigest();
  return [
    'You are the Event Horizon board orchestrator — a persistent chat for the whole board, not tied to any single ticket. You are powerful: you have the full "event-horizon" MCP toolset (list/get/create/update tickets, change_status, branches, comments, …) plus file reading, editing, bash, and subagents. Use whatever the task genuinely calls for.',
    '',
    'Match the weight of your response to the weight of the request. For a greeting or a simple question, just reply in a sentence or two — don\'t go investigate. When a task actually needs depth — reasoning across the board, doing real work on a ticket, parallel research — bring your full toolkit to bear, including subagents. Quick for quick, thorough for thorough: don\'t gather context you don\'t need, and don\'t skimp on work that does.',
    'For board and ticket actions, prefer the event-horizon MCP tools over editing ticket files by hand.',
    'When the user asks to GROOM, IMPLEMENT, REVIEW, or FINALIZE a specific ticket, DISPATCH it rather than doing that ticket\'s work here: call start_session(ticketId, phase) to launch the phase session on that ticket (it runs in the ticket\'s own scope and returns immediately), then tell the user to open that ticket\'s chat to drive it.',
    'Propose and CONFIRM before anything destructive or irreversible (status changes, deletions). Don\'t silently restructure the board.',
    'BOARD-REBASE RITUAL: when asked to triage, "rebase the board", or at the end of a session, do NOT mutate the board directly — call propose_board_rebase with a BATCH of items so the user approves/rejects them in one pass. Each item is { kind, targets, summary, rationale }, kind ∈ promote (extract a chat/turns into a new card) · fold (merge a stream into another) · archive (retire) · dispatch (start a phase session) · status (move a ticket) · leave (keep it in this thread). The restructuring verbs (extract_ticket, merge_tickets, archive_ticket) and change_status are GATED — reorganize the board through proposals, not direct calls. When unsure about an item, propose it as "leave" (it stays in this durable thread) — never drop it.',
    'To ask the user a structured question, call the ask_user_question tool — it shows an interactive picker in this chat and returns their choice so you continue the same turn. Never assume when a quick question would resolve ambiguity; ask.',
    `When you reference a ticket in prose, always write its full id (e.g. \`${key}-123\`) — every single time, including repeat mentions, shorthand lists, and x/y comparisons. Never abbreviate to a bare number (a bare \`123\` cannot render as a chip). The full id renders as an interactive chip; on first mention spell out the title too — \`${key}-123 (short title)\` — to keep the message readable before the reader hovers.`,
    'You run at the workspace root, with the whole board in scope.',
    '',
    // FLUX-838: cold-resume re-prime — recovered prior dialogue (+ working-tree preamble) after an
    // engine restart wiped the in-memory session. Ordered before the live digest, mirroring the
    // warm-resume path in sendBoardInput (preamble first, then digest, then the message).
    ...(priorContext ? [priorContext, ''] : []),
    ...(digest ? [digest, ''] : []),
    firstMessage,
  ].join('\n');
}

function boardMcpArgs(): string[] {
  return buildSpawnMcpConfigArgs(undefined, undefined);
}

function wireBoardProc(proc: ReturnType<typeof spawn>, session: CliSessionRecord, onExitStatus: () => void) {
  session.proc = proc as ChildProcessWithoutNullStreams;
  session.pid = proc.pid;
  const commitPending = attachStdoutProcessing(proc, session, BOARD_CONVERSATION_ID);
  proc.stderr!.on('data', (chunk) => appendSessionOutput(session, chunk, 'stderr', false));
  proc.on('error', (error) => {
    session.status = 'failed';
    session.endedAt = new Date().toISOString();
    commitPending();
    flushSessionOutput(session, true);
    console.error('[board] spawn error:', error.message);
  });
  proc.on('exit', (code) => {
    commitPending();
    flushSessionOutput(session, true);
    // Only a CLEAN turn becomes the resumable parked state (waiting-input). A turn that the
    // user stopped, that exited non-zero, or that died before `claude` emitted its init message
    // (so we never captured a claudeSessionId) must end TERMINAL — otherwise it sits at
    // waiting-input forever: unresumable (no session id) yet "active" enough to 409 every new
    // start, permanently wedging the orchestrator (FLUX-667).
    if (session.requestedStop) {
      session.status = 'cancelled';
      session.endedAt = new Date().toISOString();
    } else if (code !== 0 || !session.claudeSessionId) {
      session.status = 'failed';
      session.endedAt = new Date().toISOString();
    } else {
      onExitStatus();
      // FLUX-810: a clean board turn === the orchestrator answered the user. This is the only
      // self-noise-free hook (stopped/non-zero/crashed turns are handled above), so emit the
      // "Orchestrator replied" notification-bar entry here and nowhere else.
      generateOrchestratorReplyNotification();
    }
    broadcastEvent('taskUpdated', { id: BOARD_CONVERSATION_ID });
  });
}

export async function startBoardSession(session: CliSessionRecord, firstMessage: string, workspaceRoot: string, opts?: SendInputOptions) {
  checkBinaryInstalled('claude');
  session.executionRoot = workspaceRoot;
  // FLUX-838: cold-resume re-prime. The CLI session store is in-memory only, so an engine
  // restart leaves an empty store and this start path runs with no `--resume`. Recover the
  // orchestrator's memory from the durable `__board__.jsonl` transcript: a bounded verbatim
  // tail of the prior dialogue, plus the working-tree situational update. Computed BEFORE this
  // turn's `user` event is appended (below) so the just-sent message can't leak into the
  // "prior" digest. A fresh / post-reset board (FLUX-659) yields null → no re-prime block.
  const reprime = await buildBoardReprime();
  let resumePreamble: string | null = null;
  if (reprime) {
    // sinceIso from the last prior transcript turn's ts — the in-memory lastOutputAt is gone
    // after restart. Board scope has no branch → preamble degrades to ticket-movement only.
    resumePreamble = await buildResumePreamble({
      workspaceRoot: canonicalWorkspaceRoot ?? workspaceRoot,
      sinceIso: reprime.sinceIso,
    });
  }
  const priorContext = [resumePreamble, reprime?.digest].filter(Boolean).join('\n\n---\n\n') || undefined;
  // FLUX-676: pasted-image attachments on the opening orchestrator turn. Reference their
  // absolute sidecar paths in the spawn prompt (the agent Reads them); keep the clean refs
  // for the transcript so the bubble re-renders the thumbnail on reload / cold resume.
  const attachments = opts?.attachments ?? [];
  const attachmentAbsPaths = resolveAttachmentAbsPaths(attachments);
  const claudeArgs = [
    '-p', `${buildBoardPrompt(firstMessage, priorContext)}${attachmentReadInstruction(attachmentAbsPaths)}`,
    '--output-format', 'stream-json',
    '--verbose',
    // FLUX-691: token-by-token live streaming for the board orchestrator chat too.
    '--include-partial-messages',
    // medium by default; the chat picker (FLUX-604) overrides via session.model/effortOverride.
    ...modelEffortArgs(session, 'medium'),
    ...DISALLOW_NATIVE_ASK,
    ...permissionArgs(session),
    ...boardMcpArgs(),
  ];
  session.status = 'running';
  session.args = claudeArgs;
  // FLUX-838: persist the working-tree preamble as a context-update note (mirrors the warm-resume
  // path in sendBoardInput), ordered ahead of this turn's user event so it renders before the
  // bubble. The re-prime dialogue digest is NOT appended — it is recovered from the transcript,
  // and re-appending it would compound across successive restarts (criterion 6).
  if (resumePreamble) {
    appendTranscriptEvent(BOARD_CONVERSATION_ID, { type: 'resume-preamble', text: resumePreamble, timestamp: session.startedAt });
  }
  // First turn: record the user message in the transcript (mirrors the per-ticket chat /start).
  appendTranscriptEvent(BOARD_CONVERSATION_ID, { type: 'user', text: firstMessage, attachments, timestamp: session.startedAt });
  const proc = spawnClaudeForBoard(claudeArgs, workspaceRoot);
  // Persistent conversation: a finished turn stays RESUMABLE (waiting-input), never
  // terminal. If it ended 'completed', the next message would spawn a fresh session
  // with no memory of this one (it wouldn't know about a ticket it just created).
  wireBoardProc(proc, session, () => { session.status = 'waiting-input'; });
}

export async function sendBoardInput(session: CliSessionRecord, message: string, workspaceRoot: string, opts?: SendInputOptions) {
  checkBinaryInstalled('claude');
  const inputAt = new Date().toISOString();
  // FLUX-655: capture the "since you last spoke" basis BEFORE overwriting lastInputAt (see the
  // per-ticket path). Board scope has no branch, so the preamble degrades to ticket-movement only.
  const sinceIso = session.lastOutputAt ?? session.lastInputAt;
  session.lastInputAt = inputAt;
  session.status = 'running';
  session.pausedForInput = false;
  // FLUX-676: pasted-image attachments for this turn. Resolve to absolute sidecar paths the
  // agent can Read; keep the metadata on the transcript turn so the bubble re-renders.
  const attachments = opts?.attachments ?? [];
  const attachmentAbsPaths = resolveAttachmentAbsPaths(attachments);
  // FLUX-655: on a RESUMED board turn, build the situational update (ticket-movement only at board
  // scope). Computed BEFORE the user event is recorded so the `resume-preamble` transcript event is
  // ordered ahead of the `user` event for this turn (FLUX-716 item 3). Best-effort: a null assemble
  // (no delta / git hiccup) is a no-op.
  let resumePreamble: string | null = null;
  if (session.claudeSessionId) {
    resumePreamble = await buildResumePreamble({
      workspaceRoot: canonicalWorkspaceRoot ?? workspaceRoot,
      sinceIso,
    });
    if (resumePreamble) {
      appendTranscriptEvent(BOARD_CONVERSATION_ID, { type: 'resume-preamble', text: resumePreamble, timestamp: inputAt });
    }
  }
  appendTranscriptEvent(BOARD_CONVERSATION_ID, { type: 'user', text: message, attachments, timestamp: inputAt });
  // Effective prompt to the CLI = the user's text + a Read-the-image instruction (FLUX-676).
  const safeMessage = `${message.replace(/\0/g, '')}${attachmentReadInstruction(attachmentAbsPaths)}`;
  // Prepend the fresh triage digest to the prompt sent to claude — NOT to the transcript above,
  // which keeps the user's verbatim message (FLUX-659 push half).
  const digest = buildBoardDigest();
  let promptForCli = digest ? `${digest}\n\n${safeMessage}` : safeMessage;
  // FLUX-655: prepend the situational update (computed above) — same contract as the per-ticket chat.
  if (resumePreamble) {
    promptForCli = `${resumePreamble}\n\n---\n\n${promptForCli}`;
  }
  const meArgs = modelEffortArgs(session, 'medium');
  // FLUX-691: `--include-partial-messages` → token-by-token live streaming on the board send path.
  const claudeArgs = session.claudeSessionId
    ? ['-p', promptForCli, '--resume', session.claudeSessionId, '--output-format', 'stream-json', '--verbose', '--include-partial-messages', ...meArgs, ...DISALLOW_NATIVE_ASK, ...permissionArgs(session), ...boardMcpArgs()]
    : ['-p', promptForCli, '--output-format', 'stream-json', '--verbose', '--include-partial-messages', ...meArgs, ...DISALLOW_NATIVE_ASK, ...permissionArgs(session), ...boardMcpArgs()];
  session.args = claudeArgs;
  const proc = spawnClaudeForBoard(claudeArgs, session.executionRoot ?? workspaceRoot);
  wireBoardProc(proc, session, () => { session.status = 'waiting-input'; });
}
