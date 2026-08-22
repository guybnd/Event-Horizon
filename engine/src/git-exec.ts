import { spawn } from 'child_process';
import { killProcessTree } from './kill-process-tree.js';
import { buildGitSyncEnv, GIT_SYNC_TIMEOUT_MS } from './git-sync-env.js';

/**
 * The ONE hardened way to spawn `git`/`gh` in the engine (FLUX-997, epic FLUX-996).
 *
 * Before this, ~6 modules each rolled their own bare `execFile('git', …, {windowsHide:true})`
 * with NO timeout and NOT the non-interactive credential env — only the background sync path
 * (sync-watcher / storage-sync) was hardened (FLUX-989/895). So a slow/unreachable remote, or a
 * Git Credential Manager prompt, hung those calls FOREVER on the exact paths users hit most
 * (spawn agent, Ready, finish, create ticket). This module makes EVERY git/gh spawn:
 *   1. NON-INTERACTIVE + gh-authed — via buildGitSyncEnv(): a missing credential fails fast
 *      instead of popping GCM / an askpass GUI a headless Express process can never answer.
 *   2. TIME-BOUNDED — a hung fetch/push becomes a catchable error, never a pending-forever promise.
 *   3. TREE-KILLED on timeout/abort — on POSIX the child is spawned `detached` (its own process-group
 *      leader) and the whole group is signalled, so descendants (git-remote-https, ssh) are reaped too
 *      and a killed `git` can't orphan a network child that keeps the socket (and the hang) alive. This
 *      matters because those helpers block on a socket read, not on stdin EOF, so killing only the
 *      parent `git` would leave the grandchild holding the inherited stdio pipe open → execFile's
 *      completion callback (which waits on stdio 'close', not just 'exit') would never fire → the
 *      promise would hang forever, reproducing the exact FLUX-996 bug. Windows uses `taskkill /T`.
 *
 * S2–S5 route the scattered bare runners through runGit()/runGh(); the check-git-exec.mjs guard
 * fails CI on any new bare git/gh spawn outside this module.
 */

export interface GitExecResult {
  stdout: string;
  stderr: string;
}

export interface GitExecOptions {
  /** Working directory for the spawn. */
  cwd?: string;
  /** Wall-clock ceiling; on expiry the child + descendants are killed and the call rejects. Default GIT_SYNC_TIMEOUT_MS (60s). */
  timeoutMs?: number;
  /** External cancellation — aborting kills the child tree and rejects with an 'aborted' error. */
  signal?: AbortSignal;
  /** Larger stdout buffer for big outputs (e.g. `git diff`). Default 10 MiB. */
  maxBuffer?: number;
  /**
   * Escape hatch (FLUX-998): use this exact env instead of calling buildGitSyncEnv(). ONLY
   * `branch-manager.checkGhAuth()` needs this — buildGitSyncEnv() calls checkGhAuth() itself (to
   * decide whether to inject gh's credential helper), so routing checkGhAuth's own probe through
   * the normal env-building path recurses infinitely (buildGitSyncEnv → checkGhAuth → runGh →
   * buildGitSyncEnv → …, blowing the call stack). Every other caller should omit this and get the
   * real non-interactive/gh-authed env.
   */
  env?: NodeJS.ProcessEnv;
}

export type GitExecOutcome = 'ok' | 'timeout' | 'aborted' | 'error';

/** One completed git/gh subprocess. S9 installs the real sink via setGitOperationSink() to stream these over SSE. */
export interface GitOperationEvent {
  file: 'git' | 'gh';
  args: readonly string[];
  cwd?: string | undefined;
  startedAt: number;
  durationMs: number;
  outcome: GitExecOutcome;
  /** Process exit code when it exited normally (else null). */
  code?: number | null | undefined;
  /** Short failure reason (timeout / abort / stderr head) for non-ok outcomes. */
  reason?: string | undefined;
}

// Telemetry sinks — a multicast set, empty until bootstrap installs consumers. S9's
// operation-telemetry (ring buffer + SSE) and FLUX-1131's git-timing (perf registry) both need
// every event, so this is `add`, not `replace` — a second setGitOperationSink() call must not
// silently drop the first consumer. Kept defensive: a throwing sink must NEVER break a git call,
// so emit() swallows each sink's errors independently.
const operationSinks = new Set<(e: GitOperationEvent) => void>();
/**
 * Register a sink; call again to add another (both receive every event). Pass `null` to clear
 * ALL registered sinks — a blunt reset used by tests to tear down between runs, not meant for
 * removing a single consumer in production (there's no unsubscribe handle today; no caller has
 * needed one — every current sink lives for the process lifetime).
 */
export function setGitOperationSink(sink: ((e: GitOperationEvent) => void) | null): void {
  if (sink === null) { operationSinks.clear(); return; }
  operationSinks.add(sink);
}
function emit(event: GitOperationEvent): void {
  for (const sink of operationSinks) {
    try { sink(event); } catch { /* a broken telemetry sink must never break a git call */ }
  }
}

const DEFAULT_MAX_BUFFER = 10 * 1024 * 1024;
// Grace between the SIGTERM tree-kill and the escalation SIGKILL on POSIX.
const SIGKILL_GRACE_MS = 2_000;
// POSIX-only: spawn the child as its own process-group leader so killTree() can signal the whole
// group (parent git + git-remote-https/ssh grandchildren). No-op on win32 (taskkill /T handles the tree).
const DETACHED = process.platform !== 'win32';

// Credentials shouldn't ride in an argv (auth is via env), but a future caller could pass a remote
// URL with embedded userinfo (https://x-access-token:TOKEN@github.com/…), or stderr could echo a
// credential-embedded remote resolved from .git/config. Redact before telemetry AND before it can
// reach a thrown Error.message — callers (e.g. cli-session.ts's prepareAndLaunchSession) persist
// that message into synced ticket history / SSE broadcasts, so redaction has to happen HERE, at the
// one place every git/gh spawn funnels through, not at each downstream call site (FLUX-1002 review).
const CREDENTIAL_URL_RE = /([a-z][a-z0-9+.-]*:\/\/)[^/@\s]+@/gi;
export function redactArg(arg: string): string {
  return arg.replace(CREDENTIAL_URL_RE, '$1***@');
}

/**
 * Core hardened subprocess runner. INTERNAL — production code MUST call runGit()/runGh()
 * (the check-git-exec.mjs guard forbids any other module from spawning 'git'/'gh' directly).
 * Exported only so the timeout / tree-kill machinery can be unit-tested against a stand-in
 * command without a real git remote.
 */
export async function runHardened(
  file: 'git' | 'gh',
  args: string[],
  opts: GitExecOptions = {},
): Promise<GitExecResult> {
  const timeoutMs = opts.timeoutMs ?? GIT_SYNC_TIMEOUT_MS;
  const maxBuffer = opts.maxBuffer ?? DEFAULT_MAX_BUFFER;
  // opts.env bypasses buildGitSyncEnv() entirely (not just its result) — see GitExecOptions.env.
  // opts.cwd (when set) lets buildGitSyncEnv scope its gh-credential injection to an actual
  // github.com remote (FLUX-987) rather than any repo a gh-authed user happens to be touching.
  const env = opts.env ?? await buildGitSyncEnv(opts.cwd);
  const startedAt = Date.now();

  return await new Promise<GitExecResult>((resolve, reject) => {
    let settled = false;
    let timedOut = false;
    let aborted = false;
    let maxBufferExceeded = false;
    let sigkillTimer: ReturnType<typeof setTimeout> | null = null;

    // Use spawn() (NOT execFile) so `detached` is honoured: execFile forwards only a fixed subset
    // of options to spawn and silently drops `detached`, leaving the child in the engine's own
    // process group — killTree()'s group-kill would then hit ESRCH (no such group) and never reap
    // the git-remote-https/ssh grandchildren. spawn makes the child a real group leader on POSIX.
    const child = spawn(file, args, { cwd: opts.cwd, env, windowsHide: true, detached: DETACHED });

    // Buffer stdout/stderr ourselves (spawn doesn't) and enforce maxBuffer, like execFile did.
    let stdout = '';
    let stderr = '';
    let stdoutBytes = 0;
    let stderrBytes = 0;
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      stdoutBytes += Buffer.byteLength(chunk);
      if (stdoutBytes > maxBuffer) { maxBufferExceeded = true; killTree(); return; }
      stdout += chunk;
    });
    child.stderr?.on('data', (chunk: string) => {
      stderrBytes += Buffer.byteLength(chunk);
      if (stderrBytes > maxBuffer) { maxBufferExceeded = true; killTree(); return; }
      stderr += chunk;
    });

    // 'error' = the spawn itself failed (e.g. ENOENT: git not on PATH) — no exit code.
    child.on('error', (err: Error & { stdout?: string; stderr?: string }) => {
      err.stdout = redactArg(stdout);
      err.stderr = redactArg(stderr);
      finish('error', err, null, null, err.message);
    });

    // 'close' (not 'exit') fires once the process exited AND its stdio streams closed — so we have
    // the complete output. A surviving stdio-inheriting grandchild would delay it forever, which is
    // exactly why the timeout path group-kills the whole tree.
    child.on('close', (code) => {
      if (timedOut) {
        // "timed out" in the message maps to classifyGitError() === 'network'.
        finish('timeout', new Error(redactArg(`${file} ${args.join(' ')} timed out after ${timeoutMs}ms`)), null, null, 'timeout');
        return;
      }
      if (aborted) {
        finish('aborted', new Error(redactArg(`${file} ${args.join(' ')} aborted`)), null, null, 'aborted');
        return;
      }
      if (maxBufferExceeded) {
        const err = new Error(redactArg(`${file} ${args.join(' ')} exceeded maxBuffer of ${maxBuffer} bytes`)) as Error & { stdout?: string; stderr?: string };
        err.stdout = redactArg(stdout);
        err.stderr = redactArg(stderr);
        finish('error', err, null, null, 'maxBuffer exceeded');
        return;
      }
      if (code !== 0) {
        // Mirror execFile's error shape: message carries stderr, .code/.stdout/.stderr attached so
        // callers and classifyGitError() keep working. Redact the argv echo, stderr, AND the raw
        // .stdout/.stderr properties — any of them can carry a credential-embedded remote URL, and
        // this message is now persisted into synced ticket history by callers like cli-session.ts
        // (FLUX-1002 review finding). .stdout/.stderr are redacted defense-in-depth even though no
        // current caller reads them directly (FLUX-1091).
        const err = new Error(redactArg(`Command failed: ${file} ${args.join(' ')}\n${stderr}`)) as Error & { code?: number | null; stdout?: string; stderr?: string };
        err.code = code;
        err.stdout = redactArg(stdout);
        err.stderr = redactArg(stderr);
        finish('error', err, null, typeof code === 'number' ? code : null, redactArg(stderr.trim().slice(0, 200)) || err.message);
        return;
      }
      finish('ok', null, { stdout, stderr }, 0);
    });

    // Honor an already-aborted signal, or wire the listener (child is assigned above).
    if (opts.signal) {
      if (opts.signal.aborted) onAbort();
      else opts.signal.addEventListener('abort', onAbort, { once: true });
    }

    const timeoutTimer = setTimeout(() => {
      timedOut = true;
      killTree();
    }, timeoutMs);
    timeoutTimer.unref?.();

    // Hoisted declarations: the executor references these above regardless of order. They run
    // only asynchronously (stream/close/error events / timers / abort listener), after `child` and
    // `timeoutTimer` are assigned — so there is no temporal-dead-zone hazard.
    function finish(
      outcome: GitExecOutcome,
      err: Error | null,
      result: GitExecResult | null,
      code: number | null,
      reason?: string,
    ): void {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      if (sigkillTimer) clearTimeout(sigkillTimer);
      if (opts.signal) opts.signal.removeEventListener('abort', onAbort);
      emit({ file, args: args.map(redactArg), cwd: opts.cwd, startedAt, durationMs: Date.now() - startedAt, outcome, code, reason });
      if (err) reject(err); else resolve(result as GitExecResult);
    }

    // Reap the child AND its descendants (a killed `git` can leave a git-remote-https child
    // holding the socket open); escalate to SIGKILL after a grace on POSIX. `group: true` signals
    // the whole detached process group (see DETACHED). Re-entrancy-guarded so a timeout/abort race
    // can't double-fire and orphan the first sigkill timer.
    let killing = false;
    function killTree(): void {
      if (killing) return;
      killing = true;
      killProcessTree(child, 'SIGTERM', { group: DETACHED });
      sigkillTimer = setTimeout(() => killProcessTree(child, 'SIGKILL', { group: DETACHED }), SIGKILL_GRACE_MS);
      sigkillTimer.unref?.();
    }

    function onAbort(): void {
      if (settled) return;
      aborted = true;
      killTree();
    }
  });
}

/** Run `git` with the hardened guarantees above. The ONLY sanctioned way to spawn git in the engine. */
export function runGit(args: string[], opts?: GitExecOptions): Promise<GitExecResult> {
  return runHardened('git', args, opts);
}

/**
 * Binary-safe variant of runGit() for reading raw blob bytes (`git show`/`cat-file`) — e.g. a
 * committed/staged asset that isn't valid UTF-8. runGit()/runHardened() always `setEncoding('utf8')`
 * on the child's stdout, which is lossy (invalid byte sequences become U+FFFD) for anything that
 * isn't text; this collects stdout as raw Buffer chunks instead, so the returned bytes are exactly
 * what Git wrote, never decoded/re-encoded. stderr is still decoded utf8 (Git's own error text is
 * always text). Same timeout/tree-kill/telemetry hardening as runHardened() (FLUX-1643 review).
 */
export async function runGitBinary(args: string[], opts: GitExecOptions = {}): Promise<Buffer> {
  const timeoutMs = opts.timeoutMs ?? GIT_SYNC_TIMEOUT_MS;
  const maxBuffer = opts.maxBuffer ?? DEFAULT_MAX_BUFFER;
  const env = opts.env ?? await buildGitSyncEnv(opts.cwd);
  const startedAt = Date.now();

  return await new Promise<Buffer>((resolve, reject) => {
    let settled = false;
    let timedOut = false;
    let aborted = false;
    let maxBufferExceeded = false;
    let sigkillTimer: ReturnType<typeof setTimeout> | null = null;

    const child = spawn('git', args, { cwd: opts.cwd, env, windowsHide: true, detached: DETACHED });

    const stdoutChunks: Buffer[] = [];
    let stderr = '';
    let stdoutBytes = 0;
    let stderrBytes = 0;
    // Deliberately no setEncoding on stdout — chunks stay raw Buffers.
    child.stdout?.on('data', (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > maxBuffer) { maxBufferExceeded = true; killTree(); return; }
      stdoutChunks.push(chunk);
    });
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      stderrBytes += Buffer.byteLength(chunk);
      if (stderrBytes > maxBuffer) { maxBufferExceeded = true; killTree(); return; }
      stderr += chunk;
    });

    child.on('error', (err: Error & { stderr?: string }) => {
      err.stderr = redactArg(stderr);
      finish('error', err, null, null, err.message);
    });

    child.on('close', (code) => {
      if (timedOut) {
        finish('timeout', new Error(redactArg(`git ${args.join(' ')} timed out after ${timeoutMs}ms`)), null, null, 'timeout');
        return;
      }
      if (aborted) {
        finish('aborted', new Error(redactArg(`git ${args.join(' ')} aborted`)), null, null, 'aborted');
        return;
      }
      if (maxBufferExceeded) {
        finish('error', new Error(redactArg(`git ${args.join(' ')} exceeded maxBuffer of ${maxBuffer} bytes`)), null, null, 'maxBuffer exceeded');
        return;
      }
      if (code !== 0) {
        const err = new Error(redactArg(`Command failed: git ${args.join(' ')}\n${stderr}`)) as Error & { code?: number | null; stderr?: string };
        err.code = code;
        err.stderr = redactArg(stderr);
        finish('error', err, null, typeof code === 'number' ? code : null, redactArg(stderr.trim().slice(0, 200)) || err.message);
        return;
      }
      finish('ok', null, Buffer.concat(stdoutChunks), 0);
    });

    if (opts.signal) {
      if (opts.signal.aborted) onAbort();
      else opts.signal.addEventListener('abort', onAbort, { once: true });
    }

    const timeoutTimer = setTimeout(() => {
      timedOut = true;
      killTree();
    }, timeoutMs);
    timeoutTimer.unref?.();

    function finish(
      outcome: GitExecOutcome,
      err: Error | null,
      result: Buffer | null,
      code: number | null,
      reason?: string,
    ): void {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      if (sigkillTimer) clearTimeout(sigkillTimer);
      if (opts.signal) opts.signal.removeEventListener('abort', onAbort);
      emit({ file: 'git', args: args.map(redactArg), cwd: opts.cwd, startedAt, durationMs: Date.now() - startedAt, outcome, code, reason });
      if (err) reject(err); else resolve(result as Buffer);
    }

    let killing = false;
    function killTree(): void {
      if (killing) return;
      killing = true;
      killProcessTree(child, 'SIGTERM', { group: DETACHED });
      sigkillTimer = setTimeout(() => killProcessTree(child, 'SIGKILL', { group: DETACHED }), SIGKILL_GRACE_MS);
      sigkillTimer.unref?.();
    }

    function onAbort(): void {
      if (settled) return;
      aborted = true;
      killTree();
    }
  });
}

/** Run `gh` with the hardened guarantees above. The ONLY sanctioned way to spawn gh in the engine. */
export function runGh(args: string[], opts?: GitExecOptions): Promise<GitExecResult> {
  return runHardened('gh', args, opts);
}

/**
 * FLUX-1638: resolve the commit-ish a NEW task/ticket branch should be cut from, preferring the
 * remote-tracking ref over the local default branch. `createTicketBranch` (branch-manager.ts) and
 * `createTaskWorktree` (task-worktree.ts) each used to base new branches on the bare LOCAL default
 * branch's tip (`getDefaultBranch()` / a local master→main probe) — so a commit sitting unpushed on
 * local `master` (e.g. from a branchless single-shot session) silently rode into every
 * subsequently-created branch's PR (the FLUX-1635 → PR #700 incident). Basing on the last-fetched
 * `origin/<default>` excludes any such stray local commit by construction. Deliberately does NOT
 * `git fetch` first — the last-fetched remote-tracking ref is still the correct base (it already
 * excludes unpushed local commits) and this stays offline-safe.
 *
 * `run` is injected so both call sites can route through their own cwd-bound wrapper (or a test
 * double) without this module knowing about workspace resolution.
 */
export async function resolveBranchCreationBase(
  run: (args: string[]) => Promise<{ stdout: string; stderr: string }>,
): Promise<string> {
  let defaultName = 'master';
  try {
    // No `--short` here: `--short` on a REMOTE symbolic-ref (refs/remotes/origin/HEAD) returns the
    // already-prefixed `origin/<name>` (e.g. `origin/trunk`), not the bare name — using it as-is
    // below would probe the nonsensical `refs/remotes/origin/origin/trunk`. Strip the full ref path
    // manually instead, matching getDefaultBranch's (branch-manager.ts) approach.
    const { stdout } = await run(['symbolic-ref', 'refs/remotes/origin/HEAD']);
    const ref = stdout.trim().replace('refs/remotes/origin/', '');
    if (ref) defaultName = ref;
  } catch {
    // No origin/HEAD configured — resolve the name from the local branches that exist instead.
    for (const candidate of ['master', 'main']) {
      try {
        await run(['rev-parse', '--verify', '--quiet', `refs/heads/${candidate}`]);
        defaultName = candidate;
        break;
      } catch {
        /* try the next candidate */
      }
    }
  }

  // Prefer the remote-tracking ref for the actual base — unstripped, since the bare name may have
  // no local copy to resolve against (FLUX-1341).
  try {
    await run(['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${defaultName}`]);
    return `origin/${defaultName}`;
  } catch {
    /* no remote-tracking ref (local-only repo, or origin/HEAD lied) — fall back to local */
  }

  try {
    await run(['rev-parse', '--verify', '--quiet', `refs/heads/${defaultName}`]);
    return defaultName;
  } catch {
    /* resolved name has no local ref either — last-resort ladder below */
  }
  for (const candidate of ['master', 'main']) {
    try {
      await run(['rev-parse', '--verify', '--quiet', `refs/heads/${candidate}`]);
      return candidate;
    } catch {
      /* try the next candidate */
    }
  }
  return 'master';
}

/**
 * Best-effort: log a warning when `localName`'s local tip has diverged ahead of
 * `origin/<localName>` at branch-creation time (FLUX-1638 acceptance #3) — surfaces the exact
 * condition this module's base-ref preference exists to route around, instead of silently basing
 * on the remote and leaving the divergence invisible. Never throws: a probe failure must not fail
 * branch creation itself.
 */
export async function warnIfLocalAheadOfOrigin(
  run: (args: string[]) => Promise<{ stdout: string; stderr: string }>,
  localName: string,
  logWarn: (message: string) => void,
): Promise<void> {
  try {
    const { stdout } = await run(['rev-list', '--count', `origin/${localName}..${localName}`]);
    const count = parseInt(stdout.trim(), 10) || 0;
    if (count > 0) {
      logWarn(
        `local '${localName}' is ahead of 'origin/${localName}' by ${count} commit(s) — new branches are based on the remote-tracking ref, so ${count > 1 ? 'these' : 'this'} unpushed commit${count > 1 ? 's' : ''} will NOT be inherited.`,
      );
    }
  } catch {
    /* no local branch named localName, or no origin/<localName> — nothing to warn about */
  }
}
