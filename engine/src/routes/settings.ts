import express from 'express';
import {
  getBootStatus,
  confirmBoot,
  loadGlobalSettings,
  saveGlobalSettings,
  type GlobalSettings,
} from '../global-settings.js';

const router = express.Router();

router.get('/boot-status', async (_req, res) => {
  try {
    const status = await getBootStatus();
    res.json(status);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/confirm-boot', async (req, res) => {
  try {
    const { migrate } = req.body ?? {};
    const settings = await confirmBoot({ migrate });
    res.json({ ok: true, settings });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/global', async (_req, res) => {
  try {
    const settings = await loadGlobalSettings();
    res.json(settings);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/global', async (req, res) => {
  try {
    const current = await loadGlobalSettings();
    const updates = req.body ?? {};

    if (updates.defaultUser !== undefined) current.defaultUser = updates.defaultUser;
    if (updates.preferredFramework !== undefined) current.preferredFramework = updates.preferredFramework;
    if (updates.defaultAgent !== undefined) current.defaultAgent = updates.defaultAgent;
    if (updates.port !== undefined) current.port = updates.port;
    if (updates.animations !== undefined) current.animations = updates.animations;
    if (updates.timeouts !== undefined) current.timeouts = { ...current.timeouts, ...updates.timeouts };

    await saveGlobalSettings(current);
    res.json(current);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
