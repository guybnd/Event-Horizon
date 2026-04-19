import express from 'express';
import fs from 'fs/promises';
import path from 'path';
import { getTaskAssetsDir } from '../workspace.js';
import {
  getAssetFilePath, isPathInsideRoot, normalizeAssetPathInput,
} from '../file-utils.js';

const router = express.Router();

// GET /api/assets/<path> — serves asset files
router.get(/^\/.+$/, async (req, res) => {
  const rawPath = req.path.slice(1); // strip leading /
  const assetPath = normalizeAssetPathInput(decodeURIComponent(rawPath).replace(/\\/g, '/'));

  if (!assetPath) return res.status(400).json({ error: 'Invalid asset path' });

  const filePath = getAssetFilePath(assetPath);
  if (!isPathInsideRoot(getTaskAssetsDir(), filePath)) {
    return res.status(400).json({ error: 'Invalid asset path' });
  }

  try {
    const fileStats = await fs.stat(filePath);
    if (!fileStats.isFile()) return res.status(404).json({ error: 'Asset not found' });

    const fileBuffer = await fs.readFile(filePath);
    res.type(path.extname(filePath));
    res.send(fileBuffer);
  } catch (error: any) {
    if (error.code === 'ENOENT') return res.status(404).json({ error: 'Asset not found' });
    console.error(`Failed to read asset ${assetPath}:`, error);
    res.status(500).json({ error: 'Failed to read asset' });
  }
});

export default router;
