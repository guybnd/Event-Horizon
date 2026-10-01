// FLUX-959: the Copilot `BoardSpec` runs unattended with `--yolo` while explicit denials retain
// Event Horizon's chat edit gate.
// MCP config is EXPLICIT (FLUX-984): `buildCopilotPromptArgs()` injects the bound event-horizon
// server directly via `--additional-mcp-config`. See FLUX-959 risk notes: turn-1
// `resumeSessionId` capture still needed live verification (separately confirmed working, FLUX-977).
import { attachStdoutProcessing, spawnCopilot, buildCopilotPromptArgs, checkCopilotBinaryInstalled } from './copilot.js';
import { EFFORT_LEVELS } from './shared.js';
import { CLI_CAPABILITIES } from './types.js';
import { BOARD_CONVERSATION_ID, type BoardSpec } from './board.js';
import { makeBoardAdapter } from './board-core.js';

export const copilotBoardSpec: BoardSpec = {
  framework: 'copilot',
  binary: 'copilot',
  checkBinary: () => checkCopilotBinaryInstalled(BOARD_CONVERSATION_ID),
  buildArgs({ session, workspaceRoot, isResume, attachmentAbsPaths }) {
    const model = !isResume ? session.model : undefined;
    const resumeSessionId = isResume ? session.resumeSessionId : undefined;
    const args = buildCopilotPromptArgs({
      conversationId: session.taskId,
      workspaceRoot,
      ...(model ? { model } : {}),
      ...(resumeSessionId ? { resumeSessionId } : {}),
      skipPermissions: true,
      attachmentAbsPaths,
    });
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
