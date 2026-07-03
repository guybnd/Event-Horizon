/**
 * @file kill-process-tree.ts
 *
 * Cross-platform teardown for a spawned child process and the descendant tree it leads —
 * escalating from a graceful signal (SIGTERM) to a forceful one (SIGKILL) as callers require.
 * Exists so that killing an agent process also reaps the MCP servers / git transport helpers it
 * spawned, instead of orphaning them into the stale-node-process leak.
 *
 * Callers: agent-session teardown (session-store.ts, the per-agent CLIs, routes/cli-session.ts —
 * killing the CLI process + its stdio MCP children when a session ends or is cancelled), the
 * dev-watcher restart path (dev-watcher.ts), and git-exec.ts, which tree-kills git and its network
 * transport helpers on timeout. See the {@link killProcessTree} doc for the POSIX process-group
 * nuance (`opts.group`).
 */
import { execFile } from 'child_process';
import type { ChildProcess } from 'child_process';

/**
 * Terminate an agent process AND its descendants — the MCP servers it spawned (serena, context7, …).
 *
 * On Windows `proc.kill()` maps to TerminateProcess on the agent process ALONE; its child MCP servers
 * are orphaned and accumulate across session churn / dev restarts (the stale-node-process leak that
 * wedges the machine — 100+ idle node procs). `taskkill /T` tree-kills the whole stack. On POSIX the
 * DEFAULT is the graceful single-PID signal — the stdio MCP children get EOF on their stdin when the
 * agent dies and exit on their own; pass a different signal if a caller needs a forceful kill there too.
 *
 * `opts.group` opts into a POSIX process-GROUP kill (`process.kill(-pid, signal)`). This reaps
 * descendants that a single-PID signal can't reach — notably git's network-transport helpers
 * (`git-remote-https`, `ssh`), which block on a socket read (not on stdin EOF) and so survive a kill
 * of only their parent `git`, keeping the socket (and the hang) alive. It REQUIRES the child to be a
 * process-group leader (spawned with `detached: true`); otherwise the negative-pid signal would hit
 * this engine's own group. Callers that don't spawn detached must NOT set it. See git-exec.ts (FLUX-997).
 *
 * Best-effort: a missing/already-gone pid is a no-op and errors are swallowed (the process may have
 * exited between the check and the kill, or the pid was reused).
 */
export function killProcessTree(
  proc: ChildProcess | null | undefined,
  signal: NodeJS.Signals = 'SIGTERM',
  opts: { group?: boolean } = {},
): void {
  if (!proc || !proc.pid) return;
  if (process.platform === 'win32') {
    execFile('taskkill', ['/F', '/T', '/PID', String(proc.pid)], { windowsHide: true }, () => {});
    return;
  }
  if (opts.group) {
    try {
      // Negative pid = the whole process group (child must be a group leader, i.e. detached).
      // Reaches git-remote-https/ssh grandchildren a single-PID kill would orphan.
      process.kill(-proc.pid, signal);
      return;
    } catch {
      /* group already gone, or child wasn't a leader — fall through to single-PID best-effort */
    }
  }
  try {
    proc.kill(signal);
  } catch {
    /* already gone */
  }
}
