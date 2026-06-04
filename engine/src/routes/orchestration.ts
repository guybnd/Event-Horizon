import express from 'express';
import {
  listSelectablePersonaMeta,
  getEditablePersona,
  saveCustomPersona,
  deleteCustomPersona,
  toPersonaMeta,
} from '../orchestration-personas.js';
import type { Phase } from '../models/workflow.js';

const router = express.Router();

const VALID_PHASES: Phase[] = ['grooming', 'implementation', 'review', 'release'];

// GET all user-selectable orchestration personas (metadata only — no prompt text).
// Optional `?phase=` filters to personas configured for that ticket phase.
router.get('/personas', (req, res) => {
  const phaseRaw = typeof req.query.phase === 'string' ? req.query.phase.trim() : '';
  const phase = (VALID_PHASES as string[]).includes(phaseRaw)
    ? (phaseRaw as Phase)
    : undefined;
  res.json({ personas: listSelectablePersonaMeta(phase) });
});

// GET a single persona including its prompt. Built-in personas are viewable
// (read-only) so users can read and fork them; custom personas are editable.
// The `builtIn` flag on the returned persona tells the client which is which.
router.get('/personas/:id', (req, res) => {
  const persona = getEditablePersona(req.params.id);
  if (!persona) {
    res.status(404).json({ error: 'Persona not found' });
    return;
  }
  res.json({ persona });
});

// POST create a custom persona.
router.post('/personas', async (req, res) => {
  try {
    const persona = await saveCustomPersona(req.body);
    res.status(201).json({ persona: toPersonaMeta(persona) });
  } catch (err: any) {
    res.status(400).json({ error: err?.message || 'Failed to create persona' });
  }
});

// PUT update a custom persona.
router.put('/personas/:id', async (req, res) => {
  try {
    const persona = await saveCustomPersona({ ...req.body, id: req.params.id });
    res.json({ persona: toPersonaMeta(persona) });
  } catch (err: any) {
    res.status(400).json({ error: err?.message || 'Failed to update persona' });
  }
});

// DELETE a custom persona.
router.delete('/personas/:id', async (req, res) => {
  try {
    const ok = await deleteCustomPersona(req.params.id);
    if (!ok) {
      res.status(404).json({ error: 'Persona not found' });
      return;
    }
    res.json({ ok: true });
  } catch (err: any) {
    res.status(400).json({ error: err?.message || 'Failed to delete persona' });
  }
});

export default router;
