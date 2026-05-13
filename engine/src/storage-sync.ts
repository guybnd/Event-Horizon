import fs from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

function git(cwd: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync('git', args, { cwd });
}

async function gitWithRetry(cwd: string, args: string[], maxRetries = 3): Promise<{ stdout: string; stderr: string }> {
  let attempts = 0;
  while (attempts < maxRetries) {
    try {
      return await git(cwd, args);
    } catch (err: any) {
      const msg = err.message || String(err);
      if (msg.includes('index.lock') && attempts < maxRetries - 1) {
        console.log(`[storage-sync] Git lock detected, retrying in 1s (attempt ${attempts + 1}/${maxRetries})...`);
        await new Promise(r => setTimeout(r, 1000));
        attempts++;
      } else {
        throw err;
      }
    }
  }
  throw new Error('Unreachable');
}

export async function attachWorktreeIfPresent(workspaceRoot: string): Promise<void> {
  const storeDir = path.join(workspaceRoot, '.flux-store');
  const isNewAttach = !existsSync(storeDir);

  if (!isNewAttach) {
    // Worktree already attached - pull latest changes on startup
    try {
      await git(storeDir, ['pull', '--ff-only', 'origin', 'flux-data']);
      console.log('[storage-sync] Pulled latest flux-data on startup');
    } catch (err: any) {
      console.log(`[storage-sync] Could not pull on startup: ${err.message}`);
    }
    return;
  }

  try {
    const { stdout } = await git(workspaceRoot, ['branch', '-r']);
    const hasRemote = stdout.split('\n').some((l) => l.trim() === 'origin/flux-data');
    if (!hasRemote) return;

    await git(workspaceRoot, ['worktree', 'add', '-b', 'flux-data', storeDir, 'origin/flux-data']);
    console.log('[storage-sync] Re-attached .flux-store worktree from origin/flux-data');
  } catch (err: any) {
    console.log(`[storage-sync] attachWorktreeIfPresent skipped: ${err.message}`);
  }
}

export async function migrateToOrphan(workspaceRoot: string): Promise<void> {
  const storeDir = path.join(workspaceRoot, '.flux-store');
  const fluxDir = path.join(workspaceRoot, '.flux');

  if (existsSync(storeDir)) {
    throw new Error('Already in orphan mode (.flux-store/ already exists)');
  }

  const { stdout: branchList } = await git(workspaceRoot, ['branch', '--list', 'flux-data']);
  if (branchList.trim()) {
    throw new Error('flux-data branch already exists — remove it with "git branch -D flux-data" before migrating');
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
    const addition = `\n${marker}\n.flux/*.md\n.flux/config.json\n.flux/assets/\n.flux/read-state.json\n.flux-store/\n`;
    await fs.writeFile(gitignorePath, existing + addition, 'utf-8');
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
    const section = `\n# flux-data orphan mode\n.flux/*.md\n.flux/config.json\n.flux/assets/\n.flux/read-state.json\n.flux-store/\n`;
    const cleaned = normalized.split(section).join('');
    await fs.writeFile(gitignorePath, cleaned, 'utf-8');
  } catch {
    // .gitignore may not exist
  }
}
