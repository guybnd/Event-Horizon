/**
 * @file worktree-lock-holders.ts
 *
 * Windows-only lock-holder detection for a task worktree directory (FLUX-1216). Complements
 * {@link killDescendantsByPid} (kill-process-tree.ts): that function walks a process tree from a
 * KNOWN seed pid (a still-tracked session record), but a genuinely orphaned worktree — its session
 * record is already gone (engine restart, or the session ended hours/days earlier and was reaped
 * from `cliSessionsById`) — has no seed pid to walk from. This instead matches by command-line
 * substring, so a stray `vitest --watch` or ad-hoc `node -e` server started FROM inside the
 * worktree can be found and killed even with zero tracking state.
 *
 * Incident (2026-07-06): 13 stale `.eh-worktrees/` folders resisted deletion — 8 held by zombie
 * `vitest` processes (agents misinvoking `-w` as npm's --workspace, but vitest reads it as
 * --watch) from sessions that had already ended, 1 held by a throwaway `node -e
 * http.createServer(...)` test server. None of these had a tracked session pid to reap by the
 * time anything looked, which is exactly the gap this closes.
 */
import { execFile } from 'child_process';
import path from 'path';

/** True when `child` is `parent` or nested under it. Deliberately duplicated from
 *  task-worktree.ts's private `isUnder` (rather than exported/imported) to avoid a cross-module
 *  cycle — task-worktree.ts imports {@link findWorktreeLockHolders} from this file. */
function isUnder(child: string, parent: string): boolean {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * Find live Windows processes whose command line references a path under `worktreePath` — e.g. a
 * vitest/tsserver/eslint run launched with a script path inside the worktree, or a process whose
 * cwd was passed as an argument. Best-effort and read-only (callers decide whether/how to kill):
 * never throws, resolves to `[]` on any query failure. No-op on POSIX — a blocked delete there is
 * a real permission issue, not the Windows delete-pending-on-open-handle pattern this targets.
 *
 * `baseDir` is a MANDATORY fail-closed safety guard, mirroring the FLUX-1207 PR #457 review fix
 * for the pid-based reaper (an unidentifiable/out-of-scope leftover must reap nothing, never fall
 * back to something broader): `worktreePath` must resolve under it or this returns `[]` WITHOUT
 * querying at all. Callers must pass `taskWorktreesBaseDir(workspaceRoot)` — this can then never
 * be pointed at the main checkout (or any other path) and match unrelated live processes.
 *
 * `deps.listProcesses` lets tests inject a fake process table so no real process is queried.
 */
export async function findWorktreeLockHolders(
  worktreePath: string,
  baseDir: string,
  deps: { listProcesses?: () => Promise<Array<{ pid: number; commandLine: string }>> } = {},
): Promise<number[]> {
  if (process.platform !== 'win32') return [];
  if (!isUnder(worktreePath, baseDir)) return [];
  const listProcesses = deps.listProcesses ?? defaultListWin32ProcessesWithCommandLine;
  let table: Array<{ pid: number; commandLine: string }>;
  try {
    table = await listProcesses();
  } catch {
    return [];
  }
  // Worktree dirs are named `<repo>-<ticketId>` with numeric-suffixed ids (FLUX-1, FLUX-11, ...),
  // so a plain substring match would let the shorter path match as a literal PREFIX of a sibling
  // ticket's path (".../EventHorizon-FLUX-1" is a prefix of ".../EventHorizon-FLUX-11/...") and
  // kill an unrelated, live process. Anchor the match: the character immediately after it (if any)
  // must not extend an identifier, so "flux-1" matches ".../flux-1\..." or ".../flux-1" (end of
  // string) but not ".../flux-11...".
  const needlePattern = new RegExp(`${escapeRegExp(path.resolve(worktreePath))}(?![a-z0-9])`, 'i');
  return table.filter((p) => needlePattern.test(p.commandLine)).map((p) => p.pid);
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function defaultListWin32ProcessesWithCommandLine(): Promise<Array<{ pid: number; commandLine: string }>> {
  return new Promise((resolve) => {
    execFile(
      'powershell',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        'Get-CimInstance Win32_Process | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress',
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
                const row = r as { ProcessId?: unknown; CommandLine?: unknown };
                return {
                  pid: Number(row.ProcessId),
                  commandLine: typeof row.CommandLine === 'string' ? row.CommandLine : '',
                };
              })
              .filter((r) => Number.isFinite(r.pid) && r.commandLine.length > 0),
          );
        } catch {
          resolve([]);
        }
      },
    );
  });
}
