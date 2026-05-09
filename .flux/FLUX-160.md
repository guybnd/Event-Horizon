---
assignee: Agent
tags:
  - architecture
  - research
priority: Medium
effort: S
implementationLink: ''
subtasks: []
history:
  - type: activity
    user: Guy
    date: '2026-05-09T07:45:37.155Z'
    comment: Created ticket.
  - type: activity
    user: Agent
    date: '2026-05-09T07:45:39.252Z'
    comment: Launched Claude Code session (02e4996d).
  - type: status_change
    from: Grooming
    to: Todo
    user: Agent
    date: '2026-05-09T07:49:08.593Z'
  - type: comment
    user: Agent
    date: '2026-05-09T07:49:08.594Z'
    comment: >-
      Grooming complete. Researched current .md+YAML format against JSON, split
      JSON+MD, and SQLite alternatives. Verdict: keep the current format — the
      fragility is in the write path, not the format. Ticket body contains full
      pros/cons table, refactor cost estimates, and concrete hardening
      recommendations for a follow-up.
    id: c-2026-05-09t07-49-08-594z
  - type: status_change
    from: Todo
    to: Done
    user: Guy
    date: '2026-05-09T07:53:35.697Z'
  - type: status_change
    from: Done
    to: Released
    user: Agent
    date: '2026-05-09T08:10:27.358Z'
title: reevaluate card architecture
status: Released
createdBy: Guy
updatedBy: Guy
version: 0.2.0
releasedAt: '2026-05-09T08:10:27.358Z'
releaseDocPath: release-notes/0.2.0
---

## Research: Is Markdown+YAML the Right Storage Format for Tickets?

This ticket is a research and analysis task. There is no code change to ship. The deliverable is a written verdict — with pros, cons, migration cost, and a recommendation — for whether the current `.flux/*.md` format should be kept or replaced.

---

## Current Architecture

Each ticket is a single file in `.flux/` named `FLUX-NNN.md`. The format is:

```
---
YAML frontmatter (all structured fields)
---

Markdown body (free-text description, plan, acceptance criteria)
```

Parsing uses `gray-matter` (which uses `js-yaml` under the hood). Writes use `matter.stringify()`. There are currently **153 ticket files**. A `patch-ticket` CLI was added specifically to avoid direct YAML edits because those frequently broke formatting.

---

## Format Comparison

### Option A: Markdown + YAML Frontmatter (current)

**Pros:**
- Human-readable and directly editable in any text editor or IDE
- Body is native markdown — renders in GitHub, VS Code, and the portal without transformation
- Git-friendly: diffs are meaningful, history is line-level, blame works on comments
- AI/agent-friendly: agents can read, reason about, and write tickets as prose + structured data in one pass
- No database or additional tooling required — `ls .flux/` is the full query layer
- Installer is trivially simple: copy files into a directory
- Field additions are zero-migration: add a key to frontmatter, older files just return `undefined`

**Cons:**
- YAML is fragile: tab indentation, special characters in strings, or a misplaced colon silently corrupts a ticket and drops it from the board
- `gray-matter` does not enforce schema — invalid types pass silently
- History (the YAML array) is the most mutation-heavy field and also the most fragile to hand-edits
- No atomic writes: a crash mid-write leaves a partial file
- Concurrent writes require manual re-read-then-write logic (already implemented but adds complexity)
- Harder to query across tickets (no index, must read and parse every file)
- The `patch-ticket` CLI exists purely to paper over YAML write fragility

---

### Option B: Pure JSON (`FLUX-NNN.json`)

**Pros:**
- Strict schema possible with JSON Schema or Zod — invalid structure throws immediately
- Fewer edge cases than YAML: no indentation sensitivity, no implicit type coercion, no multiline string ambiguity
- `JSON.parse` / `JSON.stringify` are battle-tested and always available
- Easier to validate atomically before writing

**Cons:**
- Body/description field becomes a JSON string — markdown stored as escaped text, not native markdown
- No human-readable diffs: a long comment addition changes one huge string blob
- Much worse for AI agents: body prose is buried inside a JSON string, harder to read and write correctly
- Less intuitive to edit manually
- Git diffs are noisier for body changes
- Frontmatter + body separation is lost — everything is flat fields

---

### Option C: Split format — JSON frontmatter + MD body (`FLUX-NNN.json` + `FLUX-NNN.md`)

**Pros:**
- Structured fields in strict JSON, free-form body in native markdown
- Best of both worlds for editing and querying

**Cons:**
- Two files per ticket doubles the file count and complicates atomic writes
- The engine must read and join two files on every load
- More moving parts for the installer and any file-watching logic
- Git history harder to follow (file pairs must be kept in sync)

---

### Option D: SQLite

**Pros:**
- Full relational queries, indexes, joins across 153+ tickets in milliseconds
- ACID transactions — no partial writes, no corruption from crashes
- Schema can be enforced with NOT NULL constraints and typed columns
- No custom write logic needed for concurrent access

**Cons:**
- Binary file — git diffs are meaningless, history shows only "changed"
- Loses the entire "files are source of truth" property that makes the agent workflow natural
- Adds a dependency (better-sqlite3 or similar)
- Breaks the installer's simplicity: setup now requires schema initialization
- No easy manual editing; ticket state is opaque without a GUI or CLI
- Fundamentally changes the nature of the tool — it stops being "just files in your repo"

---

## Refactor Cost Assessment

| Change | Scope | Effort |
|---|---|---|
| MD → JSON (pure) | Rewrite engine read/write, portal body renderer must handle escaped MD string | L |
| MD → split JSON+MD | Two files per ticket, engine join logic, installer update | XL |
| MD → SQLite | Full persistence layer rewrite, lose git-native story | XL |
| MD → MD (stay, harden) | Add schema validation, atomic writes, improve YAML error surfacing | S–M |

---

## Recommendation

**Keep Markdown + YAML, but harden the write path.**

The current format's biggest strengths — native markdown body, human-readable diffs, AI-legibility, zero-migration field additions — are core to what makes Event Horizon work well with agents and with git. None of the alternatives preserve all three.

The fragility is real but localised: it's almost entirely in the YAML write path, not the format choice. The `patch-ticket` CLI exists specifically to handle this, and the known failure mode (tab indentation, broken YAML) is detectable and recoverable.

Concrete hardening steps worth considering (not in scope for this ticket, but should be filed separately):

1. **Atomic writes**: write to a temp file then `rename()` — prevents partial-write corruption.
2. **Post-write validation**: after every write, re-parse the file and log `[FLUX VALIDATION ERROR]` immediately rather than at next load.
3. **Schema validation**: add a lightweight Zod schema over frontmatter fields so type errors surface at write time.
4. **Surface YAML errors in the portal**: currently errors only appear in the engine console; the portal could show a banner for tickets that failed to parse.

These are S-effort changes that would close the gap without abandoning the format's strengths.

---

## Verdict

`.md` with YAML frontmatter is the right choice for this system. The fragility is a write-path problem, not a format problem. A full migration to JSON or SQLite would cost L–XL effort, break the git-native and agent-legible properties, and not meaningfully improve the user experience for the only real failure mode (YAML corruption on manual edits).
