---
id: FLUX-254
title: Fix Agent AttachConsole failed error on tool execution
status: Todo
priority: High
createdBy: Guy
updatedBy: Guy
assignee: unassigned
tags:
  - bug
  - engine
history:
  - type: activity
    user: Guy
    date: '2026-05-14T12:55:00.000Z'
    comment: Created ticket to address tool execution failures.
---

## Problem / Motivation

During ticket implementation (notably FLUX-251), the Gemini agent failed to update ticket descriptions despite successfully completing the code work. The logs revealed a series of `AttachConsole failed` errors originating from `node-pty/conpty_console_list_agent.js`.

This error typically occurs on Windows when a child process attempts to interact with a console that is already being managed or has been detached. It prevents the agent from reliably calling tools like `replace` or `write_file` at the end of a long session.

## Implementation Plan

1.  **Investigate the use of `node-pty` and `conpty`** in the agent execution pipeline.
2.  **Check Console Management**: Check if the engine is correctly managing console handles when spawning agent processes on Windows.
3.  **Improve error recovery**: If a tool call fails with `AttachConsole`, the agent should retry or the engine should provide a fallback mechanism.
4.  **Enhanced Logging**: Add better logging in the engine for tool execution failures to distinguish between logic errors and environment/PTY issues.
