// Strip NODE_OPTIONS early — pkg binaries crash when child processes inherit
// V8 flags like --max-old-space-size that get misinterpreted as module paths.
// Case-insensitive removal for Windows where env var casing may vary.
for (const key of Object.keys(process.env)) {
  if (key.toUpperCase() === 'NODE_OPTIONS') delete process.env[key];
}

// MCP mode guard — redirect stdout before any module-level code can corrupt JSON-RPC framing.
// ESM static imports are hoisted so we can't prevent those from running first, but this ensures
// no downstream execution (workspace activation, doc loading, etc.) reaches stdout in MCP mode.
const MCP_MODE = process.argv.includes('--mcp');
if (MCP_MODE) {
  // eslint-disable-next-line no-console -- intentional MCP stdout shim: redirects stray console.log to stderr so it can't corrupt JSON-RPC framing
  console.log = (...args: unknown[]) => console.error(...args);
}

import { log } from './log.js';
import express from 'express';
import cors from 'cors';
import fs from 'fs/promises';
import { existsSync, appendFileSync } from 'fs';
import { execFile, spawn } from 'child_process';
import path from 'path';
import os from 'os';

import { fileURLToPath } from 'url';
import { requireWorkspace, loopbackOnly, originGuard, isLoopbackHostname } from './middleware.js';
import { requestTiming } from './perf/request-timing.js';
import { startEventLoopMonitor, stopEventLoopMonitor } from './perf/event-loop-monitor.js';
import { startGitTiming } from './perf/git-timing.js';
import { workspaceRoot, loadAppSettings, getCliWorkspace, resolvePortalDist, autoRegisterWorkspace } from './workspace.js';
import { isPkg, isSea, isPackaged, ensureSeaAssetsExtracted, getSeaAsset, setEnginePort } from './packaged-mode.js';
import { migrateFromLegacy } from './global-settings.js';
import { activateWorkspace, tasksCache } from './task-store.js';
// FLUX-705: statically imported so the in-process HTTP MCP mount runs on THIS engine's
// task-store (shared workspaceRoot/tasksCache/watchers). Bundling them together is what
// makes the MCP tools and the engine one instance — in the packaged SEA build the old
// lazy `seaRequire('mcp-server.js')` loaded a SECOND, never-activated task-store, so MCP
// writes threw "Received null" and MCP reads were blind to tickets REST had written.
import { handleMcpHttpRequest, startMcpServer } from './mcp-server.js';
import { stopAllCliSessions, setAutoRestartCallback, getAllActiveSessions, getActiveSessionsForTask, syncActiveSessionStubs } from './session-store.js';
import { requestApproval, resolveApproval, listPendingApprovals } from './permission-prompts.js';
import { requestAnswer, resolveAnswer, listPendingQuestions } from './ask-questions.js';
import { isSafeStreamId } from './transcript.js';
import { verifyConversation } from './session-binding.js';
import { proposeBoardRebase, resolveBoardRebase, listPendingBoardRebases } from './board-rebase.js';
import { buildTriageFragment } from './board-triage.js';
import { shutdownSharedServers } from './shared-mcp-server.js';
import { flushOpenPrompts } from './hitl-prompts.js';
import { broadcastEvent } from './events.js';
import { installOperationTelemetry } from './operation-telemetry.js';

import tasksRouter, { bulkRenameHandler } from './routes/tasks.js';
import diffsRouter from './routes/diffs.js';
import cliSessionRouter from './routes/cli-session.js';
import docsRouter from './routes/docs.js';
import configRouter from './routes/config.js';
import workspaceRouter from './routes/workspace.js';
import workspacesRouter from './routes/workspaces.js';
import assetsRouter from './routes/assets.js';
import skillRouter from './routes/skill.js';
import statsRouter from './routes/stats.js';
import perfRouter from './routes/perf.js';
import operationsRouter from './routes/operations.js';
import readStateRouter from './routes/read-state.js';
import eventsRouter from './routes/events.js';
import storageRouter from './routes/storage.js';
import syncStatusRouter from './routes/sync-status.js';
import notificationsRouter from './routes/notifications.js';
import settingsRouter from './routes/settings.js';
import orchestrationRouter from './routes/orchestration.js';
import workflowsRouter from './routes/workflows.js';
import furnaceRouter from './routes/furnace.js';
import { startStoker } from './furnace-stoker.js';
import agentsRouter from './routes/agents.js';
import bootstrapRouter from './routes/bootstrap.js';
import groupRouter from './routes/group.js';
import devOnboardingRouter from './routes/dev-onboarding.js';
import devOnboardingFlowRouter from './routes/dev-onboarding-flow.js';
import devOnboardingAssetsRouter from './routes/dev-onboarding-assets.js';
import devOnboardingDraftRouter from './routes/dev-onboarding-draft.js';
import { checkForUpdate, getCachedUpdateInfo, getLocalVersion } from './update-check.js';
import { checkGhAuth } from './branch-manager.js';
import terminalRouter, { handleTerminalUpgrade } from './routes/terminal.js';
import { reconcileOrphanedTerminalSessions, destroyAllTerminalSessions } from './terminal-session-store.js';
import { reconcilePullRequests, pruneMergedBranches, reclaimReadyWorktrees } from './pr-cleanup.js';
import { syncPrTickets } from './pr-tickets.js';

const __dir = (() => {
  // Note: __dirname is a CJS-only global; this module runs as ESM, but Node's ambient
  // types are pulled in program-wide (via other files' core-module imports), so
  // referencing it here type-checks even though it's only actually defined at runtime
  // when this module is loaded as CJS (e.g. bundled/packaged output).
  if (typeof __dirname === 'string' && path.isAbsolute(__dirname)) return __dirname;
  try { return path.dirname(fileURLToPath(import.meta.url)); } catch {}
  return path.join(process.cwd(), 'src');
})();

function isValidWorkspaceRoot(dir: string): boolean {
  return existsSync(path.join(dir, '.flux')) || existsSync(path.join(dir, '.flux-store'));
}

/** Explain, for the engine log, why a workspace candidate can't be bound (FLUX-705). */
function describeWorkspaceProblem(dir: string): string {
  if (!existsSync(dir)) return 'folder does not exist (moved or deleted?)';
  const hasFlux = existsSync(path.join(dir, '.flux'));
  const hasStore = existsSync(path.join(dir, '.flux-store'));
  if (!hasFlux && !hasStore) {
    return 'no .flux or .flux-store store found — in orphan mode the .flux-store git worktree ' +
      'may have been removed during an update (recover with: git worktree add .flux-store flux-data)';
  }
  return 'store present but rejected (unexpected)';
}

const app = express();

// FLUX-774/783: the engine has no auth and can spawn agents with shell/file access, so by default
// it binds to loopback (below), rejects non-loopback Host headers (DNS-rebinding) and non-loopback
// Origins (drive-by cross-site fetch), and reflects CORS only for loopback origins so a page the
// user merely visits can neither drive the API nor read its responses. Opt into LAN exposure with
// EH_ALLOW_REMOTE=1 (no auth — trusted networks only).
const ALLOW_REMOTE = process.env.EH_ALLOW_REMOTE === '1';
if (ALLOW_REMOTE) {
  app.use(cors());
} else {
  app.use(cors({
    // Reflect ONLY loopback origins; never echo an arbitrary site's origin back. `false`
    // simply omits CORS headers (no error) — the request still hits originGuard below.
    origin: (origin, cb) => {
      if (!origin) return cb(null, true); // same-origin navigations / curl / server-side callers
      try {
        let h = new URL(origin).hostname.toLowerCase();
        if (h.startsWith('[')) h = h.slice(1, h.indexOf(']'));
        return cb(null, isLoopbackHostname(h));
      } catch {
        return cb(null, false);
      }
    },
  }));
  app.use(loopbackOnly);
  app.use(originGuard);
}

// FLUX-1129: times every request into the perf registry (GET /api/perf) — mounted early,
// alongside the other cross-cutting guards above, so it wraps the whole API surface.
app.use(requestTiming);

// FLUX-1130: samples event-loop delay in the background so a synchronous stall anywhere in
// the process (blocking git spawn, giant JSON serialize, sync fs rescan, ...) surfaces in
// GET /api/perf and the log, regardless of which code path caused it.
startEventLoopMonitor();

// ─── MCP over HTTP (FLUX-645) ───────────────────────────────────────────────────
// Serve the Event Horizon MCP server in-process over loopback so every Claude Code session
// — main checkout or an `.eh-worktrees/*` worktree — connects to ONE URL and shares this
// engine's task-store cache + watchers (no per-session stdio process). Registered BEFORE
// express.json so the raw JSON-RPC request stream reaches the MCP transport unparsed —
// express.json would otherwise consume the body and the transport would hang. handleMcpHttpRequest
// is statically imported (FLUX-705), so it runs on the engine's own task-store and routes each
// session's StreamableHTTP transport in-process.
const handleMcp = (req: express.Request, res: express.Response) => {
  Promise.resolve(handleMcpHttpRequest(req, res)).catch((err) => {
    console.error('[mcp-http] request failed:', err);
    if (!res.headersSent) {
      res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal error' }, id: null });
    }
  });
};
app.post('/mcp', handleMcp);
app.get('/mcp', handleMcp);
app.delete('/mcp', handleMcp);

// Prod-wide JSON body limit stays 10mb (FLUX-760: do NOT widen this — large onboarding
// gif uploads get a dedicated 64mb parser scoped to the dev-only asset route instead).
// The dev onboarding-asset route is EXEMPTED here so the global 10mb parser does not
// consume/413 its body first; its own express.json({limit:'64mb'}) (inside the router)
// then parses it. This exemption is inert in prod because the route is never mounted there.
const globalJsonParser = express.json({ limit: '10mb' });
app.use((req, res, next) => {
  if (req.path === '/api/dev/onboarding-asset') return next();
  return globalJsonParser(req, res, next);
});

// ─── API routes ───────────────────────────────────────────────────────────────

app.use('/api/tasks', requireWorkspace, tasksRouter);
app.use('/api/tasks', requireWorkspace, cliSessionRouter);
app.use('/api/diffs', requireWorkspace, diffsRouter);
app.post('/api/bulk-rename', requireWorkspace, bulkRenameHandler);
app.use('/api/docs', requireWorkspace, docsRouter);
app.use('/api/config', requireWorkspace, configRouter);
app.use('/api/workspace', workspaceRouter);
app.use('/api/workspaces', workspacesRouter);
app.use('/api/assets', assetsRouter);
app.use('/api/skill', requireWorkspace, skillRouter);
app.use('/api/stats', requireWorkspace, statsRouter);
// No requireWorkspace: perf metrics are process-level (request timings), not workspace data.
app.use('/api/perf', perfRouter);
app.use('/api/operations', requireWorkspace, operationsRouter);
app.use('/api/read-state', requireWorkspace, readStateRouter);
app.use('/api/events', eventsRouter);
app.use('/api/storage', requireWorkspace, storageRouter);
app.use('/api/sync-status', requireWorkspace, syncStatusRouter);
app.use('/api/notifications', notificationsRouter);
app.use('/api/settings', settingsRouter);
app.use('/api/orchestration', requireWorkspace, orchestrationRouter);
app.use('/api/workflows', requireWorkspace, workflowsRouter);
app.use('/api/furnace', requireWorkspace, furnaceRouter);
app.use('/api/agents', requireWorkspace, agentsRouter);
app.use('/api/bootstrap', requireWorkspace, bootstrapRouter);
app.use('/api/group', requireWorkspace, groupRouter);
app.use('/api/terminal', requireWorkspace, terminalRouter);

// S9 (epic FLUX-996): install the real git-exec telemetry sink once at bootstrap — before this,
// setGitOperationSink() had zero call sites and every hardened git/gh call's timing/outcome was
// dropped on the floor. Workspace-agnostic (git-exec runs before a workspace is bound too).
installOperationTelemetry();

// FLUX-1131: feed every git/gh subprocess duration into the perf registry (GET /api/perf) and
// warn on slow calls. setGitOperationSink() is a multicast (git-exec.ts), so this coexists with
// installOperationTelemetry()'s sink above rather than replacing it.
startGitTiming();

// FLUX-755: dev-only onboarding-features editor endpoints. Mounted WITHOUT
// requireWorkspace (the config file is repo-relative, not workspace-relative) and
// ONLY in dev — isPackaged is true in pkg/SEA/electron prod binaries, so the router
// never mounts when shipped. Each handler also re-checks DEV and 404s as a backstop.
const DEV = !isPackaged && process.env.NODE_ENV !== 'production';
if (DEV) app.use('/api/dev', devOnboardingRouter);
// FLUX-759: dev-only onboarding-FLOW editor endpoints (sibling of the features route
// above). Same /api/dev prefix, distinct sub-path (/onboarding-flow), same DEV-only
// + no-requireWorkspace posture. Targets portal/src/config/onboardingFlow.json.
if (DEV) app.use('/api/dev', devOnboardingFlowRouter);
// FLUX-760: dev-only onboarding-IMAGE upload endpoint (POST/DELETE /onboarding-asset).
// Same /api/dev prefix + DEV-only + no-requireWorkspace posture as the two routes
// above. Writes committed bytes to portal/public/onboarding-assets/ (served by
// express.static below in dev AND prod). Carries its OWN express.json({limit:'64mb'})
// internally, so it does NOT widen the prod-wide 10mb /api limit at line 117.
if (DEV) app.use('/api/dev', devOnboardingAssetsRouter);
// FLUX-763 Phase 4: dev-only onboarding DRAFT store + PUBLISH. Routine Studio Save now
// writes the gitignored *.draft.json (GET/PUT onboarding-{flow,features}-draft, seeded
// from committed on first read); POST onboarding-publish is the ONLY path that writes
// the committed onboardingFlow.json/onboardingFeatures.json. Same /api/dev prefix +
// DEV-only + no-requireWorkspace posture as the routes above; small JSON bodies fit the
// prod-wide 10mb limit, so no body-parser exemption is needed.
if (DEV) app.use('/api/dev', devOnboardingDraftRouter);

// FLUX-604: live board snapshot for the orchestrator — active sessions + status counts.
app.get('/api/board/state', requireWorkspace, (_req, res) => {
  const activeSessions = getAllActiveSessions().map((s) => ({
    taskId: s.taskId,
    status: s.status,
    phase: s.phase,
    role: s.role,
    label: s.label,
    activity: s.currentActivity,
  }));
  const statusCounts: Record<string, number> = {};
  for (const t of Object.values(tasksCache)) {
    const st = (t as { status?: string }).status || 'Unknown';
    statusCounts[st] = (statusCounts[st] || 0) + 1;
  }
  res.json({ activeSessions, statusCounts });
});

// FLUX-966: on-demand board-health signals for the "Board Health" quick action — computed ONLY
// when this fires (the dead-PR check shells out to `gh pr view` per Ready+branched ticket), never
// folded into the always-on buildBoardDigest(). Portal bakes the returned fragment into the canned
// prompt it sends to the board orchestrator.
app.get('/api/board/triage-signals', requireWorkspace, async (_req, res) => {
  const fragment = await buildTriageFragment();
  res.json({ fragment });
});

// FLUX-833 (Phase 2): the `claude --resume` pointer for the live session on a conversation, if
// any active session has captured one yet. Persisted on the durable HITL record so a post-restart
// answer has a resume target (Phase 3). `conversationId` is the ticket id (or the `__board__`
// sentinel, whose session is registered under that taskId); null/no-match → undefined.
function resumePointerFor(conversationId: string | null): string | undefined {
  if (!conversationId) return undefined;
  for (const session of getActiveSessionsForTask(conversationId)) {
    if (session.resumeSessionId) return session.resumeSessionId;
  }
  return undefined;
}

// FLUX-841: resolve the conversationId a HITL request is allowed to route to. `conversationId` is
// an agent-supplied self-declaration that selects a transcript stream (`${id}.jsonl`); isSafeStreamId
// (FLUX-833 M4) blocks path traversal, but a *valid sibling ticket id* is same-shape, so a session
// bound to ticket A could otherwise drive a permission/ask transcript event into ticket B's stream
// (cross-ticket injection). Each session is launched with EH_CONVERSATION_TOKEN = an HMAC of its OWN
// bound conversationId (claude-code.ts/cleanChildEnv) and the MCP tools forward it here. We require
// that token to match the claimed id — a session can only produce a valid token for its own ticket,
// so a mismatched/forged id is dropped to null (unrouted): the human round-trip still happens via the
// global overlay, but cannot be attributed/persisted to a foreign ticket. No token (legacy/delegated
// session, or a null id) → unrouted, exactly as before.
function boundConversationId(req: express.Request): string | null {
  const claimed = typeof req.body?.conversationId === 'string' && isSafeStreamId(req.body.conversationId)
    ? req.body.conversationId : null;
  if (!claimed) return null;
  const token = typeof req.body?.conversationToken === 'string' ? req.body.conversationToken : null;
  if (!verifyConversation(claimed, token)) {
    console.warn(`[hitl] dropping unbound conversationId "${claimed}" (session token missing/mismatched) — routing as unrouted`);
    return null;
  }
  return claimed;
}

// FLUX-605: gated-tool approval round-trip. permission_prompt (MCP) posts a request that
// parks until a human resolves it via the portal, or 120s timeout → deny.
app.post('/api/board/permission-request', requireWorkspace, async (req, res) => {
  const toolName = String(req.body?.tool_name || req.body?.toolName || 'unknown');
  const input = req.body?.input ?? {};
  // FLUX-833 M4 (path safety) + FLUX-841 (session→ticket binding): conversationId becomes a
  // transcript stream id; require it to be path-safe AND match the requesting session's binding
  // token, so an agent can neither escape the transcripts dir nor inject into a sibling ticket.
  const conversationId = boundConversationId(req);
  // FLUX-833 (Phase 2): persist the live session's `claude --resume` pointer on the durable
  // record so a later Phase 3 can re-inject a post-restart decision (it lives only in-memory on
  // the session and is lost when reconcileOrphanedSessions cancels the session on restart).
  const decision = await requestApproval(toolName, input, conversationId, resumePointerFor(conversationId));
  res.json(decision);
});
app.post('/api/board/permission-resolve', requireWorkspace, (req, res) => {
  const id = String(req.body?.id || '');
  // FLUX-1026: omit updatedInput when absent rather than emitting `updatedInput: undefined`.
  // The MCP permission_prompt layer is the authoritative fix (it echoes the original tool input
  // on a bare allow); this just keeps the resolve payload clean.
  const decision = req.body?.behavior === 'allow'
    ? (req.body?.updatedInput !== undefined
        ? { behavior: 'allow' as const, updatedInput: req.body.updatedInput }
        : { behavior: 'allow' as const })
    : { behavior: 'deny' as const, message: typeof req.body?.message === 'string' ? req.body.message : 'Denied by user.' };
  res.json({ ok: resolveApproval(id, decision) });
});
app.get('/api/board/permission-pending', requireWorkspace, (_req, res) => {
  res.json({ pending: listPendingApprovals() });
});

// FLUX-662: structured-question round-trip. ask_user_question (MCP) posts a request that
// parks until the user answers via the portal picker, or 4min timeout → unanswered sentinel.
app.post('/api/board/ask-question', requireWorkspace, async (req, res) => {
  const questions = Array.isArray(req.body?.questions) ? req.body.questions : [];
  // FLUX-833 M4 (path safety) + FLUX-841 (session→ticket binding): see the permission route.
  const conversationId = boundConversationId(req);
  if (questions.length === 0) {
    res.status(400).json({ error: 'questions[] is required' });
    return;
  }
  // FLUX-923: attribution breadcrumb so HITL routing is observable. When a ticket-bound question lands
  // UNROUTED, the portal can only show it in the dock catch-all (the inline picker filters by id) unless
  // the resilience net claims it — this log distinguishes "claimed id verified" from "dropped to unrouted"
  // (boundConversationId already warns on a token mismatch). Pairs with the FLUX-908 binding work.
  const claimedId = typeof req.body?.conversationId === 'string' ? req.body.conversationId : null;
  if (claimedId && !conversationId) {
    // The interesting case — a claimed id that failed verification and dropped to unrouted. Always warn.
    console.warn(`[hitl] ask-question from claimed "${claimedId}" routed UNROUTED (token unverified) — inline picker will rely on the portal resilience net (FLUX-923)`);
  } else if (DEV) {
    // The happy path runs on every routed ask-question (a hot HITL path) — keep it out of production logs.
    log.debug(`[hitl] ask-question routed to conversationId=${conversationId ?? '(unrouted/null)'}`);
  }
  // FLUX-826 (lever B): mark that this turn routed a decision through the structured picker, so
  // the turn-end soft backstop won't ALSO nudge on a benign comment from the same turn — the
  // question route (lever A) already owns that turn's safety net. conversationId is the ticket id
  // for per-ticket sessions; a no-match (board / unrouted) simply marks nothing.
  if (conversationId) {
    for (const session of getActiveSessionsForTask(conversationId)) session.askedThisTurn = true;
  }
  const result = await requestAnswer(questions, conversationId, resumePointerFor(conversationId));
  res.json(result);
});
app.post('/api/board/ask-question/:id/answer', requireWorkspace, (req, res) => {
  const id = String(req.params.id || '');
  const answers = req.body?.answers && typeof req.body.answers === 'object' ? req.body.answers : {};
  const notes = typeof req.body?.notes === 'string' && req.body.notes.trim() ? req.body.notes.trim() : undefined;
  res.json({ ok: resolveAnswer(id, { answers, notes }) });
});
app.get('/api/board/pending-questions', requireWorkspace, (_req, res) => {
  res.json({ pending: listPendingQuestions() });
});

// FLUX-659: board-rebase ritual. propose_board_rebase (MCP) parks a BATCH of proposed
// restructurings and broadcasts `board-rebase-proposed`; the portal panel approves a subset and
// posts to -resolve, which executes the approved items via the verb registry and broadcasts
// `board-rebase-resolved`. Sibling of the permission round-trip but batch + fire-then-resolve
// (the propose call returns immediately, it does not block).
app.post('/api/board/board-rebase', requireWorkspace, (req, res) => {
  const items = Array.isArray(req.body?.items) ? req.body.items : [];
  const conversationId = typeof req.body?.conversationId === 'string' ? req.body.conversationId : null;
  if (items.length === 0) {
    res.status(400).json({ error: 'items[] is required' });
    return;
  }
  const batch = proposeBoardRebase(items, conversationId);
  res.status(201).json({ id: batch.id, count: batch.items.length });
});
app.get('/api/board/board-rebase', requireWorkspace, (_req, res) => {
  res.json({ pending: listPendingBoardRebases() });
});
app.post('/api/board/board-rebase-resolve', requireWorkspace, async (req, res) => {
  const id = String(req.body?.id || '');
  const approvedItemIds = Array.isArray(req.body?.approvedItemIds) ? req.body.approvedItemIds.map(String) : [];
  const result = await resolveBoardRebase(id, approvedItemIds);
  if (!result) {
    res.status(404).json({ error: 'No pending board-rebase batch with that id' });
    return;
  }
  res.json(result);
});

let ghAuthAvailable: boolean | null = null;

// How often to poll gh for out-of-band PR state (FLUX-557). 90s balances freshness against
// gh process churn — branch tickets in review are few.
const PR_RECONCILE_INTERVAL_MS = 90_000;

app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', workspace: workspaceRoot, ghAuthAvailable });
});

app.post('/api/shutdown', (_req, res) => {
  stopAllCliSessions('shutdown');
  shutdownSharedServers();
  res.json({ ok: true });
  setTimeout(() => process.exit(0), 150);
});

app.post('/api/restart', (_req, res) => {
  res.json({ ok: true });
  void gracefulShutdown('restart');
});

app.post('/api/events/restart-pending', (_req, res) => {
  broadcastEvent('restart_pending', {});
  setAutoRestartCallback(() => {
    broadcastEvent('auto_restarting', {});
    setTimeout(() => void gracefulShutdown('auto-restart'), 500);
  });
  res.json({ ok: true });
});

app.get('/api/update-check', (_req, res) => {
  const info = getCachedUpdateInfo();
  if (info) {
    res.json(info);
  } else {
    res.json({ updateAvailable: false, currentVersion: getLocalVersion(), latestVersion: '', releaseUrl: '' });
  }
});

// ─── Static portal serving — registered inside startServer() after SEA extraction ─

// ─── App config (port) ───────────────────────────────────────────────────────

async function readPortConfig(): Promise<number> {
  if (!isPackaged) return parseInt(process.env.PORT || '3067', 10);

  const cfgPath = path.join(path.dirname(process.execPath), 'event-horizon.config.json');
  try {
    const raw = await fs.readFile(cfgPath, 'utf-8');
    const cfg = JSON.parse(raw);
    if (Number.isInteger(cfg.port) && cfg.port > 0 && cfg.port < 65536) return cfg.port;
  } catch {
    try { await fs.writeFile(cfgPath, JSON.stringify({ port: 3067 }, null, 2), 'utf-8'); } catch {}
  }
  return 3067;
}

// ─── Open browser ─────────────────────────────────────────────────────────────

function openBrowser(url: string) {
  try {
    if (process.platform === 'win32') {
      execFile('cmd.exe', ['/c', 'start', '', url], { windowsHide: true });
    } else if (process.platform === 'darwin') {
      execFile('open', [url]);
    } else {
      execFile('xdg-open', [url]);
    }
  } catch {}
}

// ─── System tray ─────────────────────────────────────────────────────────────

const TRAY_BINARIES: Partial<Record<NodeJS.Platform, string>> = {
  win32:  'tray_windows_release.exe',
  darwin: 'tray_darwin_release',
  linux:  'tray_linux_release',
};

async function initTray(port: number): Promise<void> {
  const binaryName = TRAY_BINARIES[process.platform];
  if (!binaryName) return;

  let binaryPath: string;

  if (isPkg) {
    const embeddedPath = path.join(__dir, 'traybin', binaryName);
    const tmpPath = path.join(os.tmpdir(), `eh-tray-${binaryName}`);
    if (!existsSync(tmpPath)) {
      const data = await fs.readFile(embeddedPath);
      await fs.writeFile(tmpPath, data, { mode: 0o755 });
    }
    binaryPath = tmpPath;
  } else if (isSea) {
    const tmpPath = path.join(os.tmpdir(), `eh-tray-${binaryName}`);
    if (!existsSync(tmpPath)) {
      const data = getSeaAsset(`traybin/${binaryName}`);
      await fs.writeFile(tmpPath, data, { mode: 0o755 });
    }
    binaryPath = tmpPath;
  } else {
    const candidates = [
      path.resolve(__dir, '..', '..', 'node_modules', 'systray', 'traybin', binaryName),
      path.resolve(__dir, '..', 'node_modules', 'systray', 'traybin', binaryName),
    ];
    const found = candidates.find(p => existsSync(p));
    if (!found) {
      console.warn('Tray binary not found — skipping tray init.');
      return;
    }
    binaryPath = found;
  }

  if (process.platform !== 'win32') {
    try { await fs.chmod(binaryPath, 0o755); } catch {}
  }

  const trayProc = spawn(binaryPath, [], {
    stdio: ['pipe', 'pipe', 'ignore'],
    windowsHide: true,
  });

  const TRAY_ICON_PNG = 'iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAGXRFWHRTb2Z0d2FyZQBBZG9iZSBJbWFnZVJlYWR5ccllPAAAA2ZpVFh0WE1MOmNvbS5hZG9iZS54bXAAAAAAADw/eHBhY2tldCBiZWdpbj0i77u/IiBpZD0iVzVNME1wQ2VoaUh6cmVTek5UY3prYzlkIj8+IDx4OnhtcG1ldGEgeG1sbnM6eD0iYWRvYmU6bnM6bWV0YS8iIHg6eG1wdGs9IkFkb2JlIFhNUCBDb3JlIDUuMC1jMDYwIDYxLjEzNDc3NywgMjAxMC8wMi8xMi0xNzozMjowMCAgICAgICAgIj4gPHJkZjpSREYgeG1sbnM6cmRmPSJodHRwOi8vd3d3LnczLm9yZy8xOTk5LzAyLzIyLXJkZi1zeW50YXgtbnMjIj4gPHJkZjpEZXNjcmlwdGlvbiByZGY6YWJvdXQ9IiIgeG1sbnM6eG1wTU09Imh0dHA6Ly9ucy5hZG9iZS5jb20veGFwLzEuMC9tbS8iIHhtbG5zOnN0UmVmPSJodHRwOi8vbnMuYWRvYmUuY29tL3hhcC8xLjAvc1R5cGUvUmVzb3VyY2VSZWYjIiB4bWxuczp4bXA9Imh0dHA6Ly9ucy5hZG9iZS5jb20veGFwLzEuMC8iIHhtcE1NOk9yaWdpbmFsRG9jdW1lbnRJRD0ieG1wLmRpZDo2NzI0QkUxNUVEMjA2ODExODhDNkYyODE1REEzQzU1NSIgeG1wTU06RG9jdW1lbnRJRD0ieG1wLmRpZDpBM0I0RkI2NjNBQTgxMUUyQjJDQTk3QkQzNDQxRUYzMiIgeG1wTU06SW5zdGFuY2VJRD0ieG1wLmlpZDpBM0I0RkI2NTNBQTgxMUUyQjJDQTk3QkQzNDQxRUYzMiIgeG1wOkNyZWF0b3JUb29sPSJBZG9iZSBQaG90b3Nob3AgQ1M1IE1hY2ludG9zaCI+IDx4bXBNTTpEZXJpdmVkRnJvbSBzdFJlZjppbnN0YW5jZUlEPSJ4bXAuaWlkOkU2ODE0QzZBRUUyMDY4MTE4OEM2RjI4MTVEQTNDNTU1IiBzdFJlZjpkb2N1bWVudElEPSJ4bXAuZGlkOjY3MjRCRTE1RUQyMDY4MTE4OEM2RjI4MTVEQTNDNTU1Ii8+IDwvcmRmOkRlc2NyaXB0aW9uPiA8L3JkZjpSREY+IDwveDp4bXBtZXRhPiA8P3hwYWNrZXQgZW5kPSJyIj8+Xe014gAABO5JREFUeNrEV89vVUUYPfPj/up7r6VtCtg0vhaDaYwuBOKGuHDhBjUYE11gjNFo4sq4MzHxb3BnXLFi4UZCjAvjRjQlEUEUpCSkCFgKKRQKbenru+/OnfHMva+lRGNJ7kt4yffunTszd853vvN9M1c45/A4f3qrAeLZN//rsaJ9Rtvrh9CO07741yhr4S5887/vl1tCNAbwLG024EPaiJDykOpvvAshnmf7jaLPdsdwXv9Af3UGxieauHZjvnBT8C/nAtbacTav0Q7LOBZc9Hq+vNIUcQQZaPiwStouzq0MYPdTu5CHEXaP7kCoNf6avzU2c/nqJNL0IF0tvBVJDB2G3wklf4AU044gkzBEo9HYEoDcOgIGpLqwWhIrLvQ1tD5YhN6zkaZkhvdKvkrPj+QmD0Kl8MzoE1D+eWUR8h2GYpqavoind44EnTQbRdqB995TnXcyBEmCiB5nuak34kQ8OTyEqBuKygC6vyg15sCfFy99IK1twuTYEEUQINAB+gmiFoUT9Sg6Gih1mEt/z95W5RDw9zZtSgpxFEodsH7OOrW8KuoiUJIRkNCK3Au8wh6fe7/QPuoFgI9p+3x2gY4jdaV1MWgPgGasRJoJOFu+kt3P0d6rHIKVVN9YWuOrOg71yGFyTFNcDidnsmJ2KFVRl/aMS/RFwK175L0jsNohURBXKgM4tPfvmeCFNTSHFSZ3DqM5XnPHflrFW5/PCdQVGVCUhMT7LyV4bZ/E7YUMc/dSzC44XF905yoD+OTlm+egt9HJQQq/jy73Cak4TcwWnvuwB1pQi3VIHWFksI3tQ23smaD+TGu6MoDU7LgsXJ1FvSEhayxGNaadfaABCjAkC1FcZyNBJkJqxZs2cOG1sHIdCIZmoeIl6IFBoWpkoB9B3FnvpfoVQg+iAOBZCOD4zAlxmyBmq9cBmdyk51eEbgzSmPeD9HZtI398CvoQxDH7FDcfTfFRE6xCl51Qi9UrYTCQQYaX6P2eAoDaRm9Xi1LgM9PnPwsPomSAjTqEZoUswpPPCBfZ6nVAUXgy+oNhgPD3XCSMBiBlOdXX+1IDBKf92ITgIu4d0Rl/rc6A8i+RZ3nj6fBgEIQNNmWxH0jRZSBooBgjA39lR3gewlXfDf2CfOl53i2V269FGPj0K6d6IiK2g5ALk/syOeQCQZwvwPSgFHtP5+CyC7BUf75GAOkDAD4E3PkixcrIfud8vc4JWCxs5GolAI4vdsZy4z/t8lWW5GXEqsW4y4IQgTILIsHMMDTbJojs12IvdrY6AJdnpZnWlDPLBHAXfWKFJ54ugEKErAfuPgGscGzLM3GCE1BY5TpgVtehnHa2cx/C1H1161sHAA+A2WC5uD/AmrU7RHGmZ8dyl6+s315F7s5atPcrq5Fs6IsAKHqRL3eZSn8jsTd6BgDZvY1Tvj+YONvar4RGrF2peoZASwIwSzwts/xbc7ynHyaWnm2i40dh5adCBTwDWpQlzzPA+5xZmlOszv38KOp/9BBk85ubp7jJzJGBsXpoSgDC74YGiqHi+peoht97yoDLFjY3F3NnTvIUNFaPkvJ8QG99DRD5XY51JxiMVm8BmPmH284cgWm/WIub24F6kcmhbFEDd864XH/lis/GHgJ4OJ7+3hyDXThVC4dfZ/sdPmgrYb6Ea3/rUGuXYx79i1s87s/zfwQYAOBu3WMkV4BvAAAAAElFTkSuQmCC';

  // Windows needs an .ico; macOS/Linux use the PNG. The systray Go binary loads
  // the icon through the OS, which won't render a PNG on win32. This ICO wraps the
  // same 32x32 image bytes in an ICO container (FLUX-129).
  const TRAY_ICON_ICO = 'AAABAAEAICAAAAEAIAC+CAAAFgAAAIlQTkcNChoKAAAADUlIRFIAAAAgAAAAIAgGAAAAc3p69AAAABl0RVh0U29mdHdhcmUAQWRvYmUgSW1hZ2VSZWFkeXHJZTwAAANmaVRYdFhNTDpjb20uYWRvYmUueG1wAAAAAAA8P3hwYWNrZXQgYmVnaW49Iu+7vyIgaWQ9Ilc1TTBNcENlaGlIenJlU3pOVGN6a2M5ZCI/PiA8eDp4bXBtZXRhIHhtbG5zOng9ImFkb2JlOm5zOm1ldGEvIiB4OnhtcHRrPSJBZG9iZSBYTVAgQ29yZSA1LjAtYzA2MCA2MS4xMzQ3NzcsIDIwMTAvMDIvMTItMTc6MzI6MDAgICAgICAgICI+IDxyZGY6UkRGIHhtbG5zOnJkZj0iaHR0cDovL3d3dy53My5vcmcvMTk5OS8wMi8yMi1yZGYtc3ludGF4LW5zIyI+IDxyZGY6RGVzY3JpcHRpb24gcmRmOmFib3V0PSIiIHhtbG5zOnhtcE1NPSJodHRwOi8vbnMuYWRvYmUuY29tL3hhcC8xLjAvbW0vIiB4bWxuczpzdFJlZj0iaHR0cDovL25zLmFkb2JlLmNvbS94YXAvMS4wL3NUeXBlL1Jlc291cmNlUmVmIyIgeG1sbnM6eG1wPSJodHRwOi8vbnMuYWRvYmUuY29tL3hhcC8xLjAvIiB4bXBNTTpPcmlnaW5hbERvY3VtZW50SUQ9InhtcC5kaWQ6NjcyNEJFMTVFRDIwNjgxMTg4QzZGMjgxNURBM0M1NTUiIHhtcE1NOkRvY3VtZW50SUQ9InhtcC5kaWQ6QTNCNEZCNjYzQUE4MTFFMkIyQ0E5N0JEMzQ0MUVGMzIiIHhtcE1NOkluc3RhbmNlSUQ9InhtcC5paWQ6QTNCNEZCNjUzQUE4MTFFMkIyQ0E5N0JEMzQ0MUVGMzIiIHhtcDpDcmVhdG9yVG9vbD0iQWRvYmUgUGhvdG9zaG9wIENTNSBNYWNpbnRvc2giPiA8eG1wTU06RGVyaXZlZEZyb20gc3RSZWY6aW5zdGFuY2VJRD0ieG1wLmlpZDpFNjgxNEM2QUVFMjA2ODExODhDNkYyODE1REEzQzU1NSIgc3RSZWY6ZG9jdW1lbnRJRD0ieG1wLmRpZDo2NzI0QkUxNUVEMjA2ODExODhDNkYyODE1REEzQzU1NSIvPiA8L3JkZjpEZXNjcmlwdGlvbj4gPC9yZGY6UkRGPiA8L3g6eG1wbWV0YT4gPD94cGFja2V0IGVuZD0iciI/Pl3tNeIAAATuSURBVHjaxFfPb1VFGD3z4/7qe6+lbQrYNL4Wg2mMLgTihrhw4QY1GBNdYIzRaOLKuDMx8W9wZ1yxYuFGQowL40Y0JRFBFKQkpAhYCikUCm3p67vvzp3xzL2vpURjSe5LeMn37p07M3fOd77zfTNXOOfwOH96qwHi2Tf/67GifUbb64fQjtO++Ncoa+EufPO/75dbQjQG8CxtNuBD2oiQ8pDqb7wLIZ5n+42iz3bHcF7/QH91BsYnmrh2Y75wU/Av5wLW2nE2r9EOyzgWXPR6vrzSFHEEGWj4sEraLs6tDGD3U7uQhxF2j+5AqDX+mr81NnP56iTS9CBdLbwVSQwdht8JJX+AFNOOIJMwRKPR2BKA3DoCBqS6sFoSKy70NbQ+WITes5GmZIb3Sr5Kz4/kJg9CpfDM6BNQ/nllEfIdhmKamr6Ip3eOBJ00G0XagffeU513MgRJgogeZ7mpN+JEPDk8hKgbisoAur8oNebAnxcvfSCtbcLk2BBFECDQAfoJohaFE/UoOhoodZhLf8/eVuUQ8Pc2bUoKcRRKHbB+zjq1vCrqIlCSEZDQitwLvMIen3u/0D7qBYCPaft8doGOI3WldTFoD4BmrESaCThbvpLdz9HeqxyClVTfWFrjqzoO9chhckxTXA4nZ7JidihVUZf2jEv0RcCte+S9I7DaIVEQVyoDOLT375nghTU0hxUmdw6jOV5zx35axVufzwnUFRlQlITE+y8leG2fxO2FDHP3UswuOFxfdOcqA/jk5ZvnoLfRyUEKv48u9wmpOE3MFp77sAdaUIt1SB1hZLCN7UNt7Jmg/kxrujKA1Oy4LFydRb0hIWssRjWmnX2gAQowJAtRXGcjQSZCasWbNnDhtbByHQiGZqHiJeiBQaFqZKAfQdxZ76X6FUIPogDgWQjg+MwJcZsgZqvXAZncpOdXhG4M0pj3g/R2bSN/fAr6EMQx+xQ3H03xUROsQpedUIvVK2EwkEGGl+j9ngKA2kZvV4tS4DPT5z8LD6JkgI06hGaFLMKTzwgX2ep1QFF4MvqDYYDw91wkjAYgZTnV1/tSAwSn/diE4CLuHdEZf63OgPIvkWd54+nwYBCEDTZlsR9I0WUgaKAYIwN/ZUd4HsJV3w39gnzped4tlduvRRj49CuneiIitoOQC5P7MjnkAkGcL8D0oBR7T+fgsguwVH++RgDpAwA+BNz5IsXKyH7nfL3OCVgsbORqJQCOL3bGcuM/7fJVluRlxKrFuMuCEIEyCyLBzDA02yaI7NdiL3a2OgCXZ6WZ1pQzywRwF31ihSeeLoBChKwH7j4BrHBsyzNxghNQWOU6YFbXoZx2tnMfwtR9detbBwAPgNlgubg/wJq1O0RxpmfHcpevrN9eRe7OWrT3K6uRbOiLACh6kS93mUp/I7E3egYA2b2NU74/mDjb2q+ERqxdqXqGQEsCMEs8LbP8W3O8px8mlp5touNHYeWnQgU8A1qUJc8zwPucWZpTrM79/Cjqf/QQZPObm6e4ycyRgbF6aEoAwu+GBoqh4vqXqIbfe8qAyxY2NxdzZ07yFDRWj5LyfEBvfQ0Q+V2OdScYjFZvAZj5h9vOHIFpv1iLm9uBepHJoWxRA3fOuFx/5YrPxh4CeDie/t4cg104VQuHX2f7HT5oK2G+hGt/61Brl2Me/YtbPO7P838EGADgbt1jJFeAbwAAAABJRU5ErkJggg==';

  const projectName = workspaceRoot ? path.basename(workspaceRoot) : 'No project open';
  const menu = {
    icon: process.platform === 'win32' ? TRAY_ICON_ICO : TRAY_ICON_PNG,
    title: 'Event Horizon',
    tooltip: 'Event Horizon',
    items: [
      { title: 'Event Horizon',       tooltip: '', checked: false, enabled: false },
      { title: projectName,           tooltip: '', checked: false, enabled: false },
      { title: 'Open in Browser',     tooltip: '', checked: false, enabled: true },
      { title: 'Quit Event Horizon',  tooltip: '', checked: false, enabled: true },
    ],
  };

  let lineBuf = '';
  let menuSent = false;
  trayProc.stdout!.on('data', (chunk: Buffer) => {
    lineBuf += chunk.toString();
    const lines = lineBuf.split('\n');
    lineBuf = lines.pop() || '';
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const evt = JSON.parse(line);
        if (!menuSent && evt.type === 'ready') {
          menuSent = true;
          trayProc.stdin!.write(JSON.stringify(menu) + '\n');
        } else if (evt.type === 'clicked') {
          const title: string = evt.item?.title || '';
          if (title === 'Open in Browser') openBrowser(`http://localhost:${port}`);
          else if (title === 'Quit Event Horizon') process.exit(0);
        }
      } catch {}
    }
  });

  trayProc.on('exit', () => { process.exit(0); });
  process.on('exit', () => { try { trayProc.kill(); } catch {} });
}

// ─── Server startup ───────────────────────────────────────────────────────────

async function startServer() {
  // In SEA mode, extract embedded assets to tmpdir before serving anything.
  if (isSea) {
    const extractDir = await ensureSeaAssetsExtracted();
    const portalDist = path.join(extractDir, 'portal', 'dist');
    if (existsSync(portalDist)) {
      app.use(express.static(portalDist));
      app.get(/^(?!\/api\/).*/, (_req, res) => {
        res.sendFile(path.join(portalDist, 'index.html'));
      });
    }
  } else {
    const portalDist = resolvePortalDist();
    if (existsSync(portalDist)) {
      app.use(express.static(portalDist));
      app.get(/^(?!\/api\/).*/, (_req, res) => {
        res.sendFile(path.join(portalDist, 'index.html'));
      });
    }
  }

  // Terminal error handler (FLUX-783). 4-arg, registered AFTER all routes + the SPA catch-all.
  // Maps body-parser JSON failures to 400 and anything else to status||500, always as the uniform
  // {error} JSON the portal expects — never an HTML stack trace (Express's default finalhandler
  // would leak internals in dev). Stack is logged server-side for 5xx, never sent to the client.
  app.use((err: unknown, _req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (res.headersSent) return next(err);
    const e = err as { status?: number; statusCode?: number; type?: string; message?: string } | null | undefined;
    const status = e?.status || e?.statusCode || (e?.type === 'entity.parse.failed' ? 400 : 500);
    if (status >= 500) console.error('[express] unhandled error:', err);
    res.status(status).json({ error: status === 400 ? 'Invalid request body' : (e?.message || 'Internal error') });
  });

  const PORT = await readPortConfig();
  setEnginePort(PORT); // FLUX-645: the installer renders this port into .mcp.json's /mcp URL.

  const bindHost = ALLOW_REMOTE ? '0.0.0.0' : '127.0.0.1';
  const server = app.listen(PORT, bindHost, async () => {
    log.info(`Event Horizon Engine running on port ${PORT}`);
    log.info(`Portal:   http://localhost:${PORT}`);
    if (ALLOW_REMOTE) {
      console.warn('[FLUX] EH_ALLOW_REMOTE=1 — bound to 0.0.0.0 and accepting non-loopback connections. The API has NO authentication and can spawn agents with shell/file access; only enable this on a trusted network.');
    }

    reconcileOrphanedTerminalSessions();
    await migrateFromLegacy();

    const cliWorkspace = getCliWorkspace();
    const settings = await loadAppSettings();
    const cwdFallback = isValidWorkspaceRoot(process.cwd()) ? process.cwd() : null;
    // Recover the common post-update failure where "lastWorkspace" was lost but the
    // workspaces[] registry survived (FLUX-705) — bind a real workspace instead of booting
    // unbound (every write would otherwise throw the cryptic "Received null"). Only auto-bind
    // when the registry is UNAMBIGUOUS (exactly one valid entry); with several we can't know
    // which board the user wants, so stay unbound and let the portal prompt rather than
    // silently bind the wrong one (FLUX-712).
    const validRegistered = (settings.workspaces ?? [])
      .map((w) => w.path)
      .filter((p) => isValidWorkspaceRoot(p));
    const registeredFallback = validRegistered.length === 1 ? validRegistered[0]! : null;

    const candidates: Array<[string, string | null]> = [
      ['--workspace', cliWorkspace],
      ['lastWorkspace', settings.workspace ?? null],
      ['cwd', cwdFallback],
      ['registered', registeredFallback],
    ];
    const picked = candidates.find(([, c]) => c && isValidWorkspaceRoot(c));

    if (picked) {
      const [source, initial] = picked as [string, string];
      if (source !== '--workspace' && source !== 'lastWorkspace') {
        console.warn(`[workspace] lastWorkspace unavailable — recovered via ${source} fallback: ${initial}`);
      }
      const bound = await activateWorkspace(initial);
      await autoRegisterWorkspace(bound); // register the canonical bound path, not the raw input (FLUX-711)
    } else {
      const saved = cliWorkspace || settings.workspace;
      if (saved) {
        console.warn(`[workspace] Saved workspace "${saved}" is not loadable: ${describeWorkspaceProblem(saved)}`);
      }
      console.warn(
        '[workspace] No active workspace bound — the board is read-only and ticket writes will ' +
        'fail until you open the portal and select a project folder. Checked: ' +
        `cli=${cliWorkspace ?? '-'}, lastWorkspace=${settings.workspace ?? '-'}, ` +
        `cwd=${cwdFallback ?? 'invalid'}, registered=${registeredFallback ?? (validRegistered.length > 1 ? `${validRegistered.length} valid (ambiguous — refusing to guess)` : 'none valid')}.`,
      );
    }

    // FLUX-793: under the Electron desktop shell, Electron owns the window + tray, so the engine
    // must NOT open its own browser tab or spawn the systray binary (that would duplicate the
    // window and show two tray icons). The shell sets EH_SHELL=electron on the engine it spawns.
    if (isPackaged && process.env.EH_SHELL !== 'electron') {
      setTimeout(() => openBrowser(`http://localhost:${PORT}`), 800);
      initTray(PORT).catch(e => console.warn('Tray init failed:', e.message));
    }

    checkForUpdate().catch(() => {});

    checkGhAuth().then(ok => {
      ghAuthAvailable = ok;
      if (!ok) {
        console.warn('[branch] GitHub CLI not configured — PR creation unavailable. Run `gh auth login` to enable.');
      }
    }).catch(() => { ghAuthAvailable = false; });

    // Out-of-band PR reconcile (FLUX-557): catch PRs merged/closed directly on GitHub and
    // reconcile the board (advance + clean up, or bounce a closed PR back to In Progress).
    // Polling-based v1 (decision #10); only runs when gh is available and a workspace is active.
    // FLUX-1001: in-flight guard — if a prior tick's sweep is still running (e.g. slow GitHub
    // API), skip the new tick entirely so ticks can't pile up and saturate the event loop.
    let prReconcileInFlight = false;
    setInterval(() => {
      if (prReconcileInFlight) return;
      if (workspaceRoot) {
        prReconcileInFlight = true;
        Promise.all([
          // FLUX-1060: refresh the on-disk active-session stubs (write current running/waiting-input
          // task sessions, prune ended ones) so the reclaim guard survives an engine restart. Runs
          // alongside the reclaim below — reclaim reads the in-memory map, this just keeps the disk
          // mirror ≤ one tick stale for the NEXT restart.
          syncActiveSessionStubs(),
          // FLUX-1031: proactively free task-worktree slots held by tickets resting at Ready
          // (or terminal) with no live session, so the board-wide pool doesn't exhaust while
          // PRs await review. Independent of gh — reclamation is a local git/worktree op — so
          // it runs even when GitHub CLI is unconfigured.
          reclaimReadyWorktrees(workspaceRoot),
          // The remaining reconcilers depend on gh; skip them when it's unavailable.
          ...(ghAuthAvailable
            ? [
                reconcilePullRequests(workspaceRoot),
                // FLUX-566: maintain the engine-managed PR-<n> tickets (the PR-as-first-class entity).
                syncPrTickets(workspaceRoot),
                // FLUX-599: backstop — reclaim merged branches whose merge-time delete was missed.
                pruneMergedBranches(workspaceRoot),
              ]
            : []),
        ]).catch(() => {}).finally(() => { prReconcileInFlight = false; });
      }
    }, PR_RECONCILE_INTERVAL_MS);

    // The Furnace (FLUX-1008 / S3): background Stoker loop. A no-op until a run is ignited
    // (it drives only the single `burning` run each tick), so it's always safe to start here.
    startStoker();
  });

  // Terminal WebSocket upgrade handler — handles /api/terminal/ws/:sessionId.
  server.on('upgrade', (req, socket, head) => {
    if (req.url?.startsWith('/api/terminal/ws/')) {
      handleTerminalUpgrade(req, socket, head);
    } else {
      socket.destroy();
    }
  });

  // Without this, a listen failure (e.g. another Event Horizon instance already
  // holding the port) surfaces as an uncaught 'error' event and crashes the
  // process with a confusing stack. Report it clearly and exit cleanly.
  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      console.error(
        `Port ${PORT} is already in use — another Event Horizon instance is ` +
        `likely running. Close it (or change the port in event-horizon.config.json) and try again.`
      );
    } else {
      console.error('Event Horizon failed to start its HTTP server:', err.message);
      logCrash('server-listen-error', err);
    }
    process.exit(1);
  });
}

// ─── Graceful shutdown ────────────────────────────────────────────────────────

async function gracefulShutdown(signal: string) {
  destroyAllTerminalSessions();
  stopAllCliSessions(signal);
  stopEventLoopMonitor();
  shutdownSharedServers();
  // FLUX-863: persist() in hitl-prompts is async + coalesced (FLUX-854), so on
  // SIGTERM/SIGINT the final open-prompt write may still be in flight. Await it
  // explicitly for deterministic durability instead of relying on the 400ms grace.
  await flushOpenPrompts();
  await new Promise(r => setTimeout(r, 400));
  process.exit(0);
}
process.on('SIGTERM', () => { void gracefulShutdown('SIGTERM'); });
process.on('SIGINT',  () => { void gracefulShutdown('SIGINT'); });

// Crash logging: in packaged mode the process prints to stderr that nobody sees
// (double-clicked .exe has no attached console), then exits — leaving no trace.
// Persist every crash to a log file so failures are diagnosable after the fact.
// Packaged builds write next to the executable; dev builds fall back to cwd.
function crashLogPath(): string {
  try {
    const dir = isPackaged ? path.dirname(process.execPath) : process.cwd();
    return path.join(dir, 'event-horizon-crash.log');
  } catch {
    return path.join(os.tmpdir(), 'event-horizon-crash.log');
  }
}

// Append synchronously — this runs inside an uncaughtException handler moments
// before exit, where async writes may never flush.
function logCrash(kind: string, detail: unknown): void {
  try {
    const ts = new Date().toISOString();
    const err = detail instanceof Error
      ? (detail.stack || `${detail.name}: ${detail.message}`)
      : String(detail);
    appendFileSync(crashLogPath(), `\n[${ts}] ${kind} (v${getLocalVersion()})\n${err}\n`, 'utf-8');
  } catch {
    // Never let crash logging itself throw — we're already on the way down.
  }
}

process.on('uncaughtException', (err) => {
  console.error('CRITICAL: Uncaught Exception:', err);
  console.error(`A crash log was written to: ${crashLogPath()}`);
  logCrash('uncaughtException', err);
  stopAllCliSessions('uncaught-exception');
  setTimeout(() => process.exit(1), 500);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('CRITICAL: Unhandled Rejection at:', promise, 'reason:', reason);
  logCrash('unhandledRejection', reason);
});

// FLUX-705: the MCP server module is statically imported (see the import near the top of
// this file), so the engine and the in-process HTTP mount share ONE task-store instance.
// It is no longer lazy-loaded as a separate SEA bundle — that second instance, never
// workspace-activated, was the root of the packaged-build "Received null" / blind-cache bug.
if (MCP_MODE) {
  startMcpServer().catch(err => {
    console.error('MCP server failed:', err);
    process.exit(1);
  });
} else {
  startServer().catch(err => {
    console.error('Failed to start Event Horizon:', err);
    stopAllCliSessions('startup-failure');
    process.exit(1);
  });
}
