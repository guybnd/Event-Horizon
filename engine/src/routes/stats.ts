import { getWorkspace } from '../workspace-context.js';
import express from 'express';
import { computeAgentPayloadMetrics, computeDigestSavings, computeOversizedFlags } from '../agent-payload-metrics.js';


const router = express.Router();

interface TokenStatsRow {
  inputTokens: number;
  outputTokens: number;
  costUSD: number;
  costIsEstimated: boolean;
  pctSaved?: number;
  tokensSaved?: number;
  bodyOversized?: boolean;
  historyOversized?: boolean;
}

router.get('/tokens', (req, res) => {
  const lifetime = { inputTokens: 0, outputTokens: 0, costUSD: 0, costIsEstimated: false };
  const byTask: Record<string, TokenStatsRow> = {};
  for (const [id, task] of Object.entries(getWorkspace().tasks)) {
    if (task.tokenMetadata) {
      const tm = task.tokenMetadata;
      const row: TokenStatsRow = {
        inputTokens: tm.inputTokens ?? 0,
        outputTokens: tm.outputTokens ?? 0,
        costUSD: tm.costUSD ?? 0,
        costIsEstimated: tm.costIsEstimated ?? false,
      };
      // FLUX-1512: this endpoint now does real per-task work (re-serialization), not pure
      // arithmetic on already-stored numbers — one malformed ticket must not 500 the whole
      // board-wide stats response, so each task's extra computation is independently isolated.
      try {
        const savings = computeDigestSavings(task);
        const flags = computeOversizedFlags(computeAgentPayloadMetrics(task));
        row.pctSaved = savings.pctSaved;
        row.tokensSaved = savings.tokensSaved;
        row.bodyOversized = flags.bodyOversized;
        row.historyOversized = flags.historyOversized;
      } catch (err: unknown) {
        console.error(`[stats/tokens] Failed to compute digest savings/oversized flags for ${id}:`, err);
      }
      byTask[id] = row;
      lifetime.inputTokens += tm.inputTokens ?? 0;
      lifetime.outputTokens += tm.outputTokens ?? 0;
      lifetime.costUSD = parseFloat((lifetime.costUSD + (tm.costUSD ?? 0)).toFixed(6));
      if (tm.costIsEstimated) lifetime.costIsEstimated = true;
    }
  }
  res.json({ lifetime, byTask });
});

export default router;
