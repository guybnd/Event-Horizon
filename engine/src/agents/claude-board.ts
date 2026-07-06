// FLUX-904 / FLUX-959: the Claude `BoardSpec` — the only per-CLI plug-in points are the arg
// list, spawn, stdout parsing, and MCP-server priming. Everything else (prompt assembly, resume
// re-prime, transcript events, exit-state machine) lives in the generic core (board-core.ts).
import { spawn } from 'child_process';
import { cleanChildEnv, resolveClaudeExePath } from './shared.js';
import { attachStdoutProcessing, buildSpawnMcpConfigArgs, modelEffortArgs, permissionArgs, ensureSharedServersForRoot, DISALLOW_NATIVE_ASK } from './claude-code.js';
import { BOARD_CONVERSATION_ID, type BoardSpec } from './board.js';
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
  return spawn('claude', claudeArgs, { cwd: executionRoot, env: cleanChildEnv('claude', conversationId), stdio: 'pipe', windowsHide: true });
}

function boardMcpArgs(projectPath?: string): string[] {
  // FLUX-579: the board runs at the workspace root, so its shared server is keyed
  // there. Pass the root explicitly (falls back to canonicalWorkspaceRoot in
  // buildModuleServerMap when omitted). FLUX-1213: bind the board's own event-horizon
  // HTTP headers to BOARD_CONVERSATION_ID so it routes to __board__ by binding, not by
  // coincidentally matching the unrouted fallback.
  return buildSpawnMcpConfigArgs(undefined, undefined, projectPath, BOARD_CONVERSATION_ID);
}

export const claudeBoardSpec: BoardSpec = {
  framework: 'claude',
  binary: 'claude',
  buildArgs({ session, prompt, workspaceRoot, isResume }) {
    const meArgs = modelEffortArgs(session, 'medium');
    const resumeArgs = isResume && session.resumeSessionId ? ['--resume', session.resumeSessionId] : [];
    return [
      '-p', prompt,
      ...resumeArgs,
      '--output-format', 'stream-json',
      '--verbose',
      // FLUX-691: token-by-token live streaming for the board orchestrator chat too.
      '--include-partial-messages',
      // medium by default; the chat picker (FLUX-604) overrides via session.model/effortOverride.
      ...meArgs,
      ...DISALLOW_NATIVE_ASK,
      ...permissionArgs(session),
      ...boardMcpArgs(workspaceRoot),
    ];
  },
  spawn: spawnClaudeForBoard,
  attachStdout: attachStdoutProcessing,
  ensureMcp: ensureSharedServersForRoot,
};

export const claudeBoardAdapter = makeBoardAdapter(claudeBoardSpec);
