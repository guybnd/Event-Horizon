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
import { BOARD_CONVERSATION_ID, type BoardSpec } from './board.js';
import { makeBoardAdapter } from './board-core.js';

export const copilotBoardSpec: BoardSpec = {
  framework: 'copilot',
  binary: 'copilot',
  buildArgs({ session, prompt, isResume }) {
    const resumeArgs = isResume && session.resumeSessionId ? ['--resume', session.resumeSessionId] : [];
    const args = [
      // Copilot has no `--resume`-time model re-specification in the per-ticket adapter either —
      // mirror that: only set --model on a fresh turn.
      ...(!isResume && session.model ? ['--model', session.model] : []),
      '-p', prompt,
      ...resumeArgs,
      '--output-format', 'json',
      '--yolo',
      // FLUX-984: explicit MCP config injection — workspace .mcp.json is never auto-loaded in -p mode.
      ...buildAdditionalMcpConfigArgs(),
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
  spawn: (args, executionRoot) => spawnCopilot(BOARD_CONVERSATION_ID, args, executionRoot),
  attachStdout: attachStdoutProcessing,
};

export const copilotBoardAdapter = makeBoardAdapter(copilotBoardSpec);
