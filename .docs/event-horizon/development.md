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

## Related Docs

- [[Code Map]]
- [[Architecture Overview]]
- [[Installation & Setup]]
