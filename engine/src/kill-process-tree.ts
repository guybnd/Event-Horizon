import { execFile } from 'child_process';
import type { ChildProcess } from 'child_process';

/**
 * Terminate an agent process AND its descendants — the MCP servers it spawned (serena, context7, …).
 *
 * On Windows `proc.kill()` maps to TerminateProcess on the agent process ALONE; its child MCP servers
 * are orphaned and accumulate across session churn / dev restarts (the stale-node-process leak that
 * wedges the machine — 100+ idle node procs). `taskkill /T` tree-kills the whole stack. On POSIX we
 * keep the graceful signal — the stdio MCP children get EOF on their stdin when the agent dies and
 * exit on their own; pass a different signal if a caller needs a forceful kill there too.
 *
 * Best-effort: a missing/already-gone pid is a no-op and errors are swallowed (the process may have
 * exited between the check and the kill, or the pid was reused).
 */
export function killProcessTree(
  proc: ChildProcess | null | undefined,
  signal: NodeJS.Signals = 'SIGTERM',
): void {
  if (!proc || !proc.pid) return;
  if (process.platform === 'win32') {
    execFile('taskkill', ['/F', '/T', '/PID', String(proc.pid)], { windowsHide: true }, () => {});
  } else {
    try {
      proc.kill(signal);
    } catch {
      /* already gone */
    }
  }
}
