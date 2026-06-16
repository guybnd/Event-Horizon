# Recording the Event Horizon showcase GIFs

This guide is the **source of truth** for the GIFs in the root [`README.md`](../../README.md). Each
shot has an exact click-path so any contributor can re-record it consistently as the UI evolves.

> **Why a guide?** Live UI visuals go stale as the portal changes. Rather than treat the GIFs as
> precious one-offs, treat them as **reproducible artifacts** — when a screen changes, re-shoot the
> affected clip from the steps below and drop the new file over the old one. The filenames are fixed,
> so the README never needs editing.

---

## 0. Setup (do this once)

### Record against the demo workspace — never the real board

The repo ships a self-contained demo workspace at [`demo/`](../../demo) seeded with a fictional
hiking app, **Trailhead** (project key `TRAIL`). It exists precisely so recordings look alive without
leaking FLUX internals.

1. Launch Event Horizon (binary or `node engine/dist/index.js`).
2. **Settings → Workspace → Add** and pick the repo's `demo/` folder, then switch to it from the
   header dropdown. The board loads ~15 `TRAIL-*` tickets across every column.
3. To regenerate or tweak the demo board: `npx tsx engine/src/seed-demo.ts` (writes `demo/.flux/`).
   Re-run it any time the seed changes — it validates every ticket against the engine schema before
   writing.

### Display + browser hygiene

- **Window size:** 1440×900 logical. Record a cropped region, not the whole desktop.
- **Zoom:** browser at 100%; OS display scaling at 100% (or record at 2× and downscale — see §3).
- **Theme:** light mode for the hero/gallery unless a shot is specifically about dark mode.
- Hide bookmarks bar, notifications, and any personal tabs. Use a clean browser profile.
- Move the mouse deliberately and slowly — fast cursor jumps read as jittery in a looped GIF.

---

## 1. Tools

| Job | Tool | Notes |
|-----|------|-------|
| **Portal GIFs (primary)** | [**ScreenToGif**](https://www.screentogif.com/) (free, Windows) | Record a region directly to GIF; built-in editor to trim, crop, and remove dead frames. The default choice on Windows. |
| Longer clips / mp4 | **Xbox Game Bar** (`Win+G`) or **OBS Studio** | Use for clips destined for a **PR or release description**, where GitHub renders `.mp4`/`.mov` inline. **Committed README images must be GIF** — GitHub does not autoplay committed video in `README.md`. |
| macOS GIFs | [Kap](https://getkap.co/) | ScreenToGif equivalent for Mac contributors. |
| Optimization | [**gifsicle**](https://www.lcdf.org/gifsicle/) | Required final step on every GIF — see §3. |

---

## 2. Capture settings

- **Frame rate:** 15–20 fps. Higher just inflates file size; the UI motion is slow.
- **Length:** keep each clip **5–12s** and **loopable** — start and end on the same resting state so
  the loop is seamless.
- **Crop tight:** frame only the pane the shot is about (the board, the modal, the header), not the
  whole window. Target widths below assume a cropped region.
- **Target dimensions (width):**
  - Hero: **1200px** wide (it spans the README column).
  - Gallery clips: **900px** wide.
  - Detail/modal clips: **800px** wide.
- **File size budget:** aim **< 3 MB** per gallery GIF, **< 5 MB** for the hero. If a clip blows the
  budget, shorten it or drop the frame rate before reaching for heavier lossy settings.

---

## 3. Optimize before committing (required)

Uncompressed screen GIFs are huge and bloat the repo + slow the README. Always run:

```bash
# Lossy + max optimization + a sane color cap; tune --lossy (30–80) and --colors to taste
gifsicle -O3 --lossy=60 --colors 192 in.gif -o docs/media/<name>.gif

# If still too big: drop every other frame (halves size, halves smoothness)
gifsicle -O3 --lossy=80 --colors 128 --delete '#0--2x2' in.gif -o docs/media/<name>.gif
```

Downscaling a 2×-captured clip also helps sharpness-per-byte:

```bash
gifsicle -O3 --lossy=60 --resize-width 900 in.gif -o docs/media/<name>.gif
```

If total media ever grows large, consider **Git LFS** for `docs/media/*.gif` — but optimize first;
most clips should be a few MB.

---

## 4. Asset convention

- All showcase media lives in **`docs/media/`** at the repo root.
- **Filenames are fixed** (the README links to them); re-recording means overwriting the same file.
- Use these exact names:

| # | File | Feature |
|---|------|---------|
| 1 | `hero-board.gif` | Board overview + drag a card across columns |
| 2 | `agent-session.gif` | Launch an agent from a card → live progress + token counter |
| 3 | `require-input.gif` | Require Input → answer in portal → agent resumes |
| 4 | `finish-pr.gif` | Ready → diff review in modal → finish → commit/PR |
| 5 | `ticket-modal.gif` | Ticket modal: body, metadata, history timeline |
| 6 | `search.gif` | Global fuzzy search jumping to a ticket |
| 7 | `workspace-switch.gif` | Switch workspace from the header dropdown |
| 8 | `docs-tree.gif` | Browse/edit the in-product Docs tree |
| 9 | `git-sync.gif` _(optional)_ | Git Sync toggle concept |
| 10 | `scatter-gather.gif` _(optional)_ | Multi-agent scatter-gather run |

Placeholder images are committed at these paths so the README layout is correct before real captures
land. Replace each placeholder in place; do not rename.

---

## 5. Shot list (click-paths)

Order matches the README gallery. Lead with #1 (hero) and #2 (the agent differentiator).

### 1 — `hero-board.gif` · Board overview + drag a card
**Why:** the headline shot; loops well and instantly communicates "kanban for agents."
1. Open the Trailhead board, light mode, all columns visible.
2. Let it sit for ~1s so the viewer reads the columns.
3. Drag **`TRAIL-11 Weather overlay`** from **Todo → In Progress**, hold briefly, then drag it back to
   **Todo** so the clip loops to its starting state.
4. Crop to the board area only. ~8s.

### 2 — `agent-session.gif` · Launch an agent → live streaming
**Why:** EH's killer differentiator. **This requires a real, live agent run** — the committed demo
sessions are static history; for the streaming + token-counter motion you must drive it live.
1. Open **`TRAIL-12 Community trail difficulty ratings`** (Grooming) — a ticket with room to groom.
2. Click **Start Task / Launch Agent**; pick the grooming phase.
3. Record the agent session panel: progress lines appearing in real time and the **token counter
   ticking up** in the card/modal.
4. Stop once a few progress lines and a non-zero token count are visible. ~10–12s.
5. Crop to the session panel. (Tip: a short, cheap grooming pass is enough — you only need motion.)

### 3 — `require-input.gif` · Human-in-the-loop
**Why:** shows the autonomous-loop-with-checkpoints model.
1. Open **`TRAIL-2 Cache offline map tiles`** — it sits in the **Require Input** swimlane with a real
   question ("what hard cap for the offline tile cache?").
2. Show the highlighted Require Input swimlane on the board, then open the ticket and show the
   question comment.
3. Type an answer in the reply box and post it. (For the "agent resumes" beat, chain a live grooming
   run as in shot #2.) ~10s.

### 4 — `finish-pr.gif` · Ready → diff → finish
**Why:** closes the loop from request to merged PR.
1. Open **`TRAIL-7 Crash when exporting an empty route`** (Ready, Critical bug).
2. Show the **diff/review** affordance in the modal and the pinned review-handoff comment.
3. Trigger **finish** and show the implementation link / PR being recorded and the card landing in
   **Done**. ~10s. _(Use a throwaway run if you want a real commit/PR; otherwise stage the visual.)_

### 5 — `ticket-modal.gif` · The ticket modal
1. Open **`TRAIL-1 Record GPS breadcrumb trail`** — it has a rich markdown body, full metadata
   (High / L / `feature`,`maps` / assignee Maya), and a layered history (plan comment → status
   changes → completed agent session → progress note).
2. Slowly scroll the modal: body → metadata → history timeline. ~9s.

### 6 — `search.gif` · Global fuzzy search
1. Click the header search (or its shortcut).
2. Type `gpx` and jump to **`TRAIL-9 Share a trail as a GPX file`**. ~5s.

### 7 — `workspace-switch.gif` · Multi-workspace
1. Open the header workspace dropdown showing **Trailhead** and at least one other workspace.
2. Switch to the other and back so the board visibly swaps. ~6s.
   _(Add a second demo or your FLUX board to the workspace list first.)_

### 8 — `docs-tree.gif` · In-product docs
1. Go to the **Docs** screen.
2. Expand the docs tree, open a page, show the rendered markdown (and the edit affordance). ~8s.

### 9 — `git-sync.gif` _(optional/advanced)_
Show **Settings → Git Sync** and the orphan-branch concept. Static/explanatory is fine.

### 10 — `scatter-gather.gif` _(optional/advanced)_
If a multi-agent run (planner + scout + interrogator) can be shown cleanly, capture the grouped
sessions on one ticket. Skip if it doesn't read clearly in a short loop.

---

## 6. Capture handoff checklist

- [ ] Demo workspace (`demo/`) added and selected; board shows the `TRAIL-*` tickets.
- [ ] Shots 1–8 recorded per the click-paths above.
- [ ] Every GIF run through `gifsicle` and under its size budget.
- [ ] Files dropped into `docs/media/` with the **exact** names from §4 (overwriting placeholders).
- [ ] README renders: hero loads near the top, gallery images all resolve.
- [ ] Optional shots (#9, #10) captured if they read cleanly.
