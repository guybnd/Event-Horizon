import express from 'express';
import { workspaceRoot } from './workspace.js';

export function requireWorkspace(req: express.Request, res: express.Response, next: express.NextFunction) {
  if (!workspaceRoot) {
    res.status(503).json({ error: 'No workspace configured', code: 'NO_WORKSPACE' });
    return;
  }
  next();
}
