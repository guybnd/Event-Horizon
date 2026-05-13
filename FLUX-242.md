---
priority: Critical
effort: S
assignee: Agent
tags:
  - bugfix
  - infrastructure
implementationLink: d5f8125e1b4c9528a2e8c42a17221c662c7e0c45
id: FLUX-242
title: 'Fix engine crash: ES module compatibility'
status: Done
createdBy: Unknown
updatedBy: Unknown
history:
  - type: activity
    user: Unknown
    date: '2026-05-13T11:57:41.934Z'
    comment: Created ticket.
---
## Problem
Engine crashed on startup with `ReferenceError: __dirname is not defined in ES module scope`. TypeScript 6 with strict module syntax checking (`verbatimModuleSyntax`) detected mismatch between package.json declaring `"type": "commonjs"` while source files used ES module syntax.

## Solution
1. Changed `engine/package.json` to `"type": "module"` to match actual ES module syntax used throughout codebase
2. Added ES module equivalent of `__dirname` in `workspace.ts` using `fileURLToPath(import.meta.url)`

## Validation
- Engine starts successfully
- Health check endpoint responds: `http://localhost:3067/api/health`
- No TypeScript compilation errors in module resolution

## Files Changed
- `engine/package.json`: Changed type to module
- `engine/src/workspace.ts`: Added __dirname polyfill for ES modules
