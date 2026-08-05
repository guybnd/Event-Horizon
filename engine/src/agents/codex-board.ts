// FLUX-1625: the Codex `BoardSpec`, mirroring copilot-board.ts. The board orchestrator chat is
// always full-trust (no ticket status to gate edits against), so — unlike codex.ts's per-ticket
// spawn — there was never a read-only branch to consider here.
//
// FLUX-1631: sandbox mode alone (`-s workspace-write`) does NOT unblock mutating event-horizon MCP
// calls — codex still elicits a human approval for every MCP tool call, which non-interactive `exec`
// can never satisfy, so every `create_ticket`/`change_status`/`start_session` the orchestrator tried
// was auto-cancelled ("user cancelled MCP tool call", live-verified). This is the board's easiest
// case, not its hardest: the orchestrator's entire job is board mutation, so a sandboxed board
// session isn't degraded — it's dead. It also already runs unsandboxed in the main checkout
// (board-core.ts sets `executionRoot = workspaceRoot`), matching Copilot's `--yolo` / Gemini's
// `--yolo --skip-trust` posture — so hardlocking the bypass changes nothing about isolation here.
// `--dangerously-bypass-approvals-and-sandbox` is confirmed accepted directly on both `exec` and
// `exec resume` (live-verified, codex-cli 0.146.0). See codex.ts's `startCliSession` comment for the
// full rationale and the `request_permissions_tool` future-fix note.
import { attachStdoutProcessing, spawnCodex, buildCodexMcpConfigArgs } from './codex.js';
import type { BoardSpec } from './board.js';
import { makeBoardAdapter } from './board-core.js';

export const codexBoardSpec: BoardSpec = {
  framework: 'codex',
  binary: 'codex',
  buildArgs({ session, workspaceRoot, isResume }) {
    // FLUX-1625, re-verified live against codex-cli 0.146.0 (`codex exec resume --help`): `-s`/`-C`
    // are rejected on resume. `--model` IS accepted on resume (unlike copilot-board.ts's `!isResume`
    // gate, which exists for a Copilot-specific bug, not a codex one) — re-specify it on both paths.
    const args = isResume && session.resumeSessionId
      ? ['exec', 'resume', session.resumeSessionId, '--json', ...(session.model ? ['--model', session.model] : []), '--dangerously-bypass-approvals-and-sandbox']
      : [
          'exec',
          '--json',
          ...(session.model ? ['--model', session.model] : []),
          '--dangerously-bypass-approvals-and-sandbox',
        ];
    // FLUX-1625: per-spawn MCP override (no user-global config write) — carries the FLUX-1213
    // per-conversation header binding too (re-verified live; see buildCodexMcpConfigArgs).
    args.push(...buildCodexMcpConfigArgs(session.taskId, workspaceRoot));
    return args;
  },
  spawn: (args, executionRoot, conversationId) => spawnCodex(conversationId, args, executionRoot),
  attachStdout: attachStdoutProcessing,
};

export const codexBoardAdapter = makeBoardAdapter(codexBoardSpec);
