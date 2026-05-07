import fs from 'fs/promises';
import path from 'path';
import matter from 'gray-matter';

const FLUX_DIR = path.join(__dirname, '../../.flux');
const CONFIG_FILE = path.join(FLUX_DIR, 'config.json');

async function run() {
  const version = process.argv[2];
  if (!version) {
    console.error('Usage: npm run flux:release <version>');
    process.exit(1);
  }

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

  const REPO_ROOT = path.resolve(FLUX_DIR, '..');
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
    console.log('No tickets in "Done" status found. Exiting.');
    return;
  }

  console.log(`Found ${tasksToRelease.length} tickets to release.`);

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
  console.log(`Updated release notes at: ${docRelativePath}.md`);

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

  console.log(`Successfully released ${tasksToRelease.length} tickets as ${version}.`);
}

run().catch(console.error);
