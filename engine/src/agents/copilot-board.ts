// FLUX-959: the Copilot `BoardSpec`. Degrades relative to Claude — no `--include-partial-messages`
// (no token-by-token deltas) and no `--disallowed-tools` / `--permission-prompt-tool` (Copilot has
// no permission-gating flag, so the board always runs `--yolo`). MCP config is now EXPLICIT
// (FLUX-984): workspace `.mcp.json` is never auto-loaded by Copilot in non-interactive `-p` mode —
// confirmed live, no permission flag changes it — so `buildAdditionalMcpConfigArgs()` injects the
// event-horizon server directly via `--additional-mcp-config`. See FLUX-959 risk notes: turn-1
// `resumeSessionId` capture still needed live verification (separately confirmed working, FLUX-977).
import { attachStdoutProcessing, spawnCopilot, buildAdditionalMcpConfigArgs } from './copilot.js';
import { EFFORT_LEVELS } from './shared.js';
import { CLI_CAPABILITIES } from './types.js';
import type { BoardSpec } from './board.js';
import { makeBoardAdapter } from './board-core.js';

export const copilotBoardSpec: BoardSpec = {
  framework: 'copilot',
  binary: 'copilot',
  buildArgs({ session, workspaceRoot, isResume }) {
    const resumeArgs = isResume && session.resumeSessionId ? ['--resume', session.resumeSessionId] : [];
    // FLUX-1496: `-p` is a bare flag — the prompt is written to stdin by wireBoardProc after spawn
    // (board-core.ts), mirroring the FLUX-1444 per-ticket fix (copilot.ts:467).
    const args = [
      // Copilot has no `--resume`-time model re-specification in the per-ticket adapter either —
      // mirror that: only set --model on a fresh turn.
      ...(!isResume && session.model ? ['--model', session.model] : []),
      '-p',
      ...resumeArgs,
      '--output-format', 'json',
      '--yolo',
      // FLUX-984: explicit MCP config injection — workspace .mcp.json is never auto-loaded in -p mode.
      // FLUX-1213/FLUX-1580: bind to the turn's ACTUAL conversation id (`__board__` or
      // `__furnace__`) + workspaceRoot, not a hardcoded board literal — previously every Furnace
      // child's own HITL prompts / MCP tool calls silently routed as `__board__`.
      ...buildAdditionalMcpConfigArgs(session.taskId, workspaceRoot),
    ];
    // FLUX-977: Copilot CLI rejects --effort outright when no explicit --model is passed in the
    // SAME invocation (its default "auto" model doesn't support it — confirmed against the live
    // CLI). Mirror the exact same condition --model is gated on above (!isResume && session.model),
    // not just "is a model configured somewhere" — a resumed turn never sends --model regardless
    // of session.model, so --effort must be excluded there too or every resumed board turn with an
    // effort override set would crash the same way the per-ticket path did.
    const effortCap = CLI_CAPABILITIES.copilot.effort;
    if (effortCap.supported && effortCap.flag && !isResume && session.model && session.effortOverride && (EFFORT_LEVELS as readonly string[]).includes(session.effortOverride)) {
      args.push(effortCap.flag, session.effortOverride);
    }
    return args;
  },
  // FLUX-1209: pass through the conversation id board-core.ts resolved (board or Furnace chat)
  // instead of the hardcoded board sentinel.
  spawn: (args, executionRoot, conversationId) => spawnCopilot(conversationId, args, executionRoot),
  attachStdout: attachStdoutProcessing,
};

export const copilotBoardAdapter = makeBoardAdapter(copilotBoardSpec);
