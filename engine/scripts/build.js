#!/usr/bin/env node
/**
 * Production build script for the Event Horizon engine.
 * Bundles engine/src/index.ts + engine/src/init.ts into standalone CJS files
 * under engine/dist/ using esbuild. All npm dependencies are bundled in so the
 * output is self-contained (no node_modules needed at runtime).
 */

const esbuild = require('esbuild');
const path = require('path');
const fs = require('fs');
const fsp = require('fs/promises');

const engineRoot = path.resolve(__dirname, '..');
const repoRoot = path.resolve(engineRoot, '..');
const outDir = path.join(engineRoot, 'dist');
const portalSrc = path.join(repoRoot, 'portal', 'dist');
const portalDest = path.join(outDir, 'portal', 'dist');

// Skill/instructions source files to embed in the binary
const bundledAssets = [
  { src: path.join(repoRoot, '.docs', 'skills'),          dest: path.join(outDir, '.docs', 'skills') },
  { src: path.join(repoRoot, '.docs', 'event-horizon'),   dest: path.join(outDir, '.docs', 'event-horizon') },
  { src: path.join(repoRoot, '.flux', 'skills'),          dest: path.join(outDir, '.flux', 'skills') },
];

fs.mkdirSync(outDir, { recursive: true });

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
  ],
};

async function build() {
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

  console.log('Build complete → engine/dist/');
}

build().catch((err) => {
  console.error('Build failed:', err);
  process.exit(1);
});
