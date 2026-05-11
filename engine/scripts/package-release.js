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

const { execFileSync, spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');

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

// ── Mac ───────────────────────────────────────────────────────────────────────

function buildMac() {
  const tmpBin = path.join(distDir, 'event-horizon-macos');
  pkg('node18-macos-x64', tmpBin);

  const zipName = `event-horizon-macos-${version}.zip`;
  const zipPath = path.join(releasesDir, zipName);
  execFileSync('zip', ['-j', zipPath, tmpBin], { stdio: 'inherit' });
  fs.rmSync(tmpBin, { force: true });

  console.log(`Mac artifact → releases/${zipName}`);
  return zipPath;
}

// ── Windows ───────────────────────────────────────────────────────────────────

function buildWin() {
  const tmpBase = path.join(distDir, 'event-horizon');
  pkg('node18-win-x64', tmpBase);

  // patch-pe changes the exe subsystem to suppress the console window
  const patchResult = spawnSync('node', [path.join(__dirname, 'patch-pe.js'), `${tmpBase}.exe`], { stdio: 'inherit' });
  if (patchResult.status !== 0) process.exit(patchResult.status ?? 1);

  const exeName = `event-horizon-win-${version}.exe`;
  const exeDest = path.join(releasesDir, exeName);
  fs.renameSync(`${tmpBase}.exe`, exeDest);

  console.log(`Win artifact → releases/${exeName}`);
  return exeDest;
}

// ── Main ──────────────────────────────────────────────────────────────────────

const platform = platformFlag === 'mac' ? 'mac'
  : platformFlag === 'win' ? 'win'
  : 'all';

if (platform === 'mac' || platform === 'all') buildMac();
if (platform === 'win' || platform === 'all') buildWin();

console.log(`Done. Artifacts in releases/`);
