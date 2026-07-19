import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest';
import { execSync, execFileSync, type ChildProcessWithoutNullStreams } from 'child_process';
import { EventEmitter } from 'events';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { cleanChildEnv, chatEditGateNote } from './agents/shared.js';
import { verifyConversation } from './session-binding.js';
import { CLI_CAPABILITIES, type CliFramework, type CliCapabilities, type CliSessionRecord } from './agents/types.js';
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
  getWorkspaceRoot: () => '/tmp/test-repo',
  getActiveFluxDir: () => '/tmp/test-repo/.flux',
  getTaskAssetsDir: () => '/tmp/test-repo/.flux/assets',
}));
// FLUX-1373: resolveModel (agents/shared.ts) reads INTEGRATION_TIER_DEFAULTS/MODEL_POLICY_PRESETS
// from this module too — keep the real exports via importOriginal, only stub getConfig.
vi.mock('./config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./config.js')>();
  return { ...actual, getConfig: () => ({}) };
});
vi.mock('./task-store.js', () => ({
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

// ─── Extra mocks for the FLUX-1193 wiring-regression block below — these are only exercised by a
// real startCliSession/sendCliSessionInput run (the A.1 fixtures above only call
// attachStdoutProcessing, never these collaborators). Each is a real filesystem/git/HTTP-touching
// module in the non-test engine; stubbed here so a real adapter spawn stays hermetic. `child_process`
// keeps execSync/execFileSync/exec/execFile REAL via importOriginal (the per-adapter binary
// resolution above and copilot.ts/gemini.ts's own binary-path probing still exercise real, harmless
// `where`/`npm` lookups) and only replaces `spawn` with a recording fake.
// FLUX-1444: the prompt is now delivered over stdin instead of argv — each proc's stdin.write mock
// records what was sent, and `promptFromLastSpawnCall` (below) reads it back via `mockSpawn.mock.results`.
const { mockSpawn } = vi.hoisted(() => {
  return {
    mockSpawn: vi.fn((_command: string, _args?: readonly string[], _options?: unknown) => {
      const proc = new EventEmitter() as unknown as ChildProcessWithoutNullStreams;
      const stdin = { write: vi.fn(), end: vi.fn(), on: vi.fn() };
      Object.assign(proc, { stdout: new EventEmitter(), stderr: new EventEmitter(), stdin, pid: 4242, kill: () => true });
      return proc;
    }),
  };
});
vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return { ...actual, spawn: mockSpawn };
});
vi.mock('./task-worktree.js', () => ({
  resolveTaskExecutionRoot: vi.fn().mockResolvedValue('/tmp/test-repo'),
  resolveResumeExecutionRoot: vi.fn().mockResolvedValue('/tmp/test-repo'),
  assertIsolatedSpawnRoot: vi.fn(),
}));
vi.mock('./group.js', () => ({ buildMemberScopeArgs: vi.fn(() => []) }));
vi.mock('./group-member-worktree.js', () => ({ buildGroupDocsScopeArg: vi.fn(() => []) }));
vi.mock('./workflow-installer.js', () => ({
  buildMcpServerEntry: vi.fn(() => ({ type: 'http', url: 'http://127.0.0.1:0/mcp' })),
}));
vi.mock('./parked-ticket.js', () => ({
  captureTurnStartState: vi.fn(),
  clearNeedsActionIfSet: vi.fn().mockResolvedValue(undefined),
  flagIfParked: vi.fn().mockResolvedValue(undefined),
  raiseNeedsAction: vi.fn(),
}));

/** A bare EventEmitter stands in for the spawned CLI's ChildProcess — `attachStdoutProcessing`
 *  only ever calls `proc.stdout!.on('data', ...)`, so this is a faithful, dependency-free stand-in.
 *  Cast from this narrower shape to the real `ChildProcessWithoutNullStreams` because the runtime
 *  contract these adapters rely on (an EventEmitter-shaped `.stdout`) is genuinely all that's used. */
function fakeProc(): ChildProcessWithoutNullStreams {
  return { stdout: new EventEmitter() } as ChildProcessWithoutNullStreams;
}

/** The subset of `CliSessionRecord` the three adapters' onEvent handlers actually touch — typed
 *  independently (rather than `Partial<CliSessionRecord>`) so every field below is REQUIRED here,
 *  catching a typo/omission instead of silently leaving it `undefined`. */
interface FakeSession {
  id: string;
  taskId: string;
  pendingAssistantText: string;
  liveOutputBuffer: string;
  outputBuffer: string;
  cumulativeOutput: string;
  currentActivity: string | undefined;
  lastProgressLog: string | undefined;
  resumeSessionId: string | undefined;
  sessionHistoryEntry: { sessionId: string; progress: unknown[] };
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  costUSD: number;
  costIsEstimated: boolean;
  status: string;
  label: string;
  writeQueue: Promise<void>;
  flushTimer: NodeJS.Timeout | undefined;
}

/** Minimal CliSessionRecord — only the fields the three adapters' onEvent handlers actually touch. */
function fakeSession(): CliSessionRecord {
  const session: FakeSession = {
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
  return session as CliSessionRecord;
}

/** Feeds each fixture as a JSONL line through the fake process's stdout, one `data` event per line. */
function feedLines(proc: ChildProcessWithoutNullStreams, ...events: unknown[]) {
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

// The seven optional per-framework behaviors added in FLUX-901 (audit B.1–B.7), plus
// chatEditGateEnforced (FLUX-1123: whether the FLUX-926 chat file-edit gate is a real block vs an
// advisory prompt note).
const BEHAVIOR_FLAGS = [
  'persistentChat', 'selfPause', 'partialDeltas', 'permissionGating',
  'nativeAskBlocked', 'spawnTimeMcpConfig', 'imageAttachments', 'chatEditGateEnforced',
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

  // FLUX-1213: verified live — the /delegate route spawns via spawnSession(task, ...), so a
  // delegated persona's `id` IS the real ticket id and cleanChildEnv gets called WITH it (not bare
  // `cleanChildEnv('claude')` as this test does). This case covers cleanChildEnv's own no-id
  // contract in isolation (a caller that truly has none, e.g. a binary probe) — not delegate.
  it('without a conversationId, leaves the HITL env unset (the no-id contract; NOT what /delegate passes)', () => {
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

  it('six of the eight B.1–B.7 (+chatEditGateEnforced) optional behaviors are Claude-only (verified against current master)', () => {
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

  it('chatEditGateEnforced: only Claude can actually block chat file-edits — neither CLI has a --disallowed-tools equivalent (FLUX-1123)', () => {
    expect(CLI_CAPABILITIES.claude.chatEditGateEnforced).toBe(true);
    expect(CLI_CAPABILITIES.copilot.chatEditGateEnforced).toBe(false);
    expect(CLI_CAPABILITIES.gemini.chatEditGateEnforced).toBe(false);
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

  it('spawnTimeMcpConfig: Claude AND Copilot inject MCP config explicitly (FLUX-984); Gemini cannot — it routes via env-resolved settings headers (FLUX-1222)', () => {
    // Copilot never auto-loads workspace .mcp.json in non-interactive mode (confirmed live,
    // no permission flag changes it) — copilot.ts injects it via --additional-mcp-config, a
    // different flag/JSON-shape than Claude's --mcp-config, same capability concept (B.6).
    // Gemini (verified on FLUX-1222) has NO inline-config-injection flag — only the
    // differently-shaped --allowed-mcp-server-names — so the flag stays `false`. Its per-session
    // HITL routing works WITHOUT spawn-time config instead: the installer bakes
    // ${EH_CONVERSATION_ID}/${EH_CONVERSATION_TOKEN} header placeholders into the static
    // .gemini/settings.json, and each Gemini process resolves them from its own spawn env
    // (cleanChildEnv). See buildGeminiMcpServerEntry in workflow-installer.ts and
    // gemini-conversation-headers.test.ts.
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
    expect(claudeSession.sessionHistoryEntry!.progress).toHaveLength(1);
    expect(claudeSession.sessionHistoryEntry!.progress[0]).not.toHaveProperty('type');
    expect(claudeSession.sessionHistoryEntry!.progress[0]!.message).toBe('Claude reply');

    const copilotSession = fakeSession();
    copilotSession.outputBuffer = 'Copilot reply';
    flushSessionOutput(copilotSession, true, 'text');
    await copilotSession.writeQueue;
    expect(copilotSession.sessionHistoryEntry!.progress[0]!.type).toBe('text');
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

// ─── FLUX-1193: wiring-level regression — the FLUX-1123 chat edit-gate note reaches the REAL
// spawn -p arg ───
// FLUX-1123 added chatEditGateNote/prependEditGateNote and wired them into copilot.ts/gemini.ts's
// startCliSession (via buildInitialPrompt's editsGated option) and sendCliSessionInput (via
// prependEditGateNote). shared.test.ts and build-initial-prompt.test.ts already lock those HELPER
// functions in isolation, but nothing spawned the actual adapters and asserted the note lands in
// the real `-p` argument handed to the child process — a future refactor could silently drop the
// one-line call site with nothing failing. This calls the real startCliSession/sendCliSessionInput
// for copilot and gemini (mocks above stub out the git/filesystem/HTTP collaborators only) and reads
// the `-p` value straight off the mocked `spawn()` call.
function fakeChatSession(taskId: string, framework: CliFramework): CliSessionRecord {
  return {
    id: 'sess-1',
    taskId,
    framework,
    command: framework,
    phase: 'chat',
    skipPermissions: true,
    label: framework === 'copilot' ? 'Copilot CLI' : 'Gemini CLI',
    status: 'running',
    sessionHistoryEntry: { sessionId: 'sess-1', progress: [] },
    writeQueue: Promise.resolve(),
    pendingAssistantText: '',
    liveOutputBuffer: '',
    outputBuffer: '',
    cumulativeOutput: '',
  } as unknown as CliSessionRecord;
}

/** Loads the two spawn-side entry points for a framework via a literal dynamic `import()` path
 *  (not a template literal) — required to stay outside the adapter-boundary guard's
 *  `adapter-deep-import` pattern, same technique the A.1 fixtures above already use. */
async function loadAdapter(framework: 'copilot' | 'gemini'): Promise<{
  startCliSession: (session: CliSessionRecord, task: { id?: string; status?: string }, appendPrompt: string, effortOverrideRaw: string, workspaceRoot: string) => Promise<void>;
  sendCliSessionInput: (session: CliSessionRecord, message: string, user: string, workspaceRoot: string) => Promise<void>;
}> {
  return framework === 'copilot' ? import('./agents/copilot.js') : import('./agents/gemini.js');
}

/** Pulls the prompt written to the last mocked spawn() call's stdin, regardless of which
 *  binary-resolution branch (node+entry / exe / cmd.exe shell fallback) fired. FLUX-1444: the
 *  prompt is delivered over stdin, not the `-p` argv value (which is now a bare/empty flag). */
function promptArgFromLastSpawnCall(): string {
  const result = mockSpawn.mock.results[mockSpawn.mock.results.length - 1];
  expect(result, 'spawn() was never called').toBeDefined();
  const proc = result!.value as ChildProcessWithoutNullStreams & { stdin: { write: ReturnType<typeof vi.fn> } };
  const writeCalls = proc.stdin.write.mock.calls as unknown[][];
  expect(writeCalls.length, 'nothing was written to stdin').toBeGreaterThan(0);
  return writeCalls.map((c) => c[0]).join('');
}

/** Pulls the `--model` value out of a mocked spawn() call's args array, or undefined if the
 *  flag wasn't passed at all (the adapter had nothing to override with). */
function modelArgFromLastSpawnCall(): string | undefined {
  const call = mockSpawn.mock.calls[mockSpawn.mock.calls.length - 1];
  expect(call, 'spawn() was never called').toBeDefined();
  const args = call![1] as string[];
  const idx = args.indexOf('--model');
  return idx >= 0 ? args[idx + 1] : undefined;
}

describe('FLUX-1193: chat edit-gate note reaches the real spawn -p arg', () => {
  // gemini's startCliSession/sendCliSessionInput pre-flight `checkBinaryInstalled('gemini')` for
  // real; on a machine without the Gemini CLI (the CI norm — see the per-adapter spawn smoke tests
  // above) that throws before the prompt is ever built. Spy it out for this block only — every OTHER
  // shared.js helper (buildInitialPrompt, isChatEditGated, prependEditGateNote, chatEditGateNote,
  // cleanChildEnv, attachStdoutProcessing) stays real; that real wiring is the entire point.
  beforeAll(async () => {
    const shared = await import('./agents/shared.js');
    vi.spyOn(shared, 'checkBinaryInstalled').mockResolvedValue(undefined);
  });
  afterAll(() => {
    vi.restoreAllMocks();
  });

  for (const framework of ['copilot', 'gemini'] as const) {
    it(`${framework}: initial spawn's -p arg carries the framework-appropriate gate note for a gated chat session`, async () => {
      const { startCliSession } = await loadAdapter(framework);
      const taskId = `FLUX-TEST-${framework}-initial`;
      const task = { id: taskId, status: 'Todo' }; // chat + not In Progress → gated
      const session = fakeChatSession(taskId, framework);

      mockSpawn.mockClear();
      await startCliSession(session, task, '', '', '/tmp/test-repo');
      if (session.progressHeartbeat) clearInterval(session.progressHeartbeat);

      expect(promptArgFromLastSpawnCall()).toContain(chatEditGateNote(framework));
    });

    it(`${framework}: a resumed turn's -p arg re-prepends the gate note (recomputed per turn, not just at spawn)`, async () => {
      const { startCliSession, sendCliSessionInput } = await loadAdapter(framework);
      const { getWorkspace } = await import('./workspace-context.js');
      const taskId = `FLUX-TEST-${framework}-resume`;
      const task = { id: taskId, status: 'Todo' };
      getWorkspace().tasks[taskId] = task;
      const session = fakeChatSession(taskId, framework);

      mockSpawn.mockClear();
      await startCliSession(session, task, '', '', '/tmp/test-repo');
      if (session.progressHeartbeat) clearInterval(session.progressHeartbeat);

      mockSpawn.mockClear();
      await sendCliSessionInput(session, 'continue please', 'TestUser', '/tmp/test-repo');
      if (session.progressHeartbeat) clearInterval(session.progressHeartbeat);

      const prompt = promptArgFromLastSpawnCall();
      expect(prompt).toContain(chatEditGateNote(framework));
      expect(prompt).toContain('continue please');
    });
  }
});

// ─── FLUX-931: session.model reaches the real spawn --model arg on Gemini/Copilot ───
// FLUX-482 threaded a delegate's resolved model onto `session.model`, but only claude-code.ts
// read it (`session.model || selectedModel`) — Gemini/Copilot ignored it and always used their own
// configured grooming/implementation model. gemini.ts/copilot.ts now honor it the same way; this
// locks the wiring against the real spawn args (not just a unit test of the ternary in isolation),
// mirroring the FLUX-1193 block above.
describe('FLUX-931: session.model reaches the real spawn --model arg', () => {
  beforeAll(async () => {
    const shared = await import('./agents/shared.js');
    vi.spyOn(shared, 'checkBinaryInstalled').mockResolvedValue(undefined);
    // FLUX-1375: the claude test below doesn't go through loadAdapter's copilot/gemini binary
    // resolution — stub claude-code.ts's own real binary probe too, so this stays hermetic on a
    // machine without claude.exe on PATH (this test only cares about session.model, not the spawn's
    // real binary path).
    vi.spyOn(shared, 'resolveClaudeExePath').mockResolvedValue('C:\\fake\\claude.exe');
  });
  afterAll(() => {
    vi.restoreAllMocks();
  });

  it("gemini: session.model overrides the (unset) configured model — validated against KNOWN_GEMINI_MODELS", async () => {
    const { startCliSession } = await loadAdapter('gemini');
    const taskId = 'FLUX-TEST-gemini-delegate-model';
    const task = { id: taskId, status: 'Todo' };
    const session = fakeChatSession(taskId, 'gemini');
    session.model = 'flash'; // a delegate's cheap-tier model (TIER_MODELS.gemini)

    mockSpawn.mockClear();
    await startCliSession(session, task, '', '', '/tmp/test-repo');
    if (session.progressHeartbeat) clearInterval(session.progressHeartbeat);

    expect(modelArgFromLastSpawnCall()).toBe('flash');
  });

  // FLUX-1375 bug 1: the resolved model was previously only a local var (`selectedModel`) inside
  // startCliSession — never written back to `session.model` — so the fallback cost estimator (and a
  // resumed turn's own --model resolution) had nothing real to key on. Locks that the resolved model
  // now durably lands on the session record, not just the spawn args, for a session with NO override
  // (the common case — most sessions don't come from a delegate call).
  it('gemini: the resolved (no-override) configured model is persisted onto session.model too', async () => {
    const { startCliSession } = await loadAdapter('gemini');
    const taskId = 'FLUX-TEST-gemini-no-override-model';
    const task = { id: taskId, status: 'Todo' };
    const session = fakeChatSession(taskId, 'gemini');
    expect(session.model).toBeUndefined();

    mockSpawn.mockClear();
    await startCliSession(session, task, '', '', '/tmp/test-repo');
    if (session.progressHeartbeat) clearInterval(session.progressHeartbeat);

    const spawnedModel = modelArgFromLastSpawnCall();
    expect(spawnedModel).toBeTruthy();
    expect(session.model).toBe(spawnedModel);
  });

  it('gemini: an unrecognized session.model is nulled out (same guard as the configured model)', async () => {
    const { startCliSession } = await loadAdapter('gemini');
    const taskId = 'FLUX-TEST-gemini-delegate-model-bad';
    const task = { id: taskId, status: 'Todo' };
    const session = fakeChatSession(taskId, 'gemini');
    session.model = 'not-a-real-gemini-model';

    mockSpawn.mockClear();
    await startCliSession(session, task, '', '', '/tmp/test-repo');
    if (session.progressHeartbeat) clearInterval(session.progressHeartbeat);

    expect(modelArgFromLastSpawnCall()).toBeUndefined();
  });

  it('copilot: session.model overrides the (unset) configured model', async () => {
    const { startCliSession } = await loadAdapter('copilot');
    const taskId = 'FLUX-TEST-copilot-delegate-model';
    const task = { id: taskId, status: 'Todo' };
    const session = fakeChatSession(taskId, 'copilot');
    session.model = 'gpt-5-mini';

    mockSpawn.mockClear();
    await startCliSession(session, task, '', '', '/tmp/test-repo');
    if (session.progressHeartbeat) clearInterval(session.progressHeartbeat);

    expect(modelArgFromLastSpawnCall()).toBe('gpt-5-mini');
  });

  // FLUX-1375 bug 1: see the gemini "no-override" test above for the rationale — same fix, same gap,
  // Copilot's own adapter.
  it('copilot: the resolved (no-override) configured model is persisted onto session.model too', async () => {
    const { startCliSession } = await loadAdapter('copilot');
    const taskId = 'FLUX-TEST-copilot-no-override-model';
    const task = { id: taskId, status: 'Todo' };
    const session = fakeChatSession(taskId, 'copilot');
    expect(session.model).toBeUndefined();

    mockSpawn.mockClear();
    await startCliSession(session, task, '', '', '/tmp/test-repo');
    if (session.progressHeartbeat) clearInterval(session.progressHeartbeat);

    const spawnedModel = modelArgFromLastSpawnCall();
    expect(spawnedModel).toBeTruthy();
    expect(session.model).toBe(spawnedModel);
  });

  // FLUX-1375 bug 1: claude-code.ts had the identical gap — `modelToUse` was a local var in
  // startCliSession, never written back to `session.model`. Unlike gemini/copilot, claude-code.ts's
  // startCliSession isn't reachable via `loadAdapter` above (that helper only covers copilot/gemini),
  // so this imports it directly.
  it('claude: the resolved model is persisted onto session.model too', async () => {
    const { startCliSession } = await import('./agents/claude-code.js');
    const taskId = 'FLUX-TEST-claude-no-override-model';
    const task = { id: taskId, status: 'Todo' };
    const session = fakeChatSession(taskId, 'claude');
    expect(session.model).toBeUndefined();

    mockSpawn.mockClear();
    await startCliSession(session, task, '', '', '/tmp/test-repo');
    if (session.progressHeartbeat) clearInterval(session.progressHeartbeat);

    const spawnedModel = modelArgFromLastSpawnCall();
    expect(spawnedModel).toBeTruthy();
    expect(session.model).toBe(spawnedModel);
  });
});

// ─── FLUX-1479 (FLUX-1226 Phase F): a resolved persona's `model` reaches the real spawn --model
// arg for a solo/dispatched Claude session — Claude-only, and only for solo/dispatched spawns
// (never a delegate/relay position, which resolves its model entirely via the /delegate route).
describe('FLUX-1479: persona.model reaches the real spawn --model arg (Claude solo/dispatched)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('a resolved persona\'s model wins over the task-tier policy for a solo Claude session', async () => {
    const orchestrationPersonas = await import('./orchestration-personas.js');
    vi.spyOn(orchestrationPersonas, 'resolveSoloChatPersona').mockReturnValue({
      id: 'test-cheap-persona', label: 'Test', description: '', role: 'lead', phases: [], requiredCapabilities: [], prompt: 'x',
      model: 'claude-haiku-4-5-20251001',
    });
    const { startCliSession } = await import('./agents/claude-code.js');
    const taskId = 'FLUX-TEST-claude-persona-model';
    const task = { id: taskId, status: 'Todo' };
    const session = fakeChatSession(taskId, 'claude');
    expect(session.model).toBeUndefined();

    mockSpawn.mockClear();
    await startCliSession(session, task, '', '', '/tmp/test-repo');
    if (session.progressHeartbeat) clearInterval(session.progressHeartbeat);

    expect(modelArgFromLastSpawnCall()).toBe('claude-haiku-4-5-20251001');
    expect(session.model).toBe('claude-haiku-4-5-20251001');
  });

  it('an explicit session.model (e.g. the chat model picker) still wins over a resolved persona model', async () => {
    const orchestrationPersonas = await import('./orchestration-personas.js');
    vi.spyOn(orchestrationPersonas, 'resolveSoloChatPersona').mockReturnValue({
      id: 'test-cheap-persona', label: 'Test', description: '', role: 'lead', phases: [], requiredCapabilities: [], prompt: 'x',
      model: 'claude-haiku-4-5-20251001',
    });
    const { startCliSession } = await import('./agents/claude-code.js');
    const taskId = 'FLUX-TEST-claude-persona-model-override';
    const task = { id: taskId, status: 'Todo' };
    const session = fakeChatSession(taskId, 'claude');
    session.model = 'claude-opus-4-8';

    mockSpawn.mockClear();
    await startCliSession(session, task, '', '', '/tmp/test-repo');
    if (session.progressHeartbeat) clearInterval(session.progressHeartbeat);

    expect(modelArgFromLastSpawnCall()).toBe('claude-opus-4-8');
  });

  it('a resolved persona model is NOT applied to a delegate/relay spawn (patternPosition assistant/step)', async () => {
    const orchestrationPersonas = await import('./orchestration-personas.js');
    const spy = vi.spyOn(orchestrationPersonas, 'resolveSoloChatPersona').mockReturnValue({
      id: 'test-cheap-persona', label: 'Test', description: '', role: 'worker', phases: [], requiredCapabilities: [], prompt: 'x',
      model: 'claude-haiku-4-5-20251001',
    });
    const { startCliSession } = await import('./agents/claude-code.js');
    const taskId = 'FLUX-TEST-claude-persona-model-delegate';
    const task = { id: taskId, status: 'Todo' };
    const session = fakeChatSession(taskId, 'claude');
    session.patternPosition = 'assistant';

    mockSpawn.mockClear();
    await startCliSession(session, task, '', '', '/tmp/test-repo');
    if (session.progressHeartbeat) clearInterval(session.progressHeartbeat);

    // Never even consulted for a delegate/relay position — falls through to the task-tier policy.
    expect(modelArgFromLastSpawnCall()).not.toBe('claude-haiku-4-5-20251001');
    spy.mockRestore();
  });
});

// ─── FLUX-1444: oversized prompt is delivered via stdin, not argv ───────────────────────────────
// Windows' CreateProcess caps the command line at 32,767 chars — a scatter-gather reviewer inlines
// the whole PR diff into the prompt (shared.ts's buildInitialPrompt, diffBlock), easily exceeding
// that cap when passed as a single `-p <prompt>` argv element (the HomeUp PR #79 "spawn
// ENAMETOOLONG" incident). The fix delivers the prompt over child stdin instead. This locks that,
// for gemini/copilot too (claude's own initial+resume paths are covered directly in
// claude-code-prompt-stdin.test.ts), no argv element carries the oversized prompt and the full
// prompt bytes land on the spawned process's stdin.
describe('FLUX-1444: oversized prompt is delivered via stdin, not argv', () => {
  beforeAll(async () => {
    const shared = await import('./agents/shared.js');
    vi.spyOn(shared, 'checkBinaryInstalled').mockResolvedValue(undefined);
  });
  afterAll(() => {
    vi.restoreAllMocks();
  });

  // A synthetic scatter-gather reviewer prompt, well past the 32,767-char Windows CreateProcess cap.
  const OVERSIZED_PROMPT = 'DIFF_LINE_'.repeat(4000); // 40,000 chars

  function assertNoArgvElementCarriesPrompt() {
    const call = mockSpawn.mock.calls[mockSpawn.mock.calls.length - 1];
    expect(call, 'spawn() was never called').toBeDefined();
    const args = call![1] as string[];
    for (const arg of args) {
      expect(arg.length).toBeLessThan(1000);
      expect(arg).not.toContain('DIFF_LINE_');
    }
  }

  for (const framework of ['copilot', 'gemini'] as const) {
    it(`${framework}: initial spawn — no argv element carries the oversized prompt, full prompt lands on stdin`, async () => {
      const { startCliSession } = await loadAdapter(framework);
      const taskId = `FLUX-TEST-${framework}-oversized-initial`;
      const task = { id: taskId, status: 'Todo' };
      const session = fakeChatSession(taskId, framework);

      mockSpawn.mockClear();
      await startCliSession(session, task, OVERSIZED_PROMPT, '', '/tmp/test-repo');
      if (session.progressHeartbeat) clearInterval(session.progressHeartbeat);

      assertNoArgvElementCarriesPrompt();
      expect(promptArgFromLastSpawnCall()).toContain(OVERSIZED_PROMPT);
    });

    it(`${framework}: resume — no argv element carries the oversized prompt, full prompt lands on stdin`, async () => {
      const { startCliSession, sendCliSessionInput } = await loadAdapter(framework);
      const { getWorkspace } = await import('./workspace-context.js');
      const taskId = `FLUX-TEST-${framework}-oversized-resume`;
      const task = { id: taskId, status: 'Todo' };
      getWorkspace().tasks[taskId] = task;
      const session = fakeChatSession(taskId, framework);

      mockSpawn.mockClear();
      await startCliSession(session, task, '', '', '/tmp/test-repo');
      if (session.progressHeartbeat) clearInterval(session.progressHeartbeat);

      mockSpawn.mockClear();
      await sendCliSessionInput(session, OVERSIZED_PROMPT, 'TestUser', '/tmp/test-repo');
      if (session.progressHeartbeat) clearInterval(session.progressHeartbeat);

      assertNoArgvElementCarriesPrompt();
      expect(promptArgFromLastSpawnCall()).toContain(OVERSIZED_PROMPT);
    });
  }
});
