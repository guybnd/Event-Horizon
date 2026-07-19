import fs from 'fs/promises';
import path from 'path';
import { log } from './log.js';
import { atomicWriteFile } from './task-serialize.js';
import { runWithConcurrency } from './concurrency.js';

// FLUX-1547 Phase 2: a persisted, per-workspace cache of the fully-parsed ticket store so a warm
// boot can skip the read+YAML-parse+validate+history-normalize pipeline entirely for every file
// that hasn't changed since the last full rescan. This is a CACHE, never a source of truth — the
// on-disk `.md` files stay authoritative. A missing, corrupt, or version-mismatched index simply
// makes `loadBootIndex` return null, and the caller (task-store.ts's `initDir`) falls back to
// treating every file as needing a full load — identical to the pre-FLUX-1547 behavior.

export const BOOT_INDEX_VERSION = 1;
export const BOOT_INDEX_FILE = 'boot-index.json';

/** One cached ticket record plus the filesystem stat fingerprint it was captured against. */
export interface BootIndexEntry {
  /** Filename (relative to the active flux dir) this entry was loaded from, e.g. "FLUX-42.md". */
  path: string;
  mtimeMs: number;
  size: number;
  /** The full post-load `ws.tasks[id]` record (frontmatter + body + `_path`). */
  data: Record<string, unknown>;
}

export interface BootIndexFile {
  version: number;
  entries: Record<string, BootIndexEntry>;
}

export function bootIndexPath(activeDir: string): string {
  return path.join(activeDir, BOOT_INDEX_FILE);
}

/** Loads and validates the persisted index. Returns null on any missing/corrupt/stale-version file. */
export async function loadBootIndex(activeDir: string): Promise<BootIndexFile | null> {
  let raw: string;
  try {
    raw = await fs.readFile(bootIndexPath(activeDir), 'utf-8');
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<BootIndexFile> | null;
    if (!parsed || typeof parsed !== 'object') return null;
    if (parsed.version !== BOOT_INDEX_VERSION) return null;
    if (!parsed.entries || typeof parsed.entries !== 'object') return null;
    return { version: parsed.version, entries: parsed.entries };
  } catch (err) {
    log.warn(`[boot-index] discarding unparseable boot index at ${bootIndexPath(activeDir)}: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

/** Best-effort persist — a failure here never blocks or fails the boot scan. */
export async function saveBootIndex(activeDir: string, entries: Record<string, BootIndexEntry>): Promise<void> {
  const file: BootIndexFile = { version: BOOT_INDEX_VERSION, entries };
  try {
    await atomicWriteFile(bootIndexPath(activeDir), JSON.stringify(file));
  } catch (err) {
    log.warn(`[boot-index] failed to persist boot index (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Splits `names` (top-level ticket filenames already known to exist in `activeDir`) into
 * cache-hits (populated directly into `onHit`, synchronously with no file read) and misses
 * (returned for the caller to run through the normal full-load path). A hit requires both an
 * indexed entry for that filename AND a stat match (mtimeMs + size) against the entry's recorded
 * fingerprint — any drift (edit, touch, restore from backup) is treated as a miss so the fresh
 * disk content always wins over the cache.
 */
export async function partitionByBootIndex(
  activeDir: string,
  names: readonly string[],
  index: BootIndexFile,
  onHit: (id: string, data: Record<string, unknown>, name: string) => void,
  concurrency: number,
): Promise<string[]> {
  const byName = new Map<string, BootIndexEntry>();
  for (const [id, entry] of Object.entries(index.entries)) {
    byName.set(entry.path, { ...entry, data: { ...entry.data, id } });
  }
  const misses: string[] = [];
  await runWithConcurrency(names, concurrency, async (name) => {
    const cached = byName.get(name);
    if (!cached) {
      misses.push(name);
      return;
    }
    try {
      const stat = await fs.stat(path.join(activeDir, name));
      if (stat.mtimeMs === cached.mtimeMs && stat.size === cached.size) {
        onHit(String(cached.data.id ?? path.basename(name, '.md')), cached.data, name);
      } else {
        misses.push(name);
      }
    } catch {
      misses.push(name);
    }
  });
  return misses;
}

/**
 * Rebuilds the on-disk index from the current in-memory cache: one fresh `stat` per file (never
 * trusts a stat captured before this rescan's own repair write-backs) paired with whatever is
 * currently in `tasks[id]`. A ticket missing from `tasks` (parse error, or removed mid-scan) is
 * simply omitted — it will be treated as new/uncached on the next boot rather than poisoning the
 * cache with stale or invalid data.
 */
export async function persistBootIndex(
  activeDir: string,
  names: readonly string[],
  tasks: Record<string, unknown>,
  concurrency: number,
): Promise<void> {
  const entries: Record<string, BootIndexEntry> = {};
  await runWithConcurrency(names, concurrency, async (name) => {
    const id = path.basename(name, '.md');
    const task = tasks[id] as Record<string, unknown> | undefined;
    if (!task || task.id !== id) return;
    try {
      const stat = await fs.stat(path.join(activeDir, name));
      entries[id] = { path: name, mtimeMs: stat.mtimeMs, size: stat.size, data: task };
    } catch {
      // File vanished between load and snapshot — next boot correctly treats it as missing.
    }
  });
  await saveBootIndex(activeDir, entries);
}
