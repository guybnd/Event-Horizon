---
assignee: unassigned
tags: []
priority: None
effort: None
implementationLink: ''
subtasks: []
history:
  - type: activity
    user: Guy
    date: '2026-05-26T12:32:37.152Z'
    comment: Created ticket.
  - type: agent_session
    sessionId: 4c941b1b-5fb2-42f5-bedb-a482faac5206
    startedAt: '2026-05-26T12:32:38.235Z'
    status: active
    progress: []
    user: Claude Code
    date: '2026-05-26T12:32:38.235Z'
id: FLUX-331
title: help verify this bug of why MCP not working for some customers
status: Grooming
createdBy: Guy
updatedBy: Agent
---
they report:  
The problem is clear — the exe starts the HTTP engine (port 3067) instead of responding with the MCP JSON-RPC protocol on stdio. It needs extra time to get to the MCP portion, or it's outputting the startup logs to stdout which breaks the JSON-RPC framing. Let me check if there's a version with different flags.

**Bash** Check event-horizon exe help/flags

IN

```
"c:/GitHub/event-horizon-win-v0.10.0.exe" --help 2>&1 | head -30
```

OUT

```
Event Horizon Engine running on port 3067
Portal:   http://localhost:3067
Workspace: C:\GitHub\HomeUp
[storage-sync] Pulled latest flux-data on startup
Loaded doc: architecture
Loaded doc: database-schema
Loaded doc: event-horizon/agent-integrations
Loaded doc: event-horizon/architecture/decoupled-storage
Loaded doc: event-horizon/architecture/docs-workspace
Loaded doc: event-horizon/architecture/overview
Loaded doc: event-horizon/architecture/repository-map
Loaded doc: event-horizon/architecture/ticket-model
Loaded doc: event-horizon/configuration
Loaded doc: event-horizon/development
Loaded doc: event-horizon/INDEX
Loaded doc: event-horizon/installation
Loaded doc: event-horizon/mcp-server
Loaded doc: event-horizon/model-pricing
Loaded doc: event-horizon/multi-agent-cli-research
Loaded doc: event-horizon/project-overview
Loaded doc: event-horizon/troubleshooting/windows-agent-spawn
Loaded doc: event-horizon/workflow/ticket-interactions
Loaded doc: event-horizon/workflow/ticket-lifecycle
Loaded doc: event-horizon/workflow/workflow-install
Loaded doc: INDEX
Loaded doc: project-overview
Loaded doc: secrets
Loaded doc: style-guide
Loaded config
Loaded 15 pricing entries from model-pricing.md
```

Found the problem. The exe is printing its startup logs to **stdout**, which corrupts the MCP JSON-RPC channel — Claude Code sees the logs instead of a valid `initialize` response, so the tools never register.

The fix is to redirect stderr in the `.mcp.json` config, or suppress logs. Let me check what options are available:
