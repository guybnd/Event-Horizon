import express from 'express';
import fs from 'fs/promises';
import {
  normalizeDocPathInput, getDocFilePath,
  serializeDoc, sortDocs, writeDocFile, removeEmptyDocDirectories,
  parseDocOrder, titleFromDocPath,
} from '../file-utils.js';
import { docsCache, loadDoc } from '../task-store.js';
import { GROUP_DOCS_PREFIX } from '../group.js';

const router = express.Router();

// All doc path routes strip leading slash from req.path to get the doc path segment
function docPathFromReq(req: express.Request) {
  const raw = req.path.replace(/^\//, '');
  return normalizeDocPathInput(decodeURIComponent(raw));
}

router.get('/', (req, res) => {
  res.json(sortDocs(Object.values(docsCache).map(serializeDoc)));
});

router.post('/', async (req, res) => {
  const docPath = normalizeDocPathInput(req.body?.path);

  if (!docPath) return res.status(400).json({ error: 'Invalid doc path' });
  if (docPath.split('/')[0] === GROUP_DOCS_PREFIX) {
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
    return res.status(403).json({ error: 'This is a read-only cross-project group doc; edit it through the parent repo.' });
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
    return res.status(403).json({ error: 'This is a read-only cross-project group doc; it cannot be deleted from here.' });
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
