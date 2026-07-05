import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

/**
 * Resolve the hostname of a git repo's `origin` remote, cached (FLUX-987).
 *
 * Used by git-sync-env.ts to scope its gh-credential-helper injection to `github.com`
 * remotes only: a flux-data (or main-repo) remote on GitLab/Bitbucket/GH-Enterprise/a
 * self-hosted host must NOT have its OS credential helper reset just because the user
 * happens to be logged into `gh` for some GitHub account — that reset only makes sense
 * when the remote actually IS github.com.
 */

const REMOTE_HOST_TTL_MS = 5 * 60_000;
const cache = new Map<string, { host: string | null; at: number }>();

/** Drop cached remote-host resolutions (tests / a remote URL change taking immediate effect). */
export function invalidateRemoteHostCache(): void {
  cache.clear();
}

function extractHost(url: string): string | null {
  const trimmed = url.trim();
  if (!trimmed) return null;
  // scp-like syntax: git@host:owner/repo.git (no scheme, so `new URL` can't parse it).
  const scpMatch = /^[^/@\s]+@([^:/\s]+):/.exec(trimmed);
  if (scpMatch?.[1]) return scpMatch[1].toLowerCase();
  try {
    const parsed = new URL(trimmed);
    return parsed.hostname ? parsed.hostname.toLowerCase() : null;
  } catch {
    return null;
  }
}

/** Resolve the `origin` remote's hostname for the repo/worktree at `cwd` (cached; null if unresolvable). */
export async function resolveRemoteHost(cwd: string): Promise<string | null> {
  const cached = cache.get(cwd);
  const now = Date.now();
  if (cached && now - cached.at < REMOTE_HOST_TTL_MS) return cached.host;

  let host: string | null;
  try {
    const { stdout } = await execFileAsync('git', ['remote', 'get-url', 'origin'], {
      cwd,
      windowsHide: true,
      timeout: 10_000,
    });
    host = extractHost(stdout);
  } catch {
    host = null;
  }
  cache.set(cwd, { host, at: now });
  return host;
}
