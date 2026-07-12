import { getWorkspace } from './workspace-context.js';
import fs from 'fs/promises';
import path from 'path';
import { copyDir } from './docs-seeder.js';
import { createTask } from './task-store.js';
import { getDocsDir } from './file-utils.js';

export interface DocItem {
  relativePath: string;
  type: 'folder' | 'file';
  sizeLines: number;
}

export interface TaskItem {
  title: string;
  body?: string;
  sourceFile: string;
  lineNumber: number;
  extractionMode: 'checklist' | 'heading';
}

export interface ScanResult {
  docs: DocItem[];
  tasks: TaskItem[];
  warnings: string[];
}

export interface ImportSelections {
  selectedDocs: string[];
  selectedTasks: Array<{ title: string; body?: string }>;
}

export interface ImportResult {
  docsImported: number;
  ticketsCreated: number;
  ticketsSkipped: number;
}

const SKIP_DIRS = new Set([
  '.git', 'node_modules', '.flux', '.flux-store', 'vendor', 'dist', 'build',
  '.next', '__pycache__', '.venv', '.docs',
]);

const DOC_DIRS = new Set(['docs', 'documentation', 'wiki']);
const ROOT_DOC_FILES = new Set(['README.md', 'ARCHITECTURE.md', 'CONTRIBUTING.md', 'CHANGELOG.md']);
const TASK_FILENAMES = new Set(['TODO.MD', 'TASKS.MD', 'BACKLOG.MD']);

const MAX_ITEMS_PER_FILE = 50;
const LARGE_FILE_THRESHOLD = 500;
const MAX_MARKDOWN_FILES = 100;
const MAX_TITLE_LENGTH = 200;

function isTaskFilename(name: string): boolean {
  return TASK_FILENAMES.has(name.toUpperCase());
}

function countLines(content: string): number {
  if (!content) return 0;
  return content.split('\n').length;
}

async function readFileUtf8(filePath: string): Promise<string | null> {
  try {
    return await fs.readFile(filePath, 'utf-8');
  } catch {
    return null;
  }
}

function extractChecklistItems(content: string, sourceFile: string): TaskItem[] {
  const items: TaskItem[] = [];
  const lines = content.split('\n');

  const hasCheckboxes = lines.some(l => /^\s*-\s*\[[ x]\]/i.test(l));

  for (let i = 0; i < lines.length; i++) {
    if (items.length >= MAX_ITEMS_PER_FILE) break;

    const line = lines[i]!;
    // Skip completed items
    if (/^\s*-\s*\[x\]/i.test(line)) continue;

    // Match unchecked checkboxes
    const checkboxMatch = line.match(/^\s*-\s*\[ \]\s+(.+)/);
    if (checkboxMatch) {
      items.push({
        title: checkboxMatch[1]!.trim().slice(0, MAX_TITLE_LENGTH),
        sourceFile,
        lineNumber: i + 1,
        extractionMode: 'checklist',
      });
      continue;
    }

    // Only match plain bullets if file has no checkbox-style items
    if (!hasCheckboxes) {
      const bulletMatch = line.match(/^-\s+(.+)/);
      if (bulletMatch) {
        items.push({
          title: bulletMatch[1]!.trim().slice(0, MAX_TITLE_LENGTH),
          sourceFile,
          lineNumber: i + 1,
          extractionMode: 'checklist',
        });
      }
    }
  }

  return items;
}

function extractHeadingItems(content: string, sourceFile: string): TaskItem[] {
  const items: TaskItem[] = [];
  const lines = content.split('\n');
  let currentHeading: string | null = null;
  let currentBody: string[] = [];
  let currentLine = 0;

  for (let i = 0; i < lines.length; i++) {
    if (items.length >= MAX_ITEMS_PER_FILE) break;

    const line = lines[i]!;
    const headingMatch = line.match(/^##\s+(.+)/);

    if (headingMatch) {
      if (currentHeading) {
        const bodyText = currentBody.join('\n').trim();
        items.push({
          title: currentHeading.slice(0, MAX_TITLE_LENGTH),
          ...(bodyText ? { body: bodyText } : {}),
          sourceFile,
          lineNumber: currentLine,
          extractionMode: 'heading',
        });
      }
      currentHeading = headingMatch[1]!.trim();
      currentBody = [];
      currentLine = i + 1;
    } else if (currentHeading) {
      currentBody.push(line);
    }
  }

  if (currentHeading && items.length < MAX_ITEMS_PER_FILE) {
    const bodyText = currentBody.join('\n').trim();
    items.push({
      title: currentHeading.slice(0, MAX_TITLE_LENGTH),
      ...(bodyText ? { body: bodyText } : {}),
      sourceFile,
      lineNumber: currentLine,
      extractionMode: 'heading',
    });
  }

  return items;
}

export async function scanWorkspaceForBootstrap(wsRoot: string): Promise<ScanResult> {
  const docs: DocItem[] = [];
  const tasks: TaskItem[] = [];
  const warnings: string[] = [];
  let mdFilesFound = 0;

  let entries;
  try {
    entries = await fs.readdir(wsRoot, { withFileTypes: true });
  } catch {
    return { docs, tasks, warnings };
  }

  for (const entry of entries) {
    if (mdFilesFound >= MAX_MARKDOWN_FILES) break;

    const entryPath = path.join(wsRoot, entry.name);
    const relativePath = entry.name;

    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;

      if (DOC_DIRS.has(entry.name.toLowerCase())) {
        docs.push({ relativePath, type: 'folder', sizeLines: 0 });
        await scanForTaskFiles(entryPath, wsRoot, tasks, warnings);
      }
    } else if (entry.isFile()) {
      if (ROOT_DOC_FILES.has(entry.name)) {
        const content = await readFileUtf8(entryPath);
        const lines = content ? countLines(content) : 0;
        docs.push({ relativePath, type: 'file', sizeLines: lines });
        mdFilesFound++;
      }

      if (isTaskFilename(entry.name)) {
        mdFilesFound++;
        await processTaskFile(entryPath, relativePath, tasks, warnings);
      }
    }
  }
  return { docs, tasks, warnings };
}

async function scanForTaskFiles(
  dirPath: string,
  wsRoot: string,
  tasks: TaskItem[],
  warnings: string[],
) {
  let entries;
  try {
    entries = await fs.readdir(dirPath, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (entry.isFile() && isTaskFilename(entry.name)) {
      const entryPath = path.join(dirPath, entry.name);
      const relativePath = path.relative(wsRoot, entryPath).replace(/\\/g, '/');
      await processTaskFile(entryPath, relativePath, tasks, warnings);
    }
  }
}

async function processTaskFile(
  filePath: string,
  relativePath: string,
  tasks: TaskItem[],
  warnings: string[],
) {
  const content = await readFileUtf8(filePath);
  if (!content) return;

  const lines = countLines(content);
  if (lines > LARGE_FILE_THRESHOLD) {
    warnings.push(`${relativePath} has ${lines} lines — results may be noisy`);
  }

  const checklistItems = extractChecklistItems(content, relativePath);
  const items = checklistItems.length > 0 ? checklistItems : extractHeadingItems(content, relativePath);

  if (items.length >= MAX_ITEMS_PER_FILE) {
    warnings.push(`${relativePath} capped at ${MAX_ITEMS_PER_FILE} items`);
  }

  tasks.push(...items);
}

export async function importBootstrapSelections(
  wsRoot: string,
  selections: ImportSelections,
): Promise<ImportResult> {
  let docsImported = 0;
  let ticketsCreated = 0;
  let ticketsSkipped = 0;

  const docsDir = getDocsDir();
  const resolvedWsRoot = path.resolve(wsRoot);

  // Import docs with path traversal guard
  for (const relPath of selections.selectedDocs) {
    const resolved = path.resolve(wsRoot, relPath);
    const relative = path.relative(resolvedWsRoot, resolved);
    if (relative.startsWith('..') || path.isAbsolute(relative)) continue;

    const destPath = path.join(docsDir, relPath);

    try {
      const stat = await fs.stat(resolved);
      if (stat.isDirectory()) {
        await copyDir(resolved, destPath);
      } else {
        await fs.mkdir(path.dirname(destPath), { recursive: true });
        await fs.copyFile(resolved, destPath);
      }
      docsImported++;
    } catch (err) {
      console.warn(`[bootstrap] Failed to import doc ${relPath}:`, err);
    }
  }

  // Import tasks sequentially to avoid ID races
  for (const taskItem of selections.selectedTasks) {
    const duplicate = Object.values(getWorkspace().tasks).find(
      (t: { title?: string }) => t.title && t.title.toLowerCase() === taskItem.title.toLowerCase(),
    );
    if (duplicate) {
      ticketsSkipped++;
      continue;
    }

    try {
      await createTask({
        title: taskItem.title,
        body: taskItem.body,
        status: 'Grooming',
        priority: 'None',
        effort: 'None',
        author: 'Bootstrapper',
      });
      ticketsCreated++;
    } catch (err) {
      console.error(`[bootstrap] Failed to create ticket:`, err);
    }
  }

  return { docsImported, ticketsCreated, ticketsSkipped };
}
