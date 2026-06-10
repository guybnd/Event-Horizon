import express from 'express';
import crypto from 'crypto';
import {
  loadWorkflows,
  saveWorkflow,
  deleteWorkflow,
  validateWorkflow,
  getCliPatternSupport,
  isBuiltInWorkflow,
  type WorkflowTemplate,
} from '../models/workflow.js';

const router = express.Router();

router.get('/', async (_req, res) => {
  try {
    const workflows = await loadWorkflows();
    res.json(workflows);
  } catch (err) {
    res.status(500).json({ error: 'Failed to load workflows' });
  }
});

router.get('/patterns', (_req, res) => {
  res.json(getCliPatternSupport());
});

router.get('/:id', async (req, res) => {
  try {
    const workflows = await loadWorkflows();
    const workflow = workflows.find(w => w.id === req.params.id);
    if (!workflow) return res.status(404).json({ error: 'Workflow not found' });
    res.json(workflow);
  } catch (err) {
    res.status(500).json({ error: 'Failed to load workflow' });
  }
});

router.post('/', async (req, res) => {
  try {
    const now = new Date().toISOString();
    const workflow: WorkflowTemplate = {
      id: crypto.randomUUID(),
      name: req.body.name || 'Untitled Workflow',
      cliTarget: req.body.cliTarget || 'claude',
      phases: req.body.phases || {},
      createdAt: now,
      updatedAt: now,
    };

    const error = validateWorkflow(workflow);
    if (error) return res.status(400).json({ error });

    await saveWorkflow(workflow);
    res.status(201).json(workflow);
  } catch (err) {
    res.status(500).json({ error: 'Failed to create workflow' });
  }
});

router.put('/:id', async (req, res) => {
  try {
    if (isBuiltInWorkflow(req.params.id)) {
      return res.status(400).json({ error: 'Built-in templates cannot be edited — duplicate it to customize.' });
    }
    const workflows = await loadWorkflows();
    const existing = workflows.find(w => w.id === req.params.id);
    if (!existing) return res.status(404).json({ error: 'Workflow not found' });

    const updated: WorkflowTemplate = {
      ...existing,
      ...req.body,
      id: existing.id,
      createdAt: existing.createdAt,
      updatedAt: new Date().toISOString(),
    };

    const error = validateWorkflow(updated);
    if (error) return res.status(400).json({ error });

    await saveWorkflow(updated);
    res.json(updated);
  } catch (err) {
    res.status(500).json({ error: 'Failed to update workflow' });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    if (isBuiltInWorkflow(req.params.id)) {
      return res.status(400).json({ error: 'Built-in templates cannot be deleted.' });
    }
    const deleted = await deleteWorkflow(req.params.id);
    if (!deleted) return res.status(404).json({ error: 'Workflow not found' });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete workflow' });
  }
});

export default router;
