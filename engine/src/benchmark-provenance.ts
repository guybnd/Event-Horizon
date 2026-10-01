// Provenance stamping for benchmark runs (FLUX-1739 follow-up).
//
// WHY THIS IS NOT OPTIONAL BOOKKEEPING. The L2.5 friction layer measures EVENTHORIZON ITSELF — how
// often its tools failed the agent, how much context it injected, how often a run parked. A friction
// number is therefore only meaningful against a named version of EventHorizon. Two suites run a
// rebuild apart are not comparable, and without a stamp nothing in the stored record says so.
//
// This is not hypothetical: during the very first live multi-cell runs, three suites executed against
// three different engine builds (a calibration fix, a ticket-minting fix, a workspace-binding fix
// landed between them). Their reports look directly comparable and are not.
//
// The `dirty` flag matters as much as the commit. Benchmarking from a modified working tree is the
// normal case while developing the benchmark itself, and a commit SHA alone would claim a precision
// the run does not have.

import { runGit } from './git-exec.js';
import { log } from './log.js';

export interface EnginePunchcard {
  /** Package version of the engine that executed the run. */
  version: string;
  /** Commit of the EventHorizon checkout the engine was built/run from, when resolvable. */
  commit?: string;
  /** True when that checkout had uncommitted changes — the stamp is then approximate by definition. */
  dirty?: boolean;
  capturedAt: string;
}

let cached: EnginePunchcard | undefined;

/**
 * Capture the running engine's identity.
 *
 * Cached per process: it cannot change without a restart, and a restart produces a fresh process
 * (which is precisely the event that would change the answer).
 */
export async function captureEngineProvenance(engineRoot: string, version: string): Promise<EnginePunchcard> {
  if (cached) return cached;

  const card: EnginePunchcard = { version, capturedAt: new Date().toISOString() };
  try {
    const { stdout } = await runGit(['rev-parse', 'HEAD'], { cwd: engineRoot });
    card.commit = stdout.trim();
    const status = await runGit(['status', '--porcelain'], { cwd: engineRoot });
    card.dirty = isEngineDirty(status.stdout);
  } catch (err) {
    // A benchmark can legitimately run from a packaged build with no git checkout behind it. Record
    // what we have rather than failing the run — an absent commit is honest; a fabricated one is not.
    log.warn(`[benchmark-provenance] could not resolve engine commit: ${err instanceof Error ? err.message : String(err)}`);
  }

  cached = card;
  return card;
}

/** Test seam. */
/**
 * Is the ENGINE modified? Scoped to `engine/` deliberately.
 *
 * A run's worktree is pinned to the suite's baseCommit, so nothing outside the engine's own source
 * can reach it: a modified `AGENTS.md`, a portal edit or a stray doc in the checkout the engine runs
 * from changes no behaviour a run can observe. Counting them would disqualify every suite on a
 * machine where a human is also working — which is every machine — and a provenance rule that
 * disqualifies everything protects nothing.
 *
 * Paths are taken from `git status --porcelain` (XY + space + path; renames as `old -> new`).
 */
export function isEngineDirty(porcelain: string): boolean {
  for (const raw of porcelain.split(/\r?\n/)) {
    if (!raw.trim()) continue;
    const entry = raw.slice(3);
    const paths = entry.split(' -> ').map((p) => p.trim().replace(/^"|"$/g, ''));
    if (paths.some((p) => p.startsWith('engine/') && !p.startsWith('engine/node_modules/'))) return true;
  }
  return false;
}

export function __resetProvenanceCache(): void {
  cached = undefined;
}

/**
 * Are two runs comparable on platform grounds?
 *
 * Deliberately strict: a differing commit, OR either side dirty, means NO. A dirty tree cannot be
 * shown equal to anything, including itself at another moment — which is the whole point of
 * recording the flag rather than quietly dropping it.
 */
export function comparableProvenance(a: EnginePunchcard | undefined, b: EnginePunchcard | undefined): boolean {
  if (!a || !b) return false;
  if (a.dirty || b.dirty) return false;
  if (!a.commit || !b.commit) return false;
  return a.commit === b.commit;
}
