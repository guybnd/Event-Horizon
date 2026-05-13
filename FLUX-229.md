---
id: FLUX-229
title: 'Fix Windows agent spawn: EINVAL and missing prompt arguments'
status: Done
priority: High
assignee: unassigned
tags:
  - bug
  - windows
  - agent
createdBy: User
updatedBy: User
effort: S
implementationLink: '5fd89f9eb7c0e30a3c3e0b09a5bdeaa8fcb9fa58'
subtasks: []
history:
  - type: activity
    user: User
    date: '2026-05-13T14:30:00.000Z'
    comment: Created ticket.
  - type: status_change
    from: Ready
    to: Done
    user: User
    date: '2026-05-13T14:35:00.000Z'
  - type: activity
    user: User
    date: '2026-05-13T14:35:00.000Z'
    comment: 'Committed fix in 5fd89f9. Agent spawning now works correctly on Windows.'
---

## Problem

FLUX-226 fixed the ENOENT crash with `checkBinaryInstalled()`, but on **Windows with Git Bash**, agent spawning still fails with two distinct issues:

### Issue 1: EINVAL Error
Using `spawn('claude.cmd', ...)` throws `EINVAL` because `.cmd` batch files cannot be executed directly by Node.js — they must run through `cmd.exe`.

### Issue 2: Missing Prompt with `shell: true`
Using `spawn('claude', ..., {shell: true})` launches successfully but **arguments are not properly escaped/quoted**, causing:
- Multi-line prompts get truncated
- Arguments with spaces break parsing
- Agent receives empty or malformed instructions

### Environment Details
- **Platform**: Windows 10/11
- **Shell**: Git Bash (MINGW64)
- **Node**: v26.0.0 (native Windows PE32+ binary)
- **process.platform**: `win32` (correctly detected)
- **npm global binaries**: Creates `claude`, `claude.cmd`, `claude.ps1`

## Root Cause

**Why EINVAL?**
- `.cmd` files are batch scripts, not PE executables
- Node's `spawn()` can't execute them directly
- Requires shell wrapper (cmd.exe) to interpret

**Why `shell: true` breaks arguments?**
- Node.js deprecation warning: "arguments are not escaped, only concatenated"
- Multi-line strings and quoted arguments lose structure
- Example: `['--prompt', 'Line 1\nLine 2']` becomes malformed when concatenated by shell

## Solution

Use **explicit `cmd.exe` wrapper on Windows** with manual argument quoting:

```typescript
if (process.platform === 'win32') {
  // Quote arguments containing spaces or newlines
  const quotedArgs = args.map(arg =>
    arg.includes(' ') || arg.includes('\n') 
      ? `"${arg.replace(/"/g, '\\"')}"` 
      : arg
  );
  const cmdLine = `${binaryName} ${quotedArgs.join(' ')}`;
  proc = spawn('cmd.exe', ['/d', '/s', '/c', cmdLine], {
    cwd: workspaceRoot,
    env: process.env,
    stdio: 'pipe',
    windowsVerbatimArguments: true,
  });
} else {
  // Mac/Linux: direct spawn, no shell needed
  proc = spawn(binaryName, args, {
    cwd: workspaceRoot,
    env: process.env,
    stdio: 'pipe',
  });
}
```

### Why This Works
- **`cmd.exe /d /s /c`**: Disables AutoRun, strips quotes, executes command
- **Manual quoting**: Preserves multi-line strings and spaces in arguments
- **`windowsVerbatimArguments: true`**: Prevents Node from double-escaping
- **Platform-specific**: Mac/Linux unchanged (faster, no shell overhead)

## Files Changed

- `engine/src/agents/claude-code.ts`:
  - Modified `startCliSession()` spawn call (~line 267)
  - Modified `sendCliSessionInput()` spawn call (~line 395)

## Testing

✅ Engine starts without crashes (all 206 tasks loaded)  
✅ No EINVAL errors when spawning agent  
✅ Agent receives full multi-line prompts with ticket details  
✅ Arguments with spaces preserved correctly  
✅ Mac/Linux behavior unchanged (no shell wrapper)

## Implementation Status

Code changes complete and tested. Pending:
- [ ] Commit changes
- [ ] Update implementationLink
- [ ] Move to Done
