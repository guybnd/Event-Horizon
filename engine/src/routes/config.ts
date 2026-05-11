import express from 'express';
import { configCache, saveConfig } from '../config.js';

const router = express.Router();

router.get('/', (req, res) => {
  res.json(configCache);
});

router.put('/', async (req, res) => {
  try {
    await saveConfig(req.body);
    res.json(configCache);
  } catch (err) {
    res.status(500).json({ error: 'Failed to save config' });
  }
});

export default router;
