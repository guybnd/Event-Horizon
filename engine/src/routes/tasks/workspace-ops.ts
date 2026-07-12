// Workspace-level operations mounted under /api/tasks (FLUX-349 split): open the workspace (or a
// worktree checkout) in the editor, and commit selected files from the board's uncommitted panel.
// Both resolve a `ref` (branch name or 'main') to the checkout that holds it.
import express from 'express';
import path from 'path';
import { getWorkspaceRoot } from '../../workspace.js';
import { getWorkspace } from '../../workspace-context.js';
import { findWorktreeForBranch } from '../../task-worktree.js';
import { isEditorAvailable, openEditorWindow, openEditorFile, isShellSafePath } from '../../editor-launcher.js';
import { getBlockingSessionsForRef } from '../../session-store.js';
import { discardUncommittedFiles } from '../../workspace-discard.js';
import { git, gitErrorDetail } from './helpers.js';

const router = express.Router();

// Open the active workspace root in a new VS Code window (FLUX-544). Best-effort:
// `opened` is false when the `code` CLI isn't on PATH (the portal surfaces that).
router.post('/open-editor', async (req, res) => {
  const workspaceRoot = getWorkspaceRoot();
  if (!workspaceRoot) return res.json({ opened: false });
  const available = await isEditorAvailable();
  if (!available) return res.json({ opened: false });
  const file = typeof req.body?.file === 'string' ? req.body.file.trim() : '';
  const ref = typeof req.body?.ref === 'string' ? req.body.ref.trim() : '';
  if (file) {
    // Repo-relative only — reject absolute / traversal paths before joining.
    if (file.startsWith('/') || file.includes('..') || /^[a-zA-Z]:/.test(file)) {
      return res.status(400).json({ error: 'Invalid path' });
    }
    // FLUX-789: reject shell metacharacters — `file` flows into a shell:true spawn.
    if (!isShellSafePath(file)) {
      return res.status(400).json({ error: 'Invalid path' });
    }
    // A worktree ref (branch) opens the file in that worktree's checkout;
    // 'main'/empty opens it in the engine workspace root.
    let root: string = workspaceRoot;
    if (ref && ref !== 'main') {
      const wt = await findWorktreeForBranch(workspaceRoot, ref).catch(() => null);
      if (wt) root = wt;
    }
    openEditorFile(path.join(root, file));
  } else {
    openEditorWindow(workspaceRoot);
  }
  res.json({ opened: true });
});

// Commit selected uncommitted files from the board panel (FLUX-554). Commit-ONLY —
// never pushes. Pathspec-scoped so only the listed files are committed even if the
// index held other staged changes. `ref` picks the checkout: 'main'/omitted →
// workspace root; a branch → that branch's worktree.
router.post('/commit', async (req, res) => {
  const workspaceRoot = getWorkspaceRoot();
  if (!workspaceRoot) return res.status(400).json({ error: 'No active workspace' });
  const ref = typeof req.body?.ref === 'string' ? req.body.ref.trim() : 'main';
  const message = typeof req.body?.message === 'string' ? req.body.message.trim() : '';
  const files: string[] = Array.isArray(req.body?.files)
    ? req.body.files.filter((f: unknown): f is string => typeof f === 'string' && f.trim().length > 0).map((f: string) => f.trim())
    : [];
  if (!message) return res.status(400).json({ error: 'Commit message is required' });
  if (files.length === 0) return res.status(400).json({ error: 'No files selected' });
  for (const f of files) {
    if (f.startsWith('/') || f.includes('..') || /^[a-zA-Z]:/.test(f)) {
      return res.status(400).json({ error: `Invalid path: ${f}` });
    }
  }
  let root: string = workspaceRoot;
  if (ref && ref !== 'main') {
    const wt = await findWorktreeForBranch(workspaceRoot, ref).catch(() => null);
    if (wt) root = wt;
  }
  try {
    // Stage the selected paths (covers untracked + deletions), then commit only them.
    await git(root, ['add', '--', ...files]);
    await git(root, ['commit', '-m', message, '--', ...files]);
    const { stdout } = await git(root, ['rev-parse', '--short', 'HEAD']);
    res.json({ hash: stdout.trim() });
  } catch (err: unknown) {
    res.status(500).json({ error: gitErrorDetail(err, 'Commit failed') });
  }
});

// Discard selected files' UNCOMMITTED changes (FLUX-1333) — the destructive sibling of /commit:
// restores each file to its checkout's HEAD state (per-state git semantics live in
// workspace-discard.ts). Same `ref` addressing as /commit, but deliberately TIGHTER: an
// unresolvable worktree refuses (404) instead of silently falling back to the main tree — the
// worst failure mode here is reverting files in the wrong checkout. Also refuses (409) while an
// agent session is actively executing in the target tree, so a discard can never race an
// in-flight write. Responds with per-file results (one failed file never aborts the rest).
router.post('/discard', async (req, res) => {
  const workspaceRoot = getWorkspaceRoot();
  if (!workspaceRoot) return res.status(400).json({ error: 'No active workspace' });
  const ref = typeof req.body?.ref === 'string' && req.body.ref.trim() ? req.body.ref.trim() : 'main';
  const files: string[] = Array.isArray(req.body?.files)
    ? req.body.files.filter((f: unknown): f is string => typeof f === 'string' && f.trim().length > 0).map((f: string) => f.trim())
    : [];
  if (files.length === 0) return res.status(400).json({ error: 'No files selected' });
  for (const f of files) {
    if (f.startsWith('/') || f.includes('..') || /^[a-zA-Z]:/.test(f)) {
      return res.status(400).json({ error: `Invalid path: ${f}` });
    }
  }
  let root: string = workspaceRoot;
  if (ref !== 'main') {
    const wt = await findWorktreeForBranch(workspaceRoot, ref).catch(() => null);
    if (!wt) return res.status(404).json({ error: `No worktree holds branch "${ref}" — refusing to discard in a guessed checkout` });
    root = wt;
  }
  const tasks = Object.values(getWorkspace().tasks) as Array<{ id: string; branch?: string | null }>;
  if (getBlockingSessionsForRef(ref, root, tasks).length > 0) {
    return res.status(409).json({ error: 'An agent session is actively working in this checkout — wait for it to finish before discarding changes.' });
  }
  try {
    const results = await discardUncommittedFiles(root, files);
    res.json({ results });
  } catch (err: unknown) {
    res.status(500).json({ error: gitErrorDetail(err, 'Discard failed') });
  }
});

export default router;
