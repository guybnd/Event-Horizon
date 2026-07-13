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
 * Spawn the user's login shell once to read its resolved PATH. `-ilc` makes it an
 * interactive login shell so `.zprofile`/`.bash_profile`/`.zshrc` (wherever the user's
 * PATH additions actually live) run; a marker precedes the PATH so noisy rc-file output
 * (motd, nvm banners, etc.) on stdout can't be mistaken for it. No stdin, hard timeout —
 * a hung or prompting shell must not block engine startup.
 */
export function probeLoginShellPath(
  shell: string,
  timeoutMs = DEFAULT_PROBE_TIMEOUT_MS
): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      shell,
      ['-ilc', `echo -n ${MARKER}; command printf '%s' "$PATH"`],
      { timeout: timeoutMs, windowsHide: true },
      (err, stdout) => {
        if (err || !stdout) { resolve(null); return; }
        const idx = stdout.indexOf(MARKER);
        if (idx === -1) { resolve(null); return; }
        const value = stdout.slice(idx + MARKER.length).trim();
        resolve(value || null);
      }
    );
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
  if (platform !== 'darwin') return;

  const env = deps.env ?? process.env;
  const before = env.PATH || '';
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
}
