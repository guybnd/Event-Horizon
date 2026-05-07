---
title: Event Horizon Release
order: 4
---
> ⚠️ DO NOT DELETE — This file is required for the Event Horizon agent workflow. Deleting it will break release orchestration behaviour.

## Phase: Release Orchestration
Scope: Version bumping, changelog generation, and running the release tool.

---

# Event Horizon Agent — Release Skill

Version: 2.0.0

## When This Skill Applies

Load this skill when the user asks to "create a release", "release the current version", or run a release.

## Release Workflow

1. Determine the version number (e.g. `v1.2.0`). If the user hasn't provided one, ask them for the target version label or propose one based on recent changes and semantic versioning.
2. Provide a brief summary of what's currently in `Done` status and confirm they are ready to be released under this version.
3. Execute the release script via `npm run flux:release <version>` in the `engine` directory or root workspace. This script automatically gathers `Done` tickets, applies the version, generates release notes in the `.docs` system according to Release Settings, and moves the tickets to `Released`.
4. Review the generated release notes in the `.docs` directory and optionally adjust them if they need more narrative context beyond the ticket summaries.
5. Create a git commit to clean up the git status immediately after generating the release files and modifying the tickets. Use a sensible message like `Release <version>`.
6. Notify the user that the release was successfully created, the tickets were moved to `Released`, committed, and point them to the generated release notes doc or the Releases view.
