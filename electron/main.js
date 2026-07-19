// @ts-check
'use strict';

/**
 * Event Horizon — Electron desktop shell (FLUX-793, Option A: additional opt-in build).
 *
 * The engine is already a localhost web app (Express + in-process MCP, serves the built
 * portal in prod). This shell only adds the WINDOW: it makes sure the engine is up, opens
 * a BrowserWindow pointed at it, owns a tray, and enforces single-instance — so Event
 * Horizon gets its own taskbar/dock entry instead of living in a browser tab.
 *
 * Engine lifecycle: if the engine is already healthy we ATTACH (don't spawn, don't kill on
 * quit — the dev `npm run dev` case). If it's down we SPAWN it with EH_SHELL=electron (so the
 * engine skips its own browser-open + systray — see engine/src/index.ts) and kill it on quit.
 */

const { app, BrowserWindow, Tray, Menu, shell, nativeImage, ipcMain, Notification, dialog } = require('electron');
const { spawn } = require('node:child_process');
const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');

// ── Config ──────────────────────────────────────────────────────────────────
const ENGINE_PORT = resolveEnginePort();
const HEALTH_URL = `http://127.0.0.1:${ENGINE_PORT}/api/health`;
// In a packaged build the engine serves the portal itself (port 3067). In dev the portal is
// served by Vite (5167) which proxies /api → the engine. Override with EH_URL if needed.
const APP_URL =
  process.env.EH_URL || (app.isPackaged ? `http://localhost:${ENGINE_PORT}` : 'http://localhost:5167');

/** @type {import('electron').BrowserWindow | null} */
let win = null;
/** @type {import('electron').Tray | null} */
let tray = null;
/** @type {import('node:child_process').ChildProcess | null} */
let engineProc = null; // only set when WE spawned the engine (so we only kill what we own)

// FLUX-1458: `beforeunload` can't show a dialog in Electron — it just silently cancels the close.
// The renderer instead reports dirty state here, and main owns the confirm + the actual guard.
let hasUnsavedChanges = false;
let allowClose = false;
// FLUX-1541: closing the window while agent sessions are running kills them (only when we spawned
// the engine — see shutdownEngine). The renderer reports the running count here, same seam as above.
let runningSessionCount = 0;

// ── Defender false-positive mitigation ─────────────────────────────────────────
// Windows Defender's JS heuristic (VirTool:JS/Anomelesz.A) false-positives on the minified portal
// bundle that Chromium would otherwise write to disk under …/Cache/Cache_Data. Everything loads
// from localhost (the engine serves it instantly), so the on-disk HTTP cache buys nothing — disable
// it so there's no cached JS artifact on disk for an AV heuristic to scan and flag. Must run before
// app 'ready'.
app.commandLine.appendSwitch('disable-http-cache');

// ── Single instance ───────────────────────────────────────────────────────────
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => focusWindow());
  app.whenReady().then(start).catch((err) => {
    console.error('[electron] failed to start:', err);
    app.quit();
  });
}

async function start() {
  // Stable identity so Windows attributes native notifications to Event Horizon (toasts silently
  // no-op without an AppUserModelID). No-op on macOS/Linux. Must be set before any Notification.
  app.setAppUserModelId('com.eventhorizon.desktop');
  registerNativeBridge();
  await ensureEngine();
  createWindow();
  createTray();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
    else focusWindow();
  });
}

// ── Engine lifecycle ───────────────────────────────────────────────────────────
async function ensureEngine() {
  if (await isHealthy()) return; // already running (dev `npm run dev`, or a prior instance) → attach
  spawnEngine();
  // Wait up to ~30s for the engine to come up.
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    await delay(400);
    if (await isHealthy()) return;
  }
  console.warn('[electron] engine did not become healthy in time — loading the window anyway.');
}

function spawnEngine() {
  // EH_ENGINE_CMD overrides everything (space-separated argv). Packaged builds spawn the bundled
  // engine binary from resources; dev spawns the built engine entrypoint via node.
  const env = { ...process.env, EH_SHELL: 'electron', PORT: String(ENGINE_PORT) };
  let cmd;
  let args;
  if (process.env.EH_ENGINE_CMD) {
    const parts = process.env.EH_ENGINE_CMD.split(' ').filter(Boolean);
    cmd = parts[0];
    args = parts.slice(1);
  } else if (app.isPackaged) {
    // electron-builder stages the self-contained engine bundle (esbuild output: index.js with all
    // deps inlined + the staged portal/dist) under resources/engine/. Run it with Electron's OWN
    // node (ELECTRON_RUN_AS_NODE) — no separate engine binary needed — and point it at the staged
    // portal so the engine serves the UI on the engine port (resolvePortalDist honors --portal-dist).
    const engineDir = path.join(process.resourcesPath, 'engine');
    cmd = process.execPath;
    args = [path.join(engineDir, 'index.js'), '--portal-dist', path.join(engineDir, 'portal', 'dist')];
    env.ELECTRON_RUN_AS_NODE = '1';
  } else {
    // Dev fallback (only reached if no engine is already healthy): run the built engine bundle via
    // Electron-as-node. Requires `npm run build` first; pointing --portal-dist at the staged portal
    // makes the engine serve the UI at :3067, so the window has something to load.
    const engineDir = path.join(__dirname, '..', 'engine', 'dist');
    cmd = process.execPath;
    args = [path.join(engineDir, 'index.js'), '--portal-dist', path.join(engineDir, 'portal', 'dist')];
    env.ELECTRON_RUN_AS_NODE = '1';
  }
  try {
    engineProc = spawn(cmd, args, { env, stdio: 'inherit', windowsHide: true });
    engineProc.on('exit', (code) => {
      console.log(`[electron] engine exited (${code})`);
      engineProc = null;
    });
    engineProc.on('error', (err) => console.error('[electron] failed to spawn engine:', err));
  } catch (err) {
    console.error('[electron] failed to spawn engine:', err);
  }
}

function isHealthy() {
  return new Promise((resolve) => {
    const req = http.get(HEALTH_URL, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.setTimeout(1500, () => { req.destroy(); resolve(false); });
  });
}

// ── Window ──────────────────────────────────────────────────────────────────
function createWindow() {
  const bounds = loadBounds();
  win = new BrowserWindow({
    width: bounds.width,
    height: bounds.height,
    x: bounds.x,
    y: bounds.y,
    minWidth: 960,
    minHeight: 600,
    backgroundColor: '#0a0d08', // matches the Matrix theme base so there's no white flash
    title: 'Event Horizon',
    icon: path.join(__dirname, 'build', 'icon.png'), // window + taskbar icon (Win/Linux)
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  win.loadURL(APP_URL);

  // External links (target=_blank / window.open) open in the OS browser, not a new app window.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isAppUrl(url)) return { action: 'allow' };
    shell.openExternal(url).catch(() => {});
    return { action: 'deny' };
  });
  // In-page navigations to a foreign origin → OS browser.
  win.webContents.on('will-navigate', (e, url) => {
    if (!isAppUrl(url)) { e.preventDefault(); shell.openExternal(url).catch(() => {}); }
  });

  win.on('close', (e) => {
    if (win && !allowClose && (hasUnsavedChanges || (runningSessionCount > 0 && engineProc))) {
      if (!confirmClose()) {
        e.preventDefault();
        return;
      }
      allowClose = true;
    }
    if (win) saveBounds(win.getBounds());
  });
  win.on('closed', () => { win = null; });
}

function focusWindow() {
  if (!win) { createWindow(); return; }
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

// ── Native bridge: taskbar badge + OS toasts (FLUX-796) ─────────────────────────
// The portal (running inside this window) computes the "action needed" count and pops toasts via
// window.electronAPI (see electron/preload.js). Everything here is additive and best-effort — the
// plain browser portal never reaches these channels.
function registerNativeBridge() {
  ipcMain.on('eh:set-action-count', (_e, payload) => {
    const { count = 0, iconDataUrl = null } = payload || {};
    updateBadge(Number(count) || 0, iconDataUrl);
  });
  ipcMain.on('eh:notify', (_e, payload) => {
    if (payload && typeof payload === 'object') showNotification(payload);
  });
  ipcMain.on('eh:set-unsaved-guard', (_e, dirty) => { hasUnsavedChanges = !!dirty; });
  ipcMain.on('eh:set-running-guard', (_e, count) => { runningSessionCount = Number(count) || 0; });
}

/**
 * Native confirm shown in place of the browser's `beforeunload` dialog, which Electron never
 * renders (it just silently cancels the close). Returns the clicked button index — 0 = Cancel.
 */
function promptUnsaved() {
  return dialog.showMessageBoxSync(win, {
    type: 'warning',
    buttons: ['Cancel', 'Discard & Close'],
    defaultId: 0,
    cancelId: 0,
    title: 'Unsaved changes',
    message: 'You have unsaved doc changes.',
    detail: 'Closing now will discard them.',
  });
}

/**
 * Native confirm for closing while agent sessions are still running (FLUX-1541). Only shown when
 * we own the engine (`engineProc` set) — closing would actually stop it; when attached to an
 * externally-managed engine (dev `npm run dev`), sessions survive the window close, so no warning
 * is needed. Returns the clicked button index — 0 = Cancel.
 */
function promptRunningSessions(count) {
  return dialog.showMessageBoxSync(win, {
    type: 'warning',
    buttons: ['Cancel', 'Close anyway'],
    defaultId: 0,
    cancelId: 0,
    title: 'Agent sessions running',
    message: `${count} agent session${count === 1 ? '' : 's'} are still running.`,
    detail: 'Closing Event Horizon will stop them.',
  });
}

/**
 * Runs the close/quit guards in priority order, showing AT MOST ONE dialog (FLUX-1541): unsaved
 * changes take priority over running sessions. Returns true if the close should proceed.
 */
function confirmClose() {
  if (hasUnsavedChanges) return promptUnsaved() !== 0;
  if (runningSessionCount > 0 && engineProc) return promptRunningSessions(runningSessionCount) !== 0;
  return true;
}

/**
 * Show the count of action-required tickets on the taskbar/dock icon. On Windows `setBadgeCount`
 * is a no-op, so the count rides on a renderer-drawn overlay icon (`setOverlayIcon`); macOS/Linux
 * use the native `setBadgeCount`. Count 0 clears the badge.
 */
function updateBadge(count, iconDataUrl) {
  if (!win) return;
  try {
    if (process.platform === 'win32') {
      if (count > 0 && iconDataUrl) {
        const img = nativeImage.createFromDataURL(iconDataUrl);
        win.setOverlayIcon(img, `${count} ${count === 1 ? 'ticket needs' : 'tickets need'} action`);
      } else {
        win.setOverlayIcon(null, '');
      }
    } else {
      app.setBadgeCount(count > 0 ? count : 0);
    }
  } catch (err) {
    console.warn('[electron] updateBadge failed:', err);
  }
}

/** Pop a native OS toast; clicking it focuses the window and tells the renderer which ticket to open. */
function showNotification({ title, body, ticketId }) {
  if (!Notification.isSupported()) return;
  try {
    const iconPath = path.join(__dirname, 'build', 'icon.png');
    const n = new Notification({
      title: title || 'Event Horizon',
      body: body || '',
      icon: fs.existsSync(iconPath) ? iconPath : undefined,
    });
    n.on('click', () => {
      focusWindow();
      if (win && ticketId) win.webContents.send('eh:notification-click', ticketId);
    });
    n.show();
    // Bounce the taskbar button for attention when the window isn't the foreground app (Windows).
    if (process.platform === 'win32' && win && !win.isFocused()) win.flashFrame(true);
  } catch (err) {
    console.warn('[electron] showNotification failed:', err);
  }
}

function isAppUrl(url) {
  try {
    const u = new URL(url);
    return u.hostname === 'localhost' || u.hostname === '127.0.0.1';
  } catch {
    return false;
  }
}

// ── Tray ──────────────────────────────────────────────────────────────────────
function createTray() {
  try {
    const iconPath = path.join(__dirname, 'build', 'tray.png');
    const image = fs.existsSync(iconPath) ? nativeImage.createFromPath(iconPath) : nativeImage.createEmpty();
    tray = new Tray(image);
    tray.setToolTip('Event Horizon');
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: 'Show Event Horizon', click: () => focusWindow() },
        { type: 'separator' },
        { label: 'Quit', click: () => app.quit() },
      ]),
    );
    tray.on('click', () => focusWindow());
  } catch (err) {
    console.warn('[electron] tray init failed:', err);
  }
}

// ── Window bounds persistence ──────────────────────────────────────────────────
function boundsFile() {
  return path.join(app.getPath('userData'), 'window-bounds.json');
}
function loadBounds() {
  try {
    return ensureVisible({ width: 1440, height: 900, ...JSON.parse(fs.readFileSync(boundsFile(), 'utf-8')) });
  } catch {
    return { width: 1440, height: 900 };
  }
}

/**
 * FLUX-1097: a remembered position can reference a display that no longer exists (unplugged
 * monitor, changed layout/scaling, RDP session), and restoring it blindly opens the window
 * outside every screen. Unless enough of the window intersects some display's work area to
 * grab the title bar, drop x/y (Electron then centers on the primary display) and clamp the
 * size to the primary work area.
 */
function ensureVisible(b) {
  if (typeof b.x !== 'number' || typeof b.y !== 'number') { delete b.x; delete b.y; return b; }
  // `screen` must not be touched before app.ready — loadBounds() only runs from createWindow(),
  // which the ready handler gates, so a lazy require keeps that invariant visible here.
  const { screen } = require('electron');
  const visible = screen.getAllDisplays().some(({ workArea: wa }) => {
    const w = Math.min(b.x + b.width, wa.x + wa.width) - Math.max(b.x, wa.x);
    const h = Math.min(b.y + b.height, wa.y + wa.height) - Math.max(b.y, wa.y);
    return w >= 100 && h >= 40;
  });
  if (!visible) {
    delete b.x;
    delete b.y;
    const wa = screen.getPrimaryDisplay().workArea;
    b.width = Math.min(b.width, wa.width);
    b.height = Math.min(b.height, wa.height);
  }
  return b;
}
function saveBounds(b) {
  try { fs.writeFileSync(boundsFile(), JSON.stringify(b)); } catch { /* best-effort */ }
}

// ── Port resolution ─────────────────────────────────────────────────────────────
function resolveEnginePort() {
  if (process.env.PORT) return parseInt(process.env.PORT, 10) || 3067;
  // Packaged builds keep their port in event-horizon.config.json next to the exe.
  try {
    const cfgPath = path.join(path.dirname(process.execPath), 'event-horizon.config.json');
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'));
    if (Number.isInteger(cfg.port) && cfg.port > 0 && cfg.port < 65536) return cfg.port;
  } catch { /* fall through */ }
  return 3067;
}

// ── Shutdown ────────────────────────────────────────────────────────────────────
function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function shutdownEngine() {
  if (!engineProc) return; // we attached to an externally-managed engine → leave it running
  // Ask the engine to stop gracefully (flushes sessions), then hard-kill as a backstop.
  await new Promise((resolve) => {
    const req = http.request(`http://127.0.0.1:${ENGINE_PORT}/api/shutdown`, { method: 'POST' }, (res) => {
      res.resume();
      resolve(undefined);
    });
    req.on('error', () => resolve(undefined));
    req.setTimeout(2000, () => { req.destroy(); resolve(undefined); });
    req.end();
  });
  if (engineProc) { try { engineProc.kill(); } catch { /* already gone */ } }
}

app.on('window-all-closed', () => {
  // Stay alive in the tray on Windows/Linux; on macOS the app convention is to stay too.
  // Quit explicitly via the tray's Quit. (Comment out the next line for tray-resident behavior.)
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', async (e) => {
  if (win && !allowClose && (hasUnsavedChanges || (runningSessionCount > 0 && engineProc))) {
    e.preventDefault();
    if (!confirmClose()) return; // Cancel — stay open
    allowClose = true;
    app.quit(); // re-fires before-quit, now past the guard
    return;
  }
  if (engineProc) {
    e.preventDefault();
    await shutdownEngine();
    app.exit(0);
  }
});
