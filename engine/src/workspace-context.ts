import type chokidar from 'chokidar';
import type { StoredDoc } from './file-utils.js';

/** A ticket file that failed to parse/validate, keyed by ticket id in `Workspace.parseErrors`. */
export interface TaskParseError {
  id: string;
  path: string;
  error: string;
}

type FsWatcher = ReturnType<typeof chokidar.watch>;

/**
 * Serializes workspace activation (FLUX-343). `activateWorkspace` used to be guarded by nothing
 * but the `workspaceActivating` boolean — a signal, not a lock: two concurrent switch calls could
 * interleave cache-clear, watcher teardown, and `setWorkspaceRoot`, leaving the engine bound to
 * one root with the other root's watchers. Every activation now runs through `runExclusive`,
 * which chains callers so a second switch waits for the first to fully finish (including its
 * `finally` cleanup) before starting.
 */
export class ActivationLock {
  private tail: Promise<void> = Promise.resolve();

  runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.tail.then(fn);
    // Keep the chain alive whether fn resolved or rejected; the rejection still
    // propagates to `run`'s caller.
    this.tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
}

/**
 * The one active workspace's live state (FLUX-343, epic FLUX-1043). Everything here used to be
 * scattered module-level singletons — `tasksCache`/`docsCache`/`parseErrors`/`workspaceActivating`
 * in task-store.ts, `workspaceRoot` in workspace.ts, `configCache` in config.ts, plus the three
 * chokidar watcher handles — which made workspace switching racy and a parallel-workspaces mode
 * structurally impossible. Scope here is deliberately "one active workspace, encapsulated":
 * `getWorkspace()` is the single accessor, and the follow-up epic (FLUX-1230) swaps it for a
 * registry lookup without another consumer-wide rewrite.
 */
export class Workspace {
  /** Canonical absolute root path (realpath-normalized on activation), or null before first bind. */
  root: string | null = null;

  /**
   * All loaded tickets keyed by id. The value type intentionally stays `any` (FLUX-1073):
   * narrowing it cascades `| undefined` (noUncheckedIndexedAccess) into ~40 consumer files that
   * read/assign entries directly — see task-store.ts's TaskRecord doc comment for the history.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tasks: Record<string, any> = {};

  /** All loaded docs (project docs + group docs) keyed by doc path. */
  docs: Record<string, StoredDoc> = {};

  /** Ticket files that failed to parse/validate, keyed by ticket id. */
  parseErrors: Record<string, TaskParseError> = {};

  /**
   * The workspace's merged config (defaults + config.json). Seeded lazily by config.ts's
   * `getConfig()` — stays `any` for the same FLUX-1073 reason as `tasks`. `null` only before
   * the very first `getConfig()` call in the process.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  config: any = null;

  /**
   * True while `activateWorkspace` is mid-switch. Downstream write paths (REST create/update,
   * MCP tools, bootstrap import) check this and return a transient-retry error instead of
   * writing into a half-cleared cache. Serialization of the switch itself is `activationLock`'s
   * job — this flag is the cheap read-only signal for everyone else.
   */
  isActivating = false;

  /** chokidar watcher over the active .flux / .flux-store dir (tickets + config.json). */
  fluxWatcher: FsWatcher | null = null;

  /** chokidar watcher over the docs dir. */
  docsWatcher: FsWatcher | null = null;

  /** chokidar watcher over the active group's .flux-group store (null in single-repo mode). */
  groupDocsWatcher: FsWatcher | null = null;

  /** Serializes activateWorkspace calls — see {@link ActivationLock}. */
  readonly activationLock = new ActivationLock();
}

// Scope A (FLUX-343): exactly one Workspace per process, created eagerly and mutated in place by
// activation. Consumers must go through getWorkspace() at call time (not capture the fields at
// module scope) so the parallel-workspaces epic can swap this for per-request resolution.
const activeWorkspace = new Workspace();

/** The single active workspace. The one seam the FLUX-1230 registry later replaces. */
export function getWorkspace(): Workspace {
  return activeWorkspace;
}
