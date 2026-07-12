// Barrel for the /api/tasks router (FLUX-349): the concern files live under ./tasks/ and are
// mounted here so every importer (engine/src/index.ts, the route tests) keeps the unchanged
// `./routes/tasks.js` / `./tasks.js` specifier. Shared local helpers/types are in ./tasks/helpers.ts.
//
// MOUNT ORDER MATTERS (Express matches in registration order): the single-segment literal GETs
// (/errors, /debug/* in debug.ts; /worktrees, /uncommitted-count in worktree.ts; /branches in
// branch.ts) MUST register before crud.ts's GET /:id catch-all, or a request like GET /worktrees
// would be swallowed as a ticket lookup for id "worktrees". Everything after crud only adds
// multi-segment paths (/:id/pr, /:id/worktree/*, …), which a single-segment /:id can never shadow.
import express from 'express';
import debugRouter from './tasks/debug.js';
import worktreeRouter from './tasks/worktree.js';
import workspaceOpsRouter from './tasks/workspace-ops.js';
import branchRouter from './tasks/branch.js';
import crudRouter from './tasks/crud.js';
import updateRouter from './tasks/update.js';
import assetsRouter from './tasks/assets.js';
import prRouter from './tasks/pr.js';
import finishRouter from './tasks/finish.js';
import prTicketRouter from './tasks/pr-ticket.js';
import planReviewRouter from './tasks/plan-review.js';
import diffRouter from './tasks/diff.js';

// Mounted separately by engine/src/index.ts (POST /api/bulk-rename).
export { bulkRenameHandler } from './tasks/crud.js';
// Exercised directly by tasks-hot-poll-swr.test.ts.
export { swrAsync } from './tasks/worktree.js';

const router = express.Router();

// Literal-path routers first (see mount-order note above).
router.use(debugRouter);
router.use(worktreeRouter);
router.use(workspaceOpsRouter);
router.use(branchRouter);
// The /:id catch-alls and everything below them.
router.use(crudRouter);
router.use(updateRouter);
router.use(assetsRouter);
router.use(prRouter);
router.use(finishRouter);
router.use(prTicketRouter);
router.use(planReviewRouter);
router.use(diffRouter);

export default router;
