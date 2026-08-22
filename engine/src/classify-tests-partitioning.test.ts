import { describe, it, expect } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
import { isIntegrationTest, computeIntegrationSet } from '../scripts/classify-tests.mjs';

const scriptPath = fileURLToPath(new URL('../scripts/classify-tests.mjs', import.meta.url));
const engineRoot = path.join(fileURLToPath(new URL('.', import.meta.url)), '..');

// Meta-tests for FLUX-1665's test-tier classifier: prove the partitioning predicate on small,
// deliberately-crafted fixtures rather than the real (large, evolving) suite.

describe('classify-tests.mjs partitioning (FLUX-1665)', () => {
  describe('isIntegrationTest', () => {
    it('classifies a direct spawn-importer as integration', () => {
      const content = `
        import { execFileSync } from 'node:child_process';
        it('spawns', () => { execFileSync('git', ['status']); });
      `;
      expect(isIntegrationTest(content)).toBe(true);
    });

    it('classifies a bare child_process import as integration even without a matched call', () => {
      const content = `import { spawn } from 'child_process';\n`;
      expect(isIntegrationTest(content)).toBe(true);
    });

    it('classifies a real-git-fixture builder (mkdtemp) as integration', () => {
      const content = `
        import fs from 'fs/promises';
        async function makeRepo() { return fs.mkdtemp('/tmp/eh-'); }
      `;
      expect(isIntegrationTest(content)).toBe(true);
    });

    it('leaves a pure file (no spawn, no fixture) as unit', () => {
      const content = `
        import { describe, it, expect } from 'vitest';
        describe('add', () => { it('adds', () => { expect(1 + 1).toBe(2); }); });
      `;
      expect(isIntegrationTest(content)).toBe(false);
    });

    it('KNOWN LIMITATION: does not detect a transitive spawn via an imported helper', () => {
      // The file itself has no spawn/mkdtemp token — it only imports a helper that spawns.
      // Static scanning cannot see through that; this is documented in classify-tests.mjs and
      // is why test-tiers.json also accepts hand-curated entries beyond what this predicate finds.
      const content = `
        import { buildRealRepo } from './some-helper-that-spawns-git.js';
        it('uses a real repo built elsewhere', async () => { await buildRealRepo(); });
      `;
      expect(isIntegrationTest(content)).toBe(false);
    });
  });

  describe('computeIntegrationSet', () => {
    it('partitions a small fixture directory into integration vs. unit files', async () => {
      const scanRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'eh-classify-fixture-'));
      try {
        await fs.writeFile(
          path.join(scanRoot, 'spawn.test.ts'),
          `import { execFileSync } from 'node:child_process';\nit('x', () => { execFileSync('git', []); });\n`
        );
        await fs.writeFile(
          path.join(scanRoot, 'fixture.test.ts'),
          `import fs from 'fs/promises';\nasync function r() { return fs.mkdtemp('/tmp/x-'); }\n`
        );
        await fs.writeFile(
          path.join(scanRoot, 'pure.test.ts'),
          `it('adds', () => { expect(1 + 1).toBe(2); });\n`
        );
        // A non-test file in the same directory must be ignored (only *.test.ts is scanned).
        await fs.writeFile(path.join(scanRoot, 'helper.ts'), `import { spawn } from 'child_process';\n`);

        const result = computeIntegrationSet(scanRoot, scanRoot);

        expect(result).toEqual(['fixture.test.ts', 'spawn.test.ts']);
      } finally {
        await fs.rm(scanRoot, { recursive: true, force: true });
      }
    });

    it('returns an empty set for a directory with no matching files', async () => {
      const scanRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'eh-classify-fixture-empty-'));
      try {
        await fs.writeFile(path.join(scanRoot, 'pure.test.ts'), `it('x', () => {});\n`);
        expect(computeIntegrationSet(scanRoot, scanRoot)).toEqual([]);
      } finally {
        await fs.rm(scanRoot, { recursive: true, force: true });
      }
    });
  });

  describe('CLI guard (real subprocess)', () => {
    it('fails when a spawn-importing test file is missing from the committed test-tiers.json', async () => {
      // Planted directly under the real engine/src (a throwaway subdirectory, removed in
      // `finally`) — the CLI's scan root is hardcoded to this repo, unlike computeIntegrationSet
      // above which takes an explicit root, so this is the only way to exercise `main()`'s
      // actual exit-code behavior without touching classify-tests.mjs's process.exit calls
      // directly (which would kill the test worker).
      const fixtureDir = path.join(engineRoot, 'src', '__classify_guard_fixture__');
      await fs.mkdir(fixtureDir, { recursive: true });
      await fs.writeFile(
        path.join(fixtureDir, 'unclassified-spawn.test.ts'),
        `import { execFileSync } from 'node:child_process';\nit('x', () => { execFileSync('git', []); });\n`
      );
      try {
        expect(() => execFileSync('node', [scriptPath], { cwd: engineRoot, stdio: 'pipe' })).toThrow();
      } finally {
        await fs.rm(fixtureDir, { recursive: true, force: true });
      }
    });

    it('passes on the real, currently-committed test-tiers.json', () => {
      // Sanity check that the guard is green against the actual repo state — if this fails,
      // test-tiers.json has drifted and needs `node engine/scripts/classify-tests.mjs --write`.
      expect(() => execFileSync('node', [scriptPath], { cwd: engineRoot, stdio: 'pipe' })).not.toThrow();
    });
  });
});
