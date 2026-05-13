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
 */

import fs from 'fs';
import path from 'path';
import matter from 'gray-matter';

// ── Arg parsing ──────────────────────────────────────────────────────────────

function parseArgs(argv: string[]) {
  const args = argv.slice(2);
  const id = args.find(a => !a.startsWith('--'));
  if (!id) {
    console.error('Usage: patch-ticket <id> [--status <value>] [--comment <text>] [--assignee <value>] [--priority <value>] [--effort <value>] [--body <text>] [--body-file <path>] [--workspace <path>]');
    process.exit(1);
  }

  function flag(name: string): string | undefined {
    const idx = args.indexOf(`--${name}`);
    return idx !== -1 ? args[idx + 1] : undefined;
  }

  return {
    id,
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

// ── Main ──────────────────────────────────────────────────────────────────────

const opts = parseArgs(process.argv);
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
