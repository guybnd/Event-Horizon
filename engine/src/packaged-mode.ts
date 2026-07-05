import { log } from './log.js';
import os from 'os';
import path from 'path';
import fs from 'fs/promises';
import { existsSync, statSync } from 'fs';
import { createRequire } from 'module';

// The `pkg` packaging tool injects a `pkg` property onto `process` when the app is
// bundled with it; this is not part of Node's own NodeJS.Process typings.
interface ProcessWithPkg extends NodeJS.Process {
  pkg?: unknown;
}
export const isPkg: boolean = (process as ProcessWithPkg).pkg !== undefined;

// isSea: true only when running as a Node.js Single Executable Application.
// The try/catch is required — node:sea throws when not in SEA mode.
export const isSea: boolean = (() => {
  try {
    const require = createRequire(import.meta.url);
    return (require('node:sea') as { isSea(): boolean }).isSea();
  } catch { return false; }
})();

export const isPackaged: boolean = isPkg || isSea;

// ─── Engine port (FLUX-645) ───────────────────────────────────────────────────
// The installer renders the loopback URL for the in-process MCP HTTP mount
// (http://127.0.0.1:<port>/mcp) into .mcp.json, so it needs the engine's resolved
// listen port. index.ts calls setEnginePort() once it knows the port; the installer
// reads it via getEnginePort(). Defaults to the env/standard port so it's sane even
// before the engine has bound (e.g. an installer call during early bootstrap).
let _enginePort = parseInt(process.env.PORT || '3067', 10);
export function setEnginePort(port: number): void { _enginePort = port; }
export function getEnginePort(): number { return _enginePort; }

// ─── SEA asset extraction ─────────────────────────────────────────────────────
// In SEA mode all assets (portal, skills, docs, tray binaries) are embedded as
// named blobs in the binary.  On first run they are extracted to a versioned
// directory under os.tmpdir() and served / read from there on all subsequent
// runs.  The .extracted marker file gates re-extraction so startup stays fast.

let _seaExtractDir: string | null = null;
// Extraction-verified flag (FLUX-1096). _seaExtractDir only means "the path is known" —
// getSeaExtractDir() below sets it WITHOUT extracting. ensureSeaAssetsExtracted() must key its
// early-return on THIS flag, never on _seaExtractDir: module-scope callers (e.g. the
// dev-onboarding routes' resolveSkillSourceRoot()) run at import time, before startServer(),
// and would otherwise poison the singleton and silently skip extraction — shipping an exe
// whose portal, docs, and skills 404 on a fresh machine.
let _seaAssetsExtracted = false;

/**
 * Returns the extracted-asset directory.
 *
 * Defensive: in SEA mode the path is deterministic (`tmpdir/event-horizon-<v>`), so if this is
 * ever called before ensureSeaAssetsExtracted() has populated the singleton, re-derive the path
 * from the embedded manifest rather than throwing. (Pre-FLUX-705 this also guarded a second
 * module instance from the standalone mcp-server.js bundle; that bundle is now inlined into
 * index.js, so there is only one instance — the re-derivation is kept purely as a safety net.)
 *
 * NOTE: this does NOT extract — it only derives the path. Callers needing the assets on disk
 * must go through ensureSeaAssetsExtracted() (see _seaAssetsExtracted above, FLUX-1096).
 */
export function getSeaExtractDir(): string {
  if (_seaExtractDir) return _seaExtractDir;
  if (isSea) {
    const manifest: { version: string } = JSON.parse(Buffer.from(getSeaAsset('manifest')).toString('utf8'));
    _seaExtractDir = path.join(os.tmpdir(), `event-horizon-${manifest.version}`);
    return _seaExtractDir;
  }
  throw new Error('SEA assets not yet extracted — call ensureSeaAssetsExtracted() first');
}

/** Extracts all SEA-embedded assets to a versioned tmpdir.  Idempotent. */
export async function ensureSeaAssetsExtracted(): Promise<string> {
  // Key on the extraction flag, NOT on _seaExtractDir — a prior getSeaExtractDir() call sets
  // the dir without extracting, and keying on it skipped extraction entirely (FLUX-1096).
  if (_seaAssetsExtracted && _seaExtractDir) return _seaExtractDir;

  const require = createRequire(import.meta.url);
  const { getRawAsset } = require('node:sea') as { getRawAsset(key: string): ArrayBuffer };

  const manifest: { version: string; keys: string[] } = JSON.parse(
    Buffer.from(getRawAsset('manifest')).toString('utf8')
  );

  const extractDir = path.join(os.tmpdir(), `event-horizon-${manifest.version}`);
  const marker = path.join(extractDir, '.extracted');

  // Re-extract when the marker is missing OR the running executable is newer
  // than the marker. The dir is keyed only on version, so a same-version rebuild
  // (common in dev) would otherwise serve stale embedded assets from a previous
  // build until the tmp dir was manually cleared. Comparing exe vs marker mtime
  // detects "the binary changed but the cache didn't". (FLUX-496)
  let needsExtract = !existsSync(marker);
  if (!needsExtract) {
    try {
      if (statSync(process.execPath).mtimeMs > statSync(marker).mtimeMs) needsExtract = true;
    } catch (err) {
      // Can't compare mtimes — favour freshness over speed. Serving stale assets
      // is the exact failure this guard exists to prevent, so re-extract rather
      // than trust a cache we can't validate. (FLUX-496)
      console.warn(`Could not stat exe/marker to check asset freshness — re-extracting: ${(err as Error).message}`);
      needsExtract = true;
    }
  }

  if (needsExtract) {
    log.info(`Extracting embedded assets to ${extractDir} …`);
    await fs.rm(extractDir, { recursive: true, force: true }); // drop any stale prior extract
    await fs.mkdir(extractDir, { recursive: true });
    for (const key of manifest.keys) {
      const destPath = path.join(extractDir, ...key.split('/'));
      await fs.mkdir(path.dirname(destPath), { recursive: true });
      await fs.writeFile(destPath, Buffer.from(getRawAsset(key)));
    }
    await fs.writeFile(marker, ''); // mtime = now (> exe mtime) so subsequent runs skip
  }

  _seaExtractDir = extractDir;
  _seaAssetsExtracted = true;
  return extractDir;
}

/** Read a single SEA asset by key.  Only valid in SEA mode. */
export function getSeaAsset(key: string): Buffer {
  const require = createRequire(import.meta.url);
  const { getRawAsset } = require('node:sea') as { getRawAsset(key: string): ArrayBuffer };
  return Buffer.from(getRawAsset(key));
}
