import { getWorkspace, type Workspace } from '../workspace-context.js';
import express from 'express';
import fs from 'fs/promises';
import path from 'path';
import matter from 'gray-matter';
import { getWorkspaceRoot } from '../workspace.js';
import { runGit } from '../git-exec.js';
import { getConfig, isDocsCommitOnSaveEnabled } from '../config.js';
import {
  normalizeDocPathInput, getDocFilePath, normalizeRelativePath,
  serializeDoc, sortDocs, writeDocFile, removeEmptyDocDirectories,
  parseDocOrder, titleFromDocPath, buildDocMarkdown, slugifyDocValue,
  type DocRecord,
} from '../file-utils.js';
import { loadDoc, loadGroupDoc } from '../task-store.js';
import {
  getGroupContext,
  groupDocPathToStoreRelative,
  groupDocsLabel,
  type GroupContext,
} from '../group.js';
import { submitGroupEdit } from '../group-edit.js';

const router = express.Router();

// Trust model (FLUX-418): Event Horizon is local-first — a single user driving
// the engine on localhost. The doc routes below intentionally enforce NO
// server-side edit authorization. `config.docsEditPermissions` / `docsAllowedUsers`
// are a *portal-side UX gate* (DocsScreen `canEditDocs`), not a security boundary:
// a direct POST/PUT/DELETE to /api/docs bypasses that gate by design. The 403s
// here are group-writer-resolution failures (no writable group context), NOT
// authorization checks. This is acceptable-by-design for the single-user-on-
// localhost deployment. If EH is ever exposed beyond localhost this becomes a
// real gap to close — group doc writes fan out to every member repo — by
// resolving the acting user and gating POST/PUT/DELETE at the top of each handler.

// All doc path routes strip leading slash from req.path to get the doc path segment
function docPathFromReq(req: express.Request) {
  const raw = req.path.replace(/^\//, '');
  return normalizeDocPathInput(decodeURIComponent(raw));
}

/**
 * FLUX-1448 (epic FLUX-1230 S2/S3 boundary): the workspace a route reads/writes — `req.workspace`
 * (attached globally by `attachWorkspace`, FLUX-343) when present, else the registry default.
 * Mirrors `routes/tasks/helpers.ts`'s `reqWorkspace` (kept local here rather than imported — this
 * file isn't part of the `routes/tasks/*` concern split). The fallback also means a route test's
 * minimal Express app (skipping the full `attachWorkspace` middleware) keeps exercising the real
 * handler instead of every test needing to reconstruct the full middleware stack.
 */
function reqWorkspace(req: express.Request): Workspace {
  return req.workspace ?? getWorkspace();
}

/**
 * Human-readable reason a group doc can't be edited from the current
 * workspace. With FLUX-414 the parent edits its own group docs inline, so this
 * only fires for a workspace that surfaces a group doc but owns no writer
 * (neither parent context nor a member binding) — effectively unreachable.
 */
function groupReadOnlyMessage(): string {
  return `This is a read-only cross-project group doc. Open the owning group's parent workspace to edit it.`;
}

/**
 * The group context that owns this workspace's surfaced group docs: the parent's
 * own context, or a bound member's parent group. `submitGroupEdit` writes into
 * this context's canonical store, commits, and fans out — so both the parent
 * (editing in place) and a member (push-through-parent) use the same path.
 *
 * FLUX-1565: reads `ws`'s own `groupContext`/`memberBinding` fields (populated
 * per-workspace in `hydrateWorkspace`) instead of the `getGroupContext()`/
 * `getMemberBinding()` singletons — those reflect whichever workspace activated
 * last, not necessarily the one this request is bound to.
 */
function groupWriterContext(ws: Workspace): GroupContext | null {
  return ws.groupContext ?? ws.memberBinding?.parentGroup ?? null;
}

/** The `docsLabel` group docs surface under for `ws`'s bound group, if any. */
function docsLabelFor(ws: Workspace): string {
  return groupDocsLabel(groupWriterContext(ws));
}

/**
 * Resolve the absolute file path of a `Product/...` doc inside the bound
 * parent's canonical store, given its store-relative path.
 */
function parentStorePath(storeDir: string, storeRel: string): string {
  return path.join(storeDir, ...storeRel.split('/'));
}

router.get('/', (req, res) => {
  res.json(sortDocs(Object.values(getWorkspace().docs).map(serializeDoc)));
});

router.post('/', async (req, res) => {
  const docPath = normalizeDocPathInput(req.body?.path);

  if (!docPath) return res.status(400).json({ error: 'Invalid doc path' });
  if (docPath.split('/')[0] === docsLabelFor(reqWorkspace(req))) {
    // Group doc: route the create to the canonical store writer — the parent's
    // own context, or a bound member's parent (Case 1). Both commit + fan out.
    const writer = groupWriterContext(reqWorkspace(req));
    const storeRel = writer ? groupDocPathToStoreRelative(docPath, docsLabelFor(reqWorkspace(req))) : null;
    if (writer && storeRel) {
      if (reqWorkspace(req).docs[docPath]) return res.status(409).json({ error: 'Doc already exists' });
      const title = typeof req.body?.title === 'string' && req.body.title.trim()
        ? req.body.title.trim()
        : titleFromDocPath(docPath);
      const order = parseDocOrder(req.body?.order);
      const body = typeof req.body?.body === 'string' ? req.body.body.replace(/\r\n/g, '\n') : '';
      try {
        const storeDir = writer.groupStoreDir;
        await submitGroupEdit(writer, [{ path: storeRel, content: buildDocMarkdown(title, order, body) }]);
        await loadGroupDoc(storeDir, parentStorePath(storeDir, storeRel), req.workspace);
        const created = reqWorkspace(req).docs[docPath];
        return res.status(201).json(created ? serializeDoc(created) : { success: true });
      } catch (error) {
        console.error(`Failed to write new group doc ${docPath}:`, error);
        const message = error instanceof Error ? error.message : String(error);
        return res.status(500).json({ error: `Failed to write the new group doc: ${message}` });
      }
    }
    return res.status(403).json({ error: groupReadOnlyMessage() });
  }
  if (reqWorkspace(req).docs[docPath]) return res.status(409).json({ error: 'Doc already exists' });

  const title = typeof req.body?.title === 'string' && req.body.title.trim()
    ? req.body.title.trim()
    : titleFromDocPath(docPath);
  const order = parseDocOrder(req.body?.order);
  const body = typeof req.body?.body === 'string' ? req.body.body.replace(/\r\n/g, '\n') : '';
  const filePath = getDocFilePath(docPath);

  try {
    await writeDocFile(filePath, title, order, body);
    await loadDoc(filePath, req.workspace);

    const createdDoc = reqWorkspace(req).docs[docPath];
    if (!createdDoc) throw new Error('Doc was not loaded after creation');

    res.status(201).json(serializeDoc(createdDoc));
  } catch (error) {
    console.error('Failed to create doc:', error);
    res.status(500).json({ error: 'Failed to create doc' });
  }
});

// ─── Git-backed revision history (FLUX-1653) ───────────────────────────────────
//
// Git already stores every version of a doc as a commit — these routes surface it read-only
// rather than building a parallel versioning system. Registered BEFORE the catch-all GET/PUT
// below so `/foo/bar/revisions...` doesn't get swallowed by the generic doc-path matcher.
// Group docs (surfaced under the synthetic docsLabel prefix) live in a different repo's canonical
// store, so their history isn't resolvable from this workspace's git — they degrade gracefully to
// an empty revision list / 404, matching the "non-git workspace" degrade path.

const REVISION_SEP = '\x1f';
const RECORD_SEP = '\x1e';
const MAX_REVISIONS = 500;
const DEFAULT_REVISION_LIMIT = 100;

function isGroupDocPath(docPath: string, ws: Workspace): boolean {
  return docPath.split('/')[0] === docsLabelFor(ws);
}

/** The doc file's path relative to the workspace root, for `git -C <workspaceRoot> ... -- <relFile>`. */
function relativeDocFilePath(workspaceRoot: string, docPath: string): string {
  return normalizeRelativePath(path.relative(workspaceRoot, getDocFilePath(docPath)));
}

/**
 * `--author=<name> <email>` for a save-as-revision commit (FLUX-1655), given only the portal's
 * display name (there is no email in a local-first, single-user setup). A commit still needs a
 * *committer* even with `--author` set, so an empty name here just omits the flag and falls back
 * to the repo's own configured git identity (see the PUT handler's commit try/catch).
 */
function gitAuthorArg(author: string): string[] {
  const trimmed = author.trim();
  if (!trimmed) return [];
  const emailLocal = trimmed.toLowerCase().replace(/[^a-z0-9]+/g, '.').replace(/^\.+|\.+$/g, '') || 'user';
  return [`--author=${trimmed} <${emailLocal}@users.noreply.eventhorizon.local>`];
}

// FLUX-1672: common non-ticket tokens that otherwise match the generic ticket-key shape below
// (PREFIX-NUMBER) — a bare denylist keeps `UTF-8`/`SHA-1`/`ISO-8601`/`CVE-2021`/`RFC-2822` style
// subjects from producing a spurious ticket badge when no real key is present.
const TICKET_KEY_DENYLIST = new Set(['UTF', 'SHA', 'ISO', 'CVE', 'RFC']);

/**
 * Parses a ticket key (e.g. `FLUX-123`, `ANZUBRAI-26`) out of a commit subject, for the byline
 * (DocsScreen) and history-panel badges. Shared by both surfaces since it lives on the revision
 * record itself (see the `.map` below). Prefers a key from a *known* project — this board's
 * `getConfig().projects` unioned with any configured multi-repo group's member keys — so an
 * on-board key always wins; falls back to the generic `PREFIX-NUMBER` shape (screened by the
 * denylist above) for a key from a project this workspace doesn't otherwise know about, which
 * covers cross-repo commit subjects like the anzu-brain repo's `ANZUBRAI-…`.
 */
export function parseTicketKeyFromSubject(subject: string): string | null {
  if (!subject) return null;

  const config = getConfig();
  const configProjects: string[] = Array.isArray(config?.projects)
    ? config.projects.filter((p: unknown): p is string => typeof p === 'string' && p.trim().length > 0)
    : [];
  const groupMemberKeys = getGroupContext()?.members.map((member) => member.name) ?? [];
  const knownPrefixes = [...new Set([...configProjects, ...groupMemberKeys].map((key) => key.toUpperCase()))];

  for (const prefix of knownPrefixes) {
    const match = subject.match(new RegExp(`\\b${prefix}-\\d+\\b`, 'i'));
    if (match) return match[0].toUpperCase();
  }

  const generic = subject.match(/\b([A-Z][A-Z0-9]+)-\d+\b/);
  if (generic && !TICKET_KEY_DENYLIST.has(generic[1] ?? '')) {
    return generic[0];
  }

  return null;
}

router.get(/^\/(.+)\/revisions$/, async (req, res) => {
  const docPath = normalizeDocPathInput(decodeURIComponent(String(req.params[0] ?? '')));
  if (!docPath) return res.status(400).json({ error: 'Invalid doc path' });
  if (isGroupDocPath(docPath, reqWorkspace(req))) return res.json({ revisions: [] });

  const workspaceRoot = getWorkspaceRoot();
  if (!workspaceRoot) return res.json({ revisions: [] });

  const relFile = relativeDocFilePath(workspaceRoot, docPath);
  const requestedLimit = parseInt(String(req.query.limit ?? ''), 10);
  const limit = Number.isFinite(requestedLimit) && requestedLimit > 0
    ? Math.min(requestedLimit, MAX_REVISIONS)
    : DEFAULT_REVISION_LIMIT;

  try {
    const { stdout } = await runGit(
      ['log', '--follow', `--format=%H${REVISION_SEP}%an${REVISION_SEP}%aI${REVISION_SEP}%s${RECORD_SEP}`, '-n', String(limit), '--', relFile],
      { cwd: workspaceRoot },
    );
    const revisions = stdout.split(RECORD_SEP).map((record) => record.trim()).filter(Boolean).map((record) => {
      const [hash, author, date, message] = record.split(REVISION_SEP);
      return {
        hash: hash ?? '',
        author: author ?? '',
        date: date ?? '',
        message: message ?? '',
        ticketId: parseTicketKeyFromSubject(message ?? ''),
      };
    });
    res.json({ revisions });
  } catch {
    // Not a git repo, or the file has no history (untracked) — degrade gracefully, never 500.
    res.json({ revisions: [] });
  }
});

router.get(/^\/(.+)\/revisions\/([0-9a-fA-F]+)$/, async (req, res) => {
  const docPath = normalizeDocPathInput(decodeURIComponent(String(req.params[0] ?? '')));
  const hash = String(req.params[1] ?? '');
  if (!docPath) return res.status(400).json({ error: 'Invalid doc path' });
  if (isGroupDocPath(docPath, reqWorkspace(req))) return res.status(404).json({ error: 'Revision history is not available for group docs' });

  const workspaceRoot = getWorkspaceRoot();
  if (!workspaceRoot) return res.status(404).json({ error: 'No active workspace' });
  const relFile = relativeDocFilePath(workspaceRoot, docPath);

  try {
    const { stdout } = await runGit(['show', `${hash}:${relFile}`], { cwd: workspaceRoot });
    const parsed = matter(stdout);
    const title = typeof parsed.data.title === 'string' && parsed.data.title.trim()
      ? parsed.data.title.trim()
      : titleFromDocPath(docPath);
    const order = parseDocOrder(parsed.data.order);
    const directory = docPath.includes('/') ? docPath.slice(0, docPath.lastIndexOf('/')) : '';
    const slugSource = docPath.split('/').filter(Boolean).pop() || docPath;
    const { title: _title, order: _order, ...extraFrontmatter } = parsed.data;

    const record: DocRecord = {
      path: docPath,
      title,
      body: parsed.content.replace(/\r\n/g, '\n'),
      slug: slugifyDocValue(slugSource),
      directory,
      ...(order !== undefined ? { order } : {}),
      ...(Object.keys(extraFrontmatter).length ? { extraFrontmatter } : {}),
    };
    res.json(record);
  } catch {
    res.status(404).json({ error: 'Revision not found' });
  }
});

router.get(/^\/(.+)\/revisions\/([0-9a-fA-F]+)\/diff$/, async (req, res) => {
  const docPath = normalizeDocPathInput(decodeURIComponent(String(req.params[0] ?? '')));
  const hash = String(req.params[1] ?? '');
  if (!docPath) return res.status(400).json({ error: 'Invalid doc path' });
  if (isGroupDocPath(docPath, reqWorkspace(req))) return res.status(404).json({ error: 'Revision history is not available for group docs' });

  const workspaceRoot = getWorkspaceRoot();
  if (!workspaceRoot) return res.status(404).json({ error: 'No active workspace' });
  const relFile = relativeDocFilePath(workspaceRoot, docPath);

  try {
    // `git show <hash> -- <path>` handles the root commit fine (diffed against the empty tree).
    const { stdout } = await runGit(['show', hash, '--', relFile], { cwd: workspaceRoot });
    res.type('text/plain').send(stdout);
  } catch {
    res.status(404).json({ error: 'Revision diff not found' });
  }
});

router.get(/^\/.+$/, (req, res) => {
  const docPath = docPathFromReq(req);

  if (!docPath) return res.status(400).json({ error: 'Invalid doc path' });

  const doc = getWorkspace().docs[docPath];
  if (!doc) return res.status(404).json({ error: 'Doc not found' });

  res.json(serializeDoc(doc));
});

router.put(/^\/.+$/, async (req, res) => {
  const docPath = docPathFromReq(req);

  if (!docPath) return res.status(400).json({ error: 'Invalid doc path' });

  const existingDoc = reqWorkspace(req).docs[docPath];
  if (!existingDoc) return res.status(404).json({ error: 'Doc not found' });
  if (existingDoc.group) {
    // Group doc: route the edit to the canonical store writer — the parent edits
    // in place (FLUX-414); a bound member pushes through the parent (Case 1).
    const writer = groupWriterContext(reqWorkspace(req));
    const storeRel = writer ? groupDocPathToStoreRelative(docPath, docsLabelFor(reqWorkspace(req))) : null;
    if (writer && storeRel) {
      const title = typeof req.body?.title === 'string' && req.body.title.trim()
        ? req.body.title.trim()
        : existingDoc.title;
      const order = req.body?.order === null ? undefined : parseDocOrder(req.body?.order) ?? existingDoc.order;
      const body = typeof req.body?.body === 'string' ? req.body.body.replace(/\r\n/g, '\n') : existingDoc.body;
      try {
        const storeDir = writer.groupStoreDir;
        await submitGroupEdit(writer, [{ path: storeRel, content: buildDocMarkdown(title, order, body, existingDoc.extraFrontmatter) }]);
        await loadGroupDoc(storeDir, parentStorePath(storeDir, storeRel), req.workspace);
        const updated = reqWorkspace(req).docs[docPath];
        return res.json(updated ? serializeDoc(updated) : { success: true });
      } catch (error) {
        console.error(`Failed to write group edit for ${docPath}:`, error);
        const message = error instanceof Error ? error.message : String(error);
        return res.status(500).json({ error: `Failed to write the group doc edit: ${message}` });
      }
    }
    return res.status(403).json({ error: groupReadOnlyMessage() });
  }

  // FLUX-1655: optimistic-concurrency guard. `baseHash` is the hash of the markdown the portal
  // loaded (served on the GET response); the engine compares it against `existingDoc.hash`, kept
  // fresh by the docs file-watcher. A mismatch means the file changed on disk since the editor
  // opened it — reject before writing rather than silently clobbering that external edit. Only
  // enforced when the caller sends `baseHash` (today, only the save-as-revision flow does).
  const baseHash = typeof req.body?.baseHash === 'string' ? req.body.baseHash : '';
  if (baseHash && existingDoc.hash && baseHash !== existingDoc.hash) {
    return res.status(409).json({
      error: 'This doc changed on disk since you loaded it — reload to see the latest version before saving.',
      code: 'doc-conflict',
    });
  }

  const title = typeof req.body?.title === 'string' && req.body.title.trim()
    ? req.body.title.trim()
    : existingDoc.title;
  const order = req.body?.order === null ? undefined : parseDocOrder(req.body?.order) ?? existingDoc.order;
  const body = typeof req.body?.body === 'string' ? req.body.body.replace(/\r\n/g, '\n') : existingDoc.body;
  const revisionMessage = typeof req.body?.revisionMessage === 'string' ? req.body.revisionMessage.trim() : '';
  const author = typeof req.body?.author === 'string' ? req.body.author : '';

  try {
    await writeDocFile(existingDoc._path, title, order, body, existingDoc.extraFrontmatter);
    await loadDoc(existingDoc._path, req.workspace);

    const updatedDoc = reqWorkspace(req).docs[docPath];
    if (!updatedDoc) throw new Error('Doc was not loaded after update');

    // FLUX-1655: make the save a git commit — behind the flag, and only when the caller actually
    // sent a message (the portal only prompts, and thus only sends one, when the flag is on).
    // Scoped to this one file via a trailing pathspec so unrelated dirty working-tree changes are
    // never swept in. The file write above already succeeded, so a commit failure here must not
    // look like the edit was lost — it's reported as its own 5xx, distinct from the write failure
    // caught below.
    if (isDocsCommitOnSaveEnabled() && revisionMessage) {
      const workspaceRoot = getWorkspaceRoot();
      if (workspaceRoot) {
        const relFile = relativeDocFilePath(workspaceRoot, docPath);
        try {
          await runGit(['add', '--', relFile], { cwd: workspaceRoot });
          await runGit(['commit', ...gitAuthorArg(author), '-m', revisionMessage, '--', relFile], { cwd: workspaceRoot });
        } catch (commitError) {
          const message = commitError instanceof Error ? commitError.message : String(commitError);
          return res.status(500).json({ error: `Doc saved, but the git commit failed: ${message}` });
        }
      }
    }

    res.json(serializeDoc(updatedDoc));
  } catch (error) {
    console.error(`Failed to save doc ${docPath}:`, error);
    res.status(500).json({ error: 'Failed to save doc' });
  }
});

router.delete(/^\/.+$/, async (req, res) => {
  const docPath = docPathFromReq(req);

  if (!docPath) return res.status(400).json({ error: 'Invalid doc path' });

  const doc = reqWorkspace(req).docs[docPath];
  if (!doc) return res.status(404).json({ error: 'Doc not found' });
  if (doc.group) {
    // Group doc: route the delete to the canonical store writer — the parent
    // deletes in place (FLUX-414); a bound member pushes through the parent.
    const writer = groupWriterContext(reqWorkspace(req));
    const storeRel = writer ? groupDocPathToStoreRelative(docPath, docsLabelFor(reqWorkspace(req))) : null;
    if (writer && storeRel) {
      try {
        await submitGroupEdit(writer, [{ path: storeRel, delete: true }]);
        delete reqWorkspace(req).docs[docPath];
        return res.json({ success: true });
      } catch (error) {
        console.error(`Failed to write group delete for ${docPath}:`, error);
        const message = error instanceof Error ? error.message : String(error);
        return res.status(500).json({ error: `Failed to delete the group doc: ${message}` });
      }
    }
    return res.status(403).json({ error: groupReadOnlyMessage() });
  }

  try {
    await fs.unlink(doc._path);
    delete getWorkspace().docs[docPath];
    await removeEmptyDocDirectories(doc._path);
    res.json({ success: true });
  } catch (error) {
    console.error(`Failed to delete doc ${docPath}:`, error);
    res.status(500).json({ error: 'Failed to delete doc' });
  }
});

/**
 * Rename a docs folder by rewriting the path prefix of every local doc beneath
 * it (`from/...` → `to/...`). Group docs are excluded — the surfaced group tree
 * is virtual (its root is `docsLabel`), so renaming it is a `docsLabel` change
 * handled by `PATCH /api/group/docs-label`, not a file move. Refuses collisions
 * so an existing doc is never silently overwritten.
 */
router.post('/rename-folder', async (req, res) => {
  const from = normalizeDocPathInput(req.body?.from);
  const to = normalizeDocPathInput(req.body?.to);
  if (!from || !to) return res.status(400).json({ error: 'Both "from" and "to" must be valid folder paths' });
  if (from === to) return res.status(400).json({ error: 'New folder name is unchanged' });
  if (to === from + '/' || to.startsWith(from + '/')) {
    return res.status(400).json({ error: 'Cannot move a folder into itself' });
  }

  const groupLabel = docsLabelFor(reqWorkspace(req));
  const fromRoot = from.split('/')[0];
  const toRoot = to.split('/')[0];
  if (fromRoot === groupLabel || toRoot === groupLabel) {
    return res.status(400).json({
      error: `The ${groupLabel}/ tree is the shared group folder. Rename it from Settings (group docs label), not as a file move.`,
    });
  }

  // Collect every local doc at the folder or beneath it.
  const prefix = from + '/';
  const affected = Object.values(reqWorkspace(req).docs).filter(
    (doc) => !doc.group && (doc.path === from || doc.path.startsWith(prefix)),
  );
  if (affected.length === 0) {
    return res.status(404).json({ error: `No docs found under "${from}"` });
  }

  // Pre-flight: every destination path must be free (ignoring the docs we move).
  const movingPaths = new Set(affected.map((doc) => doc.path));
  for (const doc of affected) {
    const suffix = doc.path.slice(from.length); // '' or '/rest...'
    const targetPath = to + suffix;
    if (reqWorkspace(req).docs[targetPath] && !movingPaths.has(targetPath)) {
      return res.status(409).json({ error: `A doc already exists at "${targetPath}"` });
    }
  }

  try {
    const moved: { from: string; to: string }[] = [];
    for (const doc of affected) {
      const suffix = doc.path.slice(from.length);
      const targetPath = to + suffix;
      const targetFile = getDocFilePath(targetPath);
      await writeDocFile(targetFile, doc.title, doc.order, doc.body ?? '', doc.extraFrontmatter);
      await fs.unlink(doc._path);
      delete reqWorkspace(req).docs[doc.path];
      await removeEmptyDocDirectories(doc._path);
      await loadDoc(targetFile, req.workspace);
      moved.push({ from: doc.path, to: targetPath });
    }
    res.json({ success: true, moved });
  } catch (error) {
    console.error(`Failed to rename folder ${from} → ${to}:`, error);
    const message = error instanceof Error ? error.message : String(error);
    res.status(500).json({ error: `Failed to rename folder: ${message}` });
  }
});

export default router;
