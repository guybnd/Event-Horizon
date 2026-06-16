#!/usr/bin/env node
/**
 * Production build script for the Event Horizon engine.
 * Bundles engine/src/index.ts + engine/src/init.ts into standalone CJS files
 * under engine/dist/ using esbuild. All npm dependencies are bundled in so the
 * output is self-contained (no node_modules needed at runtime).
 */

import esbuild from 'esbuild';
import path from 'path';
import fs from 'fs';
import fsp from 'fs/promises';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const engineRoot = path.resolve(__dirname, '..');
const repoRoot = path.resolve(engineRoot, '..');
const outDir = path.join(engineRoot, 'dist');

// Engine version — inlined into the bundle via esbuild `define` so the runtime
// never has to read package.json from disk (which doesn't exist next to a SEA
// binary). Read once here so both the bundle and the SEA manifest agree.
const appVersion = JSON.parse(fs.readFileSync(path.join(engineRoot, 'package.json'), 'utf-8')).version;
const portalSrc = path.join(repoRoot, 'portal', 'dist');
const portalDest = path.join(outDir, 'portal', 'dist');

// Tray binary source — hoisted to root node_modules by npm workspaces
const traybinSrc = path.join(repoRoot, 'node_modules', 'systray', 'traybin');
const traybinDest = path.join(outDir, 'traybin');

// Skill/instructions source files to embed in the binary
const bundledAssets = [
  { src: path.join(repoRoot, '.docs', 'skills'),          dest: path.join(outDir, '.docs', 'skills') },
  { src: path.join(repoRoot, '.docs', 'event-horizon'),   dest: path.join(outDir, '.docs', 'event-horizon') },
  { src: path.join(repoRoot, '.flux', 'skills'),          dest: path.join(outDir, '.flux', 'skills') },
];

fs.mkdirSync(outDir, { recursive: true });
// Override parent "type": "module" so Node treats dist/*.js as CJS
fs.writeFileSync(path.join(outDir, 'package.json'), '{"type":"commonjs"}\n');

async function copyDir(src, dest) {
  await fsp.mkdir(dest, { recursive: true });
  const entries = await fsp.readdir(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      await copyDir(srcPath, destPath);
    } else {
      await fsp.copyFile(srcPath, destPath);
    }
  }
}

const sharedConfig = {
  bundle: true,
  platform: 'node',
  target: 'node18',
  format: 'cjs',
  minify: false,
  sourcemap: false,
  external: [
    // chokidar uses native bindings; keep it external so pkg can handle it
    'fsevents',
    // node:sea is only available at runtime inside a SEA binary — never bundle it
    'node:sea',
  ],
  // Inline the version so getLocalVersion() works regardless of packaging mode.
  define: {
    __EH_VERSION__: JSON.stringify(appVersion),
  },
};

// Remove stray compiled JS sitting next to the .ts sources. esbuild resolves a
// `./foo.js` import to a real sibling `foo.js` when one exists, so leftover
// build cruft (e.g. from a stray tsc emit) silently shadows updated .ts and
// ships stale code. Always clean before bundling. (FLUX-496)
async function cleanStraySrcJs(dir) {
  let removed = 0;
  const entries = await fsp.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      removed += await cleanStraySrcJs(full);
    } else if (entry.name.endsWith('.js') || entry.name.endsWith('.js.map')) {
      // Do NOT swallow this error. A stray .js we fail to remove (e.g. locked by
      // an IDE or another process) would still shadow its .ts sibling and ship
      // stale code — the exact silent-stale-build failure this guard exists to
      // prevent. Fail the build loudly instead. (FLUX-496)
      try {
        await fsp.unlink(full);
      } catch (err) {
        throw new Error(
          `Failed to remove stray compiled file ${full}: ${err.message}. ` +
          `It would shadow the .ts source and ship stale code — aborting build. ` +
          `Close any process holding the file (IDE/tsc/stray node) and rebuild.`
        );
      }
      removed++;
    }
  }
  return removed;
}

async function build() {
  const srcDir = path.join(engineRoot, 'src');
  const removed = await cleanStraySrcJs(srcDir);
  if (removed > 0) console.log(`Cleaned ${removed} stray compiled JS file(s) from src/`);

  console.log('Building engine/src/index.ts → engine/dist/index.js …');
  await esbuild.build({
    ...sharedConfig,
    entryPoints: [path.join(engineRoot, 'src', 'index.ts')],
    outfile: path.join(outDir, 'index.js'),
  });

  console.log('Building engine/src/init.ts → engine/dist/init.js …');
  await esbuild.build({
    ...sharedConfig,
    entryPoints: [path.join(engineRoot, 'src', 'init.ts')],
    outfile: path.join(outDir, 'init.js'),
  });

  console.log('Building engine/src/mcp-server.ts → engine/dist/mcp-server.js …');
  await esbuild.build({
    ...sharedConfig,
    entryPoints: [path.join(engineRoot, 'src', 'mcp-server.ts')],
    outfile: path.join(outDir, 'mcp-server.js'),
  });

  // Copy portal/dist into engine/dist/portal/dist so pkg can embed it as assets.
  try {
    await fsp.access(portalSrc);
    console.log('Copying portal/dist → engine/dist/portal/dist …');
    await fsp.rm(portalDest, { recursive: true, force: true });
    await copyDir(portalSrc, portalDest);
    console.log('Portal assets staged.');
  } catch {
    console.warn('portal/dist not found — skipping asset staging. Run npm run build -w portal first.');
  }

  // Stage skill source files so the binary can install the agent workflow
  // into any user project without needing the full EH repo present.
  for (const { src, dest } of bundledAssets) {
    try {
      await fsp.access(src);
      console.log(`Staging ${path.relative(repoRoot, src)} → engine/dist/${path.relative(outDir, dest)} …`);
      await fsp.rm(dest, { recursive: true, force: true });
      await copyDir(src, dest);
    } catch {
      console.warn(`Skipping ${src} — not found.`);
    }
  }
  console.log('Skill assets staged.');

  // Stage systray tray binaries so they can be embedded as pkg assets.
  try {
    await fsp.access(traybinSrc);
    console.log('Staging traybin/ → engine/dist/traybin/ …');
    await fsp.rm(traybinDest, { recursive: true, force: true });
    await copyDir(traybinSrc, traybinDest);
    console.log('Tray binaries staged.');
  } catch {
    console.warn('systray traybin/ not found — skipping. Run npm install first.');
  }

  console.log('Build complete → engine/dist/');

  // ── SEA manifest + config ──────────────────────────────────────────────────
  // Scan every staged asset so the Windows SEA build can embed them all.
  // The manifest lists the asset keys; sea-config.json maps each key to its
  // on-disk path (relative to engineRoot, where the command is run from).

  const seaAssetDirs = [
    path.join(outDir, 'portal', 'dist'),
    path.join(outDir, '.docs', 'skills'),
    path.join(outDir, '.docs', 'event-horizon'),
    path.join(outDir, '.flux', 'skills'),
    path.join(outDir, 'traybin'),
  ];

  async function getAllFiles(dir) {
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    const files = [];
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) files.push(...await getAllFiles(full));
      else files.push(full);
    }
    return files;
  }

  const seaAssets = {};    // sea-config.json assets section
  const manifestKeys = []; // runtime manifest

  for (const dir of seaAssetDirs) {
    if (!fs.existsSync(dir)) continue;
    const files = await getAllFiles(dir);
    for (const file of files) {
      // key: relative to outDir, forward slashes (e.g. "portal/dist/index.html")
      const key = path.relative(outDir, file).replace(/\\/g, '/');
      // path in sea-config: relative to engineRoot, forward slashes
      seaAssets[key] = path.relative(engineRoot, file).replace(/\\/g, '/');
      manifestKeys.push(key);
    }
  }

  // Include mcp-server.js so the SEA binary can start in --mcp mode.
  // The dynamic import('./mcp-server.js') in index.ts becomes require('./mcp-server.js')
  // in the esbuild CJS output and resolves from disk — not from the SEA blob.  We
  // extract it to tmpdir at startup so that require() path exists at runtime.
  const mcpServerDist = path.join(outDir, 'mcp-server.js');
  if (fs.existsSync(mcpServerDist)) {
    const mcpKey = 'mcp-server.js';
    seaAssets[mcpKey] = path.relative(engineRoot, mcpServerDist).replace(/\\/g, '/');
    manifestKeys.push(mcpKey);
  }

  const manifest = { version: appVersion, keys: manifestKeys };
  const manifestPath = path.join(outDir, 'sea-manifest.json');
  await fsp.writeFile(manifestPath, JSON.stringify(manifest, null, 2));
  seaAssets['manifest'] = path.relative(engineRoot, manifestPath).replace(/\\/g, '/');

  const seaConfig = {
    main: path.relative(engineRoot, path.join(outDir, 'index.js')).replace(/\\/g, '/'),
    output: path.relative(engineRoot, path.join(outDir, 'sea-prep.blob')).replace(/\\/g, '/'),
    disableExperimentalSEAWarning: true,
    useCodeCache: false,
    assets: seaAssets,
  };
  await fsp.writeFile(path.join(engineRoot, 'sea-config.json'), JSON.stringify(seaConfig, null, 2));
  console.log(`SEA config written → engine/sea-config.json (${manifestKeys.length} assets)`);
}

build().catch((err) => {
  console.error('Build failed:', err);
  process.exit(1);
});
