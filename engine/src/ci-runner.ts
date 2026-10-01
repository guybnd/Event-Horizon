import { runGh } from './git-exec.js';

/**
 * FLUX-1713: which pool actually ran a PR's CI — hosted (GitHub-owned) vs self-hosted. Modeled
 * on git-remote-host.ts's cache-by-key-with-TTL pattern (there: remote hostname keyed by cwd;
 * here: runner info keyed by head SHA, since a SHA's CI verdict never changes once resolved).
 */

export type CiRunnerOrigin = 'hosted' | 'self-hosted' | 'mixed' | 'unknown';

export interface CiRunnerJob {
  name: string;
  origin: 'hosted' | 'self-hosted';
  runnerName?: string;
  labels: string[];
}

export interface CiRunnerInfo {
  origin: CiRunnerOrigin;
  runnerName?: string;
  jobs: CiRunnerJob[];
  checkedAt: string;
}

const CI_RUNNER_HIT_TTL_MS = 5 * 60_000;
// FLUX-1713 review: a miss (no workflow_runs yet, no jobs yet, gh unavailable/unauthed, bad
// shape) used to go uncached, so a repo with `gh` but no Actions workflows re-probed every
// caller on every 90s reconcile tick forever. Cache misses too, on a shorter TTL, so a real run
// appearing shortly after is still picked up promptly.
const CI_RUNNER_MISS_TTL_MS = 60_000;
const cache = new Map<string, { info: CiRunnerInfo | undefined; at: number }>();

/** Drop cached runner-origin resolutions (tests / forcing a fresh probe). */
export function invalidateCiRunnerCache(): void {
  cache.clear();
}

interface GhWorkflowRun {
  id: number;
}

interface GhWorkflowRunsResponse {
  workflow_runs?: GhWorkflowRun[];
}

interface GhJob {
  name?: string;
  labels?: string[];
  runner_name?: string;
}

interface GhJobsResponse {
  jobs?: GhJob[];
}

/**
 * Best-effort CI runner origin for a PR's head SHA — hosted (`ubuntu-latest`-style labels) vs
 * self-hosted (GitHub always tags a self-hosted runner's job with the literal `self-hosted`
 * label). Cached by head SHA (a SHA's CI verdict is immutable once resolved, same rationale as
 * git-remote-host.ts's per-cwd cache). Degrades silently to `undefined` on ANY failure — no gh
 * installed, unauthed, network hiccup, unexpected JSON shape — exactly like
 * branch-manager.ts's getPullRequestStatus, so callers never need their own fallback.
 */
export async function getCiRunnerInfo(headSha: string | null | undefined, cwd: string): Promise<CiRunnerInfo | undefined> {
  if (!headSha) return undefined;

  const cached = cache.get(headSha);
  const now = Date.now();
  if (cached) {
    const ttl = cached.info ? CI_RUNNER_HIT_TTL_MS : CI_RUNNER_MISS_TTL_MS;
    if (now - cached.at < ttl) return cached.info;
  }

  try {
    const { stdout: runsOut } = await runGh(['api', 'repos/{owner}/{repo}/actions/runs', '-f', `head_sha=${headSha}`], { cwd });
    const runs = (JSON.parse(runsOut) as GhWorkflowRunsResponse).workflow_runs;
    const runId = runs?.[0]?.id;
    if (!runId) {
      cache.set(headSha, { info: undefined, at: now });
      return undefined;
    }

    const { stdout: jobsOut } = await runGh(['api', `repos/{owner}/{repo}/actions/runs/${runId}/jobs`], { cwd });
    const rawJobs = (JSON.parse(jobsOut) as GhJobsResponse).jobs;
    if (!rawJobs || rawJobs.length === 0) {
      cache.set(headSha, { info: undefined, at: now });
      return undefined;
    }

    const jobs: CiRunnerJob[] = rawJobs.map((j) => {
      const labels = Array.isArray(j.labels) ? j.labels : [];
      const origin: CiRunnerJob['origin'] = labels.includes('self-hosted') ? 'self-hosted' : 'hosted';
      return {
        name: String(j.name ?? ''),
        origin,
        ...(j.runner_name ? { runnerName: j.runner_name } : {}),
        labels,
      };
    });

    const origins = new Set(jobs.map((j) => j.origin));
    const origin: CiRunnerOrigin = origins.size > 1 ? 'mixed' : (jobs[0]?.origin ?? 'unknown');

    // FLUX-1713 review (Minor 2): don't require exactly one job — a run with several jobs that
    // all land on the same non-mixed origin (e.g. two jobs on the same self-hosted box) should
    // still surface the runner name(s), not degrade to "unknown". Mixed origin stays nameless —
    // a single job's name would misleadingly imply it covers the whole (mixed) verdict.
    const runnerNames = origin === 'mixed' ? new Set<string>() : new Set(jobs.map((j) => j.runnerName).filter((n): n is string => !!n));
    const info: CiRunnerInfo = {
      origin,
      ...(runnerNames.size > 0 ? { runnerName: [...runnerNames].sort().join(', ') } : {}),
      jobs,
      checkedAt: new Date().toISOString(),
    };

    cache.set(headSha, { info, at: now });
    return info;
  } catch {
    cache.set(headSha, { info: undefined, at: now }); // no gh / unauthed / network hiccup / unexpected shape — best-effort
    return undefined;
  }
}
