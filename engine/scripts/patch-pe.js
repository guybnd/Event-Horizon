#!/usr/bin/env node
/**
 * Patches the PE (Portable Executable) header of the packaged Windows binary
 * to change the subsystem from 3 (IMAGE_SUBSYSTEM_WINDOWS_CUI, console) to
 * 2 (IMAGE_SUBSYSTEM_WINDOWS_GUI, windowed). This suppresses the CMD console
 * window that would otherwise appear when a user double-clicks event-horizon.exe.
 *
 * Usage: node scripts/patch-pe.js [path-to-exe]
 * Default: engine/dist/event-horizon.exe
 */

const fs = require('fs');
const path = require('path');

const exePath = process.argv[2] || path.join(__dirname, '..', 'dist', 'event-horizon.exe');

if (!fs.existsSync(exePath)) {
  console.error(`PE patch: file not found: ${exePath}`);
  process.exit(1);
}

const buf = Buffer.from(fs.readFileSync(exePath)); // copy to mutable buffer

// Validate DOS header magic: 'MZ'
if (buf[0] !== 0x4D || buf[1] !== 0x5A) {
  console.error('PE patch: not a valid DOS/PE file (missing MZ header)');
  process.exit(1);
}

// PE header offset is stored at 0x3C in the DOS header
const peOffset = buf.readUInt32LE(0x3C);

// Validate PE signature: 'PE\0\0'
const peSig = buf.toString('ascii', peOffset, peOffset + 4);
if (peSig !== 'PE\0\0') {
  console.error(`PE patch: invalid PE signature at 0x${peOffset.toString(16)}: ${JSON.stringify(peSig)}`);
  process.exit(1);
}

// COFF header is 20 bytes after PE signature.
// Optional Header starts at peOffset + 4 + 20 = peOffset + 24.
// Subsystem field is at offset 0x44 within the Optional Header.
// Total: peOffset + 24 + 0x44 = peOffset + 0x5C
const subsystemOffset = peOffset + 0x5C;
const current = buf.readUInt16LE(subsystemOffset);

if (current === 2) {
  console.log('PE patch: already WINDOWS_GUI (subsystem=2), nothing to do.');
  process.exit(0);
}

buf.writeUInt16LE(2, subsystemOffset);
fs.writeFileSync(exePath, buf);

console.log(`PE patch: subsystem ${current} → 2 (WINDOWS_GUI) — console window suppressed.`);
