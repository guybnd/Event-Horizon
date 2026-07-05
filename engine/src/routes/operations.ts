import express from 'express';
import { getRecentOperations, type OperationKind, type OperationOutcome } from '../operation-telemetry.js';

const router = express.Router();

const VALID_KINDS = new Set<OperationKind>(['git', 'gh', 'spawn', 'handshake']);
const VALID_OUTCOMES = new Set<OperationOutcome>(['ok', 'timeout', 'error', 'aborted']);

function strParam(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

router.get('/', (req, res) => {
  const kindRaw = strParam(req.query.kind);
  const outcomeRaw = strParam(req.query.outcome);
  const limitRaw = strParam(req.query.limit);
  const limit = limitRaw ? Number(limitRaw) : undefined;

  const operations = getRecentOperations({
    ticketId: strParam(req.query.ticketId),
    sessionId: strParam(req.query.sessionId),
    kind: kindRaw && VALID_KINDS.has(kindRaw as OperationKind) ? (kindRaw as OperationKind) : undefined,
    outcome: outcomeRaw && VALID_OUTCOMES.has(outcomeRaw as OperationOutcome) ? (outcomeRaw as OperationOutcome) : undefined,
    limit: Number.isFinite(limit) ? limit : undefined,
  });

  res.json({ operations });
});

export default router;
