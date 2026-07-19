// Shared helpers for the routes/tasks/* concern files (FLUX-349 split — one file per concern,
// mounted by the ../tasks.ts barrel).

// FLUX-999 (epic FLUX-996): every git call in these route files used to be a bare execFileAsync —
// no timeout, no non-interactive env — so e.g. `git fetch`/`git push` in the update-branch route
// could hang that request forever on a slow/unreachable remote. Route through the S1
// runner via this tiny local wrapper (mirrors pr-cleanup.ts's `git(cwd, args)` helper).
import type express from 'express';
import { getWorkspace, type Workspace } from '../../workspace-context.js';
import { runGit } from '../../git-exec.js';

/**
 * FLUX-1448 (epic FLUX-1230 S2/S3 boundary): the workspace a route reads/writes — `req.workspace`
 * (attached globally by `attachWorkspace`, FLUX-343) when present, else the registry default. The
 * fallback isn't just defensive: `attachWorkspace` is mounted once in `index.ts`'s real app, but a
 * route test's minimal Express app frequently skips it, and this keeps those tests exercising the
 * real handler instead of every one of them needing to reconstruct the full middleware stack.
 * Byte-for-byte the same value as `req.workspace!` on any request that actually went through
 * `attachWorkspace` (i.e. always, in production).
 */
export function reqWorkspace(req: express.Request): Workspace {
  return req.workspace ?? getWorkspace();
}

export function git(cwd: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return runGit(args, { cwd });
}

// ─── Local types (lint burndown, FLUX-1073) ──────────────────────────────────
// Ticket frontmatter has no canonical compile-time type in this codebase — it's validated at
// RUNTIME by schema.ts (validateTicketFrontmatter), and `tasksCache` itself is declared
// `Record<string, any>` in task-store.ts. This interface names only the fields the tasks/*
// route files actually read/write; every other frontmatter field still flows through via the
// index signature rather than being invented here.
export interface TaskRecord {
  id: string;
  _path: string;
  title?: string;
  status?: string;
  body?: string;
  branch?: string | null;
  baselineCommit?: string | null;
  implementationLink?: string | null;
  kind?: string;
  prNumber?: number;
  prState?: string;
  members?: string[];
  tags?: string[];
  priority?: string;
  updatedBy?: string;
  [key: string]: unknown;
}

// Shape of one `history[]` entry as branched on by the PUT /:id handler (update.ts). history.ts's
// own helpers (normalizeHistoryEntries, buildActivityEntry, …) take/return bare `any[]` — there is
// no shared HistoryEntry type to import — so this names only the fields these routes read; comment
// bodies, agent_session fields, etc. still pass through via the index signature.
export interface HistoryEntry {
  type?: string;
  from?: string;
  to?: string;
  comment?: string;
  user?: string;
  date?: string;
  swimlane?: string;
  action?: string;
  [key: string]: unknown;
}

// git-exec.ts's runGit() attaches stdout/stderr to a plain Error on subprocess failure (no
// exported type for it — branch-manager.ts:239 does the same local cast). Named here for the
// several catch blocks that need `.stderr` for a richer error message than `.message` alone.
export type GitExecError = Error & { stdout?: string; stderr?: string; code?: number | null };

export function errorMessage(err: unknown, fallback = 'Unexpected error'): string {
  return err instanceof Error && err.message ? err.message : fallback;
}

export function gitErrorDetail(err: unknown, fallback: string): string {
  const e = err as GitExecError;
  return (e?.stderr || e?.message || fallback).toString().trim();
}
