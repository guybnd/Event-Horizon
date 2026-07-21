// FLUX-904 / FLUX-959: the Claude `BoardSpec` — the only per-CLI plug-in points are the arg
// list, spawn, stdout parsing, and MCP-server priming. Everything else (prompt assembly, resume
// re-prime, transcript events, exit-state machine) lives in the generic core (board-core.ts).
import { spawn } from 'child_process';
import { cleanChildEnv, resolveClaudeExePath } from './shared.js';
import { resolveClaudeBinaryPathDarwin } from './claude-binary-darwin.js';
import { attachStdoutProcessing, buildSpawnMcpConfigArgs, modelEffortArgs, permissionArgs, ensureSharedServersForRoot, DISALLOW_NATIVE_ASK } from './claude-code.js';
import type { BoardSpec } from './board.js';
import { makeBoardAdapter } from './board-core.js';

// FLUX-1209: `conversationId` is BOARD_CONVERSATION_ID or FURNACE_CONVERSATION_ID (whichever
// virtual conversation this turn belongs to) — passed through from board-core.ts instead of a
// hardcoded board literal, so cleanChildEnv() tags the child env for the right conversation.
async function spawnClaudeForBoard(claudeArgs: string[], executionRoot: string, conversationId: string): Promise<ReturnType<typeof spawn>> {
  if (process.platform === 'win32') {
    // FLUX-975: resolveClaudeExePath caches the result across every spawn (this board path
    // included) instead of re-running `npm prefix -g` on each one. FLUX-1003: now async (no
    // longer blocks the event loop on a cache miss).
    const exePath = await resolveClaudeExePath();
    if (!exePath) {
      throw new Error('claude.exe not found. Please install @anthropic-ai/claude-code globally: npm install -g @anthropic-ai/claude-code');
    }
    return spawn(exePath, claudeArgs, { cwd: executionRoot, env: cleanChildEnv('claude', conversationId), stdio: 'pipe', windowsHide: true });
  }
  if (process.platform === 'darwin') {
    // FLUX-1600: same login-shell binary resolution as the per-ticket spawn paths in
    // claude-code.ts, cached across every board spawn/resume too. Falls back to the bare PATH
    // spawn below when the probe fails/times out or finds no login-shell override.
    const darwinExePath = await resolveClaudeBinaryPathDarwin('claude');
    return spawn(darwinExePath ?? 'claude', claudeArgs, { cwd: executionRoot, env: cleanChildEnv('claude', conversationId), stdio: 'pipe', windowsHide: true });
  }
  return spawn('claude', claudeArgs, { cwd: executionRoot, env: cleanChildEnv('claude', conversationId), stdio: 'pipe', windowsHide: true });
}

// FLUX-1580: `conversationId` is the turn's ACTUAL virtual conversation id (`session.taskId` —
// `__board__` or `__furnace__`), not a hardcoded board literal — previously this always bound to
// BOARD_CONVERSATION_ID regardless of which conversation was spawning, so a Furnace-chat child's
// own event-horizon MCP tool calls silently routed under the `__board__` identity. `workspaceRoot`
// is now also threaded through as `x-eh-workspace` (previously omitted entirely — the child had no
// workspace binding on its own tool calls at all).
function boardMcpArgs(conversationId: string, workspaceRoot: string): string[] {
  // FLUX-579: the board runs at the workspace root, so its shared server is keyed there.
  // FLUX-1213/FLUX-1580: bind the board/Furnace child's own event-horizon HTTP headers to its own
  // conversationId + workspaceRoot so it routes by binding, not by coincidentally matching the
  // unrouted fallback (or, pre-fix, the wrong conversation entirely).
  return buildSpawnMcpConfigArgs(undefined, undefined, workspaceRoot, conversationId, workspaceRoot);
}

export const claudeBoardSpec: BoardSpec = {
  framework: 'claude',
  binary: 'claude',
  buildArgs({ session, workspaceRoot, isResume }) {
    const meArgs = modelEffortArgs(session, 'medium');
    const resumeArgs = isResume && session.resumeSessionId ? ['--resume', session.resumeSessionId] : [];
    // FLUX-1496: `-p` is a bare flag — the prompt is written to stdin by wireBoardProc after spawn
    // (board-core.ts), mirroring the FLUX-1444 per-ticket fix (claude-code.ts:1128).
    return [
      '-p',
      ...resumeArgs,
      '--output-format', 'stream-json',
      '--verbose',
      // FLUX-691: token-by-token live streaming for the board orchestrator chat too.
      '--include-partial-messages',
      // medium by default; the chat picker (FLUX-604) overrides via session.model/effortOverride.
      ...meArgs,
      ...DISALLOW_NATIVE_ASK,
      ...permissionArgs(session),
      ...boardMcpArgs(session.taskId, workspaceRoot),
    ];
  },
  spawn: spawnClaudeForBoard,
  attachStdout: attachStdoutProcessing,
  ensureMcp: ensureSharedServersForRoot,
};

export const claudeBoardAdapter = makeBoardAdapter(claudeBoardSpec);
