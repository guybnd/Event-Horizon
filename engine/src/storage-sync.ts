import { log } from './log.js';
import fs from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import { execFile, type ExecFileException } from 'child_process';
import { promisify } from 'util';
import { BUILTIN_MODULES } from './modules.js';
import { buildGitSyncEnv, classifyGitError, GIT_SYNC_TIMEOUT_MS } from './git-sync-env.js';
import { addOrphanWorktree, isWorktreeOnBranch } from './git-worktree.js';
import { reportDivergedStatus, clearSyncStateAfterForceReset, withSyncLock, SUPPORTED_SYNC_PROTOCOL, SYNC_PROTOCOL_MARKER_FILE } from './sync-watcher.js';

const execFileAsync = promisify(execFile);

const MEMORY_GITIGNORE_DIRS = BUILTIN_MODULES
  .flatMap(m => m.scaffold?.dirs ?? [])
  .filter((v, i, a) => a.indexOf(v) === i);

// Creates scaffold dirs under the active flux store dir and seeds them with a .gitignore
// so SQLite/binary files are never committed by sync-watcher's `git add -A`.
// Called at startup (for every workspace) and when modules are newly enabled.
export async function scaffoldModuleDirs(storeDir: string, dirs: string[]): Promise<void> {
  for (const dir of dirs) {
    const absDir = path.join(storeDir, dir);
    await fs.mkdir(absDir, { recursive: true });
    const gitignorePath = path.join(absDir, '.gitignore');
    try {
      await fs.access(gitignorePath);
    } catch {
      await fs.writeFile(gitignorePath, '*.db\n*.db-wal\n*.db-shm\n', 'utf-8');
    }
  }
}

// FLUX-895: startup pull / orphan-migrate git calls share the sync's non-interactive +
// gh-authenticated env, so they can't pop a credential window during boot either.
async function git(cwd: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  // cwd scopes buildGitSyncEnv's gh-credential injection to an actual github.com remote (FLUX-987).
  const env = await buildGitSyncEnv(cwd);
  // FLUX-989: bound every startup/migrate git call — a hung pull/fetch/push (large
  // divergence, stalled credential prompt, dead network) must not wedge boot forever.
  try {
    return await execFileAsync('git', args, { cwd, windowsHide: true, env, timeout: GIT_SYNC_TIMEOUT_MS });
  } catch (err: unknown) {
    // FLUX-993: same rewrite as sync-watcher.ts's execFileAsync — without it a timed-out
    // migrate/startup pull surfaces as an opaque "Command failed" instead of something
    // callers can act on (or that classifyGitError would recognize as `network`).
    const execErr = err as ExecFileException;
    if (execErr && execErr.killed && execErr.signal === 'SIGTERM') {
      throw new Error(`git operation timed out after ${GIT_SYNC_TIMEOUT_MS / 1000}s: git ${args.join(' ')}`, { cause: err });
    }
    throw err;
  }
}

/**
 * Local-per-workspace state that must NOT travel through the shared `flux-data`
 * branch (FLUX-532). `config.json` carries UI prefs + board structure (project
 * keys, columns) and `read-state.json` is per-user — syncing them made settings
 * revert on every fetch and leak between clones. They stay on disk locally; they
 * just stop being version-controlled in the orphan store.
 */
// FLUX-1428: sync-journal.jsonl is the durable op journal backing push-as-CAS + replay — pure
// per-engine local state (what THIS engine has applied but not yet confirmed pushed), never
// meaningful to another clone. It must never be synced/merged like a ticket file.
const STORE_LOCAL_IGNORES = ['config.json', 'read-state.json', 'open-prompts.json', 'open-prompts.json.tmp', 'session-binding-secret', 'session-binding-secret.tmp', 'sessions/', 'sync-journal.jsonl'];

/** Ensure the store-root `.gitignore` lists the local-only files. Returns true if it changed. */
async function ensureStoreLocalGitignore(storeDir: string): Promise<boolean> {
  const gi = path.join(storeDir, '.gitignore');
  const existing = await fs.readFile(gi, 'utf-8').catch(() => '');
  const present = new Set(existing.split('\n').map((l) => l.trim()).filter(Boolean));
  const missing = STORE_LOCAL_IGNORES.filter((e) => !present.has(e));
  if (missing.length === 0) return false;
  const prefix = existing.length === 0
    ? '# Local-per-workspace state — never synced through flux-data (FLUX-532)\n'
    : existing.endsWith('\n') ? '' : '\n';
  await fs.writeFile(gi, existing + prefix + missing.join('\n') + '\n', 'utf-8');
  return true;
}

/**
 * Keep `config.json` / `read-state.json` out of `flux-data` sync: seed the store
 * `.gitignore` and untrack any copies an older engine already committed (one-time
 * migration). The working files are preserved (`rm --cached`), so the local
 * machine keeps its settings. Idempotent — safe to run on every startup.
 */
export async function excludeLocalConfigFromSync(storeDir: string): Promise<void> {
  if (!existsSync(storeDir)) return;
  try {
    const seeded = await ensureStoreLocalGitignore(storeDir);
    const { stdout: tracked } = await git(storeDir, ['ls-files', ...STORE_LOCAL_IGNORES]).catch(() => ({ stdout: '' }));
    const hadTracked = tracked.trim().length > 0;
    if (hadTracked) {
      await git(storeDir, ['rm', '--cached', '--ignore-unmatch', ...STORE_LOCAL_IGNORES]).catch(() => {});
    }
    if (seeded || hadTracked) {
      await git(storeDir, ['add', '.gitignore']).catch(() => {});
      const { stdout: status } = await git(storeDir, ['status', '--porcelain']).catch(() => ({ stdout: '' }));
      if (status.trim()) {
        await git(storeDir, ['commit', '-m', 'flux: stop syncing local config (config.json, read-state.json)']).catch(() => {});
      }
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    log.info(`[storage-sync] excludeLocalConfigFromSync skipped: ${message}`);
  }
}

/**
 * FLUX-1076: transcript files (`transcripts/<id>.jsonl`) are pure append-only event logs —
 * every line is an independent, already-timestamped, immutable event, so two sides that both
 * appended new lines since a common ancestor never actually disagree; they just each grew the
 * file. Git's built-in `union` merge driver resolves exactly that case (it takes lines from
 * BOTH sides instead of conflict-marking them) — no custom driver script needed, just this
 * gitattributes entry. Without it, an otherwise-harmless "both sides logged progress" transcript
 * divergence surfaced as a real unresolved merge conflict, which is how the flux-data sync wedge
 * this ticket hardens against got stuck in the first place.
 */
const GITATTRIBUTES_ENTRIES = ['transcripts/*.jsonl merge=union'];

/** Ensure the store-root `.gitattributes` lists the union-mergeable paths. Returns true if it changed. */
async function ensureStoreGitattributes(storeDir: string): Promise<boolean> {
  const ga = path.join(storeDir, '.gitattributes');
  const existing = await fs.readFile(ga, 'utf-8').catch(() => '');
  const present = new Set(existing.split('\n').map((l) => l.trim()).filter(Boolean));
  const missing = GITATTRIBUTES_ENTRIES.filter((e) => !present.has(e));
  if (missing.length === 0) return false;
  const prefix = existing.length === 0
    ? '# Union-mergeable append-only logs (FLUX-1076) — never a manual conflict\n'
    : existing.endsWith('\n') ? '' : '\n';
  await fs.writeFile(ga, existing + prefix + missing.join('\n') + '\n', 'utf-8');
  return true;
}

/**
 * Seed/repair `.gitattributes` in the store worktree and commit it when it changes. Idempotent
 * — safe on every startup, mirroring {@link excludeLocalConfigFromSync}'s self-healing pattern
 * so a store created before FLUX-1076 picks this up automatically.
 */
export async function ensureUnionMergeAttributes(storeDir: string): Promise<void> {
  if (!existsSync(storeDir)) return;
  try {
    const seeded = await ensureStoreGitattributes(storeDir);
    if (!seeded) return;
    await git(storeDir, ['add', '.gitattributes']).catch(() => {});
    const { stdout: status } = await git(storeDir, ['status', '--porcelain']).catch(() => ({ stdout: '' }));
    if (status.trim()) {
      await git(storeDir, ['commit', '-m', 'flux: union-merge transcripts/*.jsonl (FLUX-1076)']).catch(() => {});
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    log.info(`[storage-sync] ensureUnionMergeAttributes skipped: ${message}`);
  }
}

/**
 * FLUX-1426: `sync-protocol` is a single-integer marker file at the store root that a stale
 * engine compares against {@link SUPPORTED_SYNC_PROTOCOL} before any mutating sync op — a
 * marker ahead of what this build supports fences sync read-only (see sync-watcher.ts's
 * `runSync`/`resolveConflicts` gate checks). Write-only helper (no commit) so callers that need
 * the marker bundled into a specific commit — the initial migration commit below — can do so.
 *
 * FLUX-1428: forward-bumps, never seed-if-absent-only — a protocol bump (like this ticket's 1 -> 2
 * for CAS+replay) must actually propagate to stores that already have an older marker committed.
 * "Never auto-bump" (FLUX-1426) means the engine never invents a version number at runtime, not
 * that a version deliberately shipped in code can't move an existing marker forward. Never
 * decreases: a marker already >= what we support is either already bumped or was set by a newer
 * engine we don't understand — either way this engine must not touch it (the gate handles the
 * latter case by fencing this engine out read-only).
 */
async function ensureSyncProtocolMarkerFile(storeDir: string): Promise<boolean> {
  const markerPath = path.join(storeDir, SYNC_PROTOCOL_MARKER_FILE);
  const current = await fs.readFile(markerPath, 'utf-8')
    .then((raw) => { const parsed = parseInt(raw.trim(), 10); return Number.isFinite(parsed) ? parsed : null; })
    .catch(() => null);
  if (current !== null && current >= SUPPORTED_SYNC_PROTOCOL) return false;
  await fs.writeFile(markerPath, `${SUPPORTED_SYNC_PROTOCOL}\n`, 'utf-8');
  return true;
}

/**
 * Seed (or forward-bump) the `sync-protocol` marker in the store worktree and commit it when it
 * changed. Idempotent — safe on every startup, mirroring {@link ensureUnionMergeAttributes}'s
 * self-healing pattern so a store created before FLUX-1426 picks up the marker automatically, and
 * a store still on an older protocol number picks up a deliberate bump (FLUX-1428) the same way.
 */
export async function ensureSyncProtocolMarker(storeDir: string): Promise<void> {
  if (!existsSync(storeDir)) return;
  try {
    const seeded = await ensureSyncProtocolMarkerFile(storeDir);
    if (!seeded) return;
    await git(storeDir, ['add', SYNC_PROTOCOL_MARKER_FILE]).catch(() => {});
    const { stdout: status } = await git(storeDir, ['status', '--porcelain']).catch(() => ({ stdout: '' }));
    if (status.trim()) {
      await git(storeDir, ['commit', '-m', `flux: sync-protocol marker -> ${SUPPORTED_SYNC_PROTOCOL}`]).catch(() => {});
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    log.info(`[storage-sync] ensureSyncProtocolMarker skipped: ${message}`);
  }
}

async function gitWithRetry(cwd: string, args: string[], maxRetries = 3): Promise<{ stdout: string; stderr: string }> {
  let attempts = 0;
  while (attempts < maxRetries) {
    try {
      return await git(cwd, args);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('index.lock') && attempts < maxRetries - 1) {
        log.info(`[storage-sync] Git lock detected, retrying in 1s (attempt ${attempts + 1}/${maxRetries})...`);
        await new Promise(r => setTimeout(r, 1000));
        attempts++;
      } else {
        throw err;
      }
    }
  }
  throw new Error('Unreachable');
}

export async function attachWorktreeIfPresent(
  workspaceRoot: string,
  onPulledFiles?: (storeDir: string, changedRelativePaths: string[]) => void,
): Promise<void> {
  const storeDir = path.join(workspaceRoot, '.flux-store');
  const isNewAttach = !existsSync(storeDir);

  if (!isNewAttach) {
    // FLUX-1002: don't block workspace activation (and the /workspaces/switch response) on this
    // network round-trip — pull in the background instead of awaiting it here.
    // FLUX-1184: this used to rely on `startWatchers()`'s chokidar watcher performing a full
    // initial 'add' scan (ignoreInitial defaulted false) moments later to catch whichever side of
    // the race a late-landing pull's writes fell on. That watcher now sets `ignoreInitial: true`
    // (killing a boot-time reload-storm — see task-store.ts), so it no longer replays 'add' for
    // pre-existing files and can't double as this catch-up path any more. Diff HEAD before/after
    // the pull instead and hand the caller exactly the files it touched, so it can reload just
    // those (mirrors the watcher's own incremental-reload path rather than a second full rescan).
    void (async () => {
      const beforeHead = onPulledFiles
        ? await git(storeDir, ['rev-parse', 'HEAD']).then((r) => r.stdout.trim()).catch(() => null)
        : null;
      try {
        await git(storeDir, ['pull', '--ff-only', 'origin', 'flux-data']);
        log.info('[storage-sync] Pulled latest flux-data in background');
        if (onPulledFiles && beforeHead) {
          const afterHead = await git(storeDir, ['rev-parse', 'HEAD']).then((r) => r.stdout.trim()).catch(() => null);
          if (afterHead && afterHead !== beforeHead) {
            const { stdout } = await git(storeDir, ['diff', '--name-only', beforeHead, afterHead]);
            const changedRelativePaths = stdout.split('\n').map((line) => line.trim()).filter(Boolean);
            if (changedRelativePaths.length > 0) onPulledFiles(storeDir, changedRelativePaths);
          }
        }
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        log.info(`[storage-sync] Could not pull in background: ${message}`);
        // FLUX-1232: `git pull --ff-only` fails ONLY when neither side is an ancestor of the
        // other (a true divergence) — remote-only new commits fast-forward cleanly, and
        // local-only new commits make it a trivial no-op. A network/auth failure is already
        // classified distinctly by classifyGitError, so 'unknown' here really does mean
        // divergence. Surface it before the periodic sync (triggered right after workspace
        // activation) risks an auto-merge across many files.
        if (classifyGitError(message) === 'unknown') {
          try {
            const { stdout } = await git(storeDir, ['rev-list', '--left-right', '--count', 'origin/flux-data...HEAD']);
            const [behindStr, aheadStr] = stdout.trim().split(/\s+/);
            const behind = parseInt(behindStr ?? '0', 10) || 0;
            const ahead = parseInt(aheadStr ?? '0', 10) || 0;
            if (ahead > 0 && behind > 0) reportDivergedStatus(ahead, behind);
          } catch {
            // Best-effort — the pull failure itself is already logged above.
          }
        }
      }
    })();
    // Scaffold dirs for all modules that declare one — idempotent, safe every startup.
    await scaffoldModuleDirs(storeDir, MEMORY_GITIGNORE_DIRS);
    // Keep local config/read-state out of flux-data (and migrate older tracked copies).
    await excludeLocalConfigFromSync(storeDir);
    // Self-heal a store created before FLUX-1076 onto the union-merge transcript attribute.
    await ensureUnionMergeAttributes(storeDir);
    // Self-heal a store created before FLUX-1426 onto the sync-protocol marker.
    await ensureSyncProtocolMarker(storeDir);
    return;
  }

  try {
    const { stdout } = await git(workspaceRoot, ['branch', '-r']);
    const hasRemote = stdout.split('\n').some((l) => l.trim() === 'origin/flux-data');
    if (!hasRemote) return;

    await git(workspaceRoot, ['worktree', 'add', '-b', 'flux-data', storeDir, 'origin/flux-data']);
    await scaffoldModuleDirs(storeDir, MEMORY_GITIGNORE_DIRS);
    await excludeLocalConfigFromSync(storeDir);
    await ensureUnionMergeAttributes(storeDir);
    await ensureSyncProtocolMarker(storeDir);
    log.info('[storage-sync] Re-attached .flux-store worktree from origin/flux-data');
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    log.info(`[storage-sync] attachWorktreeIfPresent skipped: ${message}`);
  }
}

// FLUX-1410: the one commit message that only ever lands once the ticket-file move (and the
// config/read-state/assets moves alongside it) has actually completed — used as positive
// evidence of a finished migration, not merely "the worktree has some commit".
const MIGRATION_COMMIT_MESSAGE = 'flux: migrate tickets to orphan branch';

/**
 * True when `storeDir`'s history contains the migration-complete commit. Deliberately stronger
 * than "has a resolvable HEAD": the pre-2.42 plumbing fallback (`addOrphanWorktree` in
 * git-worktree.ts) commits a root commit immediately to create the branch, so a HEAD exists the
 * instant the worktree is attached — before any files have moved. Checking for the specific
 * completion commit instead means a crash between that fallback and the real migrate-commit is
 * correctly seen as incomplete on retry (FLUX-1410), matching the modern `--orphan` path where
 * HEAD stays unborn until the same commit lands.
 */
async function hasMigrationCommit(storeDir: string): Promise<boolean> {
  const { stdout } = await git(storeDir, ['log', '--format=%s']);
  return stdout.split('\n').some((line) => line.trim() === MIGRATION_COMMIT_MESSAGE);
}

export async function migrateToOrphan(workspaceRoot: string): Promise<void> {
  const storeDir = path.join(workspaceRoot, '.flux-store');
  const fluxDir = path.join(workspaceRoot, '.flux');

  if (existsSync(storeDir)) {
    // FLUX-297: distinguish a genuinely-completed migration (an attached flux-data worktree that
    // has the migration-complete commit) from a stray/half-populated `.flux-store` left by a
    // previously failed attempt — e.g. `worktree add` wrote the dir but a later step crashed,
    // it's not a worktree at all, or it never got as far as the migrate commit. The former is an
    // idempotent no-op — the original report's "if the orphan branch already exists, just
    // continue" ask. The latter is cleared so the steps below can recreate it (an unborn or
    // commit-but-not-migrated worktree's branch has nothing worth keeping, so `worktree remove`
    // cleanly detaches it without losing anything real).
    const migrated = await isWorktreeOnBranch(git, storeDir, 'flux-data')
      && await hasMigrationCommit(storeDir).catch(() => false);
    if (migrated) return;
    await git(workspaceRoot, ['worktree', 'remove', '--force', storeDir]).catch(() => {});
    await fs.rm(storeDir, { recursive: true, force: true }).catch(() => {});
  }

  if (!existsSync(storeDir)) {
    const { stdout: branchList } = await git(workspaceRoot, ['branch', '--list', 'flux-data']);
    const hasLocal = !!branchList.trim();

    // Check if remote already has flux-data (e.g. set up on another machine)
    const { stdout: remoteBranches } = await git(workspaceRoot, ['branch', '-r']).catch(() => ({ stdout: '' }));
    const hasRemote = remoteBranches.split('\n').some((l) => l.trim() === 'origin/flux-data');

    if (hasLocal || hasRemote) {
      await git(workspaceRoot, ['worktree', 'add', storeDir, 'flux-data']);

      // FLUX-1410: an existing `flux-data` branch is only a genuinely-completed migration (e.g.
      // set up on another machine and pulled here) if it actually carries the migrate commit — a
      // local branch can also be a bare root commit left by the pre-2.42 plumbing fallback
      // (`addOrphanWorktree`) from an attempt on THIS machine that crashed before any ticket
      // content moved. Only short-circuit for the former; otherwise fall through to the shared
      // move+commit logic below (the worktree is already attached) so the crash converges
      // instead of silently skipping the move.
      if (await hasMigrationCommit(storeDir).catch(() => false)) {
        const gitignorePath = path.join(workspaceRoot, '.gitignore');
        const existing = await fs.readFile(gitignorePath, 'utf-8').catch(() => '');
        const marker = '# flux-data orphan mode';
        if (!existing.includes(marker)) {
          const addition = `\n${marker}\n.flux/*.md\n.flux/config.json\n.flux/assets/\n.flux/read-state.json\n.flux/open-prompts.json\n.flux/open-prompts.json.tmp\n.flux/session-binding-secret\n.flux/session-binding-secret.tmp\n.flux/memory/\n.flux-store/\n`;
          await fs.writeFile(gitignorePath, existing + addition, 'utf-8');
        }

        await scaffoldModuleDirs(storeDir, MEMORY_GITIGNORE_DIRS);
        await excludeLocalConfigFromSync(storeDir);
        await ensureUnionMergeAttributes(storeDir);
        await ensureSyncProtocolMarker(storeDir);
        return;
      }
    } else {
      // Create orphan branch as a new worktree — does NOT touch the current checkout.
      // Version-agnostic: falls back to plumbing when `--orphan` predates the engine's git (FLUX-297).
      await addOrphanWorktree(workspaceRoot, 'flux-data', storeDir, git);
    }
  }

  // Move .flux/*.md files to .flux-store/ (idempotent — a prior partial run may have already
  // moved some/all of these; readdir on .flux/ only sees what's left).
  const fluxFiles = await fs.readdir(fluxDir).catch(() => [] as string[]);
  for (const name of fluxFiles) {
    if (!name.endsWith('.md')) continue;
    const src = path.join(fluxDir, name);
    const dst = path.join(storeDir, name);
    await fs.copyFile(src, dst);
    await fs.unlink(src);
  }

  // Move config.json
  const configSrc = path.join(fluxDir, 'config.json');
  if (existsSync(configSrc)) {
    await fs.copyFile(configSrc, path.join(storeDir, 'config.json'));
    await fs.unlink(configSrc);
  }

  // Move read-state.json
  const readStateSrc = path.join(fluxDir, 'read-state.json');
  if (existsSync(readStateSrc)) {
    await fs.copyFile(readStateSrc, path.join(storeDir, 'read-state.json'));
    await fs.unlink(readStateSrc);
  }

  // Move assets directory
  const assetsSrc = path.join(fluxDir, 'assets');
  if (existsSync(assetsSrc)) {
    await fs.cp(assetsSrc, path.join(storeDir, 'assets'), { recursive: true });
    await fs.rm(assetsSrc, { recursive: true, force: true });
  }

  // Seed the store .gitignore FIRST so the initial commit never includes the
  // local-only config.json / read-state.json just moved in above (FLUX-532).
  await ensureStoreLocalGitignore(storeDir);
  // Seed the union-merge attribute for transcripts (FLUX-1076) into the same initial commit.
  await ensureStoreGitattributes(storeDir);
  // Seed the sync-protocol marker (FLUX-1426) into the same initial commit.
  await ensureSyncProtocolMarkerFile(storeDir);

  // Initial commit in the worktree — status-gated so resuming after a partial failure (or an
  // already-committed worktree) never errors on "nothing to commit" (FLUX-297).
  await gitWithRetry(storeDir, ['add', '-A']);
  const { stdout: dirty } = await git(storeDir, ['status', '--porcelain']);
  if (dirty.trim()) {
    await git(storeDir, ['commit', '-m', MIGRATION_COMMIT_MESSAGE]);
  }
  await git(workspaceRoot, ['push', 'origin', 'flux-data']).catch(() => {
    // no remote configured — push is best-effort
  });

  // Add .flux/ data files to .gitignore
  const gitignorePath = path.join(workspaceRoot, '.gitignore');
  const existing = await fs.readFile(gitignorePath, 'utf-8').catch(() => '');
  const marker = '# flux-data orphan mode';
  if (!existing.includes(marker)) {
    const addition = `\n${marker}\n.flux/*.md\n.flux/config.json\n.flux/assets/\n.flux/read-state.json\n.flux/open-prompts.json\n.flux/open-prompts.json.tmp\n.flux/memory/\n.flux-store/\n`;
    await fs.writeFile(gitignorePath, existing + addition, 'utf-8');
  }

  await scaffoldModuleDirs(storeDir, MEMORY_GITIGNORE_DIRS);
}

export async function migrateStrandedFluxTickets(workspaceRoot: string): Promise<void> {
  const storeDir = path.join(workspaceRoot, '.flux-store');
  if (!existsSync(storeDir)) return;

  const fluxDir = path.join(workspaceRoot, '.flux');
  let entries: string[];
  try {
    entries = await fs.readdir(fluxDir);
  } catch {
    return;
  }

  for (const name of entries) {
    if (!name.endsWith('.md')) continue;
    const src = path.join(fluxDir, name);
    const dst = path.join(storeDir, name);
    try {
      if (existsSync(dst)) {
        await fs.unlink(src);
        log.info(`[startup-migrate] Removed stale duplicate: ${name}`);
      } else {
        await fs.copyFile(src, dst);
        await fs.unlink(src);
        log.info(`[startup-migrate] Migrated ticket: ${name}`);
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`[startup-migrate] Failed to migrate ${name}, skipping: ${message}`);
    }
  }

  const configSrc = path.join(fluxDir, 'config.json');
  const configDst = path.join(storeDir, 'config.json');
  if (existsSync(configSrc)) {
    try {
      if (!existsSync(configDst)) {
        await fs.copyFile(configSrc, configDst);
        log.info(`[startup-migrate] Migrated config.json`);
      } else {
        log.info(`[startup-migrate] Removed stale config.json from .flux/`);
      }
      await fs.unlink(configSrc);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`[startup-migrate] Failed to migrate config.json, skipping: ${message}`);
    }
  }

  // Migrate stray asset folders (e.g. .flux/assets/FLUX-59 → .flux-store/assets/FLUX-59)
  const assetsSrc = path.join(fluxDir, 'assets');
  const assetsDst = path.join(storeDir, 'assets');
  if (existsSync(assetsSrc)) {
    let assetEntries: string[];
    try {
      assetEntries = await fs.readdir(assetsSrc);
    } catch {
      assetEntries = [];
    }
    for (const name of assetEntries) {
      const src = path.join(assetsSrc, name);
      const dst = path.join(assetsDst, name);
      try {
        if (existsSync(dst)) {
          await fs.rm(src, { recursive: true, force: true });
          log.info(`[startup-migrate] Removed stale asset: ${name}`);
        } else {
          await fs.mkdir(assetsDst, { recursive: true });
          await fs.cp(src, dst, { recursive: true });
          await fs.rm(src, { recursive: true, force: true });
          log.info(`[startup-migrate] Migrated asset: ${name}`);
        }
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        console.warn(`[startup-migrate] Failed to migrate asset ${name}, skipping: ${message}`);
      }
    }
  }
}

export async function restoreToInRepo(workspaceRoot: string): Promise<void> {
  const storeDir = path.join(workspaceRoot, '.flux-store');
  const fluxDir = path.join(workspaceRoot, '.flux');

  if (!existsSync(storeDir)) {
    throw new Error('Not in orphan mode (.flux-store/ does not exist)');
  }

  await fs.mkdir(fluxDir, { recursive: true });

  // Copy all .md files back
  const storeFiles = await fs.readdir(storeDir).catch(() => [] as string[]);
  for (const name of storeFiles) {
    if (!name.endsWith('.md')) continue;
    await fs.copyFile(path.join(storeDir, name), path.join(fluxDir, name));
  }

  // Copy config.json back
  const configSrc = path.join(storeDir, 'config.json');
  if (existsSync(configSrc)) {
    await fs.copyFile(configSrc, path.join(fluxDir, 'config.json'));
  }

  // Copy read-state.json back
  const readStateSrc = path.join(storeDir, 'read-state.json');
  if (existsSync(readStateSrc)) {
    await fs.copyFile(readStateSrc, path.join(fluxDir, 'read-state.json'));
  }

  // Copy assets directory back
  const assetsSrc = path.join(storeDir, 'assets');
  if (existsSync(assetsSrc)) {
    await fs.cp(assetsSrc, path.join(fluxDir, 'assets'), { recursive: true });
  }

  // Flush any uncommitted changes before removing the worktree
  await gitWithRetry(storeDir, ['add', '-A']);
  const { stdout: dirty } = await git(storeDir, ['status', '--porcelain']);
  if (dirty.trim()) {
    await git(storeDir, ['commit', '-m', 'flux: pre-restore snapshot']);
  }

  // Remove worktree and local branch so migrate → restore → migrate works cleanly
  await git(workspaceRoot, ['worktree', 'remove', '--force', storeDir]);
  await git(workspaceRoot, ['branch', '-D', 'flux-data']).catch(() => {
    // branch may not exist locally if this was a fresh attach — safe to ignore
  });

  // Remove gitignore entries
  const gitignorePath = path.join(workspaceRoot, '.gitignore');
  try {
    const content = await fs.readFile(gitignorePath, 'utf-8');
    const normalized = content.replace(/\r\n/g, '\n');
    const section = `\n# flux-data orphan mode\n.flux/*.md\n.flux/config.json\n.flux/assets/\n.flux/read-state.json\n.flux/open-prompts.json\n.flux/open-prompts.json.tmp\n.flux/session-binding-secret\n.flux/session-binding-secret.tmp\n.flux/memory/\n.flux-store/\n`;
    const cleaned = normalized.split(section).join('');
    await fs.writeFile(gitignorePath, cleaned, 'utf-8');
  } catch {
    // .gitignore may not exist
  }
}

/** Result of {@link forceResetToRemote} — what the CLI/route print/return to the caller. */
export interface ForceResetResult {
  /** Local tag name (`flux-data-backup-<utc-timestamp>`) pointing at the discarded HEAD. */
  backupRef: string;
  oldHead: string;
  newHead: string;
  /** Files that differ between the discarded HEAD and the new (remote) HEAD, if any. */
  changedFiles: string[];
}

/**
 * FLUX-1232: the deliberate "my local board state is disposable — just match remote" escape
 * hatch for a wedged/diverged `.flux-store` (the dev-machine-swap incident this ticket hardens
 * against — see the ticket body: 549 remote commits ahead, 131 conflicted files, and the
 * conflict-resolution path baking `<<<<<<<` markers into ticket files). Shared by both the CLI
 * (`flux:reset-remote`) and the `POST /api/storage/reset-remote` route — neither should
 * reimplement this git sequence.
 *
 * Safety net first: tags the current local HEAD (`flux-data-backup-<ts>`) before discarding
 * anything, so a mistaken reset is always recoverable (`git checkout flux-data-backup-<ts>`).
 * Runs under the same `syncInFlight` mutex as `runSync()`/`resolveConflicts()` (FLUX-989) so it
 * can't race a background sync on the same worktree.
 */
export async function forceResetToRemote(storeDir: string): Promise<ForceResetResult> {
  if (!existsSync(storeDir)) {
    throw new Error('Not in orphan mode (.flux-store/ does not exist)');
  }

  return withSyncLock(async () => {
    const oldHead = await git(storeDir, ['rev-parse', 'HEAD']).then((r) => r.stdout.trim()).catch(() => '');
    const backupRef = `flux-data-backup-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    if (oldHead) {
      await git(storeDir, ['tag', backupRef, oldHead]);
    }

    await git(storeDir, ['fetch', 'origin', 'flux-data']);
    // There may be no merge in progress — mirror the swallowed `merge --abort` calls already
    // used elsewhere in the sync stack (sync-watcher.ts).
    await git(storeDir, ['merge', '--abort']).catch(() => {});
    await git(storeDir, ['reset', '--hard', 'origin/flux-data']);
    // Drops stray untracked leftovers (e.g. a half-written FLUX-*.md/.diff from the aborted
    // merge). `clean -fd` respects .gitignore unless -x/-X is passed, so gitignored local-only
    // files (config.json, read-state.json, session-binding-secret, ...) are left untouched.
    await git(storeDir, ['clean', '-fd']);

    // Re-run the same idempotent post-attach steps every other attach path runs, so the fresh
    // tree is consistent regardless of what the remote's state looked like. On an
    // already-migrated store this is a no-op; on an older/partial one it can add a
    // self-healing commit on top of the reset — so newHead is captured AFTER these run, to
    // reflect the tree's true final state rather than the mid-reset one.
    await scaffoldModuleDirs(storeDir, MEMORY_GITIGNORE_DIRS);
    await excludeLocalConfigFromSync(storeDir);
    await ensureUnionMergeAttributes(storeDir);
    await ensureSyncProtocolMarker(storeDir);

    const newHead = await git(storeDir, ['rev-parse', 'HEAD']).then((r) => r.stdout.trim()).catch(() => '');

    let changedFiles: string[] = [];
    if (oldHead && newHead && oldHead !== newHead) {
      changedFiles = await git(storeDir, ['diff', '--name-only', oldHead, newHead])
        .then((r) => r.stdout.split('\n').map((l) => l.trim()).filter(Boolean))
        .catch(() => []);
    }

    clearSyncStateAfterForceReset();
    return { backupRef, oldHead, newHead, changedFiles };
  });
}
