import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const __dirname = dirname(fileURLToPath(import.meta.url));

// FLUX-1665: tier the suite into a fast `unit` project (no spawn, no real git fixture —
// pool:'threads', which avoids the per-file OS process spawn 'forks' pays) and an
// `integration` project (spawns a process and/or builds a real git fixture via mkdtemp —
// pool:'forks' for real process isolation, capped concurrency to bound git/mkdtemp contention
// on Windows). Membership is the committed `test-tiers.json`, kept honest by
// `engine/scripts/classify-tests.mjs` (wired into `npm run check` and CI).
//
// `isolate: false` was tried and REVERTED for the unit project: measured empirically, a
// meaningful slice of "unit" files rely on module-level singleton/mock state (spies on the
// shared `log` module, event-emitter singletons, etc.) that bleeds across files sharing a
// worker thread. Which files fail is NON-DETERMINISTIC — it depends on vitest's file-to-worker
// grouping, which shifts as files are added/removed. Two consecutive full-unit-tier runs on
// this exact code produced two almost entirely DIFFERENT sets of ~7-13 false failures. Isolation
// stays on (the vitest default); the speed win here is `pool:'threads'` (no process spawn) plus
// skipping the 116 spawn/git-fixture files, not `isolate:false`.
function loadIntegrationTests(): string[] {
  const tiersPath = join(__dirname, 'test-tiers.json');
  const data = JSON.parse(readFileSync(tiersPath, 'utf8')) as { integration?: string[] };
  const integration = Array.isArray(data.integration) ? data.integration : [];
  // test-tiers.json paths are repo-root-relative (`engine/src/...`); vitest resolves this
  // config's `include`/`exclude` globs against its own root (`engine/`), so strip the prefix.
  return integration.map((p) => p.replace(/^engine\//, ''));
}

const integrationTests = loadIntegrationTests();

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          include: ['src/**/*.test.ts'],
          exclude: integrationTests,
          pool: 'threads',
          // Vitest 4's `related` refuses two projects that differ in maxWorkers but share a
          // sequence.groupOrder (FLUX-1690). Distinct orders also run the fast tier first.
          sequence: { groupOrder: 0 },
        },
      },
      {
        extends: true,
        test: {
          name: 'integration',
          include: integrationTests,
          pool: 'forks',
          // Bounds concurrent real-git/mkdtemp fixture contention (measured on Windows — see
          // the FLUX-1665 profile report attached to the ticket). `poolOptions.forks.maxForks`
          // was removed in Vitest 4 in favor of this top-level option.
          maxWorkers: 4,
          sequence: { groupOrder: 1 },
        },
      },
    ],
  },
});
