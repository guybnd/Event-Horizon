import fs from 'fs/promises';
import path from 'path';

export function resolveEmbeddedDocsRoot(): string {
  const isPkg = (process as any).pkg !== undefined;
  if (isPkg) return __dirname;
  return path.resolve(__dirname, '..', '..');
}

export async function copyDir(src: string, dest: string): Promise<void> {
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

export function buildStarterProjectOverview(projectKey: string): string {
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
