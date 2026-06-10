#!/usr/bin/env node
/**
 * Source distribution script.
 * Produces event-horizon-source.zip at the repo root containing a clean copy
 * of the source tree, stripped of personal dev artifacts (tickets, read-state,
 * .claude/, node_modules/, dist/, etc.).
 *
 * Usage: node engine/scripts/dist-source.js
 *   or:  npm run dist:source  (from repo root)
 */

import path from 'path';
import fs from 'fs';
import fsp from 'fs/promises';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const stagingDir = path.join(repoRoot, '.dist-source-staging');
const outputZip = path.join(repoRoot, 'event-horizon-source.zip');

// Directories/files to copy relative to repoRoot (src = dest inside zip root)
const INCLUDE_PATHS = [
  'engine/src',
  'engine/scripts',
  'engine/package.json',
  'engine/tsconfig.json',
  'engine/.event-horizon',
  'portal',
  'package.json',
  'package-lock.json',
  'README.md',
  '.docs',
  '.flux/config.json',
  '.flux/skills',
  '.flux/assets',
];

// Subdirectory names to skip when recursively copying directories
const EXCLUDE_DIR_NAMES = new Set([
  'node_modules',
  'dist',
  'build',
  '.git',
  '.dist-source-staging',
]);

// File patterns to exclude (exact names)
const EXCLUDE_FILE_NAMES = new Set([
  '.DS_Store',
  '.env',
  '.clauderc',
]);

// Regex patterns to exclude files by name
const EXCLUDE_FILE_PATTERNS = [
  /^FLUX-\d+\.md$/,         // ticket files
  /^read-state\.json$/,     // personal read state
  /\.log$/,                 // log files
  /^event-horizon.*\.zip$/, // existing dist zips
  /\.js$/,                  // compiled JS in engine/src (source-only dist)
  /\.js\.map$/,             // source maps
  /\.d\.ts$/,               // declaration files
  /\.d\.ts\.map$/,          // declaration maps
];

function shouldExcludeFile(name) {
  if (EXCLUDE_FILE_NAMES.has(name)) return true;
  return EXCLUDE_FILE_PATTERNS.some(re => re.test(name));
}

async function copyItem(src, dest) {
  const stat = await fsp.stat(src);
  if (stat.isDirectory()) {
    await fsp.mkdir(dest, { recursive: true });
    const entries = await fsp.readdir(src, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory() && EXCLUDE_DIR_NAMES.has(entry.name)) continue;
      if (!entry.isDirectory() && shouldExcludeFile(entry.name)) continue;
      await copyItem(path.join(src, entry.name), path.join(dest, entry.name));
    }
  } else {
    await fsp.mkdir(path.dirname(dest), { recursive: true });
    await fsp.copyFile(src, dest);
  }
}

function sanitiseConfig(configPath) {
  const raw = fs.readFileSync(configPath, 'utf8');
  const config = JSON.parse(raw);
  // Reset personal users to generic defaults
  config.users = [{ name: 'User' }, { name: 'Agent' }];
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');
}

async function main() {
  console.log('Cleaning staging directory…');
  await fsp.rm(stagingDir, { recursive: true, force: true });
  await fsp.mkdir(stagingDir, { recursive: true });

  for (const relPath of INCLUDE_PATHS) {
    const src = path.join(repoRoot, relPath);
    const dest = path.join(stagingDir, relPath);
    try {
      await fsp.access(src);
    } catch {
      console.warn(`  Skipping ${relPath} — not found.`);
      continue;
    }
    console.log(`  Staging ${relPath}…`);
    await copyItem(src, dest);
  }

  // Sanitise the staged config
  const stagedConfig = path.join(stagingDir, '.flux', 'config.json');
  if (fs.existsSync(stagedConfig)) {
    console.log('  Sanitising .flux/config.json (resetting users)…');
    sanitiseConfig(stagedConfig);
  }

  console.log(`Creating ${path.basename(outputZip)}…`);
  if (fs.existsSync(outputZip)) fs.unlinkSync(outputZip);

  // macOS/Linux only: requires the `zip` CLI (not available on Windows by default)
  execSync(`zip -r "${outputZip}" .`, { cwd: stagingDir, stdio: 'inherit' });

  console.log('Cleaning up staging directory…');
  await fsp.rm(stagingDir, { recursive: true, force: true });

  const size = (fs.statSync(outputZip).size / 1024).toFixed(1);
  console.log(`\nDone → event-horizon-source.zip (${size} KB)`);
}

main().catch(err => {
  console.error('dist:source failed:', err);
  process.exit(1);
});
