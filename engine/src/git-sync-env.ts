import { checkGhAuth } from './branch-manager.js';

/**
 * Non-interactive git environment for the background sync (FLUX-895).
 *
 * The orphan-mode background sync pushes/fetches `flux-data` over an HTTPS remote
 * roughly every 30s with no terminal attached (`windowsHide:true`). When Git's
 * credential helper (Git Credential Manager on Windows) can't satisfy the
 * credential, it pops an interactive "sign in to GitHub" window — and because the
 * background process never persists the credential, the popup re-fires on the
 * NEXT sync, login-spamming the user every ~30s.
 *
 * This module makes every sync git spawn:
 *   1. NON-INTERACTIVE — `GIT_TERMINAL_PROMPT=0` + `GCM_INTERACTIVE=never` turn a
 *      missing credential into a deterministic, catchable error instead of a GUI.
 *   2. gh-AUTHENTICATED when possible — when `gh` is logged in, inject gh's own
 *      credential helper for github.com so push/fetch "just works" without any
 *      interaction (gh's valid token never reaches `git push` otherwise, because
 *      gh is not wired as git's credential helper — the "`gh auth status` is ✓ but
 *      sync still fails" red herring).
 */

/** Engine-owned remediation text for an auth failure, carried on the error status payload. */
export interface SyncRemediation {
  /** One-line plain-language why. */
  reason: string;
  /** Exact copy-paste commands that fix it, in order. */
  commands: string[];
}

export const SYNC_AUTH_REMEDIATION: SyncRemediation = {
  reason:
    "Background sync can't authenticate to GitHub. git push/fetch needs GitHub credentials — being logged into gh alone isn't enough until git is pointed at it.",
  commands: ['gh auth login', 'gh auth setup-git'],
};

/**
 * Wall-clock ceiling for any single sync-related git/gh subprocess (FLUX-989).
 *
 * A hung `git push`/`git fetch` (large divergence, a stalled credential prompt, a
 * dead network) would otherwise leave its promise pending forever, wedging the sync
 * cycle and — for a user-initiated conflict resolution — the HTTP response behind it.
 * Node's `child_process.execFile` `timeout` option kills the child (SIGTERM) once this
 * elapses, turning a hang into a catchable error. Generous but bounded: a legitimate
 * fetch/push under heavy divergence can take a while, but never forever. Tune here.
 */
export const GIT_SYNC_TIMEOUT_MS = 60_000;

// ─── gh-authed detection (cached) ────────────────────────────────────────────
// A sync cycle makes several git calls; re-running `gh auth status` for each would
// spawn gh repeatedly. Cache the result for a short window. The cache is also
// invalidated on an auth failure (and on a manual retry) so a fresh `gh auth login`
// is picked up on the next cycle rather than waiting out the TTL.
const GH_AUTH_TTL_MS = 30_000;
let ghAuthCache: { ok: boolean; at: number } | null = null;

/** Drop the cached gh-auth result so the next sync re-detects (call on auth failure / manual retry). */
export function invalidateGhAuthCache(): void {
  ghAuthCache = null;
}

async function ghAuthed(): Promise<boolean> {
  const now = Date.now();
  if (ghAuthCache && now - ghAuthCache.at < GH_AUTH_TTL_MS) return ghAuthCache.ok;
  const ok = await checkGhAuth();
  ghAuthCache = { ok, at: now };
  return ok;
}

/**
 * Build the environment for a sync git spawn. Always non-interactive; injects
 * gh's credential helper for github.com when gh is authenticated.
 *
 * The gh injection uses git's `GIT_CONFIG_*` env config (git ≥ 2.31) so it applies
 * uniformly to every git call without per-command `-c` plumbing. It (a) RESETS the
 * generic + github.com credential-helper chain to empty (so GCM is dropped and can
 * never pop, even on this path) and (b) sets `!gh auth git-credential` as the sole
 * helper for `https://github.com`. `gh` must be on PATH for the spawned git's shell
 * — it is, since the same process just ran `gh auth status` to get here.
 */
export async function buildGitSyncEnv(): Promise<NodeJS.ProcessEnv> {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_TERMINAL_PROMPT: '0',
    GCM_INTERACTIVE: 'never',
    // FLUX-989: clear any inherited askpass helper. If the environment falls back to a
    // GUI askpass (e.g. macOS Keychain / SSH_ASKPASS), that's a modal dialog invisible to
    // a background Express process — it would block the child indefinitely, defeating
    // GIT_TERMINAL_PROMPT=0. Empty means "no askpass", so a missing credential fails fast.
    GIT_ASKPASS: '',
    SSH_ASKPASS: '',
    // FLUX-997: an ssh:// remote won't honour GIT_TERMINAL_PROMPT/askpass clearing — ssh does its
    // own prompting for an unknown host key or a key passphrase, which would block a headless spawn.
    // BatchMode=yes makes ssh fail fast on any such prompt. Preserve a caller's custom GIT_SSH_COMMAND
    // (e.g. `ssh -i key`) by appending to it rather than replacing.
    GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND?.trim()
      ? `${process.env.GIT_SSH_COMMAND.trim()} -o BatchMode=yes`
      : 'ssh -o BatchMode=yes',
  };

  if (await ghAuthed()) {
    // Reset generic helpers, reset github.com-scoped helpers, then set gh as the
    // only github.com helper. An empty value clears the accumulated helper list.
    env.GIT_CONFIG_COUNT = '3';
    env.GIT_CONFIG_KEY_0 = 'credential.helper';
    env.GIT_CONFIG_VALUE_0 = '';
    env.GIT_CONFIG_KEY_1 = 'credential.https://github.com.helper';
    env.GIT_CONFIG_VALUE_1 = '';
    env.GIT_CONFIG_KEY_2 = 'credential.https://github.com.helper';
    env.GIT_CONFIG_VALUE_2 = '!gh auth git-credential';
  }

  return env;
}

/**
 * Classify a git error message for the sync status indicator. Shared by the fetch
 * and push paths so they tag failures identically (FLUX-895 tightened the `auth`
 * branch — with prompting disabled, missing credentials now surface as
 * "terminal prompts disabled" / "could not read Username" rather than the old
 * "Authentication failed" string, so those must map to `auth`, not `unknown`).
 */
export function classifyGitError(message: string): 'network' | 'auth' | 'unknown' {
  const msg = message.toLowerCase();
  if (msg.includes('could not resolve host') || msg.includes('network') || msg.includes('timed out')) {
    return 'network';
  }
  if (
    msg.includes('authentication failed') ||
    msg.includes('permission denied') ||
    msg.includes('terminal prompts disabled') ||
    msg.includes('could not read username') ||
    msg.includes('could not read password') ||
    msg.includes('403') ||
    msg.includes('invalid username or password')
  ) {
    return 'auth';
  }
  return 'unknown';
}
