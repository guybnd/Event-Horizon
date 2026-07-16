# Event Horizon — Desktop shell (Electron)

An **opt-in** desktop wrapper (FLUX-793). The engine is already a localhost web app; this shell just
gives it its own window + taskbar/dock entry + tray, instead of opening a browser tab. It is a
**standalone** package — it is deliberately NOT part of the root npm workspaces, so installing the
main repo never pulls in Electron (~100 MB+).

## How it works
- On launch, the shell checks the engine's `/api/health`.
  - **Healthy already** → it ATTACHES (loads the window; does not spawn or kill the engine).
  - **Down** → it SPAWNS the engine with `EH_SHELL=electron` (the engine then skips its own
    browser-open + systray — see `engine/src/index.ts`) and shuts it down on quit.
- Single-instance (relaunch focuses the existing window), external links open in the OS browser,
  window bounds are remembered, and the tray can show/hide/quit.

## Taskbar badge + native notifications (FLUX-796)
The shell pulls you back when an agent needs you, reusing the engine's existing notification model
(`engine/src/notifications.ts`) — no new notification system. The bridge is `preload.js`
(`window.electronAPI`) ↔ `main.js` (IPC channels `eh:set-action-count`, `eh:notify`,
`eh:notification-click`). The portal (`portal/src/AppContext.tsx` + `portal/src/electronApi.ts`)
drives it; everything is guarded behind `window.electronAPI`, so the plain browser portal is a no-op.

- **Taskbar badge** = count of **unread action-required** notifications only (type `'prompt'` =
  Require Input + Needs Action) — not completions/info. The renderer draws the number to a canvas →
  data URL; on **Windows** the count rides on `win.setOverlayIcon` (`app.setBadgeCount` is a no-op
  there) plus `flashFrame` for attention; macOS/Linux use `app.setBadgeCount`.
- **Native OS toast** pops for a new `'prompt'` (always) or `'completion'` (Done) notification, but
  **only while the window is unfocused** — if you're already looking at the board, only the badge
  updates. `'info'`/`'error'` never pop. Per-ticket dedup means re-broadcasts don't re-pop.
- **Clicking a toast** focuses/restores the window and navigates to the ticket.
- Notification attribution on Windows needs a stable AppUserModelID (`main.js` sets one). In dev,
  toasts may show the default Electron identity; packaged builds attribute via the Start-Menu shortcut.
- Policy (which types badge/pop, focus-gating) lives in `AppContext.tsx`'s notification handling — a
  one-line change if you want completions to always pop or info to badge.

## Unsaved-doc close guard (FLUX-1458)
`beforeunload` is a browser-only contract — Electron honors the cancel but never renders the "Leave
site?" dialog, so a dirty doc used to make the window look unclosable. `DocsScreen.tsx` instead
reports dirty state to main over `eh:set-unsaved-guard`; main owns a native
`dialog.showMessageBoxSync` confirm (Cancel / Discard & Close) on **both** `win.on('close')` and the
front of `app.on('before-quit')` — the latter is required because `before-quit` force-exits via
`app.exit(0)` when we spawned the engine (the packaged/tray-Quit path), which bypasses
`win.on('close')` entirely. The plain browser portal is unaffected — it still gets the native
`beforeunload` warning.

## Run it (dev)
The portal is served by Vite (5167) in dev, so run the normal dev stack first, then the shell:

```bash
# terminal 1 — from the repo root
npm run dev            # engine on :3067 + vite on :5167

# terminal 2
cd electron
npm install            # one-time: downloads Electron
npm start              # opens the desktop window at http://localhost:5167
```

Or from the repo root: `npm run electron` (after `npm install` inside `electron/`).

Override the loaded URL with `EH_URL` (e.g. point at a packaged engine on `:3067`).

## Build a desktop installer
The packaged app is **self-contained**: electron-builder stages the engine bundle (the esbuild
output in `engine/dist`, with the portal already staged inside it) into `resources/engine/`, and
`main.js` runs it via Electron's own Node (`ELECTRON_RUN_AS_NODE`) — so end users need no separate
Node runtime or engine binary. Build the bundle first, then package:

```bash
# 1) from the repo root — produce engine/dist (engine bundle + staged portal)
npm run build

# 2) package the desktop app (installs Electron on first run)
npm --prefix electron run build:win    # or build:mac / build:linux
# output → electron/dist/  (NSIS .exe / .dmg / AppImage)
```

The app icon (`build/icon.png`, from which electron-builder derives the `.ico`/`.icns`) and the tray
icon are committed — regenerate them from the brand source with `node electron/scripts/gen-icons.mjs`
(needs `npm i -D sharp`). Builds are **unsigned** today (see the Defender/SmartScreen note below);
code-signing is the durable fix.

Tagged releases build these for you: pushing a `vX.Y.Z` tag produces the macOS `.dmg` and Windows
`.exe` on the GitHub Release (`.github/workflows/release.yml`). The Electron build steps stay
`continue-on-error: true` — a desktop-build hiccup doesn't sink the release — but since FLUX-835 the
release is created as a **draft** and a `finalize` job only publishes it (`--latest`) once the core
source/SEA artifacts are verified attached; a missing `.dmg`/`.exe` still publishes, just with a
"partial release" note appended, so a desktop-build failure is never silently invisible.

**Advanced:** `EH_URL` overrides the loaded URL; `EH_ENGINE_CMD` overrides how the engine is launched
(e.g. `EH_ENGINE_CMD="node /path/to/engine/dist/index.js"`).

## Notes
- Loopback security (FLUX-774/783) is unaffected — the shell loads same-origin `localhost`.
- This is **additive**: the existing SEA binary + tray + browser distribution is untouched.

### Windows Defender false positive (`VirTool:JS/Anomelesz.A`)
Defender's JS heuristic can flag a cached file under
`…\AppData\Roaming\event-horizon-desktop\Cache\`. That's a **false positive** on the portal's own
minified JavaScript that Chromium cached to disk — not malware. The shell disables the on-disk HTTP
cache (`disable-http-cache` in `main.js`) so there's no cached JS artifact to scan; the assets come
from `localhost`, so nothing is lost. If your AV still complains, it's safe to allow (it's your own
frontend) and worth reporting as a false positive. The durable fix is **code-signing** the build,
which also clears the unsigned-binary SmartScreen/Gatekeeper prompts.
