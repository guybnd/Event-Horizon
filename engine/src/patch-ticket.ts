#!/usr/bin/env node
/**
 * patch-ticket — safe CLI for editing .flux ticket files.
 *
 * Usage (from repo root):
 *   npx tsx engine/src/patch-ticket.ts <id> [options]
 *
 * Or from the engine/ directory:
 *   npm run patch-ticket -- <id> [options]
 *
 * Options:
 *   --status <value>     Set the status field
 *   --comment <text>     Append a history comment (user: Agent)
 *   --assignee <value>   Set the assignee field
 *   --priority <value>   Set the priority field
 *   --effort <value>     Set the effort field
 *   --body <text>        Replace the ticket body (markdown below frontmatter)
 *   --body-file <path>   Replace the ticket body from a file
 *   --workspace <path>   Workspace root (default: cwd)
 *   --add-subtask <parentId>  Create a new subtask under parentId (requires --title)
 *   --title <value>      Title for the new subtask (used with --add-subtask)
 */

import fs from 'fs';
import path from 'path';
import matter from 'gray-matter';

// ── Arg parsing ──────────────────────────────────────────────────────────────

function parseArgs(argv: string[]) {
  const args = argv.slice(2);

  function flag(name: string): string | undefined {
    const idx = args.indexOf(`--${name}`);
    return idx !== -1 ? args[idx + 1] : undefined;
  }

  const addSubtask = flag('add-subtask');
  const id = args.find(a => !a.startsWith('--') && a !== addSubtask && a !== flag('status') && a !== flag('comment') && a !== flag('assignee') && a !== flag('priority') && a !== flag('effort') && a !== flag('body') && a !== flag('body-file') && a !== flag('workspace') && a !== flag('title'));

  if (!addSubtask && !id) {
    console.error('Usage: patch-ticket <id> [--status <value>] [--comment <text>] [--assignee <value>] [--priority <value>] [--effort <value>] [--body <text>] [--body-file <path>] [--workspace <path>] [--add-subtask <parentId> --title <value>]');
    process.exit(1);
  }

  return {
    id: id || '',
    addSubtask,
    title: flag('title'),
    status: flag('status'),
    comment: flag('comment'),
    assignee: flag('assignee'),
    priority: flag('priority'),
    effort: flag('effort'),
    body: flag('body'),
    bodyFile: flag('body-file'),
    workspace: flag('workspace') ?? process.cwd(),
  };
}

// ── History helpers ───────────────────────────────────────────────────────────

function nowIso() {
  return new Date().toISOString();
}

function appendStatusChange(history: unknown[], from: string, to: string) {
  history.push({
    type: 'status_change',
    from,
    to,
    user: 'Agent',
    date: nowIso(),
  });
}

function appendComment(history: unknown[], text: string) {
  history.push({
    type: 'comment',
    user: 'Agent',
    date: nowIso(),
    comment: text,
  });
}

// ── Subtask creation ─────────────────────────────────────────────────────────

function createSubtask(parentId: string, workspace: string, options: {
  title: string;
  status?: string | undefined;
  priority?: string | undefined;
  effort?: string | undefined;
  body?: string | undefined;
  bodyFile?: string | undefined;
}) {
  const fluxSub = fs.existsSync(path.join(workspace, '.flux-store')) ? '.flux-store' : '.flux';
  const fluxDir = path.resolve(workspace, fluxSub);
  const parentPath = path.resolve(fluxDir, `${parentId}.md`);

  if (!fs.existsSync(parentPath)) {
    console.error(`patch-ticket: parent ticket not found: ${parentPath}`);
    process.exit(1);
  }

  // Determine project key from config or parent ID
  let projectKey = 'FLUX';
  try {
    const configPath = path.resolve(fluxDir, 'config.json');
    const cfg = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    if (cfg.projects && cfg.projects[0]) projectKey = cfg.projects[0];
  } catch { /* use default */ }

  // Find max ID
  let maxId = 0;
  const files = fs.readdirSync(fluxDir);
  for (const file of files) {
    if (file.startsWith(`${projectKey}-`) && file.endsWith('.md')) {
      const num = parseInt(file.replace(`${projectKey}-`, '').replace('.md', ''), 10);
      if (!isNaN(num) && num > maxId) maxId = num;
    }
  }

  const childId = `${projectKey}-${maxId + 1}`;
  const childPath = path.resolve(fluxDir, `${childId}.md`);
  const createdAt = nowIso();

  let bodyContent = '';
  if (options.body !== undefined) {
    bodyContent = options.body;
  } else if (options.bodyFile !== undefined) {
    try {
      bodyContent = fs.readFileSync(path.resolve(options.bodyFile), 'utf-8');
    } catch (err) {
      console.error(`patch-ticket: failed to read body file ${options.bodyFile}:`, err);
      process.exit(1);
    }
  }

  const childFrontmatter: Record<string, unknown> = {
    id: childId,
    title: options.title,
    status: options.status || 'Todo',
    priority: options.priority || 'None',
    effort: options.effort || 'None',
    assignee: 'unassigned',
    tags: [],
    createdBy: 'Agent',
    updatedBy: 'Agent',
    history: [
      { type: 'activity', user: 'Agent', date: createdAt, comment: `Created as subtask of ${parentId}.` },
    ],
  };

  const childContent = matter.stringify(bodyContent, childFrontmatter);
  fs.writeFileSync(childPath, childContent, 'utf-8');

  // Link child to parent's subtasks array
  const parentRaw = fs.readFileSync(parentPath, 'utf-8');
  const parentParsed = matter(parentRaw);
  const subtasks: string[] = Array.isArray(parentParsed.data.subtasks)
    ? parentParsed.data.subtasks.map((s: any) => typeof s === 'string' ? s : s.id).filter(Boolean)
    : [];
  subtasks.push(childId);
  parentParsed.data.subtasks = subtasks;
  parentParsed.data.updatedBy = 'Agent';
  const parentContent = matter.stringify(parentParsed.content, parentParsed.data);
  fs.writeFileSync(parentPath, parentContent, 'utf-8');

  console.log(`Created subtask ${childId} under ${parentId}`);
  process.exit(0);
}

// ── Main ──────────────────────────────────────────────────────────────────────

const opts = parseArgs(process.argv);

// Handle --add-subtask mode
if (opts.addSubtask) {
  if (!opts.title) {
    console.error('patch-ticket: --title is required when using --add-subtask');
    process.exit(1);
  }
  createSubtask(opts.addSubtask, opts.workspace, {
    title: opts.title,
    status: opts.status,
    priority: opts.priority,
    effort: opts.effort,
    body: opts.body,
    bodyFile: opts.bodyFile,
  });
}

const fluxSubdir = fs.existsSync(path.join(opts.workspace, '.flux-store')) ? '.flux-store' : '.flux';
const ticketPath = path.resolve(opts.workspace, fluxSubdir, `${opts.id}.md`);

if (!fs.existsSync(ticketPath)) {
  console.error(`patch-ticket: ticket file not found: ${ticketPath}`);
  process.exit(1);
}

// Resolve configured status names so we can enforce comment guards.
function loadConfiguredStatuses(workspace: string): { requireInputStatus: string; readyStatus: string } {
  try {
    const configPath = path.resolve(workspace, fluxSubdir, 'config.json');
    const cfg = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    return {
      requireInputStatus: cfg.requireInputStatus || 'Require Input',
      readyStatus: cfg.readyForMergeStatus || 'Ready',
    };
  } catch {
    return { requireInputStatus: 'Require Input', readyStatus: 'Ready' };
  }
}
const { requireInputStatus, readyStatus } = loadConfiguredStatuses(opts.workspace);

let raw: string;
try {
  raw = fs.readFileSync(ticketPath, 'utf-8');
} catch (err) {
  console.error(`patch-ticket: failed to read ${ticketPath}:`, err);
  process.exit(1);
}

let parsed: matter.GrayMatterFile<string>;
try {
  parsed = matter(raw);
} catch (err) {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`patch-ticket: YAML parse error in ${ticketPath}: ${msg}`);
  process.exit(1);
}

const fm = parsed.data as Record<string, unknown>;
const history: unknown[] = Array.isArray(fm['history']) ? (fm['history'] as unknown[]) : [];

// Guard: transitioning to Require Input without a --comment is a workflow violation.
if (opts.status === requireInputStatus && String(fm['status'] ?? '') !== requireInputStatus && opts.comment === undefined) {
  console.error(`patch-ticket: --comment is required when transitioning to "${requireInputStatus}". Include the question in the same command.`);
  process.exit(1);
}

// Guard: transitioning to Ready without a --comment is a workflow violation.
if (opts.status === readyStatus && String(fm['status'] ?? '') !== readyStatus && opts.comment === undefined) {
  console.error(`patch-ticket: --comment is required when transitioning to "${readyStatus}". Include the completion summary in the same command.`);
  process.exit(1);
}

// Apply field mutations
if (opts.status !== undefined) {
  const prev = String(fm['status'] ?? '');
  if (prev !== opts.status) {
    appendStatusChange(history, prev, opts.status);
  }
  fm['status'] = opts.status;
}

if (opts.assignee !== undefined) fm['assignee'] = opts.assignee;
if (opts.priority !== undefined) fm['priority'] = opts.priority;
if (opts.effort !== undefined) fm['effort'] = opts.effort;

if (opts.comment !== undefined) {
  appendComment(history, opts.comment);
}

fm['history'] = history;
fm['updatedBy'] = 'Agent';

// Resolve the new body content (inline flag takes precedence over file)
let nextBody = parsed.content;
if (opts.body !== undefined) {
  nextBody = opts.body;
} else if (opts.bodyFile !== undefined) {
  try {
    nextBody = fs.readFileSync(path.resolve(opts.bodyFile), 'utf-8');
  } catch (err) {
    console.error(`patch-ticket: failed to read body file ${opts.bodyFile}:`, err);
    process.exit(1);
  }
}

try {
  const output = matter.stringify(nextBody, fm);
  fs.writeFileSync(ticketPath, output, 'utf-8');
  console.log(`Updated ${opts.id}`);
} catch (err) {
  console.error(`patch-ticket: failed to write ${ticketPath}:`, err);
  process.exit(1);
}
