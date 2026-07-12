// FLUX-959: the Gemini `BoardSpec`. Degrades relative to Claude — no `--include-partial-messages`,
// no `--effort` (Gemini's per-ticket adapter never sets it either), no `--disallowed-tools` /
// permission flag (board always runs `--yolo --skip-trust`), no explicit MCP config (Gemini reads
// the workspace `.gemini/settings.json` in `-p` mode; since FLUX-1222 its event-horizon entry
// carries ${EH_CONVERSATION_ID}/${EH_CONVERSATION_TOKEN} header placeholders that this process
// resolves from the spawn env below, so HITL prompts route per-conversation). See FLUX-959 risk
// note: turn-1 `resumeSessionId` capture (from `evt.session_id`) needs live verification.
import { attachStdoutProcessing, spawnGemini } from './gemini.js';
import type { BoardSpec } from './board.js';
import { makeBoardAdapter } from './board-core.js';

export const geminiBoardSpec: BoardSpec = {
  framework: 'gemini',
  binary: 'gemini',
  buildArgs({ session, prompt, isResume }) {
    const resumeArgs = isResume && session.resumeSessionId ? ['--resume', session.resumeSessionId] : [];
    return [
      // Gemini's per-ticket adapter only sets --model on a fresh turn, never on resume — mirror that.
      ...(!isResume && session.model ? ['--model', session.model] : []),
      '-p', prompt,
      ...resumeArgs,
      '--output-format', 'stream-json',
      '--screen-reader',
      '--yolo',
      '--skip-trust',
    ];
  },
  // FLUX-1209: pass through the conversation id board-core.ts resolved (board or Furnace chat)
  // instead of the hardcoded board sentinel.
  spawn: (args, executionRoot, conversationId) => spawnGemini(args, executionRoot, conversationId),
  attachStdout: attachStdoutProcessing,
};

export const geminiBoardAdapter = makeBoardAdapter(geminiBoardSpec);
