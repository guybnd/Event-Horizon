// FLUX-1722: Grok Build BoardSpec. Board chat is full-trust (no ticket-status edit gate).
// `--always-approve` + `--trust` (undocumented as of 1.0.13) match the per-ticket spawn.
// MCP config comes from EH-owned GROK_HOME (see grok.ts ensureGrokHome), not a per-invocation flag.
//
// Board-core always writes the prompt to stdin (FLUX-1496). Grok's documented large-prompt path is
// `--prompt-file`, so buildArgs writes ctx.prompt there. Stdin is still closed by wireBoardProc
// (empty extra input); --prompt-file is the authoritative prompt.
import { attachStdoutProcessing, spawnGrok, buildGrokArgs, grokSessionUuid, writePromptFile, resolveGrokBinary, grokUserBinaryPath } from './grok.js';
import type { BoardSpec } from './board.js';
import { makeBoardAdapter } from './board-core.js';
import * as fs from 'fs';

export const grokBoardSpec: BoardSpec = {
  framework: 'grok',
  binary: 'grok',
  async checkBinary() {
    const resolved = resolveGrokBinary();
    if (resolved === 'grok' && !fs.existsSync(grokUserBinaryPath())) {
      throw new Error('Grok Build CLI not found. Install from https://docs.x.ai and ensure ~/.grok/bin/grok.exe exists.');
    }
  },
  buildArgs({ session, prompt, workspaceRoot, isResume }) {
    const sessionId = grokSessionUuid(session);
    session.resumeSessionId = sessionId;
    const promptFile = writePromptFile(prompt);
    return buildGrokArgs({
      isResume,
      sessionId,
      executionRoot: workspaceRoot,
      promptFile,
      model: session.model,
    });
  },
  spawn: (args, executionRoot, conversationId) => spawnGrok(conversationId, args, executionRoot, conversationId, undefined, executionRoot),
  attachStdout: attachStdoutProcessing,
};

export const grokBoardAdapter = makeBoardAdapter(grokBoardSpec);
