import express from 'express';
import fs from 'fs/promises';
import path from 'path';
import {
  normalizeDocPathInput, getDocFilePath,
  serializeDoc, sortDocs, writeDocFile, removeEmptyDocDirectories,
  parseDocOrder, titleFromDocPath, buildDocMarkdown,
} from '../file-utils.js';
import { docsCache, loadDoc, loadGroupDoc } from '../task-store.js';
import { GROUP_DOCS_PREFIX, getGroupContext, getMemberBinding, groupDocPathToStoreRelative } from '../group.js';
import { submitGroupEdit } from '../group-edit.js';

const router = express.Router();

// All doc path routes strip leading slash from req.path to get the doc path segment
function docPathFromReq(req: express.Request) {
  const raw = req.path.replace(/^\//, '');
  return normalizeDocPathInput(decodeURIComponent(raw));
}

/**
 * Human-readable reason a `Product/` group doc can't be edited from the current
 * workspace, tailored to whether we're the parent or an unbound member.
 */
function groupReadOnlyMessage(): string {
  if (getGroupContext()) {
    return `This is a cross-project group doc. Edit it from the group tools in this parent workspace, not the wiki editor.`;
  }
  return `This is a read-only cross-project group doc. Open the owning group's parent workspace to edit it.`;
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
  if (docPath.split('/')[0] === GROUP_DOCS_PREFIX) {
    // Member workspace (Case 1): route a new group doc to the parent's writer.
    const binding = getMemberBinding();
    const storeRel = binding ? groupDocPathToStoreRelative(docPath) : null;
    if (binding && storeRel) {
      if (docsCache[docPath]) return res.status(409).json({ error: 'Doc already exists' });
      const title = typeof req.body?.title === 'string' && req.body.title.trim()
        ? req.body.title.trim()
        : titleFromDocPath(docPath);
      const order = parseDocOrder(req.body?.order);
      const body = typeof req.body?.body === 'string' ? req.body.body.replace(/\r\n/g, '\n') : '';
      try {
        const storeDir = binding.parentGroup.groupStoreDir;
        await submitGroupEdit(binding.parentGroup, [{ path: storeRel, content: buildDocMarkdown(title, order, body) }]);
        await loadGroupDoc(storeDir, parentStorePath(storeDir, storeRel));
        const created = docsCache[docPath];
        return res.status(201).json(created ? serializeDoc(created) : { success: true });
      } catch (error: any) {
        console.error(`Failed to submit new group doc ${docPath} to parent:`, error);
        return res.status(500).json({ error: `Failed to submit the new doc to the group parent: ${error.message}` });
      }
    }
    return res.status(403).json({ error: `The '${GROUP_DOCS_PREFIX}' namespace holds read-only cross-project group docs; edits go through the group's parent repo.` });
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
  if (existingDoc.readOnly) {
    // Member workspace (Case 1): route the edit to the parent's writer in-process.
    const binding = getMemberBinding();
    const storeRel = existingDoc.group && binding ? groupDocPathToStoreRelative(docPath) : null;
    if (binding && storeRel) {
      const title = typeof req.body?.title === 'string' && req.body.title.trim()
        ? req.body.title.trim()
        : existingDoc.title;
      const order = req.body?.order === null ? undefined : parseDocOrder(req.body?.order) ?? existingDoc.order;
      const body = typeof req.body?.body === 'string' ? req.body.body.replace(/\r\n/g, '\n') : existingDoc.body;
      try {
        const storeDir = binding.parentGroup.groupStoreDir;
        await submitGroupEdit(binding.parentGroup, [{ path: storeRel, content: buildDocMarkdown(title, order, body) }]);
        await loadGroupDoc(storeDir, parentStorePath(storeDir, storeRel));
        const updated = docsCache[docPath];
        return res.json(updated ? serializeDoc(updated) : { success: true });
      } catch (error: any) {
        console.error(`Failed to submit group edit for ${docPath} to parent:`, error);
        return res.status(500).json({ error: `Failed to submit the edit to the group parent: ${error.message}` });
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
  if (doc.readOnly) {
    // Member workspace (Case 1): route the delete to the parent's writer.
    const binding = getMemberBinding();
    const storeRel = doc.group && binding ? groupDocPathToStoreRelative(docPath) : null;
    if (binding && storeRel) {
      try {
        await submitGroupEdit(binding.parentGroup, [{ path: storeRel, delete: true }]);
        delete docsCache[docPath];
        return res.json({ success: true });
      } catch (error: any) {
        console.error(`Failed to submit group delete for ${docPath} to parent:`, error);
        return res.status(500).json({ error: `Failed to submit the delete to the group parent: ${error.message}` });
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

export default router;
