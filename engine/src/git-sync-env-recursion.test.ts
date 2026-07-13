import { describe, it, expect } from 'vitest';
import os from 'os';
import { buildGitSyncEnv } from './git-sync-env.js';

// ─────────────────────────────────────────────────────────────────────────────
// FLUX-1403 regression — resolveRemoteHost() (git-remote-host.ts) was migrated off a bare
// execFile spawn onto runGit() (the check-git-exec.mjs ratchet, FLUX-996/997). The naive
// migration recurses: buildGitSyncEnv() calls resolveRemoteHost() to decide whether to inject
// gh's credential helper (FLUX-987); if resolveRemoteHost's runGit() call took the runner's
// default env-building path, that path IS buildGitSyncEnv() again — buildGitSyncEnv →
// resolveRemoteHost → runGit → buildGitSyncEnv → …, a real RangeError: Maximum call stack size
// exceeded, surfaced as this exact test timing out. resolveRemoteHost's runGit call MUST pass an
// explicit `env` override to opt out (mirrors branch-manager.checkGhAuth()'s identical FLUX-998
// guard). Deliberately exercises the REAL checkGhAuth/resolveRemoteHost chain (no mocks) — a
// mocked resolveRemoteHost would never re-enter buildGitSyncEnv and so could never reproduce the
// hang, masking a reintroduced regression.
// ─────────────────────────────────────────────────────────────────────────────
describe('buildGitSyncEnv (FLUX-1403: must not recurse via resolveRemoteHost)', () => {
  it('resolves promptly for a real cwd — does not hang/stack-overflow', async () => {
    const env = await buildGitSyncEnv(os.tmpdir());
    expect(env.GIT_TERMINAL_PROMPT).toBe('0');
    // Per-test timeout raised above runGit/runGh's own 60s worst case (a real `gh auth status`
    // network round-trip when gh is installed and authed) so a slow CI network can't masquerade
    // as a recursion regression.
  }, 65_000);
});
