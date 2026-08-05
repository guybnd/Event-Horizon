import crypto from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import { runGit, runGitBinary } from './git-exec.js';

/** A single retained version. Sources intentionally remain separate for one path. */
export interface SidecarRecoveryReference {
  path: string;
  source: 'HEAD' | 'index' | 'worktree' | 'untracked';
  sha256: string;
  bytes: number;
}

export interface SidecarRecoveryManifest {
  version: 1;
  createdAt: string;
  storeDir: string;
  remoteRef: string;
  references: SidecarRecoveryReference[];
}

export interface SidecarRecoveryCapture {
  recoveryDir: string;
  manifestPath: string;
  referenceCount: number;
  manifest: SidecarRecoveryManifest;
}

function isCanonicalSidecar(relativePath: string): boolean {
  const normalized = relativePath.replace(/\\/g, '/');
  if (normalized === '_curation-ops.jsonl') return true;
  if (normalized.startsWith('artifacts/') || normalized.startsWith('assets/')) return true;
  if (/^transcripts\/[^/]+\.jsonl$/.test(normalized)) return true;
  // Ticket diff sidecars only live at the store root.  Do not make a claim for memory/**:
  // Basic Memory is an external process and cannot participate in this in-process boundary.
  return /^[^/]+\.diff$/.test(normalized);
}

function safeRelativePath(value: string): string | null {
  const normalized = value.replace(/\\/g, '/');
  if (!normalized || normalized.startsWith('/') || normalized.split('/').some((part) => !part || part === '.' || part === '..')) return null;
  return normalized;
}

async function gitBytes(storeDir: string, spec: string): Promise<Buffer | null> {
  try {
    // Binary-safe: runGit()/runHardened() force utf8-decode stdout, which corrupts non-UTF-8 blobs
    // (e.g. assets/** PNG/JPG) — every invalid byte sequence becomes U+FFFD on the way in and stays
    // corrupted on the way back out via Buffer.from(str, 'utf8'). runGitBinary() collects raw Buffer
    // chunks with no encoding step, so the recovered bytes are byte-identical to the blob (FLUX-1643 review).
    return await runGitBinary(['show', spec], { cwd: storeDir });
  } catch {
    return null;
  }
}

async function gitLines(storeDir: string, args: string[]): Promise<string[]> {
  try {
    const { stdout } = await runGit(args, { cwd: storeDir });
    return stdout.split('\n').map((line) => line.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

async function fsyncFile(filePath: string): Promise<void> {
  const handle = await fs.open(filePath, 'r');
  try {
    await handle.sync();
  } catch (error: unknown) {
    // Some Windows-backed temporary filesystems reject FlushFileBuffers for a read handle even
    // though the close has committed the write. Preserve the fail-closed behavior elsewhere.
    const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
    if (process.platform !== 'win32' || !['EPERM', 'EINVAL', 'ENOSYS'].includes(String(code))) throw error;
  } finally { await handle.close(); }
}

async function writeBlob(recoveryDir: string, bytes: Buffer): Promise<{ sha256: string; bytes: number }> {
  const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
  const blobPath = path.join(recoveryDir, 'blobs', sha256);
  await fs.mkdir(path.dirname(blobPath), { recursive: true });
  try {
    const handle = await fs.open(blobPath, 'wx');
    try {
      await handle.writeFile(bytes);
      try { await handle.sync(); } catch (error: unknown) {
        const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
        if (process.platform !== 'win32' || !['EPERM', 'EINVAL', 'ENOSYS'].includes(String(code))) throw error;
      }
    } finally { await handle.close(); }
  } catch (error: unknown) {
    if (!(error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST')) throw error;
  }
  return { sha256, bytes: bytes.length };
}

/**
 * Retain every distinct canonical sidecar version outside the Git worktree. The manifest records
 * source identity separately even when content-addressed blobs are identical, preventing a staged
 * version from being collapsed into its worktree or HEAD counterpart.
 */
export async function captureCanonicalSidecars(
  storeDir: string,
  remoteRef = 'origin/flux-data',
): Promise<SidecarRecoveryCapture> {
  const tracked = await gitLines(storeDir, ['ls-files']);
  const untracked = await gitLines(storeDir, ['ls-files', '--others', '--exclude-standard']);
  const paths = [...new Set([...tracked, ...untracked])]
    .map(safeRelativePath)
    .filter((value): value is string => value != null && isCanonicalSidecar(value));

  const isUntracked = new Set(untracked);
  // Collect endangered bytes in memory first — a recovery dir is only created below once we know
  // there is at least one reference to write, so a clean sync (or one where every canonical byte
  // already matches remote) doesn't litter a `.flux-recovery-*` sibling next to `.flux-store`.
  const pending: Array<{ path: string; source: SidecarRecoveryReference['source']; bytes: Buffer }> = [];

  for (const relativePath of paths) {
    const remote = await gitBytes(storeDir, `${remoteRef}:${relativePath}`);
    const candidates: Array<{ source: SidecarRecoveryReference['source']; bytes: Buffer | null }> = isUntracked.has(relativePath)
      ? [{ source: 'untracked', bytes: await fs.readFile(path.join(storeDir, relativePath)).catch(() => null) }]
      : [
        { source: 'HEAD', bytes: await gitBytes(storeDir, `HEAD:${relativePath}`) },
        { source: 'index', bytes: await gitBytes(storeDir, `:${relativePath}`) },
        { source: 'worktree', bytes: await fs.readFile(path.join(storeDir, relativePath)).catch(() => null) },
      ];

    for (const candidate of candidates) {
      if (candidate.bytes == null) continue;
      // A version already present at the target ref is not endangered by this reset.
      if (remote != null && candidate.bytes.equals(remote)) continue;
      pending.push({ path: relativePath, source: candidate.source, bytes: candidate.bytes });
    }
  }

  if (pending.length === 0) {
    return {
      recoveryDir: '',
      manifestPath: '',
      referenceCount: 0,
      manifest: { version: 1, createdAt: new Date().toISOString(), storeDir, remoteRef, references: [] },
    };
  }

  // A sibling directory survives reset --hard/clean -fd while remaining on the same volume.
  const recoveryDir = await fs.mkdtemp(path.join(path.dirname(storeDir), '.flux-recovery-'));
  const references: SidecarRecoveryReference[] = [];
  for (const item of pending) {
    const blob = await writeBlob(recoveryDir, item.bytes);
    references.push({ path: item.path, source: item.source, ...blob });
  }

  const manifest: SidecarRecoveryManifest = {
    version: 1,
    createdAt: new Date().toISOString(),
    storeDir,
    remoteRef,
    references,
  };
  const manifestPath = path.join(recoveryDir, 'manifest.json');
  await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  await fsyncFile(manifestPath);
  return { recoveryDir, manifestPath, referenceCount: references.length, manifest };
}
