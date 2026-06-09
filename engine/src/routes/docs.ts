import express from 'express';
import fs from 'fs/promises';
import path from 'path';
import {
  normalizeDocPathInput, getDocFilePath,
  serializeDoc, sortDocs, writeDocFile, removeEmptyDocDirectories,
  parseDocOrder, titleFromDocPath, buildDocMarkdown,
} from '../file-utils.js';
import { docsCache, loadDoc, loadGroupDoc } from '../task-store.js';
import {
  activeGroupDocsLabel,
  getGroupContext,
  getMemberBinding,
  groupDocPathToStoreRelative,
  type GroupContext,
} from '../group.js';
import { submitGroupEdit } from '../group-edit.js';

const router = express.Router();

// All doc path routes strip leading slash from req.path to get the doc path segment
function docPathFromReq(req: express.Request) {
  const raw = req.path.replace(/^\//, '');
  return normalizeDocPathInput(decodeURIComponent(raw));
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
 */
function groupWriterContext(): GroupContext | null {
  return getGroupContext() ?? getMemberBinding()?.parentGroup ?? null;
}

/**
 * Resolve the absolute file path of a `Product/...` doc inside the bound
 * parent's canonical store, given its store-relative path.
 */
function parentStorePath(storeDir: string, storeRel: string): string {
  return path.join(storeDir, ...storeRel.split('/'));
}

router.get('/', (req, res) => {
  res.json(sortDocs(Object.values(docsCache).map(serializeDoc)));
});

router.post('/', async (req, res) => {
  const docPath = normalizeDocPathInput(req.body?.path);

  if (!docPath) return res.status(400).json({ error: 'Invalid doc path' });
  if (docPath.split('/')[0] === activeGroupDocsLabel()) {
    // Group doc: route the create to the canonical store writer — the parent's
    // own context, or a bound member's parent (Case 1). Both commit + fan out.
    const writer = groupWriterContext();
    const storeRel = writer ? groupDocPathToStoreRelative(docPath) : null;
    if (writer && storeRel) {
      if (docsCache[docPath]) return res.status(409).json({ error: 'Doc already exists' });
      const title = typeof req.body?.title === 'string' && req.body.title.trim()
        ? req.body.title.trim()
        : titleFromDocPath(docPath);
      const order = parseDocOrder(req.body?.order);
      const body = typeof req.body?.body === 'string' ? req.body.body.replace(/\r\n/g, '\n') : '';
      try {
        const storeDir = writer.groupStoreDir;
        await submitGroupEdit(writer, [{ path: storeRel, content: buildDocMarkdown(title, order, body) }]);
        await loadGroupDoc(storeDir, parentStorePath(storeDir, storeRel));
        const created = docsCache[docPath];
        return res.status(201).json(created ? serializeDoc(created) : { success: true });
      } catch (error: any) {
        console.error(`Failed to write new group doc ${docPath}:`, error);
        return res.status(500).json({ error: `Failed to write the new group doc: ${error.message}` });
      }
    }
    return res.status(403).json({ error: groupReadOnlyMessage() });
  }
  if (docsCache[docPath]) return res.status(409).json({ error: 'Doc already exists' });

  const title = typeof req.body?.title === 'string' && req.body.title.trim()
    ? req.body.title.trim()
    : titleFromDocPath(docPath);
  const order = parseDocOrder(req.body?.order);
  const body = typeof req.body?.body === 'string' ? req.body.body.replace(/\r\n/g, '\n') : '';
  const filePath = getDocFilePath(docPath);

  try {
    await writeDocFile(filePath, title, order, body);
    await loadDoc(filePath);

    const createdDoc = docsCache[docPath];
    if (!createdDoc) throw new Error('Doc was not loaded after creation');

    res.status(201).json(serializeDoc(createdDoc));
  } catch (error) {
    console.error('Failed to create doc:', error);
    res.status(500).json({ error: 'Failed to create doc' });
  }
});

router.get(/^\/.+$/, (req, res) => {
  const docPath = docPathFromReq(req);

  if (!docPath) return res.status(400).json({ error: 'Invalid doc path' });

  const doc = docsCache[docPath];
  if (!doc) return res.status(404).json({ error: 'Doc not found' });

  res.json(serializeDoc(doc));
});

router.put(/^\/.+$/, async (req, res) => {
  const docPath = docPathFromReq(req);

  if (!docPath) return res.status(400).json({ error: 'Invalid doc path' });

  const existingDoc = docsCache[docPath];
  if (!existingDoc) return res.status(404).json({ error: 'Doc not found' });
  if (existingDoc.group) {
    // Group doc: route the edit to the canonical store writer — the parent edits
    // in place (FLUX-414); a bound member pushes through the parent (Case 1).
    const writer = groupWriterContext();
    const storeRel = writer ? groupDocPathToStoreRelative(docPath) : null;
    if (writer && storeRel) {
      const title = typeof req.body?.title === 'string' && req.body.title.trim()
        ? req.body.title.trim()
        : existingDoc.title;
      const order = req.body?.order === null ? undefined : parseDocOrder(req.body?.order) ?? existingDoc.order;
      const body = typeof req.body?.body === 'string' ? req.body.body.replace(/\r\n/g, '\n') : existingDoc.body;
      try {
        const storeDir = writer.groupStoreDir;
        await submitGroupEdit(writer, [{ path: storeRel, content: buildDocMarkdown(title, order, body) }]);
        await loadGroupDoc(storeDir, parentStorePath(storeDir, storeRel));
        const updated = docsCache[docPath];
        return res.json(updated ? serializeDoc(updated) : { success: true });
      } catch (error: any) {
        console.error(`Failed to write group edit for ${docPath}:`, error);
        return res.status(500).json({ error: `Failed to write the group doc edit: ${error.message}` });
      }
    }
    return res.status(403).json({ error: groupReadOnlyMessage() });
  }

  const title = typeof req.body?.title === 'string' && req.body.title.trim()
    ? req.body.title.trim()
    : existingDoc.title;
  const order = req.body?.order === null ? undefined : parseDocOrder(req.body?.order) ?? existingDoc.order;
  const body = typeof req.body?.body === 'string' ? req.body.body.replace(/\r\n/g, '\n') : existingDoc.body;

  try {
    await writeDocFile(existingDoc._path, title, order, body);
    await loadDoc(existingDoc._path);

    const updatedDoc = docsCache[docPath];
    if (!updatedDoc) throw new Error('Doc was not loaded after update');

    res.json(serializeDoc(updatedDoc));
  } catch (error) {
    console.error(`Failed to save doc ${docPath}:`, error);
    res.status(500).json({ error: 'Failed to save doc' });
  }
});

router.delete(/^\/.+$/, async (req, res) => {
  const docPath = docPathFromReq(req);

  if (!docPath) return res.status(400).json({ error: 'Invalid doc path' });

  const doc = docsCache[docPath];
  if (!doc) return res.status(404).json({ error: 'Doc not found' });
  if (doc.group) {
    // Group doc: route the delete to the canonical store writer — the parent
    // deletes in place (FLUX-414); a bound member pushes through the parent.
    const writer = groupWriterContext();
    const storeRel = writer ? groupDocPathToStoreRelative(docPath) : null;
    if (writer && storeRel) {
      try {
        await submitGroupEdit(writer, [{ path: storeRel, delete: true }]);
        delete docsCache[docPath];
        return res.json({ success: true });
      } catch (error: any) {
        console.error(`Failed to write group delete for ${docPath}:`, error);
        return res.status(500).json({ error: `Failed to delete the group doc: ${error.message}` });
      }
    }
    return res.status(403).json({ error: groupReadOnlyMessage() });
  }

  try {
    await fs.unlink(doc._path);
    delete docsCache[docPath];
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

  const groupLabel = activeGroupDocsLabel();
  const fromRoot = from.split('/')[0];
  const toRoot = to.split('/')[0];
  if (fromRoot === groupLabel || toRoot === groupLabel) {
    return res.status(400).json({
      error: `The ${groupLabel}/ tree is the shared group folder. Rename it from Settings (group docs label), not as a file move.`,
    });
  }

  // Collect every local doc at the folder or beneath it.
  const prefix = from + '/';
  const affected = Object.values(docsCache).filter(
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
    if (docsCache[targetPath] && !movingPaths.has(targetPath)) {
      return res.status(409).json({ error: `A doc already exists at "${targetPath}"` });
    }
  }

  try {
    const moved: { from: string; to: string }[] = [];
    for (const doc of affected) {
      const suffix = doc.path.slice(from.length);
      const targetPath = to + suffix;
      const targetFile = getDocFilePath(targetPath);
      await writeDocFile(targetFile, doc.title, doc.order, doc.body ?? '');
      await fs.unlink(doc._path);
      delete docsCache[doc.path];
      await removeEmptyDocDirectories(doc._path);
      await loadDoc(targetFile);
      moved.push({ from: doc.path, to: targetPath });
    }
    res.json({ success: true, moved });
  } catch (error: any) {
    console.error(`Failed to rename folder ${from} → ${to}:`, error);
    res.status(500).json({ error: `Failed to rename folder: ${error.message}` });
  }
});

export default router;
