#!/usr/bin/env node
/**
 * Packages the built engine into versioned release artifacts under releases/.
 *
 * Usage:
 *   node scripts/package-release.js [--platform mac|win|all] [--version v1.2.3]
 *
 * Version is resolved from (in priority order):
 *   1. --version flag
 *   2. VERSION environment variable
 *   3. Nearest package.json version field (prepended with "v")
 *
 * Outputs (at repo root):
 *   releases/event-horizon-macos-<version>.zip
 *   releases/event-horizon-win-<version>.exe
 */

import { execFileSync, spawnSync } from 'child_process';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const engineRoot = path.resolve(__dirname, '..');
const repoRoot = path.resolve(engineRoot, '..');
const releasesDir = path.join(repoRoot, 'releases');
const distDir = path.join(engineRoot, 'dist');

// ── Parse args ────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const platformFlag = (() => {
  const i = args.indexOf('--platform');
  return i !== -1 ? args[i + 1] : 'all';
})();
const versionFlag = (() => {
  const i = args.indexOf('--version');
  return i !== -1 ? args[i + 1] : null;
})();

const version = versionFlag
  || process.env.VERSION
  || (() => {
    const pkg = JSON.parse(fs.readFileSync(path.join(engineRoot, 'package.json'), 'utf-8'));
    return `v${pkg.version}`;
  })();

console.log(`Packaging Event Horizon ${version} …`);
fs.mkdirSync(releasesDir, { recursive: true });

// ── Helpers ───────────────────────────────────────────────────────────────────

function pkg(target, outBase) {
  const result = spawnSync(
    'npx', ['@yao-pkg/pkg', '.', '--targets', target, '--output', outBase],
    { cwd: engineRoot, stdio: 'inherit', shell: true }
  );
  if (result.status !== 0) {
    console.error(`pkg failed for target ${target}`);
    process.exit(result.status ?? 1);
  }
}

// Cross-platform zip helpers (FLUX-707/FLUX-708). Windows has no `unzip`/`zip`; we drive the
// System32 bsdtar by ABSOLUTE PATH. A bare `tar` on a Git-for-Windows box resolves to GNU tar
// (`C:\Program Files\Git\usr\bin\tar.exe`), which cannot read/write zips and fails on the
// absolute C:\ paths this script uses ("Cannot connect to C: resolve failed"), so package:win
// would break from a Git-Bash shell. macOS/Linux keep the proven `unzip`/`zip` CLIs unchanged.
const WIN_BSDTAR = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');

function extractZipMember(zipPath, member, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  const result = process.platform === 'win32'
    ? spawnSync(WIN_BSDTAR, ['-xf', zipPath, '-C', destDir, member], { stdio: 'inherit' })
    : spawnSync('unzip', ['-o', zipPath, member, '-d', destDir], { stdio: 'inherit' });
  if (result.error || result.status !== 0) {
    console.error(`Failed to extract ${member} from ${path.basename(zipPath)}${result.error ? `: ${result.error.message}` : ''}`);
    process.exit(result.status ?? 1);
  }
}

// Zip a single file flattened to the archive root (matches `zip -j`).
function createFlatZip(zipPath, filePath) {
  fs.rmSync(zipPath, { force: true }); // start clean — don't append to a stale archive
  if (process.platform === 'win32') {
    // -C <dir> + basename stores the entry without its directory prefix (the flatten).
    const result = spawnSync(
      WIN_BSDTAR, ['-a', '-cf', zipPath, '-C', path.dirname(filePath), path.basename(filePath)],
      { stdio: 'inherit' }
    );
    if (result.error || result.status !== 0) {
      console.error(`Failed to zip ${path.basename(filePath)}${result.error ? `: ${result.error.message}` : ''}`);
      process.exit(result.status ?? 1);
    }
  } else {
    execFileSync('zip', ['-j', zipPath, filePath], { stdio: 'inherit' });
  }
}

// ── Mac ───────────────────────────────────────────────────────────────────────

// buildMac cross-compiles a macOS binary via @yao-pkg/pkg, so it must run on macOS/Linux.
// buildWin runs cross-platform — its zip/extract go through the platform-aware helpers (FLUX-707).
function buildMac() {
  const tmpBin = path.join(distDir, 'event-horizon-macos');
  pkg('node22-macos-arm64', tmpBin);

  const zipName = `event-horizon-macos-${version}.zip`;
  const zipPath = path.join(releasesDir, zipName);
  createFlatZip(zipPath, tmpBin);
  fs.rmSync(tmpBin, { force: true });

  console.log(`Mac artifact → releases/${zipName}`);
  return zipPath;
}

// ── Windows (Node.js SEA) ─────────────────────────────────────────────────────
// Builds the Windows executable using Node.js Single Executable Applications
// instead of @yao-pkg/pkg.  SEA produces a standard Node.js binary rather
// than a custom runtime, which avoids the Wacatac.C!ml false-positive that
// pkg-bundled executables trigger in Windows Defender.
//
// Steps:
//  1. Generate the SEA blob (sea-prep.blob) from sea-config.json
//  2. Download the official Windows node.exe for the current Node version
//  3. Copy node.exe → event-horizon.exe
//  4. Inject the blob with postject
//  5. Patch the PE subsystem to suppress the console window (same as pkg path)
//  6. Zip and place in releases/

function buildWin() {
  const nodeVersion = process.version.slice(1); // e.g. '22.14.0'
  const tmpExe = path.join(distDir, 'event-horizon.exe');
  const blobPath = path.join(distDir, 'sea-prep.blob');
  const nodeZipPath = path.join(distDir, 'node-win.zip');
  const nodeExtractDir = path.join(distDir, 'node-win-extracted');

  // 1. Generate SEA blob — run from engineRoot so sea-config.json paths resolve
  console.log('Generating SEA blob …');
  const blobResult = spawnSync(
    'node', ['--experimental-sea-config', 'sea-config.json'],
    { cwd: engineRoot, stdio: 'inherit' }
  );
  if (blobResult.status !== 0) {
    console.error('SEA blob generation failed');
    process.exit(blobResult.status ?? 1);
  }

  // 2. Download Windows node.exe
  const nodeZipUrl = `https://nodejs.org/dist/v${nodeVersion}/node-v${nodeVersion}-win-x64.zip`;
  console.log(`Downloading ${nodeZipUrl} …`);
  const dlResult = spawnSync(
    'curl', ['-sL', '-o', nodeZipPath, nodeZipUrl],
    { stdio: 'inherit' }
  );
  if (dlResult.status !== 0) {
    console.error('Failed to download node.exe');
    process.exit(dlResult.status ?? 1);
  }

  // 3. Extract node.exe from the zip
  extractZipMember(nodeZipPath, `node-v${nodeVersion}-win-x64/node.exe`, nodeExtractDir);
  const nodeExePath = path.join(nodeExtractDir, `node-v${nodeVersion}-win-x64`, 'node.exe');

  // 4. Copy node.exe → event-horizon.exe
  fs.copyFileSync(nodeExePath, tmpExe);
  fs.rmSync(nodeZipPath, { force: true });
  fs.rmSync(nodeExtractDir, { recursive: true, force: true });

  // 5. Inject SEA blob with postject
  console.log('Injecting SEA blob …');
  const injectResult = spawnSync(
    'npx', [
      'postject', tmpExe,
      'NODE_SEA_BLOB', blobPath,
      '--sentinel-fuse', 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2',
      '--overwrite',
    ],
    { cwd: engineRoot, stdio: 'inherit', shell: true }
  );
  if (injectResult.status !== 0) {
    console.error('postject injection failed');
    process.exit(injectResult.status ?? 1);
  }

  // 6. Patch PE subsystem (CUI → GUI) to suppress the console window
  const patchResult = spawnSync('node', [path.join(__dirname, 'patch-pe.js'), tmpExe], { stdio: 'inherit' });
  if (patchResult.status !== 0) process.exit(patchResult.status ?? 1);

  // 7. Zip
  const zipName = `event-horizon-win-${version}.zip`;
  const zipPath = path.join(releasesDir, zipName);
  createFlatZip(zipPath, tmpExe);
  fs.rmSync(tmpExe, { force: true });
  fs.rmSync(blobPath, { force: true });

  console.log(`Win artifact → releases/${zipName}`);
  return zipPath;
}

// ── Main ──────────────────────────────────────────────────────────────────────

const platform = platformFlag === 'mac' ? 'mac'
  : platformFlag === 'win' ? 'win'
  : 'all';

if (platform === 'mac' || platform === 'all') buildMac();
if (platform === 'win' || platform === 'all') buildWin();

console.log(`Done. Artifacts in releases/`);
