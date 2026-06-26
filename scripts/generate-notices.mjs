// Generates THIRD_PARTY_NOTICES.txt by aggregating every installed dependency's
// declared license and license text. Run from the repo root:  node scripts/generate-notices.mjs
//
// Event Horizon's own code is licensed under PolyForm Noncommercial 1.0.0 (see LICENSE).
// This file collects the attribution notices required by the bundled third-party
// open-source components (MIT, ISC, Apache-2.0, BSD, etc.).

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OWN = new Set(["event-horizon", "engine", "portal"]);
const LICENSE_FILE_RE = /^(LICENSE|LICENCE|COPYING|NOTICE)(\.\w+)?$/i;

/** @type {Map<string, {name:string, version:string, license:string, dir:string}>} */
const pkgs = new Map();

function normLicense(pkg) {
  let l = pkg.license ?? pkg.licenses;
  if (Array.isArray(l)) l = l.map((x) => (typeof x === "object" ? x.type : x)).join(" OR ");
  else if (l && typeof l === "object") l = l.type;
  return l ? String(l) : "UNKNOWN";
}

function walk(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const full = path.join(dir, e.name);
    const pkgPath = path.join(full, "package.json");
    if (fs.existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
        if (pkg.name && pkg.version && !OWN.has(pkg.name)) {
          const key = `${pkg.name}@${pkg.version}`;
          if (!pkgs.has(key)) {
            pkgs.set(key, { name: pkg.name, version: pkg.version, license: normLicense(pkg), dir: full });
          }
        }
      } catch {
        // ignore malformed package.json
      }
    }
    if (e.name === "node_modules" || e.name.startsWith("@")) walk(full);
    else {
      const nested = path.join(full, "node_modules");
      if (fs.existsSync(nested)) walk(nested);
    }
  }
}

for (const root of ["node_modules", "engine/node_modules", "portal/node_modules"]) {
  const abs = path.join(repoRoot, root);
  if (fs.existsSync(abs)) walk(abs);
}

function licenseText(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  const file = entries.find((e) => e.isFile() && LICENSE_FILE_RE.test(e.name));
  if (!file) return null;
  try {
    return fs.readFileSync(path.join(dir, file.name), "utf8").trim();
  } catch {
    return null;
  }
}

const sorted = [...pkgs.values()].sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));

const out = [];
out.push("THIRD-PARTY SOFTWARE NOTICES AND INFORMATION");
out.push("=".repeat(60));
out.push("");
out.push("Event Horizon (FLUX) incorporates the third-party open-source components");
out.push("listed below. Each is distributed under its own license, reproduced here to");
out.push("satisfy the attribution requirements of those licenses. Event Horizon's own");
out.push("source code is licensed separately under the PolyForm Noncommercial License");
out.push("1.0.0 (see the LICENSE file); the licenses below apply ONLY to the named");
out.push("third-party components, not to Event Horizon itself.");
out.push("");
out.push(`Components: ${sorted.length}`);
out.push("");

// Summary index
out.push("INDEX");
out.push("-".repeat(60));
for (const p of sorted) out.push(`  ${p.name}@${p.version}  —  ${p.license}`);
out.push("");

for (const p of sorted) {
  out.push("");
  out.push("=".repeat(60));
  out.push(`${p.name}@${p.version}`);
  out.push(`License: ${p.license}`);
  out.push("=".repeat(60));
  out.push("");
  const text = licenseText(p.dir);
  out.push(text ?? `(No license file shipped with this package; declared license: ${p.license}.)`);
  out.push("");
}

fs.writeFileSync(path.join(repoRoot, "THIRD_PARTY_NOTICES.txt"), out.join("\n") + "\n");
console.log(`Wrote THIRD_PARTY_NOTICES.txt with ${sorted.length} components.`);
