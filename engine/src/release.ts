import { log } from './log.js';
import fs from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import matter from 'gray-matter';

const __dir = (() => {
  if (typeof __dirname === 'string' && path.isAbsolute(__dirname)) return __dirname;
  try { return path.dirname(fileURLToPath(import.meta.url)); } catch {}
  return path.join(process.cwd(), 'src');
})();

/** Minimal shape of `.flux(-store)/config.json` — only the fields this script reads. */
interface ReleaseConfig {
  releaseSettings?: {
    generateDistinctFiles?: boolean;
    releaseNotesPath?: string;
  };
  docsRoot?: string;
}

/** A "Done" ticket queued for release, paired with its parsed frontmatter and source path. */
export interface ReleaseTask {
  id: string;
  parsed: matter.GrayMatterFile<string>;
  filePath: string;
}

const GIST_MAX_LENGTH = 120;

/**
 * Single-line, truncated gist derived from a ticket's most recent `type:'comment'` history
 * entry — the shape `finish_ticket` writes for its completion comment (`mcp-server.ts`). Returns
 * `undefined` when no comment entry exists (portal-closed ticket, `merge_tickets` fold, or a
 * ticket that predates the completion-comment convention) so callers can fall back to the title.
 */
export function deriveGist(historyEntries: unknown[]): string | undefined {
  for (let i = historyEntries.length - 1; i >= 0; i--) {
    const entry = historyEntries[i];
    if (!entry || typeof entry !== 'object') continue;
    const { type, comment } = entry as Record<string, unknown>;
    if (type !== 'comment' || typeof comment !== 'string') continue;
    const singleLine = comment.replace(/\s+/g, ' ').trim();
    if (!singleLine) continue;
    return singleLine.length > GIST_MAX_LENGTH
      ? `${singleLine.slice(0, GIST_MAX_LENGTH - 1).trimEnd()}…`
      : singleLine;
  }
  return undefined;
}

/**
 * Builds the append-only `## Release {version}` block for the agent-consumable Done-ticket
 * index (FLUX-1151) — one `- **{id}**: {title}[ — {gist}]` line per released ticket, gist
 * appended only when `deriveGist` finds one.
 */
export function buildDoneIndexBlock(version: string, tasks: ReleaseTask[]): string {
  let block = `## Release ${version} — ${new Date().toISOString()}\n\n`;
  for (const t of tasks) {
    const history = Array.isArray(t.parsed.data.history) ? t.parsed.data.history : [];
    const gist = deriveGist(history);
    block += `- **${t.id}**: ${t.parsed.data.title}${gist ? ` — ${gist}` : ''}\n`;
  }
  return block + '\n';
}

/**
 * Idempotency guard — a `## Release {version}` heading already present means this version was
 * already indexed. Anchored (line-start + trailing whitespace/end-of-string) rather than a raw
 * substring check so a shorter/rougher version tag (e.g. `v2` or `v1.0`) never false-positives
 * against a previously indexed longer one (e.g. `v2.0.0` or `v1.0.1`) and silently drops a release.
 */
export function hasExistingVersionBlock(existingContent: string, version: string): boolean {
  const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^## Release ${escaped}(?:\\s|$)`, 'm').test(existingContent);
}

/** Resolve release settings with per-field defaults (a raw config may only set one field). */
function resolveReleaseSettings(
  raw: ReleaseConfig['releaseSettings'],
): { generateDistinctFiles: boolean; releaseNotesPath: string } {
  return {
    generateDistinctFiles: raw?.generateDistinctFiles ?? true,
    releaseNotesPath: raw?.releaseNotesPath ?? 'release-notes',
  };
}

async function run() {
  const args = process.argv.slice(2);
  const workspaceIdx = args.indexOf('--workspace');
  const workspaceRoot = workspaceIdx !== -1 ? (args[workspaceIdx + 1] ?? process.cwd()) : path.join(__dir, '../..');
  const skipIndices = new Set(workspaceIdx !== -1 ? [workspaceIdx, workspaceIdx + 1] : []);
  const version = args.find((a, i) => !a.startsWith('--') && !skipIndices.has(i));
  if (!version) {
    console.error('Usage: npm run flux:release <version> [--workspace <path>]');
    process.exit(1);
  }

  const fluxSubdir = existsSync(path.join(workspaceRoot, '.flux-store')) ? '.flux-store' : '.flux';
  const FLUX_DIR = path.join(workspaceRoot, fluxSubdir);
  const CONFIG_FILE = path.join(FLUX_DIR, 'config.json');

  let config: ReleaseConfig = {};
  try {
    const configData = await fs.readFile(CONFIG_FILE, 'utf-8');
    config = JSON.parse(configData);
  } catch {
    console.warn('Could not read config.json, using defaults.');
  }

  const releaseSettings = resolveReleaseSettings(config.releaseSettings);

  const REPO_ROOT = workspaceRoot;
  const DOCS_DIR = path.join(REPO_ROOT, config.docsRoot || '.docs');

  // Load all tasks
  const files = await fs.readdir(FLUX_DIR);
  const tasksToRelease: ReleaseTask[] = [];
  const taskPaths: string[] = [];

  for (const file of files) {
    if (!file.endsWith('.md')) continue;
    const filePath = path.join(FLUX_DIR, file);
    const content = await fs.readFile(filePath, 'utf-8');
    const parsed = matter(content);
    if (parsed.data.status === 'Done') {
      tasksToRelease.push({
        id: parsed.data.id || path.basename(file, '.md'),
        parsed,
        filePath
      });
      taskPaths.push(filePath);
    }
  }

  if (tasksToRelease.length === 0) {
    log.info('No tickets in "Done" status found. Exiting.');
    return;
  }

  log.info(`Found ${tasksToRelease.length} tickets to release.`);

  // Generate release notes
  let notes = `## Release ${version}\n*Released at ${new Date().toISOString()}*\n\n### Tickets\n\n`;
  for (const t of tasksToRelease) {
    notes += `- **${t.id}**: ${t.parsed.data.title}\n`;
  }
  notes += '\n';

  // Determine doc path
  const basePath = releaseSettings.releaseNotesPath.replace(/^\//, '').replace(/\/$/, '');
  let docRelativePath: string;
  let docFilePath: string;
  let finalDocContent = notes;
  let finalFrontmatter: Record<string, unknown>;

  if (releaseSettings.generateDistinctFiles) {
    docRelativePath = `${basePath}/${version}`;
    docFilePath = path.join(DOCS_DIR, `${docRelativePath}.md`);
    finalFrontmatter = { title: `Release ${version}` };
  } else {
    docRelativePath = `${basePath}/release_notes`;
    docFilePath = path.join(DOCS_DIR, `${docRelativePath}.md`);
    
    // Try to read existing
    try {
      const existing = await fs.readFile(docFilePath, 'utf-8');
      const existingParsed = matter(existing);
      finalFrontmatter = existingParsed.data || { title: 'Release Notes' };
      finalDocContent = notes + existingParsed.content;
    } catch {
      finalFrontmatter = { title: 'Release Notes' };
    }
  }

  // Ensure docs dir exists
  await fs.mkdir(path.dirname(docFilePath), { recursive: true });
  
  // Write doc
  const docFileContent = matter.stringify(finalDocContent, finalFrontmatter);
  await fs.writeFile(docFilePath, docFileContent, 'utf-8');
  log.info(`Updated release notes at: ${docRelativePath}.md`);

  // Append to the canonical, agent-consumable Done-ticket index (FLUX-1151) — a separate
  // concern from the per-version notes file above (never conflated with `generateDistinctFiles`),
  // always appended, never read-modify-rewritten so re-releasing never clobbers prior entries.
  const indexFilePath = path.join(DOCS_DIR, basePath, 'INDEX.md');
  let existingIndexContent = '';
  try {
    existingIndexContent = await fs.readFile(indexFilePath, 'utf-8');
  } catch {
    // No index yet — this is the first release being indexed.
  }
  if (hasExistingVersionBlock(existingIndexContent, version)) {
    log.warn(`INDEX.md already has a "Release ${version}" block — skipping duplicate append.`);
  } else {
    await fs.appendFile(indexFilePath, buildDoneIndexBlock(version, tasksToRelease), 'utf-8');
    log.info(`Appended ${tasksToRelease.length} ticket(s) to ${basePath}/INDEX.md`);
  }

  // Update tasks
  for (const t of tasksToRelease) {
    t.parsed.data.status = 'Released';
    t.parsed.data.version = version;
    t.parsed.data.releasedAt = new Date().toISOString();
    t.parsed.data.releaseDocPath = docRelativePath;
    
    // add history entry
    t.parsed.data.history = t.parsed.data.history || [];
    t.parsed.data.history.push({
      type: 'status_change',
      from: 'Done',
      to: 'Released',
      user: 'Agent',
      date: new Date().toISOString()
    });

    const newContent = matter.stringify(t.parsed.content, t.parsed.data);
    await fs.writeFile(t.filePath, newContent, 'utf-8');
  }

  log.info(`Successfully released ${tasksToRelease.length} tickets as ${version}.`);
}

// Only auto-run when executed directly (`tsx src/release.ts ...`) — not when imported by tests.
function isMainModule(): boolean {
  try {
    return import.meta.url === pathToFileURL(process.argv[1] ?? '').href;
  } catch {
    return false;
  }
}

if (isMainModule()) {
  run().catch(console.error);
}
