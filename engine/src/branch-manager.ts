import { execFile } from 'child_process';
import { promisify } from 'util';
import { workspaceRoot } from './workspace.js';

const execFileAsync = promisify(execFile);

function git(args: string[]): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync('git', ['-C', workspaceRoot!, ...args], { windowsHide: true });
}

// Larger maxBuffer for `git diff` — defaults (1MB) truncate big diffs into ENOBUFS.
function gitDiff(args: string[]): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync('git', ['-C', workspaceRoot!, ...args], { windowsHide: true, maxBuffer: 8 * 1024 * 1024 });
}

export function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

export function branchName(ticketId: string, title: string): string {
  return `flux/${ticketId}-${slugify(title)}`;
}

export async function createTicketBranch(ticketId: string, title: string, baseBranch?: string): Promise<string> {
  if (!baseBranch) baseBranch = await getDefaultBranch();
  const name = branchName(ticketId, title);
  // Idempotent: only create the local ref if it doesn't already exist (e.g. a prior
  // worktree-open already created it). Use `git branch` (not checkout) — the engine
  // process must NOT switch HEAD to the ticket branch; the agent's worktree/session
  // is what checks it out.
  if (!(await branchRefExists(name))) {
    await git(['branch', name, baseBranch]);
  }
  await git(['push', '-u', 'origin', name]);
  return name;
}

async function branchRefExists(name: string): Promise<boolean> {
  try {
    await git(['rev-parse', '--verify', '--quiet', `refs/heads/${name}`]);
    return true;
  } catch {
    return false;
  }
}

async function getDefaultBranch(): Promise<string> {
  try {
    const { stdout } = await git(['symbolic-ref', 'refs/remotes/origin/HEAD']);
    return stdout.trim().replace('refs/remotes/origin/', '') || 'master';
  } catch {
    return 'master';
  }
}

export async function getTicketBranchStatus(name: string): Promise<{ exists: boolean; aheadCount: number; behindCount: number }> {
  try {
    await git(['rev-parse', '--verify', name]);
  } catch {
    return { exists: false, aheadCount: 0, behindCount: 0 };
  }

  try {
    const base = await getDefaultBranch();
    const { stdout } = await git(['rev-list', '--left-right', '--count', `${base}...${name}`]);
    const parts = stdout.trim().split(/\s+/);
    const behindCount = parseInt(parts[0] ?? '0', 10) || 0;
    const aheadCount = parseInt(parts[1] ?? '0', 10) || 0;
    return { exists: true, aheadCount, behindCount };
  } catch {
    return { exists: true, aheadCount: 0, behindCount: 0 };
  }
}

export async function deleteTicketBranch(name: string, force = false): Promise<void> {
  const flag = force ? '-D' : '-d';
  await git(['branch', flag, name]);
  // Best-effort: clean up the remote ref we created in createTicketBranch. Swallow errors
  // (branch may have been deleted on GitHub already, or never pushed).
  try {
    await git(['push', 'origin', '--delete', name]);
  } catch {
    /* remote ref already gone */
  }
}

export async function checkGhAuth(): Promise<boolean> {
  try {
    await execFileAsync('gh', ['auth', 'status'], { windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

export async function createPullRequest(branch: string, title: string, body: string): Promise<string> {
  // Push latest commits on the branch before creating/updating the PR.
  await execFileAsync('git', ['-C', workspaceRoot!, 'push', '-u', 'origin', branch], { windowsHide: true });

  // If a PR already exists for this branch, return its URL rather than erroring.
  try {
    const { stdout: existing } = await execFileAsync('gh', ['pr', 'view', branch, '--json', 'url', '--jq', '.url'], { windowsHide: true });
    const url = existing.trim();
    if (url) return url;
  } catch {
    // No existing PR — fall through to create one.
  }

  const { stdout } = await execFileAsync('gh', ['pr', 'create', '--title', title, '--body', body, '--head', branch], { windowsHide: true });
  return stdout.trim();
}

export async function mergePullRequest(branch: string): Promise<void> {
  await execFileAsync('gh', ['pr', 'merge', branch, '--squash', '--delete-branch'], { windowsHide: true });
}

export async function getCurrentCommit(): Promise<string | null> {
  try {
    const { stdout } = await git(['rev-parse', 'HEAD']);
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

// Resolve any rev (e.g. 'HEAD~1') to a full sha, or null if it doesn't exist.
export async function resolveCommit(rev: string): Promise<string | null> {
  try {
    const { stdout } = await git(['rev-parse', '--verify', rev]);
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

export interface DiffFileSummary {
  file: string;
  additions: number;
  deletions: number;
}

export interface DiffCapture {
  summary: DiffFileSummary[];
  fullDiff: string;
  truncated: boolean;
}

const DIFF_MAX_BYTES = 2 * 1024 * 1024;
export const DIFF_PROMPT_MAX_BYTES = 80 * 1024;

// Resolve the range to diff: branch mode (merge-base..tip) takes precedence; otherwise
// baseline..HEAD; otherwise the single most recent commit on HEAD.
// If mode is 'working', diffs baselineCommit against the working tree.
async function resolveDiffRange(branch?: string | null, baselineCommit?: string | null, mode?: 'committed' | 'working'): Promise<string | null> {
  if (mode === 'working' && baselineCommit) {
    try {
      await git(['rev-parse', '--verify', baselineCommit]);
      return baselineCommit;
    } catch {
      return null;
    }
  }

  if (branch) {
    try {
      await git(['rev-parse', '--verify', branch]);
      const base = await getDefaultBranch();
      const { stdout: mb } = await git(['merge-base', base, branch]);
      const mergeBase = mb.trim();
      if (mergeBase) return `${mergeBase}..${branch}`;
    } catch {
      /* branch missing locally — fall through to other strategies */
    }
  }
  if (baselineCommit) {
    try {
      await git(['rev-parse', '--verify', baselineCommit]);
      return `${baselineCommit}..HEAD`;
    } catch {
      /* baseline gone — fall through */
    }
  }
  try {
    await git(['rev-parse', '--verify', 'HEAD~1']);
    return 'HEAD~1..HEAD';
  } catch {
    return null;
  }
}

function parseNumstat(stdout: string): DiffFileSummary[] {
  const out: DiffFileSummary[] = [];
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const parts = trimmed.split(/\s+/);
    if (parts.length < 3) continue;
    const [addStr, delStr, ...fileParts] = parts;
    if (addStr === undefined || delStr === undefined) continue;
    // Binary files show "-\t-\tpath" in numstat.
    const additions = addStr === '-' ? 0 : parseInt(addStr, 10) || 0;
    const deletions = delStr === '-' ? 0 : parseInt(delStr, 10) || 0;
    out.push({ file: fileParts.join(' '), additions, deletions });
  }
  return out;
}

export async function captureDiff(branch?: string | null, baselineCommit?: string | null, mode?: 'committed' | 'working'): Promise<DiffCapture | null> {
  const range = await resolveDiffRange(branch, baselineCommit, mode);
  if (!range) return null;

  let summary: DiffFileSummary[] = [];
  try {
    const { stdout } = await gitDiff(['diff', '--numstat', range]);
    summary = parseNumstat(stdout);
  } catch {
    return null;
  }

  let fullDiff = '';
  let truncated = false;
  try {
    const { stdout } = await gitDiff(['diff', range]);
    if (Buffer.byteLength(stdout, 'utf-8') > DIFF_MAX_BYTES) {
      fullDiff = stdout.slice(0, DIFF_MAX_BYTES) + '\n# [diff truncated — exceeds 2MB]\n';
      truncated = true;
    } else {
      fullDiff = stdout;
    }
  } catch {
    fullDiff = '';
  }

  return { summary, fullDiff, truncated };
}

export interface PromptDiffCapture {
  diff: string;
  truncated: boolean;
  range: string;
}

export async function captureDiffForPrompt(branch?: string | null, baselineCommit?: string | null): Promise<PromptDiffCapture | null> {
  const range = await resolveDiffRange(branch, baselineCommit);
  if (!range) return null;

  try {
    const { stdout } = await gitDiff(['diff', range]);
    const byteLen = Buffer.byteLength(stdout, 'utf-8');
    if (byteLen > DIFF_PROMPT_MAX_BYTES) {
      return {
        diff: stdout.slice(0, DIFF_PROMPT_MAX_BYTES),
        truncated: true,
        range,
      };
    }
    return { diff: stdout, truncated: false, range };
  } catch {
    return null;
  }
}

// Extract a single file's hunk from a unified diff blob. Simple parser — splits on
// `diff --git ` boundaries and matches the requested path.
export function extractFileFromDiff(fullDiff: string, file: string): string | null {
  if (!fullDiff) return null;
  const sections = fullDiff.split(/^diff --git /m);
  for (const section of sections) {
    if (!section.trim()) continue;
    // Header line looks like: a/path b/path
    const firstNewline = section.indexOf('\n');
    const header = firstNewline >= 0 ? section.slice(0, firstNewline) : section;
    if (header.includes(`a/${file}`) || header.includes(`b/${file}`)) {
      return 'diff --git ' + section;
    }
  }
  return null;
}
