---
id: FLUX-265
title: Fix GitHub Actions release workflow — CJS/ESM and macOS ARM
status: Released
priority: High
effort: S
assignee: unassigned
tags:
  - engine
  - ci
createdBy: Guy
updatedBy: Agent
history:
  - type: activity
    user: Guy
    date: '2026-05-14T10:46:00.000Z'
    comment: Created ticket.
  - type: comment
    user: Agent
    date: '2026-05-14T10:47:00.000Z'
    comment: >-
      Plan: (1) Convert dist-source.js, package-release.js, patch-pe.js from CJS
      require() to ESM imports (consistent with build.js). (2) Update pkg target
      from node18-macos-x64 to node22-macos-arm64 for ARM runners. (3) Update
      all script references.
    id: c-2026-05-14t10-47-00-000z
  - type: status_change
    from: Grooming
    to: In Progress
    user: Agent
    date: '2026-05-14T10:47:00.000Z'
  - type: comment
    user: Agent
    date: '2026-05-14T10:52:00.000Z'
    comment: >-
      Completed. Converted dist-source.js, package-release.js, patch-pe.js from
      CJS require() to ESM imports. Updated pkg targets: node18-macos-x64 →
      node22-macos-arm64, node18-win-x64 → node22-win-x64. All scripts parse,
      dist-source runs past imports successfully, vitest passes. Commit 23f4f3b.
    id: c-2026-05-14t10-52-00-000z
  - type: status_change
    from: In Progress
    to: Done
    user: Agent
    date: '2026-05-14T10:52:00.000Z'
  - type: status_change
    from: Done
    to: Released
    user: Agent
    date: '2026-05-14T10:59:32.395Z'
implementationLink: 23f4f3b
version: v0.6.0
releasedAt: '2026-05-14T10:59:32.395Z'
releaseDocPath: release-notes/v0.6.0
---

## Problem / Motivation

The GitHub Actions release workflow (`release.yml`) fails on every tag push:

1. **CJS/ESM mismatch**: `dist-source.js`, `package-release.js`, and `patch-pe.js` use `require()` but `engine/package.json` has `"type": "module"`, causing `ReferenceError: require is not defined in ES module scope`.
2. **macOS ARM target**: `package-release.js` uses `node18-macos-x64` pkg target but `macos-latest` runners are now ARM64.

## Fix

Convert all three CJS scripts to ESM imports (matching `build.js` convention). Update pkg target to `node22-macos-arm64`.
