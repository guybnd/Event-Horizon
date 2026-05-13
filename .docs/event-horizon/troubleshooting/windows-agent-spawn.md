---
order: 100
title: Windows Agent Spawn Issues
---

# Windows Agent Spawn Issues

## Problem

On Windows systems, especially when using Git Bash, launching Claude Code agents may fail with:
- `Error: spawn EINVAL`
- `Error: spawn claude ENOENT`  
- Agent starts but receives no instructions (empty prompt)

## Root Causes

### 1. EINVAL Error

**Symptom**: `spawn EINVAL` when trying to launch agent

**Cause**: On Windows, npm global installs create three files:
- `claude` (bash script for Git Bash/WSL)
- `claude.cmd` (Windows batch wrapper)
- `claude.ps1` (PowerShell wrapper)

Batch `.cmd` files are **not** PE executables and cannot be spawned directly by Node.js. They must run through `cmd.exe`.

**Fixed in**: FLUX-229 (commit 5fd89f9)

### 2. Missing or Truncated Prompts (Initial Fix)

**Symptom**: Agent launches successfully but receives empty or partial instructions

**Cause**: Using Node's `shell: true` option concatenates arguments without proper escaping. Multi-line strings and arguments with spaces get malformed.

**Initial fix**: FLUX-229 (commit 5fd89f9) - Used cmd.exe wrapper with manual quoting
**Problem with initial fix**: cmd.exe buffers/corrupts stdio pipes, breaking JSON stream output

### 3. Missing Real-Time Status Updates

**Symptom**: No "Thinking" status, no tool activity indicators, no progress feedback in UI

**Cause**: cmd.exe wrapper from FLUX-229 fix corrupts the `--output-format stream-json` output, preventing the engine from parsing activity updates

**Fixed in**: FLUX-237 (commit 6b85feb) - Spawn claude.exe directly instead of using cmd.exe

## Solution (Implemented)

Event Horizon now uses **platform-specific spawn strategies**:

### Windows
```typescript
if (process.platform === 'win32') {
  // Resolve the actual claude.exe path and spawn directly
  const npmPrefix = execSync('npm prefix -g', { encoding: 'utf8' }).trim();
  const exePath = path.join(npmPrefix, 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe');
  
  if (!fs.existsSync(exePath)) {
    throw new Error('claude.exe not found');
  }
  
  proc = spawn(exePath, args, {
    cwd: workspaceRoot,
    env: process.env,
    stdio: 'pipe',
  });
}
```

**Why this works**:
- Spawns the actual `.exe` directly, not through cmd.exe or bash wrapper
- Preserves stdio pipes for JSON stream output capture
- Enables real-time "Thinking" status and tool activity indicators
- Uses `npm prefix -g` to locate global npm packages reliably

### Mac/Linux
```typescript
else {
  // Direct spawn, no shell overhead
  proc = spawn(binaryName, args, {...});
}
```

## Verification

After the fix (commit 5fd89f9), verify agent spawning works:

1. **Start the engine**: `npm run dev` from `engine/` directory
2. **Open portal**: Navigate to `http://localhost:3067`
3. **Create test ticket**: Any simple task
4. **Launch agent**: Click "Start Agent Session"
5. **Check output**: Agent should receive full ticket details including:
   - Ticket ID and title
   - Multi-line description (if present)
   - Current status
   - Action instructions

### Expected Behavior
```
You are working on ticket FLUX-XXX.
Title: Test ticket
Current status: Todo

Ticket description:
Multi-line description
with proper newlines
preserved

Latest activity:
- [2026-05-13] User: Created ticket.

The ticket is in Todo. Begin implementation...
```

### Signs of Failure
- Agent responds with "What would you like to work on?" (no context)
- Spawn fails with EINVAL error
- Engine crashes with "Unhandled 'error' event"

## Environment Details

This fix specifically addresses:
- **OS**: Windows 10/11
- **Shell**: Git Bash (MINGW64), PowerShell, CMD
- **Node**: Native Windows builds (PE32+ executable)
- **npm globals**: Installed via `npm install -g @anthropic-ai/claude-code`

The fix detects `process.platform === 'win32'` and applies the cmd.exe wrapper automatically.

## Related Issues

- **FLUX-226**: Added `checkBinaryInstalled()` pre-check (catches ENOENT before spawn)
- **FLUX-229**: Fixed EINVAL and argument quoting (cmd.exe wrapper approach)
- **FLUX-237**: Fixed stdio capture by spawning claude.exe directly (current solution)

Evolution of the fix:
1. FLUX-226 catches missing CLI **before** spawn attempt
2. FLUX-229 fixed spawn but broke stdio capture with cmd.exe wrapper
3. FLUX-237 fixed stdio capture by spawning .exe directly while preserving multi-line arg support

## Historical Context

**Node.js spawn() on Windows**:
- Node detects `.cmd`/`.bat` files and normally wraps them in shell automatically
- But in hybrid environments (Git Bash + Windows Node), detection can fail
- `shell: true` fixes spawn but breaks argument escaping (Node deprecation warning)
- Manual cmd.exe wrapper gives full control over quoting

**Why not shell: true everywhere?**
- Security: shell=true enables command injection if args aren't sanitized
- Performance: Mac/Linux don't need shell overhead
- Correctness: shell=true's concatenation breaks complex args
