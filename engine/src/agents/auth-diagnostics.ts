// FLUX-1599: self-diagnose a CLI auth failure instead of asking the user to run shell commands.
//
// When a session's terminalReason is classified 'auth-expired' (claude-code.ts), the raw 401/403
// tells the user nothing about WHY — the field report behind this ticket (FLUX-1597) was a user
// whose terminal `claude` worked fine while the app-spawned one 401'd, because the two resolved
// different binaries with different credential stores. This module runs the checks a support
// thread would otherwise ask the user to paste by hand: which binary we spawned vs. what the
// terminal resolves, whether there's more than one install on PATH, and whether a settings file or
// env var is shadowing the `/login` token with a stale/invalid key.
//
// Probe discipline mirrors shell-path.ts: every shell-out is non-interactive (no stdin) and
// hard-timeout bounded, so a hung/prompting probe can never block the failure path itself.
import { execFile } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { cleanChildEnv } from './shared.js';

const execFileAsync = promisify(execFile);
const PROBE_TIMEOUT_MS = 5_000;
// "cached briefly" per the ticket — long enough that a burst of retry-driven auth failures in the
// same turn doesn't re-run every probe, short enough that a diagnosis taken mid-fix (user is
// actively removing a duplicate install / editing settings.json) isn't stale for long.
const DIAGNOSIS_CACHE_TTL_MS = 30_000;
const MARKER = '__EH_AUTH_DIAG__';

export interface AuthDiagnosis {
  spawnedBinary: { path: string; version?: string | undefined };
  terminalBinary?: { resolution: string; path?: string | undefined; version?: string | undefined } | undefined;
  duplicates: string[];
  shadowing: { settingsKey: boolean; settingsHelper: boolean; envKey: boolean; baseUrl: boolean };
  verdict: 'binary-divergence' | 'duplicate-installs' | 'shadowed-credentials' | 'token-rejected' | 'unknown';
}

/** Parse `type -a <bin>`'s first line into a human resolution string plus an extracted path, if
 *  any — an alias/function resolution (e.g. "claude is aliased to `/path/to/claude'") still
 *  yields the target path; a plain function with no path in its output leaves `path` unset. */
export function parseLoginShellResolution(output: string): { resolution: string; path?: string | undefined } | null {
  const firstLine = output.split('\n').map((l) => l.trim()).find((l) => l.length > 0);
  if (!firstLine) return null;
  const pathMatch = firstLine.match(/(\/[^\s'"`]+)/);
  const captured = pathMatch?.[1];
  return captured ? { resolution: firstLine, path: captured } : { resolution: firstLine };
}

/**
 * Probe the user's login shell for how it resolves `binaryName` — darwin-only caller (the "terminal
 * works, app doesn't" divergence this ticket targets). Marker-wrapped like shell-path.ts's
 * `probeLoginShellPath` so rc-file noise on stdout can't be mistaken for the real output; no stdin,
 * hard timeout. `type -a` (not `command -v`) deliberately, since we want its introspection of
 * aliases/functions, not just a plain PATH lookup.
 */
export function probeLoginShellTypeA(shell: string, binaryName: string, timeoutMs = PROBE_TIMEOUT_MS): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      shell,
      ['-ilc', `echo -n ${MARKER}; type -a ${binaryName}`],
      { timeout: timeoutMs, windowsHide: true },
      (_err, stdout) => {
        const out = String(stdout || '');
        const idx = out.indexOf(MARKER);
        if (idx === -1) { resolve(null); return; }
        const value = out.slice(idx + MARKER.length).trim();
        resolve(value || null);
      }
    );
  });
}

/** Every resolvable install of `binaryName` on PATH, in PATH order, de-duplicated — `which -a` on
 *  posix, `where` on Windows (which already lists every match). The first entry is what a bare
 *  `spawn(binaryName, …)` would resolve; more than one entry is the "duplicate installs" red flag. */
export async function resolveAllInstalls(binaryName: string, timeoutMs = PROBE_TIMEOUT_MS): Promise<string[]> {
  const checker = process.platform === 'win32' ? 'where' : 'which';
  const args = process.platform === 'win32' ? [binaryName] : ['-a', binaryName];
  try {
    const { stdout } = await execFileAsync(checker, args, { timeout: timeoutMs, windowsHide: true, env: cleanChildEnv() });
    const seen = new Set<string>();
    const out: string[] = [];
    for (const line of stdout.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (trimmed && !seen.has(trimmed)) { seen.add(trimmed); out.push(trimmed); }
    }
    return out;
  } catch {
    return [];
  }
}

/** `<binaryPath> --version`, trimmed; undefined on any failure/timeout — a probe, not a hard
 *  requirement, so version is best-effort and never blocks the rest of the diagnosis. */
export async function probeVersion(binaryPath: string, timeoutMs = PROBE_TIMEOUT_MS): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync(binaryPath, ['--version'], { timeout: timeoutMs, windowsHide: true, env: cleanChildEnv() });
    const version = stdout.trim();
    return version || undefined;
  } catch {
    return undefined;
  }
}

function readFileIfExists(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, 'utf-8');
  } catch {
    return null;
  }
}

/** Presence-only flags from one `settings.json` body — NEVER returns the actual key/helper/URL
 *  value, only whether it's set, per the ticket's "report presence only" constraint. */
export function extractSettingsFlags(raw: string): { key: boolean; helper: boolean; baseUrl: boolean } {
  try {
    const parsed = JSON.parse(raw) as { env?: Record<string, unknown>; apiKeyHelper?: unknown };
    const env = parsed?.env ?? {};
    return {
      key: typeof env.ANTHROPIC_API_KEY === 'string' && env.ANTHROPIC_API_KEY.length > 0,
      helper: typeof parsed?.apiKeyHelper === 'string' && parsed.apiKeyHelper.length > 0,
      baseUrl: typeof env.ANTHROPIC_BASE_URL === 'string' && env.ANTHROPIC_BASE_URL.length > 0,
    };
  } catch {
    return { key: false, helper: false, baseUrl: false };
  }
}

/** Check both the user-level and (if known) workspace-level `.claude/settings.json` for a
 *  credential override that would shadow the `/login` token — read-only, presence-only. */
export function checkSettingsShadowing(
  workspaceRoot: string | undefined,
  readFile: (filePath: string) => string | null = readFileIfExists,
): { settingsKey: boolean; settingsHelper: boolean; baseUrl: boolean } {
  const paths = [path.join(os.homedir(), '.claude', 'settings.json')];
  if (workspaceRoot) paths.push(path.join(workspaceRoot, '.claude', 'settings.json'));
  let settingsKey = false;
  let settingsHelper = false;
  let baseUrl = false;
  for (const p of paths) {
    const raw = readFile(p);
    if (!raw) continue;
    const flags = extractSettingsFlags(raw);
    settingsKey = settingsKey || flags.key;
    settingsHelper = settingsHelper || flags.helper;
    baseUrl = baseUrl || flags.baseUrl;
  }
  return { settingsKey, settingsHelper, baseUrl };
}

/** Presence-only check of the engine's OWN env — never logs/returns the value. */
export function checkEnvShadowing(env: NodeJS.ProcessEnv): { envKey: boolean; baseUrl: boolean } {
  return {
    envKey: Boolean(env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN),
    baseUrl: Boolean(env.ANTHROPIC_BASE_URL),
  };
}

/**
 * Priority order matters: a terminal/spawn binary mismatch is the most specific, most actionable
 * finding (FLUX-1597's actual field report), so it wins even if shadowing also happens to be
 * present. Duplicate installs are the next most specific "this machine has stale state" signal.
 * Shadowed credentials come next — a real cause, but a settings/env override existing doesn't
 * necessarily mean IT is what rejected the token. `token-rejected` is the honest fallback: a single
 * clean binary, nothing shadowing it, so the credential itself is what the provider rejected.
 */
export function computeVerdict(d: Omit<AuthDiagnosis, 'verdict'>): AuthDiagnosis['verdict'] {
  if (d.terminalBinary && d.spawnedBinary.path) {
    const divergesOnPath = d.terminalBinary.path && d.terminalBinary.path !== d.spawnedBinary.path;
    const terminalIsAliasOrFunction = !d.terminalBinary.path;
    if (divergesOnPath || terminalIsAliasOrFunction) return 'binary-divergence';
  }
  if (d.duplicates.length > 1) return 'duplicate-installs';
  if (d.shadowing.settingsKey || d.shadowing.settingsHelper || d.shadowing.envKey || d.shadowing.baseUrl) {
    return 'shadowed-credentials';
  }
  if (d.spawnedBinary.path) return 'token-rejected';
  return 'unknown';
}

export interface AuthDiagnosisDeps {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  resolveAllInstalls?: (binaryName: string) => Promise<string[]>;
  probeVersion?: (binaryPath: string) => Promise<string | undefined>;
  probeLoginShellTypeA?: (shell: string, binaryName: string) => Promise<string | null>;
  /** Authoritative override for "what we actually spawn" — e.g. Windows' `resolveClaudeExePath`,
   *  which resolves claude.exe directly rather than relying on a bare PATH lookup (claude-code.ts
   *  spawns this way, not via `where`'s first hit). Undefined/null result falls back to the first
   *  `resolveAllInstalls` entry. */
  resolveSpawnedPath?: (() => Promise<string | null>) | undefined;
  readSettingsFile?: (filePath: string) => string | null;
  now?: () => number;
}

interface CacheEntry { at: number; diagnosis: AuthDiagnosis }
const diagnosisCache = new Map<string, CacheEntry>();

/** Run every check and produce one structured verdict for an `auth-expired` session. Cached
 *  briefly per (binaryName, workspaceRoot) so a burst of auth failures in one turn doesn't re-run
 *  every probe. */
export async function diagnoseAuthFailure(
  binaryName: string,
  workspaceRoot?: string,
  deps: AuthDiagnosisDeps = {},
): Promise<AuthDiagnosis> {
  const now = deps.now ?? Date.now;
  const cacheKey = `${binaryName}:${workspaceRoot ?? ''}`;
  const cached = diagnosisCache.get(cacheKey);
  if (cached && now() - cached.at < DIAGNOSIS_CACHE_TTL_MS) return cached.diagnosis;

  const platform = deps.platform ?? process.platform;
  const env = deps.env ?? process.env;
  const resolveAllInstallsFn = deps.resolveAllInstalls ?? resolveAllInstalls;
  const probeVersionFn = deps.probeVersion ?? probeVersion;
  const probeLoginShellTypeAFn = deps.probeLoginShellTypeA ?? probeLoginShellTypeA;
  const readSettingsFileFn = deps.readSettingsFile ?? readFileIfExists;

  const installs = await resolveAllInstallsFn(binaryName);
  let spawnedPath = installs[0];
  if (deps.resolveSpawnedPath) {
    const resolved = await deps.resolveSpawnedPath();
    if (resolved) spawnedPath = resolved;
  }
  const spawnedVersion = spawnedPath ? await probeVersionFn(spawnedPath) : undefined;

  let terminalBinary: AuthDiagnosis['terminalBinary'];
  if (platform === 'darwin') {
    const shell = env.SHELL || '/bin/zsh';
    const raw = await probeLoginShellTypeAFn(shell, binaryName);
    const parsed = raw ? parseLoginShellResolution(raw) : null;
    if (parsed) {
      const version = parsed.path ? await probeVersionFn(parsed.path) : undefined;
      terminalBinary = { resolution: parsed.resolution, path: parsed.path, version };
    }
  }

  const settingsFlags = checkSettingsShadowing(workspaceRoot, readSettingsFileFn);
  const envFlags = checkEnvShadowing(env);
  const shadowing = {
    settingsKey: settingsFlags.settingsKey,
    settingsHelper: settingsFlags.settingsHelper,
    envKey: envFlags.envKey,
    baseUrl: settingsFlags.baseUrl || envFlags.baseUrl,
  };

  const base: Omit<AuthDiagnosis, 'verdict'> = {
    spawnedBinary: { path: spawnedPath ?? '', version: spawnedVersion },
    terminalBinary,
    duplicates: installs,
    shadowing,
  };
  const diagnosis: AuthDiagnosis = { ...base, verdict: computeVerdict(base) };
  diagnosisCache.set(cacheKey, { at: now(), diagnosis });
  return diagnosis;
}

/** The user-facing line appended to the chat via `appendErrorToSession` — plain language, no raw
 *  shell output, actionable next step per verdict. */
export function formatAuthDiagnosisMessage(d: AuthDiagnosis): string {
  switch (d.verdict) {
    case 'binary-divergence': {
      const spawned = `${d.spawnedBinary.path || 'unknown'}${d.spawnedBinary.version ? ` (v${d.spawnedBinary.version})` : ''}`;
      const terminal = d.terminalBinary?.path
        ? `${d.terminalBinary.path}${d.terminalBinary.version ? ` (v${d.terminalBinary.version})` : ''}`
        : (d.terminalBinary?.resolution || 'a different binary');
      return `Authentication failed — your terminal resolves ${terminal}, but the app spawned ${spawned}. Remove the stale install or fix PATH so both resolve the same binary, then retry.`;
    }
    case 'duplicate-installs':
      return `Authentication failed — found multiple installs on PATH (${d.duplicates.join(', ')}). One likely holds a stale credential; remove the duplicate(s) and keep the one you use to log in, then retry.`;
    case 'shadowed-credentials': {
      const causes = [
        d.shadowing.settingsKey && 'settings.json env.ANTHROPIC_API_KEY',
        d.shadowing.settingsHelper && 'settings.json apiKeyHelper',
        d.shadowing.envKey && 'an ANTHROPIC_API_KEY/ANTHROPIC_AUTH_TOKEN environment variable',
        d.shadowing.baseUrl && 'an ANTHROPIC_BASE_URL override',
      ].filter(Boolean).join(', ');
      return `Authentication failed — ${causes} is overriding your logged-in credential. Remove or update the override, then retry.`;
    }
    case 'token-rejected':
      return 'Authentication failed — run `claude login` to refresh your credentials; we\'ll retry automatically once you\'re re-authenticated.';
    case 'unknown':
    default:
      return 'Authentication failed and self-diagnostics couldn\'t pin down the cause. Try `claude login`, or check for multiple claude installs or a settings.json override.';
  }
}
