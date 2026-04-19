import express from 'express';
import fs from 'fs/promises';
import { getReadStateFile } from '../workspace.js';

const router = express.Router();

let writeLock: Promise<void> = Promise.resolve();

function serialized<T>(fn: () => Promise<T>): Promise<T> {
  const next = writeLock.then(fn, fn);
  writeLock = next.then(() => {}, () => {});
  return next;
}

router.get('/', async (req, res) => {
  try {
    const raw = await fs.readFile(getReadStateFile(), 'utf-8').catch(() => '{}');
    res.json(JSON.parse(raw));
  } catch {
    res.json({});
  }
});

router.put('/', async (req, res) => {
  try {
    const body = req.body as Record<string, Record<string, string[]>>;
    const result = await serialized(async () => {
      let existing: Record<string, Record<string, string[]>> = {};
      try {
        const raw = await fs.readFile(getReadStateFile(), 'utf-8');
        existing = JSON.parse(raw);
      } catch { /* file may not exist yet */ }
      for (const [user, tickets] of Object.entries(body)) {
        existing[user] = existing[user] || {};
        for (const [ticketId, ids] of Object.entries(tickets)) {
          const merged = new Set([...(existing[user][ticketId] || []), ...ids]);
          existing[user][ticketId] = [...merged];
        }
      }
      await fs.writeFile(getReadStateFile(), JSON.stringify(existing, null, 2), 'utf-8');
      return existing;
    });
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
