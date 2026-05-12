---
title: Spike - Brainstorm a mode of work decoupled from the repo
status: Released
createdBy: Guy
updatedBy: Guy
assignee: unassigned
tags:
  - architecture
  - research
priority: Low
effort: S
implementationLink: ''
subtasks: []
history:
  - type: activity
    user: Guy
    date: '2026-05-08T00:26:07.123Z'
    comment: Created ticket.
  - type: status_change
    from: Todo
    to: Grooming
    user: Guy
    date: '2026-05-11T06:02:27.141Z'
  - type: activity
    user: Agent
    date: '2026-05-11T08:02:49.841Z'
    comment: Launched Claude Code session (3fcb06c7).
  - type: activity
    user: Agent
    date: '2026-05-11T08:04:09.491Z'
    comment: Updated description. Changed effort from M to S.
  - type: status_change
    from: Grooming
    to: Todo
    user: Agent
    date: '2026-05-11T08:04:16.839Z'
  - type: agent_message
    user: Claude Code
    date: '2026-05-11T08:04:25.827Z'
    comment: >-
      Grooming complete. Here's what was done:


      - **Ticket body rewritten** with a concrete plan: produce
      `.docs/event-horizon/architecture/decoupled-storage.md` covering four
      storage options (global `~/.flux/`, SQLite, centralized server, hybrid
      gitignore) with a comparison table and a clear recommendation.

      - **Effort downgraded** from `M` to `S` — this is writing only, no code.

      - **Tags preserved**: `architecture`, `research`.

      - **Moved to `Todo`**.


      No ambiguous choices requiring user input — the four options to compare
      are straightforwardly derived from the ticket requirements, and the output
      format (architecture doc in `.docs/`) is clear.
  - type: activity
    user: Agent
    date: '2026-05-11T08:04:25.831Z'
    comment: Claude Code session ended with code 0.
  - type: activity
    user: Agent
    date: '2026-05-11T08:05:10.368Z'
    comment: Launched Claude Code session (cbb41638).
  - type: status_change
    from: Todo
    to: In Progress
    user: Agent
    date: '2026-05-11T08:05:23.771Z'
  - type: comment
    user: Agent
    date: '2026-05-11T08:05:23.772Z'
    comment: >-
      Starting work: creating
      .docs/event-horizon/architecture/decoupled-storage.md with all four
      storage options and a recommendation.
    id: c-2026-05-11t08-05-23-772z
  - type: status_change
    from: In Progress
    to: Ready
    user: Agent
    date: '2026-05-11T08:06:17.339Z'
  - type: comment
    user: Agent
    date: '2026-05-11T08:06:17.340Z'
    comment: >-
      Created .docs/event-horizon/architecture/decoupled-storage.md covering all
      four storage options (global ~/.flux/, SQLite, cloud backend, gitignore
      hybrid) with a comparison table and a concrete recommendation.
      Recommendation: Option D (gitignore .flux ticket files) as the immediate
      step, Option A (global ~/.flux/) as a natural follow-on. No code changes
      made.
    id: c-2026-05-11t08-06-17-340z
  - type: agent_message
    user: Claude Code
    date: '2026-05-11T08:06:22.429Z'
    comment: >-
      FLUX-113 is now Ready. The document
      `.docs/event-horizon/architecture/decoupled-storage.md` has been created
      with:


      - **Problem statement** covering git log pollution, diff noise, agent
      confusion, and history archaeology

      - **Four options** documented with honest tradeoffs: global `~/.flux/`,
      SQLite, cloud backend, and gitignore hybrid

      - **Comparison table** across six dimensions

      - **Recommendation**: Option D (targeted `.gitignore` for ticket files) as
      the immediate low-cost fix, with Option A as a natural follow-on if
      cross-machine persistence becomes needed


      When you're ready to close this out, say `finish FLUX-113`.
  - type: activity
    user: Agent
    date: '2026-05-11T08:06:22.437Z'
    comment: Claude Code session ended with code 0.
  - type: comment
    user: Guy
    date: '2026-05-11T08:13:38.557Z'
    comment: >-
      further investigation: is there a way to keep the files for example on
      gitignore to stay out of commits, but have a way to sync them online with
      something in the git project itself? or select a file directory like
      google drive, or something like this?>
    replyTo: c-2026-05-11t08-06-17-340z
    id: c-2026-05-11t08-13-38-545z
  - type: status_change
    from: Ready
    to: In Progress
    user: Guy
    date: '2026-05-11T08:13:38.557Z'
    comment: Returned to work
  - type: activity
    user: Agent
    date: '2026-05-11T08:13:38.590Z'
    comment: Launched Claude Code session (053d120d).
  - type: status_change
    from: In Progress
    to: Ready
    user: Agent
    date: '2026-05-11T08:17:25.955Z'
  - type: comment
    user: Agent
    date: '2026-05-11T08:17:25.956Z'
    comment: >-
      Expanded architecture doc in response to follow-up question. Added Option
      E (gitignore + external sync layer) covering four sub-approaches: E1 cloud
      folder (Google Drive/Dropbox), E2 git orphan branch, E3 Syncthing P2P, E4
      rclone object storage. Updated comparison table and recommendation
      section. New recommendation: apply Option D immediately, then add E1
      (cloud folder) or E2 (git orphan branch) if multi-device or team sync is
      needed — ranked by setup friction.
    id: c-2026-05-11t08-17-25-956z
  - type: agent_message
    user: Claude Code
    date: '2026-05-11T08:17:36.412Z'
    comment: >-
      The architecture doc has been expanded and FLUX-113 is back to **Ready**.


      Here's what was added to
      `.docs/event-horizon/architecture/decoupled-storage.md`:


      **Option E — Gitignore + External Sync Layer** with four sub-options:


      - **E1 — Cloud folder (Google Drive, Dropbox, iCloud)**: symlink `.flux/`
      into a synced folder. Simplest path for personal multi-device. Cloud
      client handles background sync, no code changes needed.

      - **E2 — Git orphan branch**: create a `flux-data` branch on the same
      remote that shares no ancestry with `main`. Purely git-native, no external
      services, automatable via a post-commit hook. Best option if you want to
      stay inside git.

      - **E3 — Syncthing**: P2P sync with no cloud provider dependency. Good for
      privacy-first setups.

      - **E4 — rclone to object storage (S3, B2, GCS)**: fire-and-forget
      backup/restore, not a real-time collaboration tool.


      **Updated recommendation**: Option D first (gitignore), then E1 or E2
      depending on preference — E1 for the least friction if you already use a
      cloud folder, E2 for a clean git-native approach.


      When you're ready to close this out, say `finish FLUX-113`.
  - type: activity
    user: Agent
    date: '2026-05-11T08:17:36.435Z'
    comment: Claude Code session ended with code 0.
  - type: comment
    user: Guy
    date: '2026-05-12T01:36:04.658Z'
    comment: >-
      lets dig deeper a bit into the git branch thing, or google drive
      integration. how would that looks like, do we hold 2 instances of the
      "repo" of tickets one in the project for agent visibility and one in
      google drive? or do we need to provide the agent or IDE viewability into
      the other drive location somehow? whats the most straightforward approach
      from the perspective of the user just installs this tool, goes. through
      the startup menu quickly and gets started without too much hassle
    replyTo: c-2026-05-11t08-17-25-956z
    id: c-2026-05-12t01-36-04-649z
  - type: status_change
    from: Ready
    to: In Progress
    user: Guy
    date: '2026-05-12T01:36:04.658Z'
    comment: Returned to work
  - type: activity
    user: Agent
    date: '2026-05-12T01:36:04.709Z'
    comment: Launched Claude Code session (6045d30d).
  - type: status_change
    from: In Progress
    to: Ready
    user: Agent
    date: '2026-05-12T01:37:09.143Z'
  - type: comment
    user: Agent
    date: '2026-05-12T01:37:09.144Z'
    comment: >-
      Expanded E1 and E2 sections with a 'how agent visibility works' deep-dive.
      Added concrete diagrams for both approaches (Drive path config vs worktree
      setup), answered the two-instance question (no duplicate copies — engine
      API is the abstraction layer), and added a first-run UX section showing
      the single startup-wizard question that covers all four storage options.
      No code changes.
    id: c-2026-05-12t01-37-09-144z
  - type: agent_message
    user: Claude Code
    date: '2026-05-12T01:37:17.159Z'
    comment: >-
      FLUX-113 is back to **Ready**. Here's what was added to the architecture
      doc:


      **New section: "E1 and E2 in Depth — How Agent Visibility Works"**
      covering:


      - **The key insight**: the engine API is the abstraction layer — no
      duplicate copies needed. Agents always call `GET /api/tasks`; the engine
      resolves wherever `ticketStorePath` points.

      - **E1 (Google Drive) deep-dive**: one canonical store at a configurable
      path (e.g. `~/Google Drive/My Drive/event-horizon/my-project`). Engine
      reads/writes there, Drive client syncs in the background. No in-repo
      ticket copy except `config.json` which stays tracked.

      - **E2 (git orphan branch) deep-dive**: one worktree (`.flux-store/`)
      pointing to a `flux-data` orphan branch. Auto-commits + pushes on every
      write via a git hook. On a second machine, the installer restores it with
      a single `git worktree add` command.

      - **First-run UX**: a single startup-wizard question with four options
      (in-repo, cloud folder, git orphan, custom path). Option 1 is instant;
      Options 2 and 3 are fully automated one-time setup taking ~5 seconds.


      When you're ready to close, say `finish FLUX-113`.
  - type: activity
    user: Agent
    date: '2026-05-12T01:37:17.162Z'
    comment: Claude Code session ended with code 0.
  - type: comment
    user: Guy
    date: '2026-05-12T01:52:52.720Z'
    comment: >-
      Heres my opinion on direction. please analyze it and lets make a ticket
      out of it if we agree on the direction:


      For the most user-friendly and technically stable approach, I would
      structure the engine's storage layer like this:


      The "Invisible Sync" Implementation:

      Storage: Keep tickets in .flux/ (in-repo) by default for absolute
      beginners.


      The "Level Up" Prompt: When the user asks for multi-device sync, the
      engine offers to "Enable Cloud Sync via Git."


      Automation: The engine then:


      Creates the flux-data orphan branch.


      Moves existing tickets there.


      Adds .flux/ to the parent .gitignore.


      Sets up a File Watcher that handles the "Debounced Push" in the
      background.


      Final Verdict: Git is actually the world's most robust distributed
      database. Using an orphan branch isn't "gaming the system"—it’s using Git
      exactly as intended: to track and sync the state of text files. As long as
      you debounce the pushes, you will never hit a limit.


      2. Managing the "Commit Fever"

      To keep the system "easy to handle" and prevent the local .git folder from
      bloating, the Flux engine should implement two simple strategies:
      Debouncing and Periodic Squashing.


      Strategy A: Debouncing (The "Wait for Silence" rule)

      Instead of committing every time the Agent writes a line, the engine
      should wait for a "breath."


      Logic: When a file in .flux-store/ changes, start a 30-second timer.


      Action: If another change happens, reset the timer. If the timer hits
      zero, commit and push all changes at once.


      Result: You turn 50 tiny "save" events into 1 meaningful "sync" commit.


      Strategy B: Auto-Squashing (The "Garbage Collection" rule)

      If the flux-data branch eventually accumulates 10,000 commits of "Changed
      status to In Progress," it’s just wasted space.


      Logic: Every 1,000 commits, the engine can "reset" the branch history.


      Action: It performs a soft reset to the first commit and creates a new
      "Snapshot" commit that represents the current state of all tickets.


      Result: This keeps the .git folder tiny and the sync lightning-fast.



      The most robust approach is the Worktree + Orphan Branch. It treats Git as
      a database without letting it pollute your source history. It is
      "developer-native"—it uses the infrastructure you already have (the Git
      remote) and handles offline work perfectly.


      If you want to make it even easier for the user, you could implement a
      "Commit Debouncing" logic in the engine. Instead of pushing every single
      keystroke, it waits for 30 seconds of inactivity before "bundling" the
      ticket updates into a single background push. This keeps the flux-data
      history clean too.
    replyTo: c-2026-05-12t01-37-09-144z
    id: c-2026-05-12t01-52-52-712z
  - type: status_change
    from: Ready
    to: In Progress
    user: Guy
    date: '2026-05-12T01:52:52.720Z'
    comment: Returned to work
  - type: activity
    user: Agent
    date: '2026-05-12T01:52:52.796Z'
    comment: Launched Claude Code session (793db8a4).
  - type: status_change
    from: In Progress
    to: Ready
    user: Agent
    date: '2026-05-12T01:54:13.118Z'
  - type: comment
    user: Agent
    date: '2026-05-12T01:54:13.119Z'
    comment: >-
      Updated architecture doc recommendation to reflect Guy's direction. The
      Recommendation section now captures the full 'Invisible Sync'
      implementation plan: E2 (git orphan branch) as the recommended path, with
      the default staying in-repo for beginners and a progressive 'Enable Cloud
      Sync via Git' upgrade that automates orphan branch creation, worktree
      setup, and gitignore entries. Added detailed sections on debouncing
      (30-second silence timer collapses burst writes into one sync commit) and
      auto-squashing (reset every 1,000 commits to a snapshot). Also added
      multi-machine restore flow and an updated option ranking table. No code
      changes.
    id: c-2026-05-12t01-54-13-119z
  - type: agent_message
    user: Claude Code
    date: '2026-05-12T01:54:20.587Z'
    comment: >-
      The architecture doc has been updated with Guy's direction and FLUX-113 is
      now **Ready**.


      Here's what changed in the Recommendation section:


      - **Selected E2 (git orphan branch) as the primary recommendation**,
      aligned with Guy's "Invisible Sync" framing

      - **Progressive upgrade UX**: default stays in-repo (zero friction for
      beginners); a single opt-in command automates orphan branch creation,
      worktree setup, and gitignore wiring

      - **Debouncing details**: 30-second silence timer collapses burst agent
      writes into one sync commit

      - **Auto-squashing details**: history reset every 1,000 commits to keep
      the `.git` folder small

      - **Multi-machine restore**: `git worktree add .flux-store flux-data` as a
      one-time installer step

      - **Updated option ranking table** with E2 clearly marked as recommended


      ---


      **Should we create an implementation ticket?** Guy's comment ended with
      "lets make a ticket out of it if we agree on the direction" — the
      architecture doc now captures that direction in full. Say `finish
      FLUX-113` to commit and close it, then I can create a FLUX implementation
      ticket for the engine work (file watcher, debounced push, orphan branch
      setup wizard, auto-squash GC).
  - type: activity
    user: Agent
    date: '2026-05-12T01:54:20.591Z'
    comment: Claude Code session ended with code 0.
  - type: status_change
    from: Ready
    to: Done
    user: Guy
    date: '2026-05-12T02:26:50.114Z'
  - type: status_change
    from: Done
    to: Released
    user: Agent
    date: '2026-05-12T07:32:17.147Z'
order: 1
tokenMetadata:
  inputTokens: 735857
  outputTokens: 17850
  costUSD: 0.997257
  costIsEstimated: false
  cacheReadTokens: 587483
  cacheCreationTokens: 136777
version: 0.4.0
releasedAt: '2026-05-12T07:32:17.147Z'
releaseDocPath: release-notes/0.4.0
---
## Plan

This is a pure research spike. The deliverable is a single architecture document under `.docs/event-horizon/architecture/decoupled-storage.md` that compares storage models and makes a concrete recommendation for decoupling tickets from the application repository.

### Context

Currently `.flux/` contains ~200 markdown ticket files committed into the repo. Every ticket update (status change, comment, board move) lands as a git commit, polluting history with project management noise and obscuring real code changes. The architecture doc at `.docs/event-horizon/architecture/overview.md` explicitly calls this a design choice (the repository itself is the application's data store), but that comes at a cost.

### Deliverable

Create `.docs/event-horizon/architecture/decoupled-storage.md` covering:

1. **Problem statement** - what git spam costs (noisy log, agent confusion, diff noise, history archaeology)
2. **Option A: Global ~/.flux/ directory** - per-project subdirs keyed by workspace path or project slug. Files stay local, no git involvement. Good fit for solo use, easy to implement.
3. **Option B: SQLite in ~/.event-horizon/** - single structured DB per user, or per-workspace DB alongside settings. Enables queries, faster indexing, no file-per-ticket clutter. Still local-first.
4. **Option C: Centralized server / cloud backend** - hosted API, multi-device sync, team collaboration. Highest setup cost, requires auth/network, removes local-first guarantees.
5. **Option D: Hybrid (keep .flux/ but gitignore it)** - minimal change, preserves current format, simply excludes tickets from version control. Preserves agent compatibility.
6. **Comparison table** across: setup complexity, collaboration support, offline/local support, agent read/write compatibility, migration cost from current state, git cleanliness.
7. **Recommendation** - a ranked recommendation with rationale.

### Acceptance Criteria

- [ ] `.docs/event-horizon/architecture/decoupled-storage.md` exists and is accessible in the Docs screen
- [ ] All four options are documented with honest tradeoffs
- [ ] A clear recommendation is stated with rationale
- [ ] No code changes are made
