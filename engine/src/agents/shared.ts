// Shared per-adapter helpers (FLUX-900, audit A.3/A.4/A.6/A.7).
//
// These were duplicated across claude-code.ts / copilot.ts / gemini.ts when the
// Copilot and Gemini adapters were forked off the original Claude-only adapter.
// The transport-side behaviour (write into the same `session` record, emit SSE,
// clean the spawn env, probe the binary) is identical across frameworks; only the
// per-CLI stdout *parsing* genuinely differs (that stays in each adapter — audit A.1).
import { execFileSync } from 'child_process';
import { broadcastEvent } from '../events.js';
import { workspaceRoot as canonicalWorkspaceRoot } from '../workspace.js';
import { signConversation } from '../session-binding.js';
import type { CliSessionRecord } from './types.js';

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
  if (conversationId) {
    env.EH_CONVERSATION_ID = conversationId;
    env.EH_CONVERSATION_TOKEN = signConversation(conversationId);
  }
  return env;
}

// ---- A.7 checkBinaryInstalled — pre-flight existence check for the CLI binary ----
export function checkBinaryInstalled(binaryName: string): void {
  const checker = process.platform === 'win32' ? 'where' : 'which';
  try {
    execFileSync(checker, [binaryName], { stdio: 'ignore', env: cleanChildEnv(), timeout: 10_000, windowsHide: true });
  } catch {
    throw new Error(`"${binaryName}" is not installed or not on PATH. Please install it before starting an agent session.`);
  }
}

// ---- A.3 serialized session-output writer chain ----
// `trackCumulative` preserves a per-adapter divergence the audit missed: Claude/Copilot
// accumulate assistant text into `session.cumulativeOutput` (the fallback source for the
// session's captured `output` when `outputData` is unset — session-store.ts), while the
// Gemini adapter never did, so a Gemini session's captured output is currently always ''.
// Default true keeps Claude/Copilot behavior; Gemini passes false to stay byte-identical.
// (The Gemini gap is a latent bug — fix it deliberately in the A.1 test-net follow-up.)
export function appendSessionOutput(session: CliSessionRecord, chunk: Buffer | string, source: 'stdout' | 'stderr', isAssistantText = false, trackCumulative = true) {
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
    if (trackCumulative) session.cumulativeOutput += text;
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
