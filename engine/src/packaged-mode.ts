import os from 'os';
import path from 'path';
import fs from 'fs/promises';
import { existsSync } from 'fs';

export const isPkg: boolean = (process as any).pkg !== undefined;

// isSea: true only when running as a Node.js Single Executable Application.
// The try/catch is required — node:sea throws when not in SEA mode.
// @ts-ignore
export const isSea: boolean = (() => {
  try { return (require('node:sea') as { isSea(): boolean }).isSea(); } catch { return false; }
})();

export const isPackaged: boolean = isPkg || isSea;

// ─── SEA asset extraction ─────────────────────────────────────────────────────
// In SEA mode all assets (portal, skills, docs, tray binaries) are embedded as
// named blobs in the binary.  On first run they are extracted to a versioned
// directory under os.tmpdir() and served / read from there on all subsequent
// runs.  The .extracted marker file gates re-extraction so startup stays fast.

let _seaExtractDir: string | null = null;

/**
 * Returns the extracted-asset directory.
 *
 * mcp-server.js is a separate esbuild bundle and therefore carries its own
 * instance of this module — its `_seaExtractDir` is independent of the one in
 * index.js.  In SEA mode the path is deterministic (`tmpdir/event-horizon-<v>`)
 * and index.js always runs ensureSeaAssetsExtracted() (which writes the files to
 * disk) before loading mcp-server, so when this module's own singleton is unset
 * we can safely re-derive the path from the embedded manifest.
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
  if (_seaExtractDir) return _seaExtractDir;

  // @ts-ignore
  const { getRawAsset } = require('node:sea') as { getRawAsset(key: string): ArrayBuffer };

  const manifest: { version: string; keys: string[] } = JSON.parse(
    Buffer.from(getRawAsset('manifest')).toString('utf8')
  );

  const extractDir = path.join(os.tmpdir(), `event-horizon-${manifest.version}`);
  const marker = path.join(extractDir, '.extracted');

  if (!existsSync(marker)) {
    console.log(`Extracting embedded assets to ${extractDir} …`);
    await fs.mkdir(extractDir, { recursive: true });
    for (const key of manifest.keys) {
      const destPath = path.join(extractDir, ...key.split('/'));
      await fs.mkdir(path.dirname(destPath), { recursive: true });
      await fs.writeFile(destPath, Buffer.from(getRawAsset(key)));
    }
    await fs.writeFile(marker, '');
  }

  _seaExtractDir = extractDir;
  return extractDir;
}

/** Read a single SEA asset by key.  Only valid in SEA mode. */
export function getSeaAsset(key: string): Buffer {
  // @ts-ignore
  const { getRawAsset } = require('node:sea') as { getRawAsset(key: string): ArrayBuffer };
  return Buffer.from(getRawAsset(key));
}
