import { describe, it, expect, vi } from 'vitest';
import { execSync, execFileSync } from 'child_process';
import { EventEmitter } from 'events';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { cleanChildEnv } from './agents/shared.js';
import { verifyConversation } from './session-binding.js';
import { CLI_CAPABILITIES, type CliFramework, type CliCapabilities } from './agents/types.js';
import { BOARD_CONVERSATION_ID } from './agents/board.js';
import { getBoardAdapter } from './agents/index.js';

// ─── Mocks for the A.1 stdout-parse fixture tests below ───────────────────────
// claude-code.ts / copilot.ts / gemini.ts each import a wide surface (task persistence,
// SSE broadcast, session bookkeeping, the durable transcript). None of it is exercised by
// `attachStdoutProcessing` itself — mocked here purely so the dynamic `import()` in each
// fixture test resolves without touching the filesystem or a real ticket store.
// NOTE: paths are relative to THIS file (src/adapter-contract.test.ts), not to the adapters
// (src/agents/*.ts) that actually import them — vi.mock resolves against the calling file, and
// vitest matches mocks by final resolved path, so `./x.js` here == `../x.js` from src/agents/*.ts.
vi.mock('./workspace.js', () => ({
  workspaceRoot: '/tmp/test-repo',
  getActiveFluxDir: () => '/tmp/test-repo/.flux',
  getTaskAssetsDir: () => '/tmp/test-repo/.flux/assets',
}));
vi.mock('./config.js', () => ({ configCache: {} }));
vi.mock('./task-store.js', () => ({
  tasksCache: {},
  updateTaskWithHistory: vi.fn().mockResolvedValue(undefined),
  updateAgentSession: vi.fn(),
  estimateCostUSD: vi.fn(() => 0),
}));
vi.mock('./events.js', () => ({ broadcastEvent: vi.fn() }));
vi.mock('./session-store.js', () => ({
  cliSessionsById: new Map(),
  cliSessionIdByTaskId: { get: vi.fn() },
  notifyGroupSessionTerminal: vi.fn(),
  notifyDelegationComplete: vi.fn(),
  checkAutoRestart: vi.fn(),
}));
vi.mock('./history.js', () => ({
  buildActivityEntry: vi.fn(),
  buildCommentEntry: vi.fn(),
  buildAgentMessageEntry: vi.fn(),
  buildAgentSessionEntry: vi.fn(() => ({ sessionId: 'x', progress: [] })),
  appendSessionProgress: vi.fn(),
  closeAgentSession: vi.fn(),
}));
vi.mock('./notifications.js', () => ({
  checkFrameworkHealth: vi.fn(),
  checkSkillStaleness: vi.fn(),
}));
vi.mock('./transcript.js', () => ({
  appendTranscriptLine: vi.fn(),
  appendTranscriptEvent: vi.fn(),
}));

/** A bare EventEmitter stands in for the spawned CLI's ChildProcess — `attachStdoutProcessing`
 *  only ever calls `proc.stdout!.on('data', ...)`, so this is a faithful, dependency-free stand-in. */
function fakeProc(): any {
  return { stdout: new EventEmitter() };
}

/** Minimal CliSessionRecord — only the fields the three adapters' onEvent handlers actually touch. */
function fakeSession(): any {
  return {
    id: 'test-session',
    taskId: 'FLUX-903',
    pendingAssistantText: '',
    liveOutputBuffer: '',
    outputBuffer: '',
    cumulativeOutput: '',
    currentActivity: undefined,
    lastProgressLog: undefined,
    resumeSessionId: undefined,
    sessionHistoryEntry: { sessionId: 'sess-1', progress: [] },
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    costUSD: 0,
    costIsEstimated: false,
    status: 'running',
    label: 'Test',
    writeQueue: Promise.resolve(),
    flushTimer: undefined,
  };
}

/** Feeds each fixture as a JSONL line through the fake process's stdout, one `data` event per line. */
function feedLines(proc: any, ...events: any[]) {
  for (const evt of events) {
    proc.stdout.emit('data', Buffer.from(JSON.stringify(evt) + '\n'));
  }
}

/**
 * FLUX-903 — cross-adapter contract test net (audit "Phase 1a"). The HARD GATE before Phase 2:
 * it locks the invariants the structural tickets are about to MOVE, so the moves are provably
 * behavior-preserving. Per the audit, it uses skip-with-reason — each skipped block maps to the
 * audit row + the ticket that will enable it (FLUX-932 extracts the stdout parser; FLUX-904 lifts
 * the board orchestrator).
 */

const FRAMEWORKS: CliFramework[] = ['claude', 'copilot', 'gemini'];

// The seven optional per-framework behaviors added in FLUX-901 (audit B.1–B.7).
const BEHAVIOR_FLAGS = [
  'persistentChat', 'selfPause', 'partialDeltas', 'permissionGating',
  'nativeAskBlocked', 'spawnTimeMcpConfig', 'imageAttachments',
] as const satisfies readonly (keyof CliCapabilities)[];

// ─── A.6: cleanChildEnv sets the HITL-routing env for EVERY framework (FLUX-900 blocking fix) ───
// Before FLUX-900, only the Claude adapter set EH_CONVERSATION_ID, so the permission_prompt /
// ask_user_question / propose_board_rebase pickers degraded to the global overlay on Copilot/Gemini.
// The unified cleanChildEnv now sets it (plus the FLUX-841 binding token) for all three. Locking this
// before FLUX-905 touches the route/MCP defaults that consume EH_CONVERSATION_ID.
describe('A.6 cleanChildEnv — HITL routing env is set for every framework (FLUX-900)', () => {
  for (const fw of FRAMEWORKS) {
    it(`${fw}: tags the framework, sets EH_CONVERSATION_ID + a verifying token, strips NODE_OPTIONS`, () => {
      const env = cleanChildEnv(fw, 'FLUX-903');
      expect(env.EVENT_HORIZON_FRAMEWORK).toBe(fw);
      expect(env.EH_CONVERSATION_ID).toBe('FLUX-903');
      expect(env.EH_CONVERSATION_TOKEN).toBeTruthy();
      // FLUX-841: the token must verify for its OWN conversationId (and only its own).
      expect(verifyConversation('FLUX-903', env.EH_CONVERSATION_TOKEN!)).toBe(true);
      expect(verifyConversation('FLUX-999', env.EH_CONVERSATION_TOKEN!)).toBe(false);
      // NODE_OPTIONS is REMOVED (not blanked to '') — Gemini's documented pkg-binary-safe behavior.
      expect(Object.keys(env).some((k) => k.toUpperCase() === 'NODE_OPTIONS')).toBe(false);
    });
  }

  it('without a conversationId, leaves the HITL env unset (a delegated subagent is unrouted)', () => {
    const env = cleanChildEnv('claude');
    expect(env.EH_CONVERSATION_ID).toBeUndefined();
    expect(env.EH_CONVERSATION_TOKEN).toBeUndefined();
    expect(env.EVENT_HORIZON_FRAMEWORK).toBe('claude');
  });

  it('a board session is routed under the __board__ sentinel', () => {
    const env = cleanChildEnv('claude', '__board__');
    expect(env.EH_CONVERSATION_ID).toBe('__board__');
    expect(verifyConversation('__board__', env.EH_CONVERSATION_TOKEN!)).toBe(true);
  });
});

// ─── B.1: the CLI_CAPABILITIES contract (FLUX-901) ───
// The capability table is the seam the route layer + portal gate behavior off (instead of
// `=== 'claude'`). Lock its shape + the verified-vs-master values before FLUX-906 consumes it.
describe('CLI_CAPABILITIES contract (FLUX-901, audit B.1)', () => {
  it('every framework declares every capability (completeness — guards "did you handle the new CLI?")', () => {
    for (const fw of FRAMEWORKS) {
      const cap = CLI_CAPABILITIES[fw];
      expect(cap, `missing capabilities for ${fw}`).toBeDefined();
      for (const flag of BEHAVIOR_FLAGS) {
        expect(typeof cap[flag], `${fw}.${flag} must be a boolean`).toBe('boolean');
      }
      expect(typeof cap.effort.supported).toBe('boolean');
      if (cap.effort.supported) expect(typeof cap.effort.flag).toBe('string');
    }
  });

  it('five of the seven B.1–B.7 optional behaviors are Claude-only (verified against current master)', () => {
    // spawnTimeMcpConfig and selfPause are excluded here — each has a dedicated test below.
    // FLUX-984: Copilot injects MCP config too (different mechanism than Claude's --mcp-config).
    // FLUX-985: copilot/gemini now honor a Require-Input pause as waiting-input, so selfPause is
    // no longer Claude-only.
    for (const flag of BEHAVIOR_FLAGS) {
      if (flag === 'spawnTimeMcpConfig' || flag === 'selfPause') continue;
      expect(CLI_CAPABILITIES.claude[flag], `claude.${flag}`).toBe(true);
      expect(CLI_CAPABILITIES.copilot[flag], `copilot.${flag}`).toBe(false);
      expect(CLI_CAPABILITIES.gemini[flag], `gemini.${flag}`).toBe(false);
    }
  });

  it('selfPause: all three now keep a Require-Input pause resumable (FLUX-985)', () => {
    // A change_status→Require Input mid-turn parks the session as waiting-input instead of
    // force-terminalizing it. Claude always did this; FLUX-985 added the same pause branch to the
    // copilot/gemini exit handlers (the resume route already accepts waiting-input), so a paused
    // Copilot/Gemini session no longer posts its question as a bogus completion comment or trips the
    // scatter-gather barrier early. Purely-descriptive flag (nothing gates on it) — kept honest here.
    expect(CLI_CAPABILITIES.claude.selfPause).toBe(true);
    expect(CLI_CAPABILITIES.copilot.selfPause).toBe(true);
    expect(CLI_CAPABILITIES.gemini.selfPause).toBe(true);
  });

  it('spawnTimeMcpConfig: Claude AND Copilot now inject MCP config explicitly (FLUX-984); Gemini unverified', () => {
    // Copilot never auto-loads workspace .mcp.json in non-interactive mode (confirmed live,
    // no permission flag changes it) — copilot.ts injects it via --additional-mcp-config, a
    // different flag/JSON-shape than Claude's --mcp-config, same capability concept (B.6).
    // Gemini's equivalent gap (if any) is unconfirmed — its CLI exposes a differently-shaped
    // --allowed-mcp-server-names flag, not an inline-config-injection flag like Copilot's —
    // and Gemini CLI access is broken in this environment, so it's deliberately left `false`
    // rather than guessed. See FLUX-984.
    expect(CLI_CAPABILITIES.claude.spawnTimeMcpConfig).toBe(true);
    expect(CLI_CAPABILITIES.copilot.spawnTimeMcpConfig).toBe(true);
    expect(CLI_CAPABILITIES.gemini.spawnTimeMcpConfig).toBe(false);
  });

  // The non-tautological exercise of buildAdditionalMcpConfigArgs() (the actual injection, not
  // just the capability flag) lives in agents/copilot-mcp-config.test.ts — co-located inside
  // engine/src/agents/, the one sanctioned exception to the adapter-boundary guard's "no deep
  // import of a concrete adapter file from outside agents/" rule. This file lives OUTSIDE
  // agents/, so importing copilot.js directly here trips that guard (caught by CI on FLUX-984).

  it('persistentChat is distinct from resume — all three resume, but only Claude persists chat', () => {
    for (const fw of FRAMEWORKS) expect(CLI_CAPABILITIES[fw].resume, `${fw}.resume`).toBe(true);
    // copilot/gemini --resume fine, but their first chat turn exits `completed`, not persistent `waiting-input`.
    expect(CLI_CAPABILITIES.copilot.persistentChat).toBe(false);
    expect(CLI_CAPABILITIES.gemini.persistentChat).toBe(false);
  });
});

// ─── FLUX-985: every adapter must resolve a pending delegation on terminal exit ───
// The Copilot adapter shipped WITHOUT a notifyDelegationComplete() call in its proc-exit handler
// (claude-code.ts and gemini.ts both had it). Consequence: a `delegate` to a Copilot specialist
// never resolved awaitDelegation on clean exit, so the orchestrator blocked for the FULL delegation
// timeout (up to 600s) and then received a bogus 'cancelled'/timeout result with the completed
// child's real output discarded. This guard fails if a current-or-future adapter forgets the call.
// Source-level (not behavioral) because the exit handler only fires through the full spawn flow;
// the ratcheting-guard style matches scripts/check-adapter-boundary.mjs.
describe('every adapter resolves delegations on terminal exit (FLUX-985)', () => {
  const agentsDir = join(dirname(fileURLToPath(import.meta.url)), 'agents');
  for (const file of ['claude-code.ts', 'copilot.ts', 'gemini.ts']) {
    it(`${file} calls notifyDelegationComplete(session) on exit`, () => {
      const src = readFileSync(join(agentsDir, file), 'utf8');
      expect(src, `${file} must resolve a pending delegation on terminal exit`).toMatch(
        /notifyDelegationComplete\(session\)/,
      );
    });
  }
});

// ─── Per-adapter spawn smoke (A.6 / NODE_OPTIONS — FLUX-900 review follow-up) ───
// The FLUX-900 review flagged that cleanChildEnv now REMOVES NODE_OPTIONS (was '' for Claude). This
// smoke confirms each CLI still launches with that env. skip-with-reason when the binary is absent
// (CI typically has no CLIs installed) so a skip means "binary absent", never a silent pass.
const BINARY: Record<CliFramework, string> = { claude: 'claude', copilot: 'copilot', gemini: 'gemini' };

function binaryPresent(bin: string): boolean {
  try {
    execFileSync(process.platform === 'win32' ? 'where' : 'which', [bin], { stdio: 'ignore', timeout: 10_000, windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

describe('per-adapter spawn smoke — the cleanChildEnv env launches the CLI (FLUX-900)', () => {
  for (const fw of FRAMEWORKS) {
    const bin = BINARY[fw];
    it.skipIf(!binaryPresent(bin))(`${fw}: \`${bin} --version\` exits 0 with cleanChildEnv (NODE_OPTIONS removed)`, () => {
      const env = cleanChildEnv(fw, 'FLUX-903');
      // Runs via the shell so it resolves the .cmd/.exe wrapper; throws on a non-zero exit / ENOENT.
      // (Some CLIs are slow to print --version, so the vitest timeout below is generous.)
      execSync(`${bin} --version`, { env, stdio: 'ignore', timeout: 30_000, windowsHide: true });
    }, 35_000);
  }
});

// ─── A.1 stdout-parse contract — ENABLED BY FLUX-932 ───
// Each adapter's `attachStdoutProcessing` parses a DIFFERENT JSONL schema (Claude `assistant.content[]`
// blocks + `stream_event` deltas; Copilot `assistant.message_delta` / tool_call / turn_end; Gemini
// `message` / `tool_use` / `result.stats`) and is currently INLINE + side-effectful (broadcastEvent,
// appendTranscriptLine, updateTaskWithHistory), so it isn't unit-addressable. FLUX-932 extracts it into
// a shared transport + per-adapter `onEvent` table; THEN these fixtures lock that each adapter's parser
// produces the SAME session-state transitions, making the extraction provably behavior-preserving.
// One divergence these must still pin (preserved, not normalized, in FLUX-900): Claude omits
// `type:'text'` on flushed progress while Copilot/Gemini push it. The OTHER former divergence — Gemini
// never accumulating `cumulativeOutput` (captured output always '') — was a latent BUG, fixed in
// FLUX-932 (shared `appendSessionOutput` now accumulates for every adapter), so the contract asserts
// Gemini NOW captures output like the others.
describe('A.1 per-adapter stdout-parse contract — enabled by FLUX-932', () => {
  it('claude: assistant content[] + result usage → activity / tokens / pendingAssistantText commit (FLUX-932)', async () => {
    const { attachStdoutProcessing } = await import('./agents/claude-code.js');
    const session = fakeSession();
    const proc = fakeProc();
    attachStdoutProcessing(proc, session, 'FLUX-903');

    feedLines(proc,
      { type: 'assistant', message: { content: [{ type: 'text', text: 'Hello world' }] } },
      {
        type: 'result',
        usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 5, cache_creation_input_tokens: 3 },
        total_cost_usd: 0.05,
      },
    );

    // The plain-text assistant event alone only fills pendingAssistantText — the FOLLOWING
    // non-tool event (`result`) is what triggers commitPendingAssistantText, per the original
    // inline logic this extraction must preserve.
    expect(session.pendingAssistantText).toBe('');
    expect(session.cumulativeOutput).toBe('Hello world');
    expect(session.inputTokens).toBe(108); // 100 + cache_read(5) + cache_creation(3)
    expect(session.outputTokens).toBe(20);
    expect(session.cacheReadTokens).toBe(5);
    expect(session.cacheCreationTokens).toBe(3);
    expect(session.costUSD).toBeCloseTo(0.05);
    expect(session.currentActivity).toBeUndefined(); // `result` resets activity
  });

  it('copilot: assistant.message_delta + tool_call + turn_end usage → same transitions (FLUX-932)', async () => {
    const { attachStdoutProcessing } = await import('./agents/copilot.js');
    const session = fakeSession();
    const proc = fakeProc();
    attachStdoutProcessing(proc, session, 'FLUX-903');

    feedLines(proc,
      { type: 'assistant.message_delta', data: { deltaContent: 'Hello world' } },
      { type: 'assistant.tool_call', data: { toolName: 'view', parameters: { path: 'foo.ts' } } },
      {
        type: 'assistant.turn_end',
        data: { usage: { input_tokens: 50, output_tokens: 10, cache_read_input_tokens: 2, cache_creation_input_tokens: 1 } },
      },
    );

    // Unlike Claude, the tool-call event itself commits the pending text (not the next event).
    expect(session.pendingAssistantText).toBe('');
    expect(session.cumulativeOutput).toBe('Hello world');
    expect(session.inputTokens).toBe(53); // 50 + cache_read(2) + cache_creation(1)
    expect(session.outputTokens).toBe(10);
    expect(session.currentActivity).toBeUndefined();
  });

  it('gemini: message/role:assistant + tool_use + result.stats → cumulativeOutput now captured (FLUX-932 fix)', async () => {
    const { attachStdoutProcessing } = await import('./agents/gemini.js');
    const session = fakeSession();
    const proc = fakeProc();
    attachStdoutProcessing(proc, session, 'FLUX-903');

    feedLines(proc,
      // The REAL Gemini CLI schema (not the Claude-schema fallback) — confirmed as the live
      // schema by FLUX-969's commit message ("Gemini's native message/role:'assistant' event").
      { type: 'message', role: 'assistant', content: 'Hello world' },
      { type: 'tool_use', tool_name: 'read_file', parameters: { file_path: 'foo.ts' } },
      { type: 'result', stats: { input_tokens: 30, output_tokens: 6, cached: 1, total_cost_usd: 0.002 } },
    );

    // Before the fix landed in this session, this branch wrote straight to `outputBuffer` and
    // NEVER touched `cumulativeOutput` — a real Gemini session's captured output stayed '' even
    // after FLUX-932's original fix (which only covered the Claude-schema-fallback branch).
    expect(session.cumulativeOutput).toBe('Hello world');
    expect(session.inputTokens).toBe(30);
    expect(session.outputTokens).toBe(6);
    expect(session.cacheReadTokens).toBe(1);
    expect(session.costUSD).toBeCloseTo(0.002);
    expect(session.currentActivity).toBeUndefined();
  });

  it('flushSessionOutput: claude omits progress type; copilot/gemini push type:"text" (Narration block) (FLUX-932)', async () => {
    const { flushSessionOutput } = await import('./agents/shared.js');

    const claudeSession = fakeSession();
    claudeSession.outputBuffer = 'Claude reply';
    flushSessionOutput(claudeSession, true); // force=true, no narrationType
    await claudeSession.writeQueue;
    expect(claudeSession.sessionHistoryEntry.progress).toHaveLength(1);
    expect(claudeSession.sessionHistoryEntry.progress[0]).not.toHaveProperty('type');
    expect(claudeSession.sessionHistoryEntry.progress[0].message).toBe('Claude reply');

    const copilotSession = fakeSession();
    copilotSession.outputBuffer = 'Copilot reply';
    flushSessionOutput(copilotSession, true, 'text');
    await copilotSession.writeQueue;
    expect(copilotSession.sessionHistoryEntry.progress[0].type).toBe('text');
  });
});

// ─── B.8 __board__ orchestrator contract (FLUX-904) ───
// The board orchestrator was lifted out of claude-code.ts: the sentinel id + BoardAdapter interface
// now live in the dependency-free agents/board.ts seam, the Claude implementation in claude-board.ts,
// and routes resolve it via getBoardAdapter() (agents/index.ts) instead of deep-importing the Claude
// adapter. These lock that seam so a future re-org / a second board framework can't regress it.
describe('B.8 __board__ orchestrator contract (FLUX-904 — lifted into a BoardAdapter)', () => {
  it('BOARD_CONVERSATION_ID is the single sentinel, from the dependency-free board.ts seam', () => {
    expect(BOARD_CONVERSATION_ID).toBe('__board__');
  });
  it('getBoardAdapter() resolves a BoardAdapter with startBoardSession + sendBoardInput', () => {
    const adapter = getBoardAdapter();
    expect(typeof adapter.startBoardSession).toBe('function');
    expect(typeof adapter.sendBoardInput).toBe('function');
  });
  it('getBoardAdapter() is a stable resolver the route layer can call per-request', () => {
    expect(getBoardAdapter()).toBe(getBoardAdapter());
  });
});
