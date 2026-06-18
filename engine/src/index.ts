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
  console.log = (...args: any[]) => console.error(...args);
}

import express from 'express';
import cors from 'cors';
import fs from 'fs/promises';
import { existsSync, appendFileSync } from 'fs';
import { execFile, spawn } from 'child_process';
import path from 'path';
import os from 'os';

import { fileURLToPath } from 'url';
import { requireWorkspace } from './middleware.js';
import { workspaceRoot, loadAppSettings, getCliWorkspace, resolvePortalDist, autoRegisterWorkspace } from './workspace.js';
import { isPkg, isSea, isPackaged, ensureSeaAssetsExtracted, getSeaAsset, setEnginePort } from './packaged-mode.js';
import { migrateFromLegacy, getBootStatus } from './global-settings.js';
import { activateWorkspace, tasksCache } from './task-store.js';
import { stopAllCliSessions, setAutoRestartCallback, getAllActiveSessions } from './session-store.js';
import { requestApproval, resolveApproval, listPendingApprovals } from './permission-prompts.js';
import { requestAnswer, resolveAnswer, listPendingQuestions } from './ask-questions.js';
import { shutdownSharedServers } from './shared-mcp-server.js';
import { broadcastEvent } from './events.js';

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
import readStateRouter from './routes/read-state.js';
import eventsRouter from './routes/events.js';
import storageRouter from './routes/storage.js';
import syncStatusRouter from './routes/sync-status.js';
import notificationsRouter from './routes/notifications.js';
import settingsRouter from './routes/settings.js';
import orchestrationRouter from './routes/orchestration.js';
import workflowsRouter from './routes/workflows.js';
import agentsRouter from './routes/agents.js';
import bootstrapRouter from './routes/bootstrap.js';
import groupRouter from './routes/group.js';
import { checkForUpdate, getCachedUpdateInfo, getLocalVersion } from './update-check.js';
import { checkGhAuth } from './branch-manager.js';
import { reconcilePullRequests, pruneMergedBranches } from './pr-cleanup.js';
import { syncPrTickets } from './pr-tickets.js';

const __dir = (() => {
  // @ts-ignore
  if (typeof __dirname === 'string' && path.isAbsolute(__dirname)) return __dirname;
  try { return path.dirname(fileURLToPath(import.meta.url)); } catch {}
  return path.join(process.cwd(), 'src');
})();

function isValidWorkspaceRoot(dir: string): boolean {
  return existsSync(path.join(dir, '.flux')) || existsSync(path.join(dir, '.flux-store'));
}

const app = express();
app.use(cors());

// ─── MCP over HTTP (FLUX-645) ───────────────────────────────────────────────────
// Serve the Event Horizon MCP server in-process over loopback so every Claude Code session
// — main checkout or an `.eh-worktrees/*` worktree — connects to ONE URL and shares this
// engine's task-store cache + watchers (no per-session stdio process). Registered BEFORE
// express.json so the raw JSON-RPC request stream reaches the MCP transport unparsed —
// express.json would otherwise consume the body and the transport would hang. The handler
// lazily loads the MCP module (keeping the SDK out of the normal-mode path and resolving the
// SEA-extracted asset) and delegates per-session transport routing to it.
const handleMcp = (req: express.Request, res: express.Response) => {
  loadMcpModule()
    .then(({ handleMcpHttpRequest }) => handleMcpHttpRequest(req, res))
    .catch((err) => {
      console.error('[mcp-http] request failed:', err);
      if (!res.headersSent) {
        res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal error' }, id: null });
      }
    });
};
app.post('/mcp', handleMcp);
app.get('/mcp', handleMcp);
app.delete('/mcp', handleMcp);

app.use(express.json({ limit: '10mb' }));

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
app.use('/api/read-state', requireWorkspace, readStateRouter);
app.use('/api/events', eventsRouter);
app.use('/api/storage', requireWorkspace, storageRouter);
app.use('/api/sync-status', requireWorkspace, syncStatusRouter);
app.use('/api/notifications', notificationsRouter);
app.use('/api/settings', settingsRouter);
app.use('/api/orchestration', requireWorkspace, orchestrationRouter);
app.use('/api/workflows', requireWorkspace, workflowsRouter);
app.use('/api/agents', requireWorkspace, agentsRouter);
app.use('/api/bootstrap', requireWorkspace, bootstrapRouter);
app.use('/api/group', requireWorkspace, groupRouter);

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
    const st = (t as any).status || 'Unknown';
    statusCounts[st] = (statusCounts[st] || 0) + 1;
  }
  res.json({ activeSessions, statusCounts });
});

// FLUX-605: gated-tool approval round-trip. permission_prompt (MCP) posts a request that
// parks until a human resolves it via the portal, or 120s timeout → deny.
app.post('/api/board/permission-request', requireWorkspace, async (req, res) => {
  const toolName = String(req.body?.tool_name || req.body?.toolName || 'unknown');
  const input = req.body?.input ?? {};
  const conversationId = typeof req.body?.conversationId === 'string' ? req.body.conversationId : null;
  const decision = await requestApproval(toolName, input, conversationId);
  res.json(decision);
});
app.post('/api/board/permission-resolve', requireWorkspace, (req, res) => {
  const id = String(req.body?.id || '');
  const decision = req.body?.behavior === 'allow'
    ? { behavior: 'allow' as const, updatedInput: req.body?.updatedInput }
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
  const conversationId = typeof req.body?.conversationId === 'string' ? req.body.conversationId : null;
  if (questions.length === 0) {
    res.status(400).json({ error: 'questions[] is required' });
    return;
  }
  const result = await requestAnswer(questions, conversationId);
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

  const PORT = await readPortConfig();
  setEnginePort(PORT); // FLUX-645: the installer renders this port into .mcp.json's /mcp URL.

  const server = app.listen(PORT, async () => {
    console.log(`Event Horizon Engine running on port ${PORT}`);
    console.log(`Portal:   http://localhost:${PORT}`);

    await migrateFromLegacy();

    const cliWorkspace = getCliWorkspace();
    const settings = await loadAppSettings();
    const cwdFallback = isValidWorkspaceRoot(process.cwd()) ? process.cwd() : null;
    const initial = cliWorkspace || settings.workspace || cwdFallback;

    if (initial && isValidWorkspaceRoot(initial)) {
      await activateWorkspace(initial);
      await autoRegisterWorkspace(initial);
    } else if (initial) {
      console.warn(`Saved workspace not found: ${initial} — open the portal to select a folder.`);
    } else {
      console.log('No workspace configured. Open the portal to select your project folder.');
    }

    if (isPackaged) {
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
    setInterval(() => {
      if (ghAuthAvailable && workspaceRoot) {
        reconcilePullRequests(workspaceRoot).catch(() => {});
        // FLUX-566: maintain the engine-managed PR-<n> tickets (the PR-as-first-class entity).
        syncPrTickets(workspaceRoot).catch(() => {});
        // FLUX-599: backstop — reclaim merged branches whose merge-time delete was missed.
        pruneMergedBranches(workspaceRoot).catch(() => {});
      }
    }, PR_RECONCILE_INTERVAL_MS);
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
  stopAllCliSessions(signal);
  shutdownSharedServers();
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

// mcp-server.js is loaded lazily so its module-level code (and the MCP SDK) never runs in
// normal server mode unless /mcp is actually hit.  In SEA mode it's embedded in the binary
// and extracted to tmpdir on first run; we then load it from disk.  The SEA global require()
// is Node's embedderRequire, which only resolves built-in modules — it CANNOT load a file
// path.  createRequire() gives us a real filesystem-capable require rooted at the extract dir.
// Shared by the `--mcp` headless stdio entry (startMcpServer) and the in-process
// Streamable-HTTP mount (handleMcpHttpRequest, FLUX-645); the module is loaded at most once.
let _mcpModulePromise: Promise<typeof import('./mcp-server.js')> | null = null;
function loadMcpModule(): Promise<typeof import('./mcp-server.js')> {
  if (!_mcpModulePromise) {
    _mcpModulePromise = (async () => {
      if (isSea) {
        const extractDir = await ensureSeaAssetsExtracted();
        const { createRequire } = await import('node:module');
        const seaRequire = createRequire(path.join(extractDir, 'mcp-server.js'));
        return seaRequire(path.join(extractDir, 'mcp-server.js')) as typeof import('./mcp-server.js');
      }
      return import('./mcp-server.js');
    })();
  }
  return _mcpModulePromise;
}

if (MCP_MODE) {
  loadMcpModule()
    .then(({ startMcpServer }) => startMcpServer())
    .catch(err => {
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
