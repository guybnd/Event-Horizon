#!/usr/bin/env node
/**
 * Event Horizon — force-reset-to-remote escape hatch (FLUX-1232)
 *
 * Recovers a wedged/diverged `.flux-store` by discarding local board state and hard-resetting
 * to `origin/flux-data` (after tagging the discarded HEAD as a backup ref). This is the CLI half
 * of the same primitive the portal's "Reset board to remote" button calls — both go through
 * `forceResetToRemote()` in storage-sync.ts.
 *
 * If a live engine is already running on this workspace, POST to its `/api/storage/reset-remote`
 * endpoint instead of touching the worktree directly — the engine holds the worktree (chokidar
 * watcher, in-flight sync), so a second process doing raw git surgery on it underneath the
 * engine risks racing it. Falls back to a standalone reset only when no engine is reachable for
 * this workspace.
 *
 * Usage:
 *   npm run flux:reset-remote [--workspace <path>]
 */

import { log } from './log.js';
import { existsSync } from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { pathsEqual } from './workspace.js';
import { forceResetToRemote, type ForceResetResult } from './storage-sync.js';

const __dir = (() => {
  if (typeof __dirname === 'string' && path.isAbsolute(__dirname)) return __dirname;
  try { return path.dirname(fileURLToPath(import.meta.url)); } catch {}
  return path.join(process.cwd(), 'src');
})();

const HEALTH_CHECK_TIMEOUT_MS = 3_000;
const ENGINE_URL = process.env.EVENT_HORIZON_ENGINE_URL || 'http://localhost:3067';

function printResult(result: ForceResetResult): void {
  log.info(`\nBackup ref: ${result.backupRef}  (recover with: git -C .flux-store checkout ${result.backupRef})`);
  log.info(`HEAD: ${result.oldHead || '(none)'} -> ${result.newHead || '(none)'}`);
  log.info(`Files changed: ${result.changedFiles.length}`);
  if (result.changedFiles.length > 0 && result.changedFiles.length <= 20) {
    for (const f of result.changedFiles) log.info(`  ${f}`);
  }
}

/** True if a running engine answers /api/health and is bound to this exact workspace. */
async function reachableEngineForWorkspace(workspaceRoot: string): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HEALTH_CHECK_TIMEOUT_MS);
  try {
    const res = await fetch(`${ENGINE_URL}/api/health`, { signal: controller.signal });
    if (!res.ok) return false;
    const body = (await res.json()) as { workspace?: string | null };
    return typeof body.workspace === 'string' && pathsEqual(body.workspace, workspaceRoot);
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function resetViaEngine(): Promise<ForceResetResult> {
  const res = await fetch(`${ENGINE_URL}/api/storage/reset-remote`, { method: 'POST' });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(body.error || `Engine reset-remote request failed (${res.status})`);
  }
  return body as ForceResetResult;
}

async function run() {
  const args = process.argv.slice(2);
  const workspaceIdx = args.indexOf('--workspace');
  const workspaceRoot = path.resolve(
    workspaceIdx !== -1 ? (args[workspaceIdx + 1] ?? process.cwd()) : path.join(__dir, '../..'),
  );

  const storeDir = path.join(workspaceRoot, '.flux-store');
  if (!existsSync(storeDir)) {
    console.error(`Not in orphan mode: ${storeDir} does not exist. This command only applies to a flux-data orphan-branch workspace.`);
    process.exit(1);
  }

  log.info(`Event Horizon — force-reset-to-remote`);
  log.info(`Workspace: ${workspaceRoot}`);

  try {
    if (await reachableEngineForWorkspace(workspaceRoot)) {
      log.info('A running engine owns this workspace — routing the reset through it (POST /api/storage/reset-remote)...');
      const result = await resetViaEngine();
      printResult(result);
    } else {
      log.info('No running engine bound to this workspace — resetting the worktree directly...');
      const result = await forceResetToRemote(storeDir);
      printResult(result);
    }
    log.info('\nDone. The local board now matches origin/flux-data.');
  } catch (err) {
    console.error('Reset failed:', err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}

function isMainModule(): boolean {
  try {
    return import.meta.url === pathToFileURL(process.argv[1] ?? '').href;
  } catch {
    return false;
  }
}

if (isMainModule()) {
  run().catch((err) => {
    console.error('Reset failed:', err);
    process.exit(1);
  });
}
