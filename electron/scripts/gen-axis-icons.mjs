// Regenerate the Axis Mundi desktop + tray + exe icons from the committed SVG masters.
// Dev helper — NOT part of the build. Requires sharp (already a devDep here):
//   node scripts/gen-axis-icons.mjs
// Sources: build/icon-axis.svg (full mark, >=48px) and build/icon-axis-small.svg
// (thick-stroke variant for 16/24/32px). Outputs:
//   build/icon-axis.png   1024px  (swap into electron-builder `icon:` to adopt)
//   build/tray-axis.png    256px  (swap into main.js tray to adopt)
//   build/icon-axis.ico    multi-size PNG-compressed ICO: 256/128/64/48 + 32/24/16
import sharp from 'sharp';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const dir = path.dirname(fileURLToPath(import.meta.url));
const buildDir = path.resolve(dir, '..', 'build');
const fullSvg = fs.readFileSync(path.join(buildDir, 'icon-axis.svg'));
const smallSvg = fs.readFileSync(path.join(buildDir, 'icon-axis-small.svg'));

async function png(svg, size) {
  // Rasterize at the SVG's native 1024 and downsample: free supersampling AA.
  return sharp(svg).resize(size, size).png().toBuffer();
}

// ICO container with PNG-compressed entries (valid Vista+; what electron-builder emits too).
function buildIco(entries) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(entries.length, 4);
  const dirEntries = [];
  const blobs = [];
  let offset = 6 + 16 * entries.length;
  for (const { size, buf } of entries) {
    const e = Buffer.alloc(16);
    e.writeUInt8(size >= 256 ? 0 : size, 0); // width (0 = 256)
    e.writeUInt8(size >= 256 ? 0 : size, 1); // height
    e.writeUInt8(0, 2);  // palette colors
    e.writeUInt8(0, 3);  // reserved
    e.writeUInt16LE(1, 4);  // planes
    e.writeUInt16LE(32, 6); // bit depth
    e.writeUInt32LE(buf.length, 8);
    e.writeUInt32LE(offset, 12);
    dirEntries.push(e);
    blobs.push(buf);
    offset += buf.length;
  }
  return Buffer.concat([header, ...dirEntries, ...blobs]);
}

const out = (name) => path.join(buildDir, name);

fs.writeFileSync(out('icon-axis.png'), await png(fullSvg, 1024));
console.log('wrote build/icon-axis.png (1024x1024)');
fs.writeFileSync(out('tray-axis.png'), await png(fullSvg, 256));
console.log('wrote build/tray-axis.png (256x256)');

const icoEntries = [];
for (const size of [256, 128, 64, 48]) icoEntries.push({ size, buf: await png(fullSvg, size) });
for (const size of [32, 24, 16]) icoEntries.push({ size, buf: await png(smallSvg, size) });
fs.writeFileSync(out('icon-axis.ico'), buildIco(icoEntries));
console.log(`wrote build/icon-axis.ico (${icoEntries.map(e => e.size).join('/')})`);

// Preview strip so the small sizes can be eyeballed without squinting: each ICO entry
// nearest-neighbor-upscaled to 128 and laid side by side.
const cell = 128;
const strip = sharp({ create: { width: cell * icoEntries.length, height: cell, channels: 4, background: { r: 60, g: 58, b: 66, alpha: 1 } } });
const composites = [];
for (let i = 0; i < icoEntries.length; i++) {
  const up = await sharp(icoEntries[i].buf).resize(cell, cell, { kernel: 'nearest' }).png().toBuffer();
  composites.push({ input: up, left: i * cell, top: 0 });
}
fs.writeFileSync(out('icon-axis-preview.png'), await strip.composite(composites).png().toBuffer());
console.log('wrote build/icon-axis-preview.png (dev preview, not shipped)');
