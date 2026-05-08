#!/usr/bin/env node
/**
 * Event Horizon — init command
 * Bootstraps a .flux/ workspace in a target directory.
 *
 * Usage:
 *   npx event-horizon init [--target <path>] [--key <PROJECT_KEY>] [--force]
 *   npm run init -w engine -- [--target <path>] [--key <PROJECT_KEY>] [--force]
 */

import fs from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import readline from 'readline';

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

function parseArgs() {
  const args = process.argv.slice(2);

  const get = (flag: string) => {
    const i = args.indexOf(flag);
    return i !== -1 && args[i + 1] ? args[i + 1] : null;
  };

  return {
    target: get('--target') ? path.resolve(get('--target')!) : process.cwd(),
    key: get('--key'),
    force: args.includes('--force'),
  };
}

// ---------------------------------------------------------------------------
// Interactive prompt helpers
// ---------------------------------------------------------------------------

async function prompt(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

function validateProjectKey(raw: string): string | null {
  const normalized = raw.trim().toUpperCase().replace(/[^A-Z0-9_-]/g, '');
  return normalized.length > 0 ? normalized : null;
}

// ---------------------------------------------------------------------------
// Default config factory
// ---------------------------------------------------------------------------

function buildDefaultConfig(projectKey: string) {
  return {
    columns: [
      { name: 'Grooming' },
      {
        name: 'Todo',
        color: 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300',
      },
      {
        name: 'In Progress',
        color: 'bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-300',
      },
      { name: 'Require Input' },
      { name: 'Ready' },
      { name: 'Done' },
      {
        name: 'Archived',
        color: 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300',
      },
    ],
    hiddenStatuses: [
      { name: 'Backlog' },
      {
        name: 'Released',
        color: 'bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-300',
      },
    ],
    projects: [projectKey],
    users: [],
    tags: [],
    priorities: [
      { name: 'Critical', icon: 'AlertCircle', color: 'text-red-500' },
      { name: 'High', icon: 'ChevronUp', color: 'text-orange-500' },
      { name: 'Medium', icon: 'Equal', color: 'text-amber-500' },
      { name: 'Low', icon: 'ChevronDown', color: 'text-emerald-500' },
      { name: 'None', icon: 'Equal', color: 'text-gray-400' },
    ],
    enableBacklogScreen: true,
    requireInputStatus: 'Require Input',
    readyForMergeStatus: 'Ready',
    archiveStatus: 'Archived',
    boardCardOpenMode: 'full',
    animationsEnabled: true,
    enableFireworks: true,
  };
}

// ---------------------------------------------------------------------------
// Embedded EH docs helpers
// ---------------------------------------------------------------------------

// In pkg binary mode, __dirname is the snapshot root where we staged
// dist/.docs/event-horizon/. In dev/compiled mode, walk up from __dirname
// to the repo root.
function resolveEmbeddedDocsRoot(): string {
  const isPkg = (process as any).pkg !== undefined;
  if (isPkg) return __dirname;
  return path.resolve(__dirname, '..', '..');
}

async function copyDir(src: string, dest: string): Promise<void> {
  await fs.mkdir(dest, { recursive: true });
  const entries = await fs.readdir(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      await copyDir(srcPath, destPath);
    } else {
      await fs.copyFile(srcPath, destPath);
    }
  }
}

// ---------------------------------------------------------------------------
// Starter docs content
// ---------------------------------------------------------------------------

function buildStarterProjectOverview(projectKey: string) {
  return `---
title: Project Overview
order: 1
---

# Project Overview

This is your Event Horizon workspace for **${projectKey}**.

Edit this file to describe your project — what it does, its goals, and key decisions.

## Getting Started

- Create tickets on the **Board** view.
- Use the **Grooming** column to plan work before it is ready to implement.
- See the **Backlog** for tickets that are not yet prioritised.
`;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const opts = parseArgs();
  const { target, force } = opts;

  const fluxDir = path.join(target, '.flux');
  const assetsDir = path.join(fluxDir, 'assets');
  const configFile = path.join(fluxDir, 'config.json');
  const docsDir = path.join(target, '.docs');
  const overviewFile = path.join(docsDir, 'project-overview.md');

  console.log(`\nEvent Horizon — workspace init`);
  console.log(`Target: ${target}\n`);

  // Check for existing installation
  try {
    await fs.access(configFile);
    if (!force) {
      console.log(`.flux/config.json already exists at ${target}`);
      console.log('Nothing was changed. Use --force to re-scaffold.\n');
      process.exit(0);
    }
    console.log('--force flag set — re-scaffolding existing workspace.\n');
  } catch {
    // config doesn't exist yet, proceed normally
  }

  // Resolve project key
  let projectKey = opts.key ? validateProjectKey(opts.key) : null;
  if (!projectKey) {
    const raw = await prompt('Project key (e.g. MYAPP, CORE) [default: PROJECT]: ');
    projectKey = validateProjectKey(raw) || 'PROJECT';
  }

  console.log(`\nUsing project key: ${projectKey}`);

  // Scaffold directories
  await fs.mkdir(fluxDir, { recursive: true });
  await fs.mkdir(assetsDir, { recursive: true });

  // Write config (always overwrite when --force, create when missing)
  const config = buildDefaultConfig(projectKey);
  await fs.writeFile(configFile, JSON.stringify(config, null, 2), 'utf-8');
  console.log('Created .flux/config.json');

  // Scaffold .docs/ if it doesn't exist
  let docsCreated = false;
  try {
    await fs.access(docsDir);
  } catch {
    await fs.mkdir(docsDir, { recursive: true });
    await fs.writeFile(overviewFile, buildStarterProjectOverview(projectKey), 'utf-8');
    console.log('Created .docs/project-overview.md');
    docsCreated = true;
  }

  if (!docsCreated) {
    console.log('.docs/ directory already exists — skipped.');
  }

  // Copy embedded EH docs (how-to guides, workflow, architecture) into .docs/event-horizon/
  // so they appear in the Docs screen of the portal.
  const ehDocsSrc = path.join(resolveEmbeddedDocsRoot(), '.docs', 'event-horizon');
  const ehDocsDest = path.join(docsDir, 'event-horizon');
  if (existsSync(ehDocsSrc) && !existsSync(ehDocsDest)) {
    try {
      await copyDir(ehDocsSrc, ehDocsDest);
      console.log('Created .docs/event-horizon/ (Event Horizon usage guides)');
    } catch {
      // Non-fatal — docs are helpful but not required to run.
    }
  }

  // Post-init guidance
  console.log(`
✓ Event Horizon workspace created!

Next steps:
  1. Start the engine:
       cd path/to/event-horizon/engine
       npm run dev

  2. Open the portal in your browser:
       http://localhost:3001

  3. Create your first ticket using the "+ New ticket" button on the board.

  4. To use the AI agent workflow, go to Settings → Agent Workflow → Install.

Workspace location: ${target}
`);
}

main().catch((err) => {
  console.error('Init failed:', err.message || err);
  process.exit(1);
});
