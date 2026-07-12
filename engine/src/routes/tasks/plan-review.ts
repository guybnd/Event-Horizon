// Plan-review gate routes (FLUX-1263 family; FLUX-349 split): the portal's REST entry points
// into the Grooming → Todo plan gate.
import { getWorkspace } from '../../workspace-context.js';
import express from 'express';

import { startPlanGateNow, startPlanReviseNow } from '../../gate-runner.js';

const router = express.Router();

// FLUX-1306: `not-found` never reaches these two routes (the `tasksCache[id]` check above always
// wins first), so only the remaining reasons need a status — `notes-required` is caller error (a
// missing required field, 400), `persist-failed` is a server-side write failure (500); the rest
// (`wrong-status`, `already-running`, `furnace-owned`) are genuine 409 conflicts with current state.
function planGateStatusFor(reason: string | undefined): number {
  if (reason === 'notes-required') return 400;
  if (reason === 'persist-failed') return 500;
  return 409;
}

// FLUX-1289: the portal's entry point for "Re-run review" (AttentionDock body / ChatPlanApprovalCard /
// PlanApprovalPanel) — the REST twin of the `start_plan_review` MCP tool, since a human clicking a
// button in the portal has no agent turn to call the MCP tool from. Same one-shot mechanics;
// startPlanGateNow already guards status / already-running / Furnace-owned.
router.post('/:id/plan-review/start', async (req, res) => {
  const { id } = req.params;
  if (!getWorkspace().tasks[id]) return res.status(404).json({ error: `Ticket ${id} not found` });
  const result = await startPlanGateNow(id, { mode: 'one-pass' });
  if (!result.ok) return res.status(planGateStatusFor(result.reason)).json({ error: result.message, reason: result.reason });
  res.json({ ok: true, message: result.message });
});

// FLUX-1303: "Send for re-grooming" — the portal's atomic revise entry point (AttentionDock body /
// ChatPlanApprovalCard / PlanApprovalPanel). One call records the user's notes as an attributed
// comment, stamps the changes-requested verdict + planReviewBodyHash, dispatches the grooming
// revise session, and registers it with the gate runner so the revision is re-reviewed — replacing
// the old two-step portal flow that could strand a stale verdict (see startPlanReviseNow).
router.post('/:id/plan-review/revise', async (req, res) => {
  const { id } = req.params;
  if (!getWorkspace().tasks[id]) return res.status(404).json({ error: `Ticket ${id} not found` });
  const { notes, user } = (req.body ?? {}) as { notes?: unknown; user?: unknown };
  const result = await startPlanReviseNow(id, {
    ...(typeof notes === 'string' ? { notes } : {}),
    ...(typeof user === 'string' ? { user } : {}),
  });
  if (!result.ok) return res.status(planGateStatusFor(result.reason)).json({ error: result.message, reason: result.reason });
  res.json({ ok: true, message: result.message });
});

export default router;
