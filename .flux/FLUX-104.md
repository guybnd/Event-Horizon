---
assignee: unassigned
tags:
  - architecture
  - skills
  - installer
priority: Medium
effort: XL
implementationLink: 40733d608a31c0a52c74113fe6c330ab233aa45a
subtasks: []
history:
  - type: comment
    user: GitHub Copilot
    date: '2026-05-08T02:10:00.000Z'
    comment: >-
      Done. Committed as 40733d6. Shipped: 4 .docs/skills/ phase files, updated
      workflow-installer.ts (Option A/B per framework), Settings.tsx skill
      links with doc deep-links, deprecated .flux/skills/event-horizon-agent.md,
      updated copilot-instructions source. Fixed doc link path bug in Settings.
    id: c-2026-05-08t02-10-00
  - type: comment
    user: GitHub Copilot
    date: '2026-05-08T02:00:00.000Z'
    comment: >-
      Implementation complete. Created 4 .docs/skills/ phase files (orchestrator,
      grooming, implementation, release). Updated workflow-installer.ts: Copilot/Cline
      use Option B (separate files), all others use Option A (concatenated with XML
      module tags). Updated Settings.tsx to show all 4 skill source paths as clickable
      doc links. Added deprecation notice to .flux/skills/event-horizon-agent.md.
      Updated copilot-instructions source to reference all 4 installed skill files.
      Reinstalled into .github/skills/event-horizon/ — all 4 files confirmed present.
      Moving to Ready for review.
    id: c-2026-05-08t02-00-00
  - type: comment
    user: GitHub Copilot
    date: '2026-05-08T01:00:00.000Z'
    comment: >-
      Starting implementation. Plan: (1) create 4 .docs/skills/ split files from
      monolith, (2) update workflow-installer.ts for Option A/B framework split,
      (3) update Settings.tsx skill links, (4) deprecate old agent.md shim,
      (5) update copilot-instructions source to reference all 4 skill files.
    id: c-2026-05-08t01-00-00
  - type: activity
    user: Guy
    date: '2026-05-08T00:00:00.000Z'
    comment: Created ticket.
  - type: comment
    user: Guy
    date: '2026-05-07T15:37:10.311Z'
    comment: >-
      the skills should live also in the docs, so user can edit them if he so
      wishes

      the  setup tool will copy the skills from the docs, so that user can
      update his edited skills easily into his projects or propagate them

      it should be clarified that those files are not to be messed with like
      deleted for functionality to continue

      we should link to those docs and each specific skill from the settings
      section
    id: c-2026-05-07t15-37-10-311z
title: Split main skill into phase-specific skills and orchestrator
status: Done
createdBy: Guy
updatedBy: Guy
---
Currently, the main `event-horizon/SKILL.md` contains all instructions for grooming, implementing, formatting commits, and releasing. As the project grows, this risks instruction dilution and prompt fatigue for the agent.

We need to implement a multi-skill/orchestrator pattern:
1.  **Orchestrator Role:** Scope `copilot-instructions.md` (or the top-level SKILL.md) to route the agent based on the ticket's status (e.g., if `Grooming`, apply the grooming skill; if `Todo`/`In Progress`, apply the coding skill).
2.  **Phase-Specific Skills:** Break down the monolithic instructions into separate files:
    *   `event-horizon-grooming.md`: Rules for interpreting requirements, updating frontmatter, and handling `.flux` metadata.
    *   `event-horizon-implementation.md`: Rules for writing code, validating logic, testing, and formatting git commits.
    *   `event-horizon-release.md`: Rules for version bouncing, change logs, and running release tools.

**Goal:**
Ensure modular, maintainable knowledge base sections that the agent can intelligently select based on the active ticket context, preventing instruction overflow.
