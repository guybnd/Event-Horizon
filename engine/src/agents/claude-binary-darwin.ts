// FLUX-1600: resolveClaudeBinaryPathDarwin — the darwin twin of resolveClaudeExePath
// (shared.ts). On macOS the adapter spawns `claude` by bare PATH lookup. If the user's
// terminal resolves `claude` through a shell alias/function, or a later login-shell PATH
// entry shadows an earlier stale global install, the app can spawn a DIFFERENT, stale
// `claude` binary with its own stale credential store — a persistent 401 while "the
// terminal works" (FLUX-1597 field report). This resolves the binary the login shell
// would actually run, once, and caches it — mirroring resolveClaudeExePath's caching
// philosophy for the Windows exe.
import { execFile } from 'child_process';
import { promisify } from 'util';
import { log } from '../log.js';
import { probeLoginShellCommand } from '../shell-path.js';

const execFileAsync = promisify(execFile);

export interface ResolveClaudeBinaryDarwinDeps {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  probe?: (shell: string, script: string, timeoutMs?: number) => Promise<string | null>;
}

// `undefined` = not yet resolved; `null` = definitively "no login-shell override — use bare
// PATH spawn" (mirrors resolveClaudeExePath's undefined/null convention in shared.ts).
let cachedDarwinClaudePath: string | null | undefined;

/** Test-only: clear the module cache so each test case starts from a clean resolution state. */
export function resetClaudeBinaryDarwinCacheForTest(): void {
  cachedDarwinClaudePath = undefined;
}

/** Clear the cache after a spawn-time ENOENT — the resolved binary vanished (moved/uninstalled)
 * since it was cached; the next spawn should re-probe rather than keep dead-spawning it. */
export function invalidateClaudeBinaryDarwinCache(): void {
  cachedDarwinClaudePath = undefined;
}

/**
 * `type -a claude` can report an alias/function line AND real binary lines. Take the first
 * token that names an actual filesystem path for this binary name — an alias/function whose
 * definition itself embeds a real path (the common case: `alias claude=/real/path/claude ...`)
 * still resolves; one with no embedded path (e.g. a shell function with no absolute path at
 * all) correctly yields no match, and the caller falls back to bare PATH spawn.
 */
function extractRealPath(binaryName: string, typeAOutput: string): string | null {
  const escaped = binaryName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`(/\\S*/${escaped})(?:[\\s'"]|$)`);
  for (const line of typeAOutput.split('\n')) {
    const match = line.match(re);
    if (match?.[1]) return match[1];
  }
  return null;
}

/**
 * Resolve `claude` (or another binary name) the way the user's login shell would: `command -v`
 * first, falling back to `type -a` when the shell reports alias/function text instead of a bare
 * path. Cached across every spawn (start + resume + board) once a DEFINITIVE answer is reached —
 * a real path, or a confirmed "no override, use PATH". A probe that times out or whose child
 * shell never ran at all is TRANSIENT and left uncached, so the next spawn retries instead of
 * poisoning every future spawn on one flaky shell startup (mirrors resolveClaudeExePath's
 * FLUX-985 transient-not-cached rule in shared.ts).
 */
export async function resolveClaudeBinaryPathDarwin(
  binaryName = 'claude',
  deps: ResolveClaudeBinaryDarwinDeps = {}
): Promise<string | null> {
  if (cachedDarwinClaudePath !== undefined) return cachedDarwinClaudePath;

  const platform = deps.platform ?? process.platform;
  if (platform !== 'darwin') {
    cachedDarwinClaudePath = null;
    return null;
  }

  const env = deps.env ?? process.env;
  const shell = env.SHELL || '/bin/zsh';
  const probe = deps.probe ?? probeLoginShellCommand;

  const commandV = await probe(shell, `command -v ${binaryName} 2>/dev/null`);
  let resolved: string | null;
  if (commandV === null) {
    log.info(`[claude] darwin login-shell probe for "${binaryName}" timed out/failed — using bare PATH spawn this turn (will retry next spawn)`);
    return null; // transient — leave cache unset
  } else if (commandV.startsWith('/')) {
    resolved = commandV; // command -v returned a real path directly
  } else {
    // Non-path output = an alias/function definition, not a usable path — fall back to `type -a`.
    const typeA = await probe(shell, `type -a ${binaryName} 2>/dev/null`);
    if (typeA === null) {
      log.info(`[claude] darwin login-shell "type -a ${binaryName}" probe timed out/failed — using bare PATH spawn this turn (will retry next spawn)`);
      return null; // transient — leave cache unset
    }
    resolved = extractRealPath(binaryName, typeA);
  }

  cachedDarwinClaudePath = resolved;
  if (resolved) {
    log.info(`[claude] Resolved "${binaryName}" via login shell: ${resolved}`);
  } else {
    log.info(`[claude] Login shell has no resolvable path for "${binaryName}" (alias/function with no backing path, or not found) — using bare PATH spawn`);
  }

  await logIfBareResolutionDiffers(binaryName, resolved, env);
  return resolved;
}

/** FLUX-1600 design: if the login-shell resolution and the bare-PATH resolution disagree, log
 * both at info level — feeds FLUX-1599's self-diagnostics sibling ticket. Best-effort only: a
 * failure here must never affect which binary actually gets spawned. */
async function logIfBareResolutionDiffers(binaryName: string, resolved: string | null, env: NodeJS.ProcessEnv): Promise<void> {
  if (!resolved) return;
  try {
    const { stdout } = await execFileAsync('which', [binaryName], { env, timeout: 5_000, windowsHide: true });
    const barePath = stdout.trim();
    if (barePath && barePath !== resolved) {
      log.info(`[claude] login-shell resolution ("${resolved}") disagrees with bare PATH lookup ("${barePath}") for "${binaryName}" — spawning the login-shell path`);
    }
  } catch {
    // A failing bare lookup isn't itself notable here — checkBinaryInstalled surfaces a missing binary.
  }
}
