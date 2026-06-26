// Regenerate the desktop app + tray icons from the committed brand source (FLUX-793).
// Dev helper — NOT part of the build. Requires sharp (not a runtime dep):
//   npm i -D sharp   &&   node scripts/gen-icons.mjs
// Source: build/icon-source.png (the green event-horizon brand icon). It's slightly portrait,
// so it's padded to a square with its own sampled corner colour — no clipping, no letterbox bars.
// Outputs build/icon.png (electron-builder derives the .ico/.icns) + build/tray.png (main.js tray).
import sharp from 'sharp';
import path from 'path';
import { fileURLToPath } from 'url';

const dir = path.dirname(fileURLToPath(import.meta.url));
const buildDir = path.resolve(dir, '..', 'build');
const src = path.join(buildDir, 'icon-source.png');

// Sample the top-left pixel as the pad colour so the square padding blends into the tile.
const corner = await sharp(src).extract({ left: 0, top: 0, width: 1, height: 1 }).removeAlpha().raw().toBuffer();
const bg = { r: corner[0], g: corner[1], b: corner[2], alpha: 1 };

async function gen(size, out) {
  await sharp(src).resize(size, size, { fit: 'contain', background: bg }).png().toFile(out);
  console.log(`wrote ${out} (${size}x${size}, pad rgb ${bg.r},${bg.g},${bg.b})`);
}

await gen(1024, path.join(buildDir, 'icon.png'));
await gen(256, path.join(buildDir, 'tray.png'));
