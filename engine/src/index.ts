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
import { existsSync } from 'fs';
import { execFile, spawn } from 'child_process';
import path from 'path';
import os from 'os';

import { fileURLToPath } from 'url';
import { requireWorkspace } from './middleware.js';
import { workspaceRoot, loadAppSettings, getCliWorkspace, resolvePortalDist, autoRegisterWorkspace } from './workspace.js';
import { isPkg, isSea, isPackaged, ensureSeaAssetsExtracted, getSeaAsset } from './packaged-mode.js';
import { migrateFromLegacy, getBootStatus } from './global-settings.js';
import { activateWorkspace } from './task-store.js';
import { stopAllCliSessions, setAutoRestartCallback } from './session-store.js';
import { broadcastEvent } from './events.js';

import tasksRouter, { bulkRenameHandler } from './routes/tasks.js';
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
app.use(express.json({ limit: '10mb' }));

// ─── API routes ───────────────────────────────────────────────────────────────

app.use('/api/tasks', requireWorkspace, tasksRouter);
app.use('/api/tasks', requireWorkspace, cliSessionRouter);
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

let ghAuthAvailable: boolean | null = null;

app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', workspace: workspaceRoot, ghAuthAvailable });
});

app.post('/api/shutdown', (_req, res) => {
  stopAllCliSessions('shutdown');
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

  const projectName = workspaceRoot ? path.basename(workspaceRoot) : 'No project open';
  const menu = {
    icon: TRAY_ICON_PNG,
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

  app.listen(PORT, async () => {
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
  });
}

// ─── Graceful shutdown ────────────────────────────────────────────────────────

async function gracefulShutdown(signal: string) {
  stopAllCliSessions(signal);
  await new Promise(r => setTimeout(r, 400));
  process.exit(0);
}
process.on('SIGTERM', () => { void gracefulShutdown('SIGTERM'); });
process.on('SIGINT',  () => { void gracefulShutdown('SIGINT'); });

process.on('uncaughtException', (err) => {
  console.error('CRITICAL: Uncaught Exception:', err);
  stopAllCliSessions('uncaught-exception');
  setTimeout(() => process.exit(1), 500);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('CRITICAL: Unhandled Rejection at:', promise, 'reason:', reason);
});

if (MCP_MODE) {
  // mcp-server.js is loaded lazily so its module-level code (and the MCP SDK)
  // never runs in normal server mode.  In SEA mode it's embedded in the binary
  // and extracted to tmpdir on first run; we then load it from disk.  The SEA
  // global require() is Node's embedderRequire, which only resolves built-in
  // modules — it CANNOT load a file path.  createRequire() gives us a real
  // filesystem-capable require rooted at the extract dir.
  (async () => {
    if (isSea) {
      const extractDir = await ensureSeaAssetsExtracted();
      const { createRequire } = await import('node:module');
      const seaRequire = createRequire(path.join(extractDir, 'mcp-server.js'));
      const { startMcpServer } = seaRequire(path.join(extractDir, 'mcp-server.js')) as typeof import('./mcp-server.js');
      startMcpServer();
    } else {
      const { startMcpServer } = await import('./mcp-server.js');
      startMcpServer();
    }
  })().catch(err => {
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
