// Asset upload route (FLUX-349 split): image/asset upload for a ticket (or a reserved virtual
// conversation id — board/furnace chat).
import { getWorkspace } from '../../workspace-context.js';
import express from 'express';
import fs from 'fs/promises';
import path from 'path';
import { getActiveFluxDir, getTaskAssetsDir } from '../../workspace.js';

import {
  resolveSupportedImageExtension, sanitizeAssetBaseName, normalizeBase64Content,
  normalizeRelativePath, encodeAssetPath, createUniqueAssetFileName,
} from '../../file-utils.js';
import { isVirtualConversationId } from '../../agents/board.js';

const router = express.Router();

router.post('/:id/assets', async (req, res) => {
  const { id } = req.params;
  // FLUX-676 / FLUX-1209: the board orchestrator chat (__board__) and the Furnace-chat conversation
  // (__furnace__) are not tickets, but pasted images still need a home. Allow either reserved id
  // here; the bytes land under assets/<id>/ alongside the per-ticket sidecars. Any other id must
  // be a real task.
  if (!isVirtualConversationId(id) && !getWorkspace().tasks[id]) return res.status(404).json({ error: 'Task not found' });

  const fileName = typeof req.body?.fileName === 'string' ? req.body.fileName.trim() : '';
  const mimeType = typeof req.body?.mimeType === 'string' ? req.body.mimeType.trim() : '';
  const content = typeof req.body?.content === 'string' ? req.body.content : '';
  const normalizedContent = normalizeBase64Content(content);

  if (!normalizedContent) return res.status(400).json({ error: 'Missing asset content' });

  const extension = resolveSupportedImageExtension(fileName, mimeType);
  if (!extension) {
    return res.status(400).json({ error: 'Only PNG, JPG, and SVG images are supported in this first version.' });
  }

  const safeBaseName = sanitizeAssetBaseName(fileName || 'image');
  const taskAssetDirectory = path.join(getTaskAssetsDir(), id);

  try {
    await fs.mkdir(taskAssetDirectory, { recursive: true });

    const requestedFileName = `${safeBaseName}${extension}`;
    const storedFileName = await createUniqueAssetFileName(taskAssetDirectory, requestedFileName);
    const filePath = path.join(taskAssetDirectory, storedFileName);
    const fileBuffer = Buffer.from(normalizedContent, 'base64');

    if (fileBuffer.length === 0) return res.status(400).json({ error: 'Invalid asset content' });

    await fs.writeFile(filePath, fileBuffer);

    const assetPath = normalizeRelativePath(path.relative(getActiveFluxDir(), filePath));
    const apiAssetPath = normalizeRelativePath(path.relative(getTaskAssetsDir(), filePath));
    res.status(201).json({
      path: assetPath,
      fileName: storedFileName,
      url: `/api/assets/${encodeAssetPath(apiAssetPath)}`,
    });
  } catch (error) {
    console.error(`Failed to write asset for task ${id}:`, error);
    res.status(500).json({ error: 'Failed to save asset' });
  }
});

export default router;
