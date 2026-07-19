import { useState, useCallback, useEffect, useMemo } from 'react';
import {
  Workflow, Plus, X, Pencil, Loader2, BookOpen, Check, Users, Lock, Copy, Eye,
  GitBranch, Layers, GitMerge, Zap, GripVertical, ChevronDown, ChevronUp,
} from 'lucide-react';
import {
  fetchOrchestrationPersonas,
  fetchEditablePersona,
  createPersona,
  updatePersona,
  fetchWorkflows,
  createWorkflow,
  updateWorkflow,
  deleteWorkflow,
  fetchConfig,
  saveConfig,
  fetchDocs,
  updateDoc,
  createDoc,
  deleteDoc,
  type OrchestrationPersonaMeta,
  type WorkflowTemplate,
  type WorkflowPhaseConfig,
  type WorkflowPhase,
} from '../api';
import type { Config, Doc } from '../types';
import { useConfirm } from '../hooks/useConfirm';
import { useNotify } from '../hooks/useNotify';
import { Skeleton, SkeletonCard } from './ui/Skeleton';

// --- Constants ---

const PHASES: { key: WorkflowPhase; label: string }[] = [
  { key: 'grooming', label: 'Grooming' },
  { key: 'implementation', label: 'Implementation' },
  { key: 'review', label: 'Review' },
  { key: 'finalize', label: 'Finalize' },
];

type Pattern = 'relay' | 'scatter' | 'supervisor';
type CliTarget = 'claude' | 'gemini' | 'copilot' | 'all';

const PATTERNS: { key: Pattern; label: string; description: string; icon: typeof GitBranch }[] = [
  { key: 'relay', label: 'Relay', description: 'Sequential pipeline A → B → C', icon: GitBranch },
  { key: 'scatter', label: 'Scatter-Gather', description: 'Parallel execution, then combine', icon: Layers },
  { key: 'supervisor', label: 'Supervisor', description: 'Lead coordinates assistants', icon: GitMerge },
];

const CLI_PATTERN_SUPPORT: Record<CliTarget, Pattern[]> = {
  claude: ['relay', 'scatter', 'supervisor'],
  gemini: ['relay', 'scatter', 'supervisor'],
  copilot: ['relay', 'scatter'],
  all: ['relay', 'scatter', 'supervisor'],
};

const CLI_COLORS: Record<CliTarget, string> = {
  claude: 'bg-orange-500/12 text-orange-300 ring-orange-500/25',
  gemini: 'bg-blue-500/12 text-blue-300 ring-blue-500/25',
  copilot: 'bg-emerald-500/12 text-emerald-300 ring-emerald-500/25',
  all: 'bg-purple-500/12 text-purple-300 ring-purple-500/25',
};

const CLI_SEGMENT_ACTIVE: Record<CliTarget, string> = {
  claude: 'bg-orange-500/28 text-orange-100 ring-orange-300/45',
  gemini: 'bg-blue-500/28 text-blue-100 ring-blue-300/45',
  copilot: 'bg-emerald-500/28 text-emerald-100 ring-emerald-300/45',
  all: 'bg-purple-500/28 text-purple-100 ring-purple-300/45',
};

const PHASE_DOT: Record<WorkflowPhase, string> = {
  grooming: 'bg-purple-400',
  implementation: 'bg-blue-400',
  review: 'bg-amber-400',
  finalize: 'bg-emerald-400',
};

const PHASE_RING: Record<WorkflowPhase, string> = {
  grooming: 'ring-purple-400/30',
  implementation: 'ring-blue-400/30',
  review: 'ring-amber-400/30',
  finalize: 'ring-emerald-400/30',
};

// --- Helpers ---

interface SkillDef { id: string; name: string; body: string; path: string; }
function docToSkill(doc: Doc): SkillDef {
  return { id: doc.path, name: doc.title, body: doc.body, path: doc.path };
}

function phaseLead(cfg: WorkflowPhaseConfig | undefined): string | undefined {
  if (!cfg) return undefined;
  if (cfg.pattern === 'supervisor') return cfg.lead;
  if (cfg.pattern === 'scatter') return cfg.combiner;
  return undefined;
}

function phaseWorkers(cfg: WorkflowPhaseConfig | undefined): string[] {
  if (!cfg) return [];
  if (cfg.pattern === 'relay') return cfg.steps ?? [];
  if (cfg.pattern === 'supervisor') return cfg.assistants ?? [];
  if (cfg.pattern === 'scatter') return cfg.parallel ?? [];
  return [];
}

function buildPhaseConfig(pattern: Pattern, lead: string | undefined, workers: string[]): WorkflowPhaseConfig {
  if (pattern === 'relay') return { pattern, steps: workers };
  if (pattern === 'supervisor') return { pattern, lead, assistants: workers };
  return { pattern, parallel: workers, combiner: lead };
}

/** All member IDs in a phase config (lead + workers). Used for counting/membership checks. */
function phaseMembers(cfg: WorkflowPhaseConfig | undefined): string[] {
  const lead = phaseLead(cfg);
  const workers = phaseWorkers(cfg);
  return lead ? [lead, ...workers] : workers;
}

// ============================================================================
// Node Graph Canvas — renders orchestration flow for a single phase
// ============================================================================

function NodeGraph({
  pattern,
  lead,
  workers,
  personaLabels,
  personaRoles,
  onRemoveLead,
  onRemoveWorker,
  onReorderWorker,
  onDropLead,
  onDropWorker,
}: {
  pattern: Pattern;
  lead: string | undefined;
  workers: string[];
  personaLabels: Record<string, string>;
  personaRoles: Record<string, string>;
  onRemoveLead: () => void;
  onRemoveWorker: (id: string) => void;
  onReorderWorker: (from: number, to: number) => void;
  onDropLead: (personaId: string) => void;
  onDropWorker: (personaId: string) => void;
}) {
  const [workerDragOver, setWorkerDragOver] = useState(false);
  const [leadDragOver, setLeadDragOver] = useState(false);
  const [rejectShake, setRejectShake] = useState<'lead' | 'worker' | null>(null);
  const [draggingIdx, setDraggingIdx] = useState<number | null>(null);

  const triggerShake = (zone: 'lead' | 'worker') => {
    setRejectShake(zone);
    setTimeout(() => setRejectShake(null), 500);
  };

  const canDropAsLead = (personaId: string) => {
    const role = personaRoles[personaId];
    return role === 'lead' || role === 'flex';
  };

  const canDropAsWorker = (personaId: string) => {
    const role = personaRoles[personaId];
    return role === 'worker' || role === 'flex';
  };

  const handleLeadDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setLeadDragOver(false);
    const personaId = e.dataTransfer.getData('persona-id');
    if (!personaId) return;
    if (!canDropAsLead(personaId)) { triggerShake('lead'); return; }
    onDropLead(personaId);
  };

  const handleWorkerDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setWorkerDragOver(false);
    const reorderIdx = e.dataTransfer.getData('reorder-idx');
    if (reorderIdx) return; // internal reorder handled separately
    const personaId = e.dataTransfer.getData('persona-id');
    if (!personaId || workers.includes(personaId)) return;
    if ((pattern === 'supervisor' || pattern === 'scatter') && !canDropAsWorker(personaId)) {
      triggerShake('worker');
      return;
    }
    onDropWorker(personaId);
  };

  const handleInternalDragStart = (e: React.DragEvent, idx: number) => {
    e.dataTransfer.setData('reorder-idx', String(idx));
    setDraggingIdx(idx);
  };

  const handleInternalDrop = (e: React.DragEvent, targetIdx: number) => {
    e.preventDefault();
    e.stopPropagation();
    const fromIdx = parseInt(e.dataTransfer.getData('reorder-idx'));
    if (!isNaN(fromIdx) && fromIdx !== targetIdx) {
      onReorderWorker(fromIdx, targetIdx);
    }
    setDraggingIdx(null);
  };

  const shakeClass = 'animate-[shake_0.3s_ease-in-out]';

  // Empty state
  const hasContent = lead || workers.length > 0;
  if (!hasContent && pattern === 'relay') {
    return (
      <div
        onDragOver={e => { e.preventDefault(); setWorkerDragOver(true); }}
        onDragLeave={() => setWorkerDragOver(false)}
        onDrop={handleWorkerDrop}
        className={`flex-1 flex items-center justify-center rounded-2xl border-2 border-dashed transition-all duration-300 ${
          workerDragOver ? 'border-primary/50 bg-primary/[0.04] scale-[1.01]' : 'border-gray-200/60 dark:border-white/[0.06]'
        }`}
      >
        <div className="text-center py-16 px-8 max-w-sm">
          <div className="w-14 h-14 mx-auto mb-4 rounded-2xl bg-gray-100 dark:bg-white/[0.04] flex items-center justify-center">
            <GripVertical className="w-6 h-6 text-gray-300 dark:text-gray-600" />
          </div>
          <p className="text-base text-gray-500 dark:text-gray-400 font-semibold mb-1">Drop agents here</p>
          <p className="text-[12px] text-gray-400 dark:text-gray-500 leading-relaxed">
            Drag agents from the left panel to build the pipeline.
          </p>
        </div>
      </div>
    );
  }

  // ── Relay: linear chain ──────────────────────────────────────────────────
  if (pattern === 'relay') {
    return (
      <div
        onDragOver={e => { e.preventDefault(); setWorkerDragOver(true); }}
        onDragLeave={() => setWorkerDragOver(false)}
        onDrop={handleWorkerDrop}
        className={`flex-1 flex items-center justify-center px-8 py-6 rounded-2xl border transition-all duration-300 ${
          workerDragOver ? 'border-primary/50 bg-primary/[0.03]' : 'border-gray-200/40 dark:border-white/[0.04] bg-gray-50/30 dark:bg-white/[0.01]'
        }`}
      >
        <div className="flex items-center gap-0 flex-wrap justify-center">
          <div className="w-10 h-10 rounded-full bg-primary/10 ring-1 ring-primary/20 flex items-center justify-center shrink-0">
            <Zap className="w-4 h-4 text-primary" />
          </div>
          {workers.map((id, i) => (
            <div key={`${id}-${i}`} className="flex items-center">
              <svg width="40" height="20" viewBox="0 0 40 20" className="shrink-0 mx-0.5">
                <line x1="0" y1="10" x2="32" y2="10" stroke="var(--eh-accent)" strokeWidth="1.5" strokeOpacity="0.4" />
                <polygon points="30,6 38,10 30,14" fill="var(--eh-accent)" fillOpacity="0.5" />
              </svg>
              <div
                draggable
                onDragStart={e => handleInternalDragStart(e, i)}
                onDragOver={e => { e.preventDefault(); e.stopPropagation(); }}
                onDrop={e => handleInternalDrop(e, i)}
                className={`group relative flex items-center gap-2 px-4 py-3 rounded-xl border bg-white dark:bg-[#1c1c1a] shadow-[0_2px_8px_rgba(0,0,0,0.04)] dark:shadow-[0_2px_8px_rgba(0,0,0,0.2)] transition-all duration-200 cursor-grab active:cursor-grabbing ${
                  draggingIdx === i ? 'opacity-50 scale-95' : 'border-gray-200/60 dark:border-white/[0.08] hover:border-primary/30'
                }`}
              >
                <GripVertical className="w-3 h-3 text-gray-300 dark:text-gray-600 shrink-0" />
                <div className="flex flex-col min-w-0">
                  <span className="text-[11px] font-semibold text-gray-800 dark:text-gray-100 truncate">{personaLabels[id] ?? id}</span>
                  <span className="text-[9px] text-gray-400 font-mono">Step {i + 1}</span>
                </div>
                <button onClick={() => onRemoveWorker(id)} className="absolute -top-1.5 -right-1.5 w-4 h-4 rounded-full bg-red-500 text-white flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity shadow-sm">
                  <X className="w-2.5 h-2.5" />
                </button>
              </div>
            </div>
          ))}
          <svg width="40" height="20" viewBox="0 0 40 20" className="shrink-0 mx-0.5">
            <line x1="0" y1="10" x2="32" y2="10" stroke="var(--eh-accent)" strokeWidth="1.5" strokeOpacity="0.4" />
            <polygon points="30,6 38,10 30,14" fill="var(--eh-accent)" fillOpacity="0.5" />
          </svg>
          <div className="w-10 h-10 rounded-full bg-emerald-500/10 ring-1 ring-emerald-500/20 flex items-center justify-center shrink-0">
            <Check className="w-4 h-4 text-emerald-500" />
          </div>
        </div>
      </div>
    );
  }

  // ── Scatter-Gather: parallel workers + combiner drop zone ────────────────
  if (pattern === 'scatter') {
    return (
      <div className="flex-1 flex items-center justify-center px-8 py-6 rounded-2xl border border-gray-200/40 dark:border-white/[0.04] bg-gray-50/30 dark:bg-white/[0.01]">
        <div className="flex items-center">
          {/* Start */}
          <div className="w-10 h-10 rounded-full bg-primary/10 ring-1 ring-primary/20 flex items-center justify-center shrink-0">
            <Zap className="w-4 h-4 text-primary" />
          </div>

          {/* Worker drop area */}
          <div
            onDragOver={e => { e.preventDefault(); setWorkerDragOver(true); }}
            onDragLeave={() => setWorkerDragOver(false)}
            onDrop={handleWorkerDrop}
            className={`relative mx-4 min-w-[200px] min-h-[80px] rounded-xl border-2 border-dashed p-3 transition-all duration-200 ${
              rejectShake === 'worker' ? shakeClass : ''
            } ${workerDragOver ? 'border-primary/50 bg-primary/[0.03]' : 'border-gray-200/40 dark:border-white/[0.06]'}`}
          >
            <span className="text-[9px] font-bold uppercase text-gray-400 tracking-wide absolute top-1.5 left-3">Workers</span>
            <div className="flex flex-col gap-1.5 mt-4">
              {workers.length === 0 && (
                <p className="text-[11px] text-gray-400 text-center py-3">Drop worker agents here</p>
              )}
              {workers.map((id, i) => (
                <div key={`${id}-${i}`} className="group relative flex items-center gap-2 px-3 py-2 rounded-lg border border-gray-200/60 dark:border-white/[0.08] bg-white dark:bg-[#1c1c1a] shadow-sm">
                  <Layers className="w-3 h-3 text-gray-300 shrink-0" />
                  <span className="text-[11px] font-semibold text-gray-800 dark:text-gray-100 truncate">{personaLabels[id] ?? id}</span>
                  <button onClick={() => onRemoveWorker(id)} className="absolute -top-1 -right-1 w-4 h-4 rounded-full bg-red-500 text-white flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity shadow-sm">
                    <X className="w-2.5 h-2.5" />
                  </button>
                </div>
              ))}
            </div>
          </div>

          {/* Combiner/Lead drop zone */}
          <div
            onDragOver={e => { e.preventDefault(); e.stopPropagation(); setLeadDragOver(true); }}
            onDragLeave={() => setLeadDragOver(false)}
            onDrop={handleLeadDrop}
            className={`flex flex-col items-center gap-2 px-4 py-3 rounded-2xl border-2 transition-all duration-200 min-w-[100px] ${
              rejectShake === 'lead' ? shakeClass : ''
            } ${leadDragOver ? 'border-amber-400/60 bg-amber-500/[0.06]' : lead ? 'border-amber-500/30 bg-amber-500/[0.04]' : 'border-dashed border-amber-400/30 bg-amber-500/[0.02]'}`}
          >
            <GitMerge className="w-4 h-4 text-amber-500" />
            <span className="text-[9px] font-bold text-amber-500 uppercase tracking-wide">Combiner</span>
            {lead ? (
              <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white dark:bg-[#1c1c1a] border border-gray-200/60 dark:border-white/[0.08]">
                <span className="text-[11px] font-semibold text-gray-800 dark:text-gray-100">{personaLabels[lead] ?? lead}</span>
                <button onClick={onRemoveLead} className="text-gray-400 hover:text-red-500 transition-colors">
                  <X className="w-3 h-3" />
                </button>
              </div>
            ) : (
              <span className="text-[10px] text-amber-400/70 italic">Drop lead here</span>
            )}
          </div>
        </div>
      </div>
    );
  }

  // ── Supervisor: lead hub + assistant spoke area ──────────────────────────
  return (
    <div className="flex-1 flex items-center justify-center px-8 py-6 rounded-2xl border border-gray-200/40 dark:border-white/[0.04] bg-gray-50/30 dark:bg-white/[0.01]">
      <div className="relative flex items-center justify-center" style={{ minHeight: Math.max(180, (workers.length + 1) * 52) }}>
        {/* Lead hub — explicit drop zone */}
        <div
          onDragOver={e => { e.preventDefault(); e.stopPropagation(); setLeadDragOver(true); }}
          onDragLeave={() => setLeadDragOver(false)}
          onDrop={handleLeadDrop}
          className={`relative z-10 flex flex-col items-center gap-2 px-5 py-4 rounded-2xl border-2 transition-all duration-200 min-w-[120px] ${
            rejectShake === 'lead' ? shakeClass : ''
          } ${leadDragOver ? 'border-amber-400/60 bg-amber-500/[0.06]' : lead ? 'border-primary/30 bg-primary/[0.04] dark:bg-primary/[0.06]' : 'border-dashed border-primary/30 bg-primary/[0.02]'}`}
        >
          <GitMerge className="w-5 h-5 text-primary" />
          <span className="text-[10px] font-bold text-primary uppercase tracking-wide">Lead</span>
          {lead ? (
            <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white dark:bg-[#1c1c1a] border border-gray-200/60 dark:border-white/[0.08]">
              <span className="text-[11px] font-semibold text-gray-800 dark:text-gray-100">{personaLabels[lead] ?? lead}</span>
              <button onClick={onRemoveLead} className="text-gray-400 hover:text-red-500 transition-colors">
                <X className="w-3 h-3" />
              </button>
            </div>
          ) : (
            <span className="text-[10px] text-primary/50 italic">Drop lead here</span>
          )}
        </div>

        {/* Assistant drop area */}
        <div
          onDragOver={e => { e.preventDefault(); setWorkerDragOver(true); }}
          onDragLeave={() => setWorkerDragOver(false)}
          onDrop={handleWorkerDrop}
          className={`ml-6 flex flex-col gap-2 min-w-[140px] rounded-xl border-2 border-dashed p-3 transition-all duration-200 ${
            rejectShake === 'worker' ? shakeClass : ''
          } ${workerDragOver ? 'border-blue-400/50 bg-blue-500/[0.03]' : 'border-gray-200/40 dark:border-white/[0.06]'}`}
        >
          <span className="text-[9px] font-bold uppercase text-gray-400 tracking-wide">Assistants</span>
          {workers.length === 0 && (
            <p className="text-[10px] text-gray-400 italic py-2">Drop workers here</p>
          )}
          {workers.map((id, i) => (
            <div key={`${id}-${i}`} className="flex items-center gap-2">
              <svg width="24" height="2" className="shrink-0">
                <line x1="0" y1="1" x2="24" y2="1" stroke="var(--eh-accent)" strokeWidth="1" strokeOpacity="0.3" strokeDasharray="4 2" />
              </svg>
              <div className="group relative flex items-center gap-2 px-3 py-2 rounded-xl border border-gray-200/60 dark:border-white/[0.08] bg-white dark:bg-[#1c1c1a] shadow-sm hover:border-primary/30 transition-all duration-200">
                <span className="text-[11px] font-medium text-gray-700 dark:text-gray-200 truncate">{personaLabels[id] ?? id}</span>
                <button onClick={() => onRemoveWorker(id)} className="absolute -top-1 -right-1 w-4 h-4 rounded-full bg-red-500 text-white flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity shadow-sm">
                  <X className="w-2.5 h-2.5" />
                </button>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ============================================================================
// Persona editor (modal)
// ============================================================================

function PersonaEditPanel({
  initial,
  onClose,
  onSaved,
}: {
  initial: OrchestrationPersonaMeta | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [forked, setForked] = useState(false);
  const readOnly = !!initial?.builtIn && !forked;
  const creating = !initial || forked;

  const [label, setLabel] = useState(initial?.label ?? '');
  const [id, setId] = useState(initial?.id ?? '');
  const [description, setDescription] = useState(initial?.description ?? '');
  const [role, setRole] = useState<'lead' | 'worker' | 'flex'>(initial?.role ?? 'worker');
  const [phases, setPhases] = useState<WorkflowPhase[]>((initial?.phases as WorkflowPhase[] ?? ['review']));
  const [prompt, setPrompt] = useState('');
  const [loadingPrompt, setLoadingPrompt] = useState(!!initial);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    if (initial) {
      setLoadingPrompt(true);
      fetchEditablePersona(initial.id)
        .then(p => { if (!cancelled) setPrompt(p.prompt); })
        .catch(() => { if (!cancelled) setError('Failed to load persona prompt'); })
        .finally(() => { if (!cancelled) setLoadingPrompt(false); });
    }
    return () => { cancelled = true; };
  }, [initial]);

  useEffect(() => {
    if (!creating) return;
    setId(label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, ''));
  }, [label, creating]);

  const handleFork = () => { setLabel(prev => `${prev} (Copy)`); setForked(true); setError(null); };
  const togglePhase = (p: WorkflowPhase) => setPhases(prev => (prev.includes(p) ? prev.filter(x => x !== p) : [...prev, p]));

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    try {
      if (creating) await createPersona({ id, label: label.trim(), description: description.trim(), role, phases, requiredCapabilities: [], prompt });
      else await updatePersona(initial!.id, { id, label: label.trim(), description: description.trim(), role, phases, requiredCapabilities: [], prompt });
      onSaved();
    } catch (err) { setError(err instanceof Error ? err.message : 'Failed to save'); }
    finally { setSaving(false); }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-md" onClick={onClose}>
      <div className="bg-white dark:bg-[#18181a] rounded-2xl shadow-[0_24px_80px_rgba(0,0,0,0.3)] w-full max-w-xl max-h-[88vh] overflow-y-auto p-6 border border-gray-200/60 dark:border-white/[0.08]" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-base font-bold text-gray-800 dark:text-gray-100 flex items-center gap-2">
            {readOnly ? 'View Persona' : creating ? 'New Persona' : 'Edit Persona'}
            {readOnly && <span className="flex items-center gap-1 text-[10px] font-bold uppercase text-gray-400"><Lock className="w-3 h-3" /> Built-in</span>}
          </h3>
          <button onClick={onClose} className="p-2 rounded-xl hover:bg-gray-100 dark:hover:bg-white/10 text-gray-400"><X className="w-4 h-4" /></button>
        </div>
        {readOnly && <p className="text-xs text-gray-500 dark:text-gray-400 mb-4 -mt-1">Built-in personas are read-only. Use <strong>Duplicate &amp; Edit</strong> to make your own copy.</p>}
        <div className="space-y-4">
          <div>
            <label className="text-[10px] font-bold text-gray-500 dark:text-gray-400 uppercase tracking-[0.08em]">Name</label>
            <input value={label} onChange={e => setLabel(e.target.value)} disabled={readOnly} placeholder="e.g. Security Auditor" className="mt-1.5 w-full px-3.5 py-2.5 rounded-xl border border-gray-200/60 dark:border-white/[0.08] bg-gray-50/50 dark:bg-black/20 text-sm text-gray-800 dark:text-gray-100 outline-none focus:border-primary/50 focus:ring-2 focus:ring-primary/10 disabled:opacity-60 disabled:cursor-not-allowed transition-all duration-200" />
            {creating && id && <p className="mt-1 text-[11px] text-gray-400 font-mono">id: {id}</p>}
          </div>
          <div>
            <label className="text-[10px] font-bold text-gray-500 dark:text-gray-400 uppercase tracking-[0.08em]">Description</label>
            <input value={description} onChange={e => setDescription(e.target.value)} disabled={readOnly} placeholder="Short summary" className="mt-1.5 w-full px-3.5 py-2.5 rounded-xl border border-gray-200/60 dark:border-white/[0.08] bg-gray-50/50 dark:bg-black/20 text-sm text-gray-800 dark:text-gray-100 outline-none focus:border-primary/50 focus:ring-2 focus:ring-primary/10 disabled:opacity-60 disabled:cursor-not-allowed transition-all duration-200" />
          </div>
          <div>
            <label className="text-[10px] font-bold text-gray-500 dark:text-gray-400 uppercase tracking-[0.08em]">Role</label>
            <div className="mt-1.5 flex gap-1.5 flex-wrap">
              {(['lead', 'worker', 'flex'] as const).map(r => (
                <button key={r} onClick={() => setRole(r)} disabled={readOnly} className={`px-3 py-1.5 rounded-lg text-[11px] font-bold transition-all duration-200 disabled:opacity-60 disabled:cursor-not-allowed ${role === r ? 'bg-primary text-white' : 'bg-gray-100 dark:bg-white/10 text-gray-500 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-white/20'}`}>
                  {r.charAt(0).toUpperCase() + r.slice(1)}
                </button>
              ))}
            </div>
            <p className="mt-1.5 text-[10px] text-gray-400 dark:text-gray-500">Lead = supervisor/combiner slots. Worker = assistant/step slots. Flex = any slot.</p>
          </div>
          <div>
            <label className="text-[10px] font-bold text-gray-500 dark:text-gray-400 uppercase tracking-[0.08em]">Phases</label>
            <div className="mt-1.5 flex gap-1.5 flex-wrap">
              {PHASES.map(p => (
                <button key={p.key} onClick={() => togglePhase(p.key)} disabled={readOnly} className={`px-3 py-1.5 rounded-lg text-[11px] font-bold transition-all duration-200 disabled:opacity-60 disabled:cursor-not-allowed ${phases.includes(p.key) ? 'bg-primary/10 text-primary ring-1 ring-primary/20' : 'bg-gray-100 dark:bg-white/10 text-gray-500 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-white/20'}`}>
                  {p.label}
                </button>
              ))}
            </div>
            <p className="mt-1.5 text-[10px] text-gray-400 dark:text-gray-500">Suggestion filter - persona shows in these phases. Empty = all phases.</p>
          </div>
          <div>
            <label className="text-[10px] font-bold text-gray-500 dark:text-gray-400 uppercase tracking-[0.08em]">Prompt</label>
            {loadingPrompt ? <div className="mt-1.5 flex items-center gap-2 text-gray-400 text-sm"><Loader2 className="w-4 h-4 animate-spin" /> Loading…</div> : (
              <textarea value={prompt} onChange={e => setPrompt(e.target.value)} readOnly={readOnly} rows={8} placeholder="The full instructions…" className={`mt-1.5 w-full px-3.5 py-3 rounded-xl border border-gray-200/60 dark:border-white/[0.08] bg-gray-50/50 dark:bg-black/20 text-[12px] text-gray-800 dark:text-gray-100 outline-none focus:border-primary/50 focus:ring-2 focus:ring-primary/10 resize-y font-mono leading-relaxed ${readOnly ? 'opacity-70 cursor-default' : ''}`} />
            )}
          </div>
          {error && <p className="text-sm text-red-500">{error}</p>}
        </div>
        <div className="flex items-center justify-end gap-2 mt-6 pt-4 border-t border-gray-200/60 dark:border-white/[0.06]">
          <button onClick={onClose} className="px-4 py-2 rounded-xl text-sm font-medium text-gray-500 hover:bg-gray-100 dark:hover:bg-white/10 transition-all duration-200">{readOnly ? 'Close' : 'Cancel'}</button>
          {readOnly ? (
            <button onClick={handleFork} disabled={loadingPrompt} className="flex items-center gap-1.5 px-4 py-2 rounded-full text-sm font-semibold bg-primary text-white hover:bg-primary-hover transition-all duration-300 active:scale-[0.97] disabled:opacity-50"><Copy className="w-3.5 h-3.5" /> Duplicate &amp; Edit</button>
          ) : (
            <button onClick={handleSave} disabled={!label.trim() || !prompt.trim() || saving || loadingPrompt} className="flex items-center gap-1.5 px-5 py-2.5 rounded-full text-sm font-semibold bg-primary text-white hover:bg-primary-hover transition-all duration-300 active:scale-[0.97] disabled:opacity-50 disabled:cursor-not-allowed">
              {saving && <Loader2 className="w-3.5 h-3.5 animate-spin" />} Save
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// ============================================================================
// Skill editor (inline panel)
// ============================================================================

function SkillInlineEditor({ skill, onClose, onSave, onDelete, isSaving }: {
  skill: SkillDef; onClose: () => void; onSave: (updated: SkillDef) => void; onDelete?: () => void; isSaving?: boolean;
}) {
  const [name, setName] = useState(skill.name);
  const [body, setBody] = useState(skill.body);
  useEffect(() => { setName(skill.name); setBody(skill.body); }, [skill.id, skill.name, skill.body]);

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between px-5 py-4 border-b border-gray-200/60 dark:border-white/[0.06]">
        <div className="flex items-center gap-2.5"><BookOpen className="w-4 h-4 text-primary/70" /><h3 className="text-sm font-bold text-gray-800 dark:text-gray-100">Edit Skill</h3></div>
        <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-gray-100 dark:hover:bg-white/10 text-gray-400"><X className="w-4 h-4" /></button>
      </div>
      <div className="flex-1 overflow-y-auto px-5 py-5 space-y-4">
        <div>
          <label className="text-[10px] font-bold text-gray-500 dark:text-gray-400 uppercase tracking-[0.08em]">Name</label>
          <input value={name} onChange={e => setName(e.target.value)} className="mt-1.5 w-full px-3 py-2.5 rounded-xl border border-gray-200/60 dark:border-white/[0.08] bg-gray-50/50 dark:bg-black/20 text-sm text-gray-800 dark:text-gray-100 outline-none focus:border-primary/50 focus:ring-2 focus:ring-primary/10" />
        </div>
        {skill.path && <p className="text-[10px] text-gray-400 font-mono">{skill.path}</p>}
        <div className="flex-1">
          <label className="text-[10px] font-bold text-gray-500 dark:text-gray-400 uppercase tracking-[0.08em]">Content</label>
          <textarea value={body} onChange={e => setBody(e.target.value)} className="mt-1.5 w-full px-3 py-3 rounded-xl border border-gray-200/60 dark:border-white/[0.08] bg-gray-50/50 dark:bg-black/20 text-[12px] text-gray-800 dark:text-gray-100 outline-none focus:border-primary/50 focus:ring-2 focus:ring-primary/10 resize-y font-mono leading-relaxed min-h-[300px]" />
        </div>
      </div>
      <div className="flex items-center justify-between px-5 py-4 border-t border-gray-200/60 dark:border-white/[0.06]">
        {onDelete ? <button onClick={onDelete} className="px-3 py-2 rounded-lg text-[11px] font-medium text-red-500 hover:bg-red-50 dark:hover:bg-red-500/10 transition-all">Delete</button> : <div />}
        <button onClick={() => onSave({ ...skill, name, body })} disabled={!name.trim() || isSaving} className="flex items-center gap-1.5 px-4 py-2 rounded-full text-[12px] font-semibold bg-primary text-white hover:bg-primary-hover transition-all duration-300 active:scale-[0.97] disabled:opacity-50 disabled:cursor-not-allowed">
          {isSaving && <Loader2 className="w-3 h-3 animate-spin" />} Save
        </button>
      </div>
    </div>
  );
}

// ============================================================================
// Main: Cockpit Layout
// ============================================================================

type DockSection = 'personas' | 'skills';
const WORKFLOW_GUIDE_COLLAPSED_KEY = 'eh-workflows-guide-collapsed';

export function WorkflowBuilder() {
  const [personas, setPersonas] = useState<OrchestrationPersonaMeta[]>([]);
  const [templates, setTemplates] = useState<WorkflowTemplate[]>([]);
  const [config, setConfigState] = useState<Config | null>(null);
  const [skills, setSkills] = useState<SkillDef[]>([]);
  const [loading, setLoading] = useState(true);
  const [skillSaving, setSkillSaving] = useState(false);
  const [guideCollapsed, setGuideCollapsed] = useState<boolean>(() => {
    try {
      return localStorage.getItem(WORKFLOW_GUIDE_COLLAPSED_KEY) === '1';
    } catch {
      return false;
    }
  });

  // Explorer (top zone) state — independent of canvas
  const [explorerPhase, setExplorerPhase] = useState<WorkflowPhase>('grooming');
  const [explorerCollapsed, setExplorerCollapsed] = useState(false);

  // Canvas editor state
  const [activeTemplate, setActiveTemplate] = useState<WorkflowTemplate | null>(null);
  const [activePhase, setActivePhase] = useState<WorkflowPhase>('grooming');
  const [dockSection, setDockSection] = useState<DockSection>('personas');
  const [editingPersona, setEditingPersona] = useState<OrchestrationPersonaMeta | null>(null);
  const [creatingPersona, setCreatingPersona] = useState(false);
  const [editingSkill, setEditingSkill] = useState<SkillDef | null>(null);
  const [creatingTemplate, setCreatingTemplate] = useState(false);

  // Template editing state (mirrors the active template for local edits)
  const [templateName, setTemplateName] = useState('');
  const [templateCliTarget, setTemplateCliTarget] = useState<CliTarget>('claude');
  const [templatePhases, setTemplatePhases] = useState<Partial<Record<WorkflowPhase, WorkflowPhaseConfig>>>({});
  const [templateSaving, setTemplateSaving] = useState(false);
  const confirm = useConfirm();
  const notify = useNotify();

  const reloadPersonas = useCallback(() => fetchOrchestrationPersonas().then(setPersonas).catch(() => {}), []);
  const reloadTemplates = useCallback(() => fetchWorkflows().then(setTemplates).catch(() => {}), []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    Promise.all([fetchOrchestrationPersonas(), fetchWorkflows(), fetchConfig(), fetchDocs()])
      .then(([p, w, c, docs]) => {
        if (cancelled) return;
        setPersonas(p);
        setTemplates(w);
        setConfigState(c);
        setSkills(docs.filter(d => d.directory === 'skills').map(docToSkill));
        if (w.length > 0) {
          setActiveTemplate(w[0]);
          setTemplateName(w[0].name);
          setTemplateCliTarget((w[0].cliTarget as CliTarget) ?? 'claude');
          setTemplatePhases(w[0].phases ?? {});
        }
      })
      .catch(() => {})
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  const selectTemplate = useCallback((t: WorkflowTemplate) => {
    setActiveTemplate(t);
    setTemplateName(t.name);
    setTemplateCliTarget((t.cliTarget as CliTarget) ?? 'claude');
    setTemplatePhases(t.phases ?? {});
    setCreatingTemplate(false);
    const primaryPhase = PHASES.find(p => phaseMembers(t.phases[p.key]).length > 0)?.key ?? 'grooming';
    setActivePhase(primaryPhase);
  }, []);

  const startNewTemplate = useCallback(() => {
    setActiveTemplate(null);
    setTemplateName('');
    setTemplateCliTarget('claude');
    setTemplatePhases({});
    setCreatingTemplate(true);
    setActivePhase(explorerPhase);
  }, [explorerPhase]);

  const handleSaveTemplate = useCallback(async () => {
    setTemplateSaving(true);
    const supportedPatterns = CLI_PATTERN_SUPPORT[templateCliTarget];
    const cleaned: Partial<Record<WorkflowPhase, WorkflowPhaseConfig>> = {};
    for (const { key } of PHASES) {
      const cfg = templatePhases[key];
      if (!cfg || phaseMembers(cfg).length === 0) continue;
      const pattern = supportedPatterns.includes(cfg.pattern as Pattern) ? (cfg.pattern as Pattern) : 'relay';
      cleaned[key] = buildPhaseConfig(pattern, phaseLead(cfg), phaseWorkers(cfg));
    }
    try {
      if (creatingTemplate) {
        const created = await createWorkflow({ name: templateName.trim(), cliTarget: templateCliTarget, phases: cleaned });
        await reloadTemplates();
        selectTemplate(created);
      } else if (activeTemplate) {
        await updateWorkflow(activeTemplate.id, { name: templateName.trim(), cliTarget: templateCliTarget, phases: cleaned });
        await reloadTemplates();
      }
      setCreatingTemplate(false);
    } catch (err) { console.error(err); }
    finally { setTemplateSaving(false); }
  }, [templateName, templateCliTarget, templatePhases, creatingTemplate, activeTemplate, reloadTemplates, selectTemplate]);

  // Phase-level actions — separate lead and worker handlers
  const handleDropLead = useCallback((personaId: string) => {
    setTemplatePhases(prev => {
      const cfg = prev[activePhase];
      const pattern = (cfg?.pattern as Pattern) ?? 'relay';
      const workers = phaseWorkers(cfg);
      return { ...prev, [activePhase]: buildPhaseConfig(pattern, personaId, workers) };
    });
  }, [activePhase]);

  const handleRemoveLead = useCallback(() => {
    setTemplatePhases(prev => {
      const cfg = prev[activePhase];
      const pattern = (cfg?.pattern as Pattern) ?? 'relay';
      const workers = phaseWorkers(cfg);
      if (workers.length === 0) { const next = { ...prev }; delete next[activePhase]; return next; }
      return { ...prev, [activePhase]: buildPhaseConfig(pattern, undefined, workers) };
    });
  }, [activePhase]);

  const handleDropWorker = useCallback((personaId: string) => {
    setTemplatePhases(prev => {
      const cfg = prev[activePhase];
      const pattern = (cfg?.pattern as Pattern) ?? 'relay';
      const lead = phaseLead(cfg);
      const workers = phaseWorkers(cfg);
      if (workers.includes(personaId)) return prev;
      return { ...prev, [activePhase]: buildPhaseConfig(pattern, lead, [...workers, personaId]) };
    });
  }, [activePhase]);

  const handleRemoveWorker = useCallback((personaId: string) => {
    setTemplatePhases(prev => {
      const cfg = prev[activePhase];
      const pattern = (cfg?.pattern as Pattern) ?? 'relay';
      const lead = phaseLead(cfg);
      const workers = phaseWorkers(cfg).filter(m => m !== personaId);
      if (!lead && workers.length === 0) { const next = { ...prev }; delete next[activePhase]; return next; }
      return { ...prev, [activePhase]: buildPhaseConfig(pattern, lead, workers) };
    });
  }, [activePhase]);

  const handleReorderWorker = useCallback((from: number, to: number) => {
    setTemplatePhases(prev => {
      const cfg = prev[activePhase];
      const pattern = (cfg?.pattern as Pattern) ?? 'relay';
      const lead = phaseLead(cfg);
      const workers = [...phaseWorkers(cfg)];
      const [moved] = workers.splice(from, 1);
      workers.splice(to, 0, moved);
      return { ...prev, [activePhase]: buildPhaseConfig(pattern, lead, workers) };
    });
  }, [activePhase]);

  const handleSetPattern = useCallback((pattern: Pattern) => {
    setTemplatePhases(prev => {
      const cfg = prev[activePhase];
      const lead = phaseLead(cfg);
      const workers = phaseWorkers(cfg);
      return { ...prev, [activePhase]: buildPhaseConfig(pattern, lead, workers) };
    });
  }, [activePhase]);


  const personaLabels = useMemo(() => {
    const map: Record<string, string> = {};
    for (const p of personas) map[p.id] = p.label;
    return map;
  }, [personas]);

  const personaRoles = useMemo(() => {
    const map: Record<string, string> = {};
    for (const p of personas) map[p.id] = p.role;
    return map;
  }, [personas]);

  const hasChanges = useMemo(() => {
    if (creatingTemplate) return templateName.trim().length > 0;
    if (!activeTemplate) return false;
    return templateName !== activeTemplate.name || templateCliTarget !== activeTemplate.cliTarget || JSON.stringify(templatePhases) !== JSON.stringify(activeTemplate.phases);
  }, [creatingTemplate, activeTemplate, templateName, templateCliTarget, templatePhases]);

  // Current phase state
  const currentPhaseCfg = templatePhases[activePhase];
  const currentPattern = (currentPhaseCfg?.pattern as Pattern) ?? 'relay';
  const currentLead = phaseLead(currentPhaseCfg);
  const currentWorkers = phaseWorkers(currentPhaseCfg);
  const currentMembers = phaseMembers(currentPhaseCfg);
  const supportedPatterns = CLI_PATTERN_SUPPORT[templateCliTarget];

  // Handlers
  const handleDeleteTemplate = useCallback(async (t: WorkflowTemplate) => { if (!(await confirm({ title: `Delete "${t.name}"?`, tone: 'danger', confirmLabel: 'Delete' }))) return; try { await deleteWorkflow(t.id); await reloadTemplates(); if (activeTemplate?.id === t.id) { setActiveTemplate(null); setTemplateName(''); setTemplatePhases({}); } if (config) { let next: Config = config; if (config.defaultWorkflowId === t.id) next = { ...next, defaultWorkflowId: '' }; if (next !== config) { await saveConfig(next); setConfigState(next); } } } catch {} }, [reloadTemplates, config, activeTemplate, confirm]);
  const handleSetPhaseDefault = useCallback(async (phase: WorkflowPhase, variant: 'single' | 'multi', templateId: string) => {
    if (!config) return;
    const current = config.phaseDefaults?.[phase]?.[variant];
    const nextVal = current === templateId ? undefined : templateId;
    const phaseDefaults = { ...config.phaseDefaults, [phase]: { ...config.phaseDefaults?.[phase], [variant]: nextVal } };
    const next = { ...config, phaseDefaults };
    try { await saveConfig(next); setConfigState(next); } catch {}
  }, [config]);
  const handleSaveSkill = useCallback(async (updated: SkillDef) => { setSkillSaving(true); try { if (updated.path) { await updateDoc(updated.path, { title: updated.name, body: updated.body }); setSkills(prev => prev.map(s => (s.id === updated.id ? updated : s))); } else { const slug = updated.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, ''); const doc = await createDoc({ path: `skills/${slug}.md`, title: updated.name, body: updated.body }); setSkills(prev => [...prev, docToSkill(doc)]); } setEditingSkill(null); } catch {} finally { setSkillSaving(false); } }, []);
  const handleDeleteSkill = useCallback(async (skill: SkillDef) => { if (!(await confirm({ title: `Delete "${skill.name}"?`, tone: 'danger', confirmLabel: 'Delete' }))) return; try { await deleteDoc(skill.path); setSkills(prev => prev.filter(s => s.id !== skill.id)); setEditingSkill(null); } catch (err) { notify.error(`Failed to delete "${skill.name}": ${err instanceof Error ? err.message : String(err)}`); } }, [confirm, notify]);
  const toggleGuide = useCallback(() => {
    setGuideCollapsed(prev => {
      const next = !prev;
      try {
        localStorage.setItem(WORKFLOW_GUIDE_COLLAPSED_KEY, next ? '1' : '0');
      } catch {
        // ignore storage errors
      }
      return next;
    });
  }, []);

  // Compute whether current template is a default for the canvas phase
  const currentVariant: 'single' | 'multi' = currentMembers.length <= 1 ? 'single' : 'multi';
  const isCurrentDefault = activeTemplate && (
    config?.phaseDefaults?.[activePhase]?.[currentVariant] === activeTemplate.id
  );

  if (loading) {
    return (
      <div className="workflow-builder flex h-full flex-col gap-4 overflow-hidden p-5" aria-busy="true" aria-label="Loading workflows">
        <Skeleton variant="bar" className="h-6 w-1/3" />
        <div className="flex flex-1 gap-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <SkeletonCard key={i} className="flex-1" />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="workflow-builder h-full flex flex-col overflow-hidden">

      {/* Top explainer */}
      <div className="shrink-0 border-b border-gray-200/60 dark:border-white/[0.06]">
        {guideCollapsed ? (
          <button
            onClick={toggleGuide}
            className="w-full flex items-center gap-2 px-4 py-2 text-left hover:bg-gray-50 dark:hover:bg-white/[0.02] transition-all"
          >
            <BookOpen className="w-3.5 h-3.5 text-primary/80" />
            <span className="text-[11px] font-semibold text-gray-600 dark:text-gray-300">Show workflow quick guide</span>
            <ChevronDown className="ml-auto w-3.5 h-3.5 text-gray-400" />
          </button>
        ) : (
          <div className="px-4 py-2.5 bg-gray-50/50 dark:bg-white/[0.015]">
            <div className="flex items-start gap-3">
              <BookOpen className="w-4 h-4 mt-0.5 text-primary/80 shrink-0" />
              <div className="min-w-0 flex-1">
                <p className="text-[11px] font-semibold text-gray-700 dark:text-gray-200">Workflow guide</p>
                <p className="text-[10px] text-gray-500 dark:text-gray-400 mt-0.5">
                  Pick a phase tab, choose a template, then edit its mode and agents on the canvas. Star-marked chips on cards indicate phase defaults.
                </p>
              </div>
              <button
                onClick={toggleGuide}
                className="p-1.5 rounded-md text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 hover:bg-white/70 dark:hover:bg-white/10 transition-all"
                title="Collapse guide"
              >
                <ChevronUp className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>
        )}
      </div>

      {/* ═══ ZONE 1: PHASE EXPLORER (collapsible) ═══ */}
      <div className="shrink-0 border-b border-gray-200/60 dark:border-white/[0.06]">
        {explorerCollapsed ? (
          /* Collapsed: thin breadcrumb strip */
          <button
            onClick={() => setExplorerCollapsed(false)}
            className="w-full flex items-center gap-3 px-4 py-2 text-left hover:bg-gray-50 dark:hover:bg-white/[0.02] transition-all"
          >
            <div className={`w-2 h-2 rounded-full ${PHASE_DOT[explorerPhase]}`} />
            <span className="text-[11px] font-semibold text-gray-600 dark:text-gray-300">{PHASES.find(p => p.key === explorerPhase)?.label}</span>
            <span className="text-[10px] text-gray-400">- {templates.filter(t => phaseMembers(t.phases[explorerPhase]).length > 0).length} templates</span>
            <span className="ml-auto text-[10px] text-gray-400">Click to expand ▾</span>
          </button>
        ) : (
          /* Expanded: full explorer */
          <div className="px-4 pb-3 pt-2">
            {/* Phase tabs — clicking active phase collapses */}
            <div className="flex items-center gap-1 mb-3">
              {PHASES.map(({ key, label }) => {
                const isActive = explorerPhase === key;
                const phaseTemplateCount = templates.filter(t => phaseMembers(t.phases[key]).length > 0).length;
                return (
                  <button
                    key={key}
                    onClick={() => {
                      if (isActive) setExplorerCollapsed(true);
                      else setExplorerPhase(key);
                    }}
                    className={`flex items-center gap-2 px-4 py-2 rounded-xl text-[11px] font-semibold transition-all duration-200 ${
                      isActive
                        ? `bg-white dark:bg-white/[0.06] shadow-sm ring-1 ${PHASE_RING[key]} text-gray-800 dark:text-gray-100`
                        : 'text-gray-500 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-white/[0.03]'
                    }`}
                  >
                    <div className={`w-2 h-2 rounded-full ${PHASE_DOT[key]} ${isActive ? 'scale-125' : ''} transition-transform`} />
                    {label}
                    {phaseTemplateCount > 0 && (
                      <span className={`text-[9px] px-1.5 py-0.5 rounded-full font-bold ${isActive ? 'bg-primary/10 text-primary' : 'bg-gray-100 dark:bg-white/[0.06] text-gray-400'}`}>
                        {phaseTemplateCount}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>

            {/* Template cards — defaults first, then others, then + New */}
            <div className="flex gap-2 overflow-x-auto pb-2">
              {(() => {
                const phaseTemplates = templates.filter(t => phaseMembers(t.phases[explorerPhase]).length > 0);
                const singleDefaultId = config?.phaseDefaults?.[explorerPhase]?.single;
                const multiDefaultId = config?.phaseDefaults?.[explorerPhase]?.multi;

                const defaults = phaseTemplates.filter(t => singleDefaultId === t.id || multiDefaultId === t.id);
                const nonDefaults = phaseTemplates.filter(t => singleDefaultId !== t.id && multiDefaultId !== t.id);
                const sorted = [...defaults, ...nonDefaults];

                return sorted.map(t => {
                  const isLoaded = activeTemplate?.id === t.id && !creatingTemplate;
                  const isSingleDefault = singleDefaultId === t.id;
                  const isMultiDefault = multiDefaultId === t.id;
                  const isDefault = isSingleDefault || isMultiDefault;
                  const memberCount = phaseMembers(t.phases[explorerPhase]).length;
                  return (
                    <div key={t.id} className="shrink-0 relative group overflow-visible">
                      <button
                        onClick={() => selectTemplate(t)}
                        className={`wb-template-card wb-no-matrix-primary relative flex flex-col items-start gap-1.5 px-4 py-3 rounded-xl border transition-all duration-200 min-w-[168px] text-left ${
                          isLoaded
                            ? 'border-primary/80 bg-primary/[0.16] shadow-[0_0_0_1px_rgba(var(--eh-accent),0.28),inset_0_1px_0_rgba(255,255,255,0.09)]'
                            : isDefault
                              ? 'border-amber-300/70 bg-amber-400/[0.14]'
                              : 'border-gray-200/60 dark:border-white/[0.06] hover:border-gray-300 dark:hover:border-white/[0.1] bg-white/50 dark:bg-white/[0.02]'
                        }`}
                      >
                        <div className="flex items-start justify-between w-full gap-2">
                          <span className="text-[12px] font-semibold text-gray-800 dark:text-gray-100 truncate">{t.name}</span>
                        </div>
                        <div className="flex items-center gap-2 w-full">
                          <span className="text-[10px] text-gray-400">{memberCount} agent{memberCount !== 1 ? 's' : ''}</span>
                          <span className={`text-[9px] font-bold uppercase px-1.5 py-0.5 rounded ring-1 ${CLI_COLORS[t.cliTarget as CliTarget] ?? 'bg-gray-100 text-gray-500 ring-gray-300/40'}`}>{t.cliTarget}</span>
                          {isLoaded && <span className="wb-editing-chip text-[8px] uppercase tracking-wide font-bold text-primary bg-primary/15 border border-primary/35 px-1.5 py-0.5 rounded-full">Editing</span>}
                        </div>
                        {isDefault && (
                          <div className="absolute bottom-0 left-1/2 -translate-x-1/2 translate-y-1/2 z-30 flex items-center gap-1 whitespace-nowrap pointer-events-none">
                            {isSingleDefault && (
                              <span className="wb-default-chip inline-flex items-center gap-1 text-[8px] font-bold uppercase text-amber-800 dark:text-amber-200 bg-amber-400/30 border border-amber-300/60 px-1.5 py-0.5 rounded-full">
                                <Users className="w-2.5 h-2.5" /> Single Default ★
                              </span>
                            )}
                            {isMultiDefault && (
                              <span className="wb-default-chip inline-flex items-center gap-1 text-[8px] font-bold uppercase text-amber-800 dark:text-amber-200 bg-amber-400/30 border border-amber-300/60 px-1.5 py-0.5 rounded-full">
                                <Layers className="w-2.5 h-2.5" /> Multi Default ★
                              </span>
                            )}
                          </div>
                        )}
                      </button>
                      {/* Delete button on hover */}
                      {!t.builtIn && (
                        <button
                          onClick={e => { e.stopPropagation(); handleDeleteTemplate(t); }}
                          className="absolute -top-1.5 -right-1.5 w-5 h-5 rounded-full bg-red-500 text-white flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity shadow-sm"
                        >
                          <X className="w-3 h-3" />
                        </button>
                      )}
                    </div>
                  );
                });
              })()}
              {/* + New Template card */}
              <button
                onClick={startNewTemplate}
                className="wb-template-new shrink-0 flex flex-col items-center justify-center gap-1.5 px-4 py-3 rounded-xl border-2 border-dashed border-gray-300 dark:border-white/[0.08] hover:border-primary/40 hover:bg-primary/[0.02] transition-all min-w-[132px] min-h-[72px]"
              >
                <Plus className="w-4 h-4 text-gray-400" />
                <span className="text-[10px] font-medium text-gray-400">New</span>
              </button>
            </div>
          </div>
        )}
      </div>

      {/* ═══════════════════════════════════════════════════════════════════
          ZONE 2: CANVAS EDITOR (fills remaining space)
          Self-contained: shows full template identity + node graph
      ═══════════════════════════════════════════════════════════════════ */}
      <div className="flex-1 flex overflow-hidden min-h-0">
        {/* LEFT DOCK */}
        <div className="w-[220px] shrink-0 flex flex-col border-r border-gray-200/60 dark:border-white/[0.05] overflow-hidden">
          <div className="flex items-center gap-1 px-3 py-2 border-b border-gray-200/40 dark:border-white/[0.04]">
            <button onClick={() => setDockSection('personas')} className={`flex items-center gap-1 px-2 py-1 rounded-md text-[10px] font-semibold transition-all ${dockSection === 'personas' ? 'bg-white dark:bg-white/10 text-gray-800 dark:text-gray-100 shadow-sm' : 'text-gray-400 hover:text-gray-600'}`}>
              <Users className="w-3 h-3" /> Agents
            </button>
            <button onClick={() => setDockSection('skills')} className={`flex items-center gap-1 px-2 py-1 rounded-md text-[10px] font-semibold transition-all ${dockSection === 'skills' ? 'bg-white dark:bg-white/10 text-gray-800 dark:text-gray-100 shadow-sm' : 'text-gray-400 hover:text-gray-600'}`}>
              <BookOpen className="w-3 h-3" /> Skills
            </button>
          </div>
          <div className="flex-1 overflow-y-auto px-2 py-2">
            {dockSection === 'personas' && (
              <div className="space-y-2">
                {/* Legend */}
                <div className="flex items-center gap-2 px-1 py-1.5 rounded-lg bg-gray-50/50 dark:bg-white/[0.02]">
                  <span className="text-[9px] font-bold uppercase w-3.5 h-3.5 flex items-center justify-center rounded bg-amber-500/15 text-amber-500">L</span>
                  <span className="text-[9px] text-gray-400">Lead</span>
                  <span className="text-[9px] font-bold uppercase w-3.5 h-3.5 flex items-center justify-center rounded bg-blue-500/15 text-blue-500">W</span>
                  <span className="text-[9px] text-gray-400">Worker</span>
                  <span className="text-[9px] font-bold uppercase w-3.5 h-3.5 flex items-center justify-center rounded bg-gray-500/15 text-gray-400">F</span>
                  <span className="text-[9px] text-gray-400">Flex</span>
                </div>
                <button onClick={() => setCreatingPersona(true)} className="wb-new-persona w-full flex items-center justify-center gap-1.5 py-2 rounded-lg text-[10px] font-semibold text-primary border border-dashed border-primary/30 hover:bg-primary/[0.04] transition-all">
                  <Plus className="w-3 h-3" /> New Persona
                </button>
                {/* Flat persona list — sorted by role (leads first) */}
                <div className="space-y-0.5">
                  {personas
                    .slice()
                    .sort((a, b) => {
                      const roleOrder = { lead: 0, flex: 1, worker: 2 };
                      return (roleOrder[a.role] ?? 1) - (roleOrder[b.role] ?? 1);
                    })
                    .map(p => {
                      const inCurrentPhase = currentMembers.includes(p.id);
                      return (
                        <div
                          key={p.id}
                          draggable={!inCurrentPhase}
                          onDragStart={e => { e.dataTransfer.setData('persona-id', p.id); e.dataTransfer.effectAllowed = 'copy'; }}
                          className={`group flex items-center gap-2 px-2 py-1.5 rounded-lg transition-all duration-150 ${inCurrentPhase ? 'bg-primary/[0.06] border border-primary/20 cursor-default' : 'hover:bg-gray-50 dark:hover:bg-white/[0.03] cursor-grab active:cursor-grabbing border border-transparent'}`}
                        >
                          {!inCurrentPhase && <GripVertical className="w-3 h-3 text-gray-300 shrink-0" />}
                          {inCurrentPhase && <Check className="w-3 h-3 text-primary shrink-0" />}
                          <span className={`text-[10px] font-bold uppercase w-3.5 h-3.5 flex items-center justify-center rounded shrink-0 ${p.role === 'lead' ? 'bg-amber-500/15 text-amber-500' : p.role === 'worker' ? 'bg-blue-500/15 text-blue-500' : 'bg-gray-500/15 text-gray-400'}`}>{p.role[0].toUpperCase()}</span>
                          <span className={`text-[11px] font-medium flex-1 truncate ${inCurrentPhase ? 'text-primary' : 'text-gray-700 dark:text-gray-200'}`}>{p.label}</span>
                          <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                            <button onClick={() => setEditingPersona(p)} title={p.builtIn ? 'View' : 'Edit'} className="p-0.5 rounded text-gray-400 hover:text-primary">
                              {p.builtIn ? <Eye className="w-3 h-3" /> : <Pencil className="w-3 h-3" />}
                            </button>
                          </div>
                        </div>
                      );
                    })}
                </div>
              </div>
            )}
            {dockSection === 'skills' && (
              <div className="space-y-1">
                <button onClick={() => setEditingSkill({ id: '', name: 'New Skill', body: '', path: '' })} className="w-full flex items-center justify-center gap-1.5 py-2 rounded-lg text-[10px] font-semibold text-primary border border-dashed border-primary/30 hover:bg-primary/[0.04] transition-all mb-2">
                  <Plus className="w-3 h-3" /> New Skill
                </button>
                {skills.length === 0 && (
                  <div className="text-center py-6 px-3">
                    <BookOpen className="w-8 h-8 mx-auto mb-2 text-gray-300 dark:text-gray-600" />
                    <p className="text-[11px] text-gray-500 dark:text-gray-400 font-medium mb-1">No skills yet</p>
                    <p className="text-[10px] text-gray-400 dark:text-gray-500 leading-relaxed">
                      Skills are reusable prompt templates that agents can reference. Create one above to get started.
                    </p>
                  </div>
                )}
                {skills.map(skill => (
                  <div key={skill.id} onClick={() => setEditingSkill(skill)} className={`group flex items-center gap-2 px-2 py-2 rounded-lg cursor-pointer transition-all ${editingSkill?.id === skill.id ? 'bg-primary/[0.06] text-primary' : 'hover:bg-gray-50 dark:hover:bg-white/[0.03] text-gray-700 dark:text-gray-200'}`}>
                    <BookOpen className="w-3 h-3 shrink-0 opacity-50" />
                    <span className="text-[11px] font-medium flex-1 truncate">{skill.name}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* CENTER — either Template Canvas or Skill Editor */}
        <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
          {editingSkill ? (
            /* Skill editor replaces the canvas */
            <SkillInlineEditor skill={editingSkill} onClose={() => setEditingSkill(null)} onSave={handleSaveSkill} onDelete={editingSkill.path ? () => handleDeleteSkill(editingSkill) : undefined} isSaving={skillSaving} />
          ) : (
            /* Template canvas */
            <>
              {/* Canvas header — full template identity */}
              <div className="shrink-0 px-5 pt-3 pb-2 border-b border-gray-200/40 dark:border-white/[0.04]">
                <div className="flex items-center gap-3 mb-2">
                  <Workflow className="w-4 h-4 text-primary shrink-0" />
                  <input
                    value={templateName}
                    onChange={e => setTemplateName(e.target.value)}
                    placeholder="Untitled template…"
                    className="flex-1 min-w-0 bg-transparent text-base font-bold text-gray-800 dark:text-gray-100 outline-none border-b border-transparent hover:border-gray-300 dark:hover:border-white/[0.1] focus:border-primary/50 transition-colors placeholder:text-gray-300 dark:placeholder:text-gray-600 pb-0.5"
                  />
                  <div className={`wb-phase-pill flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-[10px] font-semibold shrink-0 ring-1 ${PHASE_RING[activePhase]} bg-white/50 dark:bg-white/[0.03]`}>
                    <div className={`w-2 h-2 rounded-full ${PHASE_DOT[activePhase]}`} />
                    {PHASES.find(p => p.key === activePhase)?.label}
                  </div>
                  <div className="flex gap-0.5 p-0.5 rounded-lg bg-gray-100/60 dark:bg-white/[0.04] ring-1 ring-black/[0.03] dark:ring-white/[0.05] shrink-0">
                    {(['claude', 'gemini', 'copilot', 'all'] as CliTarget[]).map(cli => (
                      <button key={cli} onClick={() => setTemplateCliTarget(cli)} className={`wb-cli-pill px-2 py-1 rounded-md text-[9px] font-bold uppercase transition-all duration-200 ${templateCliTarget === cli ? CLI_SEGMENT_ACTIVE[cli] + ' ring-1' : 'text-gray-400 hover:text-gray-600 dark:hover:text-gray-300'}`}>
                        {cli}
                      </button>
                    ))}
                  </div>
                  {activeTemplate && !creatingTemplate && (
                    <button
                      onClick={() => handleSetPhaseDefault(activePhase, currentVariant, activeTemplate.id)}
                      className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[10px] font-semibold transition-all duration-200 shrink-0 ${isCurrentDefault ? 'bg-amber-500/10 text-amber-600 dark:text-amber-400 ring-1 ring-amber-500/20' : 'text-gray-400 hover:text-amber-600 dark:hover:text-amber-400 hover:bg-amber-500/5 border border-gray-200/60 dark:border-white/[0.06]'}`}
                    >
                      <span className="text-[12px]">{isCurrentDefault ? '★' : '☆'}</span>
                      {isCurrentDefault ? `${currentVariant === 'single' ? 'Single' : 'Multi'} Default` : 'Set as Default'}
                    </button>
                  )}
                  <button
                    onClick={handleSaveTemplate}
                    disabled={templateSaving || !templateName.trim() || !hasChanges}
                    className={`flex items-center gap-1.5 px-3.5 py-1.5 rounded-full text-[11px] font-semibold transition-all duration-300 active:scale-[0.97] shrink-0 ${hasChanges ? 'bg-primary text-white hover:bg-primary-hover shadow-[0_2px_8px_rgba(var(--eh-accent),0.2)]' : 'bg-gray-100 dark:bg-white/[0.04] text-gray-400 cursor-default'} disabled:opacity-50`}
                  >
                    {templateSaving ? <Loader2 className="w-3 h-3 animate-spin" /> : <Check className="w-3 h-3" />}
                    {creatingTemplate ? 'Create' : 'Save'}
                  </button>
                </div>
                <div className="flex items-center gap-1.5">
                  <span className="text-[9px] font-bold uppercase tracking-[0.06em] text-gray-400 mr-1">Mode</span>
                  {PATTERNS.map(p => {
                    const Icon = p.icon;
                    const supported = supportedPatterns.includes(p.key);
                    const active = currentPattern === p.key;
                    return (
                      <button key={p.key} disabled={!supported} onClick={() => handleSetPattern(p.key)} title={p.description} className={`wb-mode-pill wb-no-matrix-primary flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-[10px] font-semibold transition-all duration-200 ${active ? 'bg-primary/20 text-primary ring-1 ring-primary/45 shadow-[inset_0_1px_0_rgba(255,255,255,0.07)]' : 'text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 hover:bg-gray-50 dark:hover:bg-white/[0.04]'} disabled:opacity-25 disabled:cursor-not-allowed`}>
                        <Icon className="w-3 h-3" /> {p.label}
                      </button>
                    );
                  })}
                  {creatingTemplate && <span className="ml-2 text-[9px] text-primary font-medium">New template, configure and save</span>}
                </div>
              </div>
              {/* Node graph */}
              <div className="flex-1 flex p-4 overflow-auto">
                <NodeGraph
                  pattern={currentPattern}
                  lead={currentLead}
                  workers={currentWorkers}
                  personaLabels={personaLabels}
                  personaRoles={personaRoles}
                  onRemoveLead={handleRemoveLead}
                  onRemoveWorker={handleRemoveWorker}
                  onReorderWorker={handleReorderWorker}
                  onDropLead={handleDropLead}
                  onDropWorker={handleDropWorker}
                />
              </div>
            </>
          )}
        </div>
      </div>

      {/* Persona modal */}
      {(creatingPersona || editingPersona) && (
        <PersonaEditPanel initial={editingPersona} onClose={() => { setCreatingPersona(false); setEditingPersona(null); }} onSaved={() => { setCreatingPersona(false); setEditingPersona(null); reloadPersonas(); }} />
      )}
    </div>
  );
}
