// FLUX-1738: the Antigravity `BoardSpec`. Deliberately NOT a copy of geminiBoardSpec — `agy` shares
// none of Gemini CLI's flags (`--yolo`, `--resume`, `--screen-reader`, `--skip-trust` do not exist).
//
// Relative to Claude's board spec it degrades the same way Gemini's does: no `--disallowed-tools` /
// permission flag (toolGating:false — `agy --help` exposes no allow/deny surface at all, so the
// board always runs `--dangerously-skip-permissions`), and no explicit spawn-time MCP config
// (spawnTimeMcpConfig:false — MCP is file-based and managed via `agy mcp add`, so there is nothing
// to inject per invocation). Unlike Gemini's spec it DOES stream real partial deltas
// (`text_delta` on an ACTIVE `agent_response` step), so board narration arrives incrementally.
//
// The turn-1 resume-id capture that FLUX-959 flagged as unverified for Gemini is verified here:
// `init.conversation_id` fed back as `--conversation <id>` answered a question only the prior turn
// could answer (see the FLUX-1738 pinned probe note).
import { attachStdoutProcessing, spawnAntigravity } from './antigravity.js';
import type { BoardSpec } from './board.js';
import { makeBoardAdapter } from './board-core.js';

export const antigravityBoardSpec: BoardSpec = {
  framework: 'antigravity',
  binary: 'agy',
  buildArgs({ session, isResume }) {
    // Prompt-over-stdin: board-core.ts's wireBoardProc writes the real prompt after spawn.
    // `agy` reads non-TTY stdin directly when `--output-format stream-json` is provided without `-p`
    // (FLUX-1751; passing `-p ''` triggers `Error: empty prompt`).
    return [
      // Match the per-ticket adapter and geminiBoardSpec: `--model` on a fresh turn only.
      ...(!isResume && session.model ? ['--model', session.model] : []),
      '--output-format', 'stream-json',
      // Without this the default 5-minute `--print-timeout` would kill every non-trivial board
      // turn. See the PRINT_TIMEOUT note in antigravity.ts.
      '--print-timeout', '24h',
      '--dangerously-skip-permissions',
      ...(isResume && session.resumeSessionId ? ['--conversation', session.resumeSessionId] : []),
    ];
  },
  // FLUX-1209: pass through the conversation id board-core.ts resolved (board or Furnace chat)
  // rather than a hardcoded board sentinel.
  spawn: (args, executionRoot, conversationId) => spawnAntigravity(args, executionRoot, conversationId),
  attachStdout: attachStdoutProcessing,
};

export const antigravityBoardAdapter = makeBoardAdapter(antigravityBoardSpec);
