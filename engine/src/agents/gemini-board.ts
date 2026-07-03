// FLUX-959: the Gemini `BoardSpec`. Degrades relative to Claude — no `--include-partial-messages`,
// no `--effort` (Gemini's per-ticket adapter never sets it either), no `--disallowed-tools` /
// permission flag (board always runs `--yolo --skip-trust`), no explicit MCP config (Gemini reads
// the workspace `.mcp.json` in `-p` mode). See FLUX-959 risk notes: MCP-without-config and turn-1
// `resumeSessionId` capture (from `evt.session_id`) need live verification.
import { attachStdoutProcessing, spawnGemini } from './gemini.js';
import { BOARD_CONVERSATION_ID, type BoardSpec } from './board.js';
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
  spawn: (args, executionRoot) => spawnGemini(args, executionRoot, BOARD_CONVERSATION_ID),
  attachStdout: attachStdoutProcessing,
};

export const geminiBoardAdapter = makeBoardAdapter(geminiBoardSpec);
