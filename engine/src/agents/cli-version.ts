// CLI version probe (FLUX-1759).
//
// Each benchmark run records which EventHorizon produced it, but until now not which agent CLI ran
// it. A `claude` auto-update between two cells changes the thing under test as surely as an engine
// rebuild does, and it was invisible. Lives in agents/ because it names CLIs — the adapter boundary
// forbids that anywhere else.

import { spawn } from 'node:child_process';
import type { CliFramework } from './types.js';

/** The binary each framework spawns — the same names the board specs carry. */
export const CLI_BINARIES: Record<CliFramework, string> = {
  claude: 'claude',
  copilot: 'copilot',
  gemini: 'gemini',
  codex: 'codex',
  grok: 'grok',
  antigravity: 'agy',
};

const PROBE_TIMEOUT_MS = 15_000;

/**
 * Pull a version out of `--version` output. CLIs disagree on shape ("2.1.260 (Claude Code)",
 * "codex-cli 0.44.0", "v1.2.3") — take the first semver-ish token, or the first non-empty line.
 */
export function parseCliVersion(stdout: string): string | null {
  const text = stdout.trim();
  if (!text) return null;
  const semver = text.match(/\bv?(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)\b/);
  if (semver?.[1]) return semver[1];
  const firstLine = text.split(/\r?\n/).find((l) => l.trim());
  return firstLine ? firstLine.trim().slice(0, 80) : null;
}

const cache = new Map<CliFramework, Promise<string | null>>();

/**
 * `<binary> --version`, once per framework per engine process. Returns null when the probe fails or
 * the CLI has no stable `--version`; the record then says "unknown" explicitly rather than nothing.
 */
export function resolveCliVersion(framework: CliFramework): Promise<string | null> {
  let pending = cache.get(framework);
  if (!pending) {
    pending = probe(CLI_BINARIES[framework]);
    cache.set(framework, pending);
  }
  return pending;
}

export function __resetCliVersionCache(): void {
  cache.clear();
}

function probe(binary: string): Promise<string | null> {
  return new Promise((resolve) => {
    let out = '';
    let done = false;
    const finish = (value: string | null) => { if (!done) { done = true; resolve(value); } };
    try {
      // The binary name is a fixed constant from CLI_BINARIES, never user input. On Windows the
      // installed entry point is routinely a .cmd shim, which only a shell can start.
      const child = spawn(binary, ['--version'], { shell: process.platform === 'win32', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      const timer = setTimeout(() => { child.kill(); finish(null); }, PROBE_TIMEOUT_MS);
      child.stdout?.on('data', (d: Buffer) => { out += d.toString(); });
      child.stderr?.on('data', (d: Buffer) => { out += d.toString(); });
      child.on('error', () => { clearTimeout(timer); finish(null); });
      child.on('close', (code) => { clearTimeout(timer); finish(code === 0 ? parseCliVersion(out) : parseCliVersion(out) ?? null); });
    } catch {
      finish(null);
    }
  });
}
