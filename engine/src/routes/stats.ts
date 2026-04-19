import express from 'express';
import { tasksCache } from '../task-store.js';

const router = express.Router();

router.get('/tokens', (req, res) => {
  const lifetime = { inputTokens: 0, outputTokens: 0, costUSD: 0, costIsEstimated: false };
  const byTask: Record<string, { inputTokens: number; outputTokens: number; costUSD: number; costIsEstimated: boolean }> = {};
  for (const [id, task] of Object.entries(tasksCache)) {
    if (task.tokenMetadata) {
      const tm = task.tokenMetadata;
      byTask[id] = {
        inputTokens: tm.inputTokens ?? 0,
        outputTokens: tm.outputTokens ?? 0,
        costUSD: tm.costUSD ?? 0,
        costIsEstimated: tm.costIsEstimated ?? false,
      };
      lifetime.inputTokens += tm.inputTokens ?? 0;
      lifetime.outputTokens += tm.outputTokens ?? 0;
      lifetime.costUSD = parseFloat((lifetime.costUSD + (tm.costUSD ?? 0)).toFixed(6));
      if (tm.costIsEstimated) lifetime.costIsEstimated = true;
    }
  }
  res.json({ lifetime, byTask });
});

export default router;
