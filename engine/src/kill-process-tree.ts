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
  opts: { group?: boolean; label?: string } = {},
): void {
  if (!proc || !proc.pid) return;
  if (process.platform === 'win32') {
    execFile('taskkill', ['/F', '/T', '/PID', String(proc.pid)], { windowsHide: true }, () => {});
    // FLUX-1207: `/T` requires the target pid to still be alive to walk its tree — exactly false
    // whenever this fires from a `proc.on('exit', ...)` handler. Always also try the graph-walk
    // reaper, which can find true descendants via ParentProcessId even after `proc.pid` itself
    // has already exited.
    killDescendantsByPid(proc.pid)
      .then((killed) => {
        if (killed.length > 0) {
          console.warn(
            `[kill-process-tree]${opts.label ? ` ${opts.label}:` : ''} reaped orphaned descendant pid(s) ${killed.join(', ')} of pid ${proc.pid}`,
          );
        }
      })
      .catch(() => {});
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

/**
 * Windows-only: find and best-effort kill every still-alive descendant of `pid`, walking the
 * FULL process tree via `Win32_Process.ParentProcessId` — not just `taskkill /T`, which requires
 * `pid` itself to still resolve to a live process (exactly the state whenever a session's exit
 * handler runs) and so silently reaches zero descendants once the top PID has already exited.
 * `ParentProcessId` keeps recording each descendant's true parent chain even after intervening
 * ancestors have exited, so a BFS anchored on a last-known pid can still find and kill orphans
 * `taskkill /T` alone cannot reach (FLUX-1207).
 *
 * No-op on POSIX (no incident observed there). Best-effort: never throws — a stale/reused pid, an
 * empty process table, or a failed query all resolve to `[]`.
 *
 * `deps` lets tests inject a fake process table + fake killer so no real process is spawned.
 */
export async function killDescendantsByPid(
  pid: number,
  deps: {
    listProcesses?: () => Promise<Array<{ pid: number; ppid: number }>>;
    kill?: (pid: number) => void;
  } = {},
): Promise<number[]> {
  if (process.platform !== 'win32') return [];
  const listProcesses = deps.listProcesses ?? defaultListWin32Processes;
  const kill = deps.kill ?? defaultKillWin32Pid;
  let table: Array<{ pid: number; ppid: number }>;
  try {
    table = await listProcesses();
  } catch {
    return [];
  }
  const childrenByParent = new Map<number, number[]>();
  for (const { pid: cpid, ppid } of table) {
    if (!childrenByParent.has(ppid)) childrenByParent.set(ppid, []);
    childrenByParent.get(ppid)!.push(cpid);
  }
  const descendants: number[] = [];
  const seen = new Set<number>();
  const queue = [...(childrenByParent.get(pid) ?? [])];
  while (queue.length > 0) {
    const next = queue.shift()!;
    if (seen.has(next)) continue;
    seen.add(next);
    descendants.push(next);
    queue.push(...(childrenByParent.get(next) ?? []));
  }
  for (const descendantPid of descendants) {
    try {
      kill(descendantPid);
    } catch {
      /* already gone */
    }
  }
  return descendants;
}

function defaultListWin32Processes(): Promise<Array<{ pid: number; ppid: number }>> {
  return new Promise((resolve) => {
    execFile(
      'powershell',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId | ConvertTo-Json -Compress',
      ],
      { windowsHide: true, maxBuffer: 16 * 1024 * 1024 },
      (err, stdout) => {
        if (err || !stdout) return resolve([]);
        try {
          const parsed: unknown = JSON.parse(String(stdout));
          const rows: unknown[] = Array.isArray(parsed) ? parsed : [parsed];
          resolve(
            rows
              .map((r) => {
                const row = r as { ProcessId?: unknown; ParentProcessId?: unknown };
                return { pid: Number(row.ProcessId), ppid: Number(row.ParentProcessId) };
              })
              .filter((r) => Number.isFinite(r.pid) && Number.isFinite(r.ppid)),
          );
        } catch {
          resolve([]);
        }
      },
    );
  });
}

/** Best-effort taskkill of a single Windows pid (+ /T sub-tree). Exported (FLUX-1216) so the
 *  worktree lock-holder sweep (worktree-lock-holders.ts) can reuse the same kill primitive
 *  instead of duplicating an `execFile('taskkill', ...)` call. */
export function defaultKillWin32Pid(pid: number): void {
  execFile('taskkill', ['/F', '/T', '/PID', String(pid)], { windowsHide: true }, () => {});
}

/**
 * True if `pid` currently identifies a live process, cross-platform (FLUX-1572). `process.kill`
 * with signal `0` sends no signal — Node maps it to a liveness probe on both POSIX (`kill(pid, 0)`)
 * and Windows (`OpenProcess`/`GetExitCodeProcess` under the hood) — so this needs no platform
 * branch. ESRCH/"no such process" -> dead; anything else thrown (e.g. EPERM — pid exists but this
 * user can't signal it) is treated as alive, since the process plainly still occupies that pid.
 */
export function isPidAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: unknown) {
    return (err as NodeJS.ErrnoException)?.code !== 'ESRCH';
  }
}
