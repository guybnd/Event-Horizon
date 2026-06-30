import { log } from './log.js';
import fs from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import matter from 'gray-matter';

const __dir = (() => {
  // @ts-ignore
  if (typeof __dirname === 'string' && path.isAbsolute(__dirname)) return __dirname;
  try { return path.dirname(fileURLToPath(import.meta.url)); } catch {}
  return path.join(process.cwd(), 'src');
})();

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

  let config: any = {};
  try {
    const configData = await fs.readFile(CONFIG_FILE, 'utf-8');
    config = JSON.parse(configData);
  } catch (error) {
    console.warn('Could not read config.json, using defaults.');
  }

  const releaseSettings = config.releaseSettings || {
    generateDistinctFiles: true,
    releaseNotesPath: 'release-notes'
  };

  const REPO_ROOT = workspaceRoot;
  const DOCS_DIR = path.join(REPO_ROOT, config.docsRoot || '.docs');

  // Load all tasks
  const files = await fs.readdir(FLUX_DIR);
  const tasksToRelease: any[] = [];
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
  let docRelativePath = '';
  let docFilePath = '';
  let finalDocContent = notes;
  let finalFrontmatter = {};

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

run().catch(console.error);
