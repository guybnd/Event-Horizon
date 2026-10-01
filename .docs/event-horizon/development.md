---
title: Development Setup
order: 3
---

# Development Setup

This guide is for contributors developing Event Horizon itself using Event Horizon.

---

## Spinning Up the Dev Environment

Two processes need to run. Start them in separate terminals from the repo root.

### 1 — Engine (API server)

```bash
cd engine
npm run dev:no-watch
```

> **Why `dev:no-watch` and not `dev`?**
>
> `npm run dev` uses `tsx watch`, which restarts the engine whenever any imported TypeScript source file changes. If you (or an agent) edit engine source files mid-session, the engine restarts and **all active agent sessions are abandoned**. Use `dev:no-watch` to keep the engine stable. Restart it manually only when you need to pick up engine code changes.

The engine starts on port `3067` by default and serves both the API and the built portal static files.

### 2 — Portal (UI)

```bash
cd portal
npm run dev
```

Vite starts a hot-reload dev server (typically `http://localhost:5173`) that proxies API calls to the engine. Because Vite uses HMR (in-browser module replacement, not process restarts), editing portal source files does **not** restart the engine or affect running agent sessions.

---

## Working With Agents While Developing

Because Event Horizon uses itself to manage its own tickets, agent sessions are often running while you are also editing the codebase.

Key rules:

- Always run the engine with `dev:no-watch` when agents are active.
- If an agent edits engine source files (e.g. fixing a bug in `engine/src/`), the engine will **not** automatically pick up those changes. Restart it manually after the agent's session completes.
- Portal source edits by agents are safe — Vite will hot-reload them without affecting the engine.

---

## Quick Reference

| What | Command | Notes |
|---|---|---|
| Engine (dev, agent-safe) | `cd engine && npm run dev:no-watch` | No auto-restart |
| Engine (dev, auto-restart) | `cd engine && npm run dev` | ⚠️ Restarts on source changes — avoid when agents are running |
| Portal (dev, HMR) | `cd portal && npm run dev` | Safe alongside agents |
| Build engine | `cd engine && npm run build` | Output to `engine/dist/` |
| Build portal | `cd portal && npm run build` | Output to `portal/dist/` |
| Run tests | `cd engine && npm test` | Vitest |

---

## CI & Releases

### CI (per-PR / push checks)

`.github/workflows/ci.yml` runs typecheck + lint + boundary/classification guards + the full engine suite on every PR and master push. Since 2026-08-22 it runs on a **self-hosted runner** (label `[self-hosted, Linux, X64]`, ~2 min/run) instead of paid GitHub-hosted minutes — the repo is private.

- The runner lives at `~/actions-runner-eh` on the primary Linux box, installed as a systemd service (`actions.runner.guybnd-EventHorizon-dev.*`). If a check sits **queued forever**, that machine is off or the service is down: `sudo systemctl status 'actions.runner.*'`.
- Additional dev machines (macOS/Windows) can register as runners with their own labels — download the runner agent, `./config.sh --url <repo> --token $(gh api -X POST repos/guybnd/EventHorizon-dev/actions/runners/registration-token --jq .token)`, then `svc.sh install`. Matrix the check job across platforms once they exist.
- Caution: self-hosted runners execute PR code. Fine while all committers are trusted; revisit before accepting outside contributions.

Locally, the same gate is `npm run check` (see CLAUDE.md / AGENTS.md).

### Cutting a release

1. Land everything; per-ticket PRs must be CI-green (`finish_ticket` enforces this).
2. `npm run flux:release -w engine -- vX.Y.Z` — sweeps all **Done** tickets → Released, writes `.docs/release-notes/vX.Y.Z.md` + the INDEX block, and bumps every package.json/lockfile version.
3. Hand-write the TL;DR + `### Highlights` narrative above the generated `### Tickets` list (house style — see v1.11.0/v1.12.0).
4. Commit `Release vX.Y.Z`, push.
5. `npm run publish-public -- vX.Y.Z` — squashes to the public repo (`public` remote → guybnd/Event-Horizon) and pushes the tag, which fires `.github/workflows/release.yml`. Post-release fixes cut a new version; `--re-cut` exists for replacing a tag that never successfully published.

### Release artifacts

`release.yml` (tag-driven, on GitHub-hosted runners — the mac/win builds need real Apple/MS images and run once per release) produces:

| Platform | Artifacts |
|---|---|
| macOS | `event-horizon-macos-<v>.zip` (standalone binary), `.dmg` (desktop app) |
| Windows | `event-horizon-win-<v>.zip` (SEA binary, smoke-tested in CI), `Setup.exe` (NSIS) |
| Linux | `event-horizon-linux-<v>.zip` (standalone binary), `.AppImage`, `.deb`, `.rpm`, `.pacman` |
| Source | `event-horizon-source.zip` |

The `finalize` job requires all four core zips before flipping the draft release public; missing desktop installers only downgrade it to a warned "partial release". Note for Linux desktop installs: the engine resolves the user's login-shell PATH at startup (FLUX-1711), so agent CLIs in `~/.local/bin` etc. are found even when launched from the app menu.

---

## Related Docs

- [[Code Map]]
- [[Architecture Overview]]
- [[Installation & Setup]]
