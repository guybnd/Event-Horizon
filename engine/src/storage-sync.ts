import { log } from './log.js';
import fs from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import { execFile, type ExecFileException } from 'child_process';
import { promisify } from 'util';
import { BUILTIN_MODULES } from './modules.js';
import { buildGitSyncEnv, GIT_SYNC_TIMEOUT_MS } from './git-sync-env.js';

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
const STORE_LOCAL_IGNORES = ['config.json', 'read-state.json', 'open-prompts.json', 'open-prompts.json.tmp', 'session-binding-secret', 'session-binding-secret.tmp', 'sessions/'];

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
        log.info(`[storage-sync] Could not pull in background: ${err instanceof Error ? err.message : String(err)}`);
      }
    })();
    // Scaffold dirs for all modules that declare one — idempotent, safe every startup.
    await scaffoldModuleDirs(storeDir, MEMORY_GITIGNORE_DIRS);
    // Keep local config/read-state out of flux-data (and migrate older tracked copies).
    await excludeLocalConfigFromSync(storeDir);
    // Self-heal a store created before FLUX-1076 onto the union-merge transcript attribute.
    await ensureUnionMergeAttributes(storeDir);
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
    log.info('[storage-sync] Re-attached .flux-store worktree from origin/flux-data');
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    log.info(`[storage-sync] attachWorktreeIfPresent skipped: ${message}`);
  }
}

export async function migrateToOrphan(workspaceRoot: string): Promise<void> {
  const storeDir = path.join(workspaceRoot, '.flux-store');
  const fluxDir = path.join(workspaceRoot, '.flux');

  if (existsSync(storeDir)) {
    throw new Error('Already in orphan mode (.flux-store/ already exists)');
  }

  const { stdout: branchList } = await git(workspaceRoot, ['branch', '--list', 'flux-data']);
  const hasLocal = !!branchList.trim();

  // Check if remote already has flux-data (e.g. set up on another machine)
  const { stdout: remoteBranches } = await git(workspaceRoot, ['branch', '-r']).catch(() => ({ stdout: '' }));
  const hasRemote = remoteBranches.split('\n').some((l) => l.trim() === 'origin/flux-data');

  if (hasLocal || hasRemote) {
    await git(workspaceRoot, ['worktree', 'add', storeDir, 'flux-data']);

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
    return;
  }

  // Create orphan branch as a new worktree — does NOT touch the current checkout
  await git(workspaceRoot, ['worktree', 'add', '--orphan', '-b', 'flux-data', storeDir]);

  // Move .flux/*.md files to .flux-store/
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

  // Initial commit in the worktree
  await gitWithRetry(storeDir, ['add', '-A']);
  await git(storeDir, ['commit', '-m', 'flux: migrate tickets to orphan branch']);
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
