import { execFile } from 'child_process';
import { existsSync } from 'fs';
import { log } from './log.js';

/**
 * Resolve the user's real login-shell PATH once at engine startup (FLUX-1408).
 *
 * A packaged macOS app launched from Finder/Dock/dmg (not a terminal) is started by
 * launchd, which hands the process its own minimal PATH
 * (`/usr/bin:/bin:/usr/sbin:/sbin`) — NOT the user's shell PATH. Every engine child
 * spawn (git, gh, the agent CLIs, serena, …) inherits `process.env` verbatim, so under
 * launchd PATH they silently resolve to Apple's stock `/usr/bin/git` (or nothing at
 * all) instead of the user's Homebrew / npm-global tools. Mutating `process.env.PATH`
 * once here — before any workspace activation or git/gh spawn — fixes every
 * downstream spawn with no per-call plumbing (VS Code calls this `resolveShellEnv`).
 */

const MARKER = '__EH_SHELL_PATH__';
const DEFAULT_PROBE_TIMEOUT_MS = 5_000;

/** Directories a Homebrew install lives under — Apple Silicon and Intel. */
const HOMEBREW_PATHS = ['/opt/homebrew/bin', '/usr/local/bin'];

/** Heuristic: PATH looks like launchd's minimal default rather than a real shell PATH. */
export function looksLaunchdMinimal(pathEnv: string | undefined): boolean {
  const entries = (pathEnv || '').split(':');
  return HOMEBREW_PATHS.every((p) => !entries.includes(p));
}

/**
 * Spawn the user's login shell once to run an arbitrary read-only `script` and capture its
 * stdout. `-ilc` makes it an interactive login shell so `.zprofile`/`.bash_profile`/`.zshrc`
 * (wherever the user's PATH/alias setup actually lives) run; a marker precedes the script's
 * output so noisy rc-file output (motd, nvm banners, etc.) on stdout can't be mistaken for it.
 * No stdin, hard timeout — a hung or prompting shell must not block the caller.
 *
 * Deliberately ignores `err`: a non-zero exit from `script` itself (e.g. `command -v` finding
 * nothing) is an expected "no match" outcome, not a probe failure — only the ABSENCE of the
 * marker in stdout (shell never got far enough to run `script`, or failed to spawn at all)
 * counts as a genuine probe failure, signaled by resolving `null`. A clean-but-empty result
 * (marker found, nothing after it) resolves as `''` — callers that treat "no output" and
 * "probe failed" the same way (like probeLoginShellPath below) collapse that themselves;
 * callers that need to tell them apart (the darwin claude-binary resolver, FLUX-1600,
 * claude-binary-darwin.ts — an empty `command -v` means "not found", not "shell hung") can't
 * if this collapsed it here. Also shared by probeLoginShellPath (FLUX-1408).
 */
export function probeLoginShellCommand(
  shell: string,
  script: string,
  timeoutMs = DEFAULT_PROBE_TIMEOUT_MS
): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      shell,
      ['-ilc', `echo -n ${MARKER}; ${script}`],
      { timeout: timeoutMs, windowsHide: true },
      (_err, stdout) => {
        if (!stdout) { resolve(null); return; }
        const idx = stdout.indexOf(MARKER);
        if (idx === -1) { resolve(null); return; }
        resolve(stdout.slice(idx + MARKER.length).trim());
      }
    );
  });
}

/** PATH-flavored specialization of probeLoginShellCommand — see its doc comment for the mechanics. */
export function probeLoginShellPath(
  shell: string,
  timeoutMs = DEFAULT_PROBE_TIMEOUT_MS
): Promise<string | null> {
  return probeLoginShellCommand(shell, 'command printf \'%s\' "$PATH"', timeoutMs).then((value) => value || null);
}

/**
 * Shell-agnostic PATH probe (FLUX-1711): read `PATH=` out of `env`'s output instead of
 * expanding `"$PATH"` in the shell. In fish — a common default on Linux desktops — `$PATH`
 * is a LIST and `"$PATH"` expands space-joined, which would corrupt the result; `env` always
 * prints the exported, colon-joined form regardless of shell. Verified against fish 4.x.
 */
export function probeLoginShellEnvPath(
  shell: string,
  timeoutMs = DEFAULT_PROBE_TIMEOUT_MS
): Promise<string | null> {
  return probeLoginShellCommand(shell, 'command env', timeoutMs).then((out) => {
    if (!out) return null;
    const line = out.split('\n').find((l) => l.startsWith('PATH='));
    const value = line ? line.slice('PATH='.length).trim() : '';
    return value || null;
  });
}

/** Union of the shell-resolved PATH (first) and the existing PATH, de-duplicated. */
export function mergePath(shellPath: string, currentPath: string): string {
  const seen = new Set<string>();
  const merged: string[] = [];
  for (const entry of [...shellPath.split(':'), ...currentPath.split(':')]) {
    if (!entry || seen.has(entry)) continue;
    seen.add(entry);
    merged.push(entry);
  }
  return merged.join(':');
}

/** Fallback when the shell probe fails/times out: append Homebrew dirs that actually exist. */
export function fallbackPath(currentPath: string): string {
  const entries = currentPath.split(':').filter(Boolean);
  for (const dir of HOMEBREW_PATHS) {
    if (existsSync(dir) && !entries.includes(dir)) entries.push(dir);
  }
  return entries.join(':');
}

/** Heuristic (FLUX-1711): a Linux desktop/systemd-launched PATH carries no $HOME-rooted entry
 *  at all — every terminal shell setup adds at least one (~/.local/bin, nvm, cargo, …). */
export function looksGuiMinimalLinux(pathEnv: string | undefined, home: string): boolean {
  if (!home) return false;
  const prefix = home.endsWith('/') ? home : `${home}/`;
  return !(pathEnv || '').split(':').some((e) => e.startsWith(prefix));
}

/** Linux user-level bin dirs worth having when the shell probe fails (relative to $HOME). */
const LINUX_USER_BIN_DIRS = ['.local/bin', 'bin', '.npm-global/bin', '.cargo/bin'];

/** Fallback when the Linux shell probe fails/times out: append user bin dirs that exist. */
export function fallbackPathLinux(currentPath: string, home: string): string {
  const entries = currentPath.split(':').filter(Boolean);
  for (const rel of LINUX_USER_BIN_DIRS) {
    const dir = `${home}/${rel}`;
    if (existsSync(dir) && !entries.includes(dir)) entries.push(dir);
  }
  return entries.join(':');
}

export interface ResolveShellPathDeps {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  probe?: (shell: string, timeoutMs?: number) => Promise<string | null>;
}

/**
 * Resolve and adopt the user's shell PATH into `process.env.PATH` (or the injected env
 * in tests). Darwin-only, and a no-op when PATH already looks like a real shell PATH
 * (terminal launch, or a prior call already resolved it) — so this is cheap and
 * idempotent to call more than once, and harmless to also run in dev.
 */
export async function resolveShellPathAtStartup(deps: ResolveShellPathDeps = {}): Promise<void> {
  const platform = deps.platform ?? process.platform;
  const env = deps.env ?? process.env;
  const before = env.PATH || '';

  if (platform === 'darwin') {
    if (!looksLaunchdMinimal(before)) return;

    const probe = deps.probe ?? probeLoginShellPath;
    const shell = env.SHELL || '/bin/zsh';
    const shellPath = await probe(shell);

    const after = shellPath ? mergePath(shellPath, before) : fallbackPath(before);
    if (after === before) return;

    env.PATH = after;
    log.info(
      `[shell-path] launchd-minimal PATH detected — resolved via ${shellPath ? 'login shell' : 'Homebrew fallback'}. ` +
      `before="${before}" after="${after}"`
    );
    return;
  }

  // FLUX-1711: same failure on Linux — a desktop/systemd-launched AppImage (or deb/rpm/pacman
  // install) inherits the bare systemd-user PATH with no ~/.local/bin, nvm, npm-global, or cargo
  // dirs, so every agent-CLI precheck reports "not installed" even though the CLIs work from any
  // terminal. Probe via `env` (fish-safe — see probeLoginShellEnvPath) and merge, falling back to
  // appending the user bin dirs that exist.
  if (platform === 'linux') {
    const home = env.HOME || '';
    if (!looksGuiMinimalLinux(before, home)) return;

    const probe = deps.probe ?? probeLoginShellEnvPath;
    const shell = env.SHELL || '/bin/bash';
    const shellPath = await probe(shell);

    const after = shellPath ? mergePath(shellPath, before) : fallbackPathLinux(before, home);
    if (after === before) return;

    env.PATH = after;
    log.info(
      `[shell-path] GUI-minimal PATH detected — resolved via ${shellPath ? 'login shell' : 'user-bin fallback'}. ` +
      `before="${before}" after="${after}"`
    );
  }
}
