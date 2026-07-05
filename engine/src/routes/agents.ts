import express from 'express';
import crypto from 'crypto';
import {
  loadAgents,
  saveAgent,
  deleteAgent,
  validateAgent,
  type AgentDefinition,
} from '../models/agent.js';

const router = express.Router();

router.get('/', async (_req, res) => {
  try {
    const agents = await loadAgents();
    res.json(agents);
  } catch {
    res.status(500).json({ error: 'Failed to load agents' });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const agents = await loadAgents();
    const agent = agents.find(a => a.id === req.params.id);
    if (!agent) return res.status(404).json({ error: 'Agent not found' });
    res.json(agent);
  } catch {
    res.status(500).json({ error: 'Failed to load agent' });
  }
});

router.post('/', async (req, res) => {
  try {
    const now = new Date().toISOString();
    const agent: AgentDefinition = {
      id: crypto.randomUUID(),
      name: req.body.name || 'Untitled Agent',
      systemPrompt: req.body.systemPrompt || '',
      skills: req.body.skills || [],
      phase: req.body.phase || 'implementation',
      toolRestrictions: req.body.toolRestrictions || [],
      outputSchema: req.body.outputSchema,
      createdAt: now,
      updatedAt: now,
    };

    const error = validateAgent(agent);
    if (error) return res.status(400).json({ error });

    await saveAgent(agent);
    res.status(201).json(agent);
  } catch {
    res.status(500).json({ error: 'Failed to create agent' });
  }
});

router.put('/:id', async (req, res) => {
  try {
    const agents = await loadAgents();
    const existing = agents.find(a => a.id === req.params.id);
    if (!existing) return res.status(404).json({ error: 'Agent not found' });

    const updated: AgentDefinition = {
      ...existing,
      ...req.body,
      id: existing.id,
      createdAt: existing.createdAt,
      updatedAt: new Date().toISOString(),
    };

    const error = validateAgent(updated);
    if (error) return res.status(400).json({ error });

    await saveAgent(updated);
    res.json(updated);
  } catch {
    res.status(500).json({ error: 'Failed to update agent' });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    const deleted = await deleteAgent(req.params.id);
    if (!deleted) return res.status(404).json({ error: 'Agent not found' });
    res.json({ ok: true });
  } catch {
    res.status(500).json({ error: 'Failed to delete agent' });
  }
});

export default router;
