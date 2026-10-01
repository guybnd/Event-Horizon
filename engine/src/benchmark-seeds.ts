// Seed registry (FLUX-1739 follow-on): the curated tasks a benchmark can be started from.
//
// A seed is everything a suite needs except the configuration under test: which commit to pin, what
// to ask, which held-out check decides `solved`, and which broader check watches for breakage. They
// live in the repo at `bench/seeds/*.json` (prompts beside them as `.md`), so a seed is reviewed,
// versioned and diffable like any other test fixture — and so the portal can offer "start a
// benchmark" as a form instead of a hand-written manifest.
//
// `baseRef` is a branch or commit; it is resolved to a commit at creation time and pinned on the
// suite, because a suite must never drift with its branch.

import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { runGit } from './git-exec.js';
import { resolveWorkspaceByRoot } from './workspace-context.js';
import { log } from './log.js';
import { CLI_CAPABILITIES } from './agents/types.js';
import {
  DEFAULT_BENCHMARK_CONCURRENCY,
  DEFAULT_RUN_BUDGET_MS,
  type BenchmarkCell,
  type BenchmarkRegressionCheck,
  type BenchmarkSuite,
  type BenchmarkValidation,
} from './models/benchmark.js';

export type SeedTrack = 'fix' | 'build';

export interface SeedTemplate {
  id: string;
  title: string;
  /** `fix`: a held-out regression test decides. `build`: a held-out acceptance harness decides, quality is judged beside it. */
  track: SeedTrack;
  seedTitle: string;
  /** Branch or commit. Resolved to a commit when a suite is created. */
  baseRef: string;
  /** Inline prompt, or a file beside the seed (`promptFile`), optionally with `{{ticketBody}}` filled from `ticketId`. */
  seedPrompt?: string;
  promptFile?: string;
  ticketId?: string;
  validation: BenchmarkValidation;
  regression?: BenchmarkRegressionCheck;
  defaultMatrix?: BenchmarkCell[];
  repetitions?: number;
  concurrency?: number;
  wallClockBudgetMs?: number;
  /** Worktree-relative paths to preserve per run (screenshots, the built artefact). Build seeds set this. */
  artifacts?: string[];
  /** One or two sentences for the picker: what the task is and how hard. */
  notes?: string;
}

export interface ResolvedSeed extends SeedTemplate {
  baseCommit: string | null;
  /** Why `baseCommit` is null, when it is. */
  resolveError?: string;
  /** The prompt with its file and ticket body resolved. */
  prompt: string;
}

export function seedsDir(root: string): string {
  return path.join(root, 'bench', 'seeds');
}

export async function listSeedTemplates(root: string): Promise<ResolvedSeed[]> {
  const dir = seedsDir(root);
  if (!existsSync(dir)) return [];
  const files = (await fs.readdir(dir)).filter((f) => f.endsWith('.json')).sort();
  const out: ResolvedSeed[] = [];
  for (const file of files) {
    try {
      const raw = JSON.parse(await fs.readFile(path.join(dir, file), 'utf-8')) as SeedTemplate;
      if (!raw.id || !raw.baseRef || !raw.validation) {
        log.warn(`[benchmark-seeds] ${file}: missing id/baseRef/validation — skipped`);
        continue;
      }
      out.push(await resolveSeed(root, raw));
    } catch (err) {
      log.warn(`[benchmark-seeds] ${file}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return out;
}

export async function getSeedTemplate(root: string, id: string): Promise<ResolvedSeed | undefined> {
  return (await listSeedTemplates(root)).find((s) => s.id === id);
}

async function resolveSeed(root: string, seed: SeedTemplate): Promise<ResolvedSeed> {
  let baseCommit: string | null = null;
  let resolveError: string | undefined;
  try {
    const { stdout } = await runGit(['rev-parse', '--verify', `${seed.baseRef}^{commit}`], { cwd: root });
    baseCommit = stdout.trim();
  } catch (err) {
    resolveError = `baseRef ${seed.baseRef} does not resolve: ${err instanceof Error ? err.message : String(err)}`;
  }

  let prompt = seed.seedPrompt ?? '';
  if (seed.promptFile) {
    const p = path.join(seedsDir(root), seed.promptFile);
    prompt = existsSync(p) ? await fs.readFile(p, 'utf-8') : `(prompt file ${seed.promptFile} missing)`;
  }
  if (seed.ticketId) {
    // Resolved by root, never the ambient default (FLUX-1755): a seed belongs to the board whose repo it lives in.
    const task = resolveWorkspaceByRoot(root)?.tasks[seed.ticketId] as { body?: string } | undefined;
    const body = task?.body ?? `(ticket ${seed.ticketId} not found on this board)`;
    prompt = prompt.includes('{{ticketBody}}') ? prompt.replace('{{ticketBody}}', body) : `${prompt}\n\nThe ticket, as groomed:\n\n${body}`;
  }

  return { ...seed, baseCommit, prompt, ...(resolveError ? { resolveError } : {}) };
}

export interface SeedOverrides {
  suiteId?: string;
  matrix?: BenchmarkCell[];
  repetitions?: number;
  concurrency?: number;
  wallClockBudgetMs?: number;
}

// Engine-generic fallback: the first registered framework at its default model. Seeds carry the
// real defaults (`defaultMatrix`) — a CLI name belongs in a seed file or in agents/, not here.
const DEFAULT_MATRIX: BenchmarkCell[] = [
  { framework: Object.keys(CLI_CAPABILITIES)[0] as BenchmarkCell['framework'], phase: 'implementation' },
];

/** The suite manifest a seed produces, before expansion. Throws when the seed's base does not resolve. */
export function manifestFromSeed(seed: ResolvedSeed, over: SeedOverrides = {}): BenchmarkSuite {
  if (!seed.baseCommit) throw new Error(seed.resolveError ?? `seed ${seed.id} has no base commit`);
  const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '').replace(/(\d{8})(\d{4})/, '$1-$2');
  return {
    id: over.suiteId || `${seed.id}-${stamp}`,
    title: seed.title,
    seedTitle: seed.seedTitle,
    seedPrompt: seed.prompt,
    baseCommit: seed.baseCommit,
    validation: seed.validation,
    ...(seed.regression ? { regression: seed.regression } : {}),
    track: seed.track,
    ...(seed.artifacts && seed.artifacts.length > 0 ? { artifacts: seed.artifacts } : {}),
    matrix: over.matrix && over.matrix.length > 0 ? over.matrix : (seed.defaultMatrix ?? DEFAULT_MATRIX),
    repetitions: over.repetitions ?? seed.repetitions ?? 3,
    concurrency: over.concurrency ?? seed.concurrency ?? DEFAULT_BENCHMARK_CONCURRENCY,
    wallClockBudgetMs: over.wallClockBudgetMs ?? seed.wallClockBudgetMs ?? DEFAULT_RUN_BUDGET_MS,
    status: 'draft',
    createdAt: new Date().toISOString(),
  };
}
