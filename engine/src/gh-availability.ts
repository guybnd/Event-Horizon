import { execFile } from 'child_process';
import { promisify } from 'util';
import { getGhAvailability, type GhAvailability } from './branch-manager.js';

const execFileAsync = promisify(execFile);

/**
 * FLUX-1683: the single re-resolvable cache over `getGhAvailability()`. `index.ts`
 * previously assigned a module-local `ghAuthAvailable` boolean exactly once at boot
 * and never re-read it, so authenticating `gh` while the engine ran left every
 * consumer (the `/api/health` payload, `runPrReconcileTick`'s gate) stuck on the
 * boot-time value until a restart. Routing every read through this module — plus
 * `POST /api/gh/recheck` calling `refreshGhAvailability()` — makes Re-check work
 * live.
 */
let cached: GhAvailability | null = null;
let inFlight: Promise<GhAvailability> | null = null;
let lastCheckedAt: number | null = null;

/** The last-probed result, or `null` if `refreshGhAvailability()` has never run. */
export function getCachedGhAvailability(): GhAvailability | null {
  return cached;
}

/** `true` only once a probe has resolved `{ ok: true }`; `false` before any probe or on failure. */
export function isGhAvailable(): boolean {
  return cached?.ok === true;
}

/** When the last probe (successful or not) was made, or `null` if none has run yet. */
export function getGhLastCheckedAt(): number | null {
  return lastCheckedAt;
}

/**
 * Probe `gh` and store the result. Concurrent calls dedupe onto a single underlying
 * probe via a shared in-flight promise — otherwise Re-check and the boot probe (or
 * two rapid Re-check clicks) would each spawn their own `gh auth status`.
 *
 * `lastCheckedAt` is stamped in the `finally`, not the `then`, so it advances even if
 * a probe attempt rejects — successful and failed probes should both count toward
 * `ensureGhAvailabilityFresh()`'s `GH_MIN_RECHECK_MS` floor (`getGhAvailability()` never
 * actually rejects today, but the floor should hold even if that ever changes).
 */
export async function refreshGhAvailability(): Promise<GhAvailability> {
  if (inFlight) return inFlight;
  inFlight = getGhAvailability()
    .then((result) => {
      cached = result;
      return result;
    })
    .finally(() => {
      lastCheckedAt = Date.now();
      inFlight = null;
    });
  return inFlight;
}

/** Catches logout/token expiry on an otherwise-healthy gh without a probe every tick. */
const GH_POSITIVE_RECHECK_MS = 15 * 60_000;
/**
 * A floor under re-probes once a cache exists (negative cache included) — far below the
 * 90s reconcile tick so it never delays the self-heal, but it collapses bursts: it kills
 * the redundant second probe at boot (the boot continuation's `refreshGhAvailability()`
 * resolves, then the leading-edge tick would otherwise re-probe a negative cache
 * immediately) and makes repeated dialog opens within 30s free when gh is unavailable.
 * Does NOT cover the very first probe (`cached === null` below returns before this floor
 * is even read) — there's nothing to rate-limit against yet.
 */
const GH_MIN_RECHECK_MS = 30_000;

/**
 * The single place the "should we re-probe right now" decision lives, so both the 90s
 * reconcile tick and `GET /api/gh/status` share one freshness policy instead of each
 * re-deriving it. Decision table: cache `null` → probe; within `GH_MIN_RECHECK_MS` of
 * `lastCheckedAt` → return `cached`; negative and past the floor → probe (the self-heal);
 * positive and past `GH_POSITIVE_RECHECK_MS` → probe; positive and fresh → return `cached`.
 * Nothing new is needed for concurrency — `refreshGhAvailability()`'s `inFlight` dedupe
 * already collapses simultaneous callers.
 *
 * Never rejects: resolves `null` only when availability was never determined (no cache,
 * and the first-ever probe failed) — callers treat `null` as "don't know", not as an error.
 */
export async function ensureGhAvailabilityFresh(): Promise<GhAvailability | null> {
  if (cached === null) {
    try {
      return await refreshGhAvailability();
    } catch {
      return null;
    }
  }

  const age = lastCheckedAt === null ? Infinity : Date.now() - lastCheckedAt;
  if (age < GH_MIN_RECHECK_MS) return cached;
  if (cached.ok && age < GH_POSITIVE_RECHECK_MS) return cached;

  try {
    return await refreshGhAvailability();
  } catch {
    return cached;
  }
}

type LinuxPackageManager = 'pacman' | 'apt' | 'dnf' | 'zypper';
const LINUX_PACKAGE_MANAGERS: LinuxPackageManager[] = ['pacman', 'apt', 'dnf', 'zypper'];

let cachedPackageManager: LinuxPackageManager | null | undefined;

async function isOnPath(bin: string): Promise<boolean> {
  try {
    await execFileAsync('which', [bin], { windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * Which of `pacman`/`apt`/`dnf`/`zypper` is actually on `PATH`, in that fixed order
 * (first hit wins) — `process.platform` alone can't pick an install command, since
 * it reports `'linux'` identically for Arch, Debian/Ubuntu, Fedora, and openSUSE.
 * `null` off Linux (never probes) or when none of the four resolve. Memoized per
 * process — a running engine's distro package manager doesn't change underfoot.
 */
export async function detectLinuxPackageManager(): Promise<LinuxPackageManager | null> {
  if (process.platform !== 'linux') return null;
  if (cachedPackageManager !== undefined) return cachedPackageManager;
  for (const candidate of LINUX_PACKAGE_MANAGERS) {
    if (await isOnPath(candidate)) {
      cachedPackageManager = candidate;
      return cachedPackageManager;
    }
  }
  cachedPackageManager = null;
  return cachedPackageManager;
}
