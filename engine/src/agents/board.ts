// FLUX-904 (audit B.8 / C.1 / C.2 / C.4): the board-orchestrator seam.
//
// The `__board__` orchestrator is a persistent, board-scoped chat (the "global agent" the user
// talks to from the board, not bound to any ticket). Its contract is genuinely different from the
// per-ticket `AgentAdapter` — no ticket id, a persistent transcript, a different MCP toolset — so
// it gets its own `BoardAdapter` interface. The current Claude implementation lives in
// `claude-board.ts`; routes resolve it via `getBoardAdapter()` (agents/index.ts) instead of
// deep-importing the Claude adapter file. This file is the single home for the board sentinel id
// (previously re-declared as a local literal in claude-code.ts / board-reprime.ts / extract.ts /
// routes/tasks.ts) — import it from here. Kept dependency-free (types + const only) so any module
// can import the sentinel without risking an import cycle.
import { spawn } from 'child_process';
import type { CliFramework, CliSessionRecord, SendInputOptions } from './types.js';

/** Reserved sentinel stream id for the board orchestrator (not a real ticket). */
export const BOARD_CONVERSATION_ID = '__board__';

// FLUX-1209: reserved sentinel stream id for the Furnace Operator ("Smelter") chat — a
// persona-primed conversation launched from the Furnace drawer, not bound to any ticket. It
// shares the board-orchestrator's non-ticket-scoped machinery (board-core.ts, this file's
// BoardSpec plumbing) but is its own distinct conversation/transcript, never `__board__`'s.
export const FURNACE_CONVERSATION_ID = '__furnace__';

/** True for either reserved non-ticket-scoped conversation id (the board orchestrator or the
 *  Furnace Operator chat) — the shared guard every non-ticket-conversation route/helper widens
 *  on instead of a `=== BOARD_CONVERSATION_ID` literal. */
export function isVirtualConversationId(id: string): boolean {
  return id === BOARD_CONVERSATION_ID || id === FURNACE_CONVERSATION_ID;
}

export interface BoardAdapter {
  startBoardSession(session: CliSessionRecord, firstMessage: string, workspaceRoot: string, opts?: SendInputOptions): Promise<void>;
  sendBoardInput(session: CliSessionRecord, message: string, workspaceRoot: string, opts?: SendInputOptions): Promise<void>;
}

// FLUX-959: the per-CLI plug-in point for the generic board core (board-core.ts). All
// framework-agnostic prompt/transcript/digest/resume machinery lives in the core; a BoardSpec
// supplies only what genuinely differs per CLI — its arg list, how to spawn it, and how to
// parse its stdout. `makeBoardAdapter(spec)` (board-core.ts) closes over a spec to produce a
// full BoardAdapter.
export interface BoardSpawnContext {
  session: CliSessionRecord;
  /** Full prompt text to send this turn (already includes digest/preamble/attachment suffix). */
  prompt: string;
  workspaceRoot: string;
  executionRoot: string;
  isResume: boolean;
}

export interface BoardSpec {
  readonly framework: CliFramework;
  /** Binary name tag for checkBinaryInstalled() and cleanChildEnv()'s EVENT_HORIZON_FRAMEWORK. */
  readonly binary: string;
  buildArgs(ctx: BoardSpawnContext): string[] | Promise<string[]>;
  // FLUX-1003: Claude/Gemini resolve a cached binary path before spawning (async); Copilot spawns
  // directly (sync). board-core.ts awaits either — `await` on a non-Promise resolves immediately.
  // FLUX-1209: the conversation id (BOARD_CONVERSATION_ID or FURNACE_CONVERSATION_ID) this turn
  // belongs to — spawn implementations pass it to cleanChildEnv()/spawnGemini()/spawnCopilot()
  // instead of a hardcoded board literal, so a Furnace-chat turn tags its own child env/session.
  spawn(args: string[], executionRoot: string, conversationId: string): ReturnType<typeof spawn> | Promise<ReturnType<typeof spawn>>;
  /** Wire stdout parsing for this CLI's schema; returns the same commitPending flush fn the core expects. */
  attachStdout(proc: ReturnType<typeof spawn>, session: CliSessionRecord, taskId: string): () => void;
  /** Claude-only today: ensure the workspace-root shared MCP server(s) exist before spawning. */
  ensureMcp?(workspaceRoot: string): Promise<void>;
}
