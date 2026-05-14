---
id: FLUX-265
title: Fix GitHub Actions release workflow — CJS/ESM and macOS ARM
status: In Progress
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
      Plan: (1) Convert dist-source.js, package-release.js, patch-pe.js from CJS require() to ESM imports
      (consistent with build.js). (2) Update pkg target from node18-macos-x64 to node22-macos-arm64
      for ARM runners. (3) Update all script references.
    id: c-2026-05-14t10-47-00-000z
  - type: status_change
    from: Grooming
    to: In Progress
    user: Agent
    date: '2026-05-14T10:47:00.000Z'
---

## Problem / Motivation

The GitHub Actions release workflow (`release.yml`) fails on every tag push:

1. **CJS/ESM mismatch**: `dist-source.js`, `package-release.js`, and `patch-pe.js` use `require()` but `engine/package.json` has `"type": "module"`, causing `ReferenceError: require is not defined in ES module scope`.
2. **macOS ARM target**: `package-release.js` uses `node18-macos-x64` pkg target but `macos-latest` runners are now ARM64.

## Fix

Convert all three CJS scripts to ESM imports (matching `build.js` convention). Update pkg target to `node22-macos-arm64`.
