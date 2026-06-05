import { useState, useCallback, useEffect, useMemo, useRef } from 'react';
import {
  Workflow, Plus, X, Pencil, Loader2, BookOpen, Check, Users, Lock, Copy, Eye,
  GitBranch, Layers, GitMerge, Zap, GripVertical,
} from 'lucide-react';
import {
  fetchOrchestrationPersonas,
  fetchEditablePersona,
  createPersona,
  updatePersona,
  deletePersona,
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
  type PersonaInput,
  type WorkflowTemplate,
  type WorkflowPhaseConfig,
  type WorkflowPhase,
} from '../api';
import type { Config, Doc } from '../types';

// --- Constants ---

const PHASES: { key: WorkflowPhase; label: string }[] = [
  { key: 'grooming', label: 'Grooming' },
  { key: 'implementation', label: 'Implementation' },
  { key: 'review', label: 'Review' },
  { key: 'finalize', label: 'Finalize' },
];

type Pattern = 'relay' | 'scatter' | 'supervisor';
type CliTarget = 'claude' | 'gemini' | 'copilot';

const PATTERNS: { key: Pattern; label: string; description: string; icon: typeof GitBranch }[] = [
  { key: 'relay', label: 'Relay', description: 'Sequential pipeline A → B → C', icon: GitBranch },
  { key: 'scatter', label: 'Scatter-Gather', description: 'Parallel execution, then combine', icon: Layers },
  { key: 'supervisor', label: 'Supervisor', description: 'Lead coordinates assistants', icon: GitMerge },
];

const CLI_PATTERN_SUPPORT: Record<CliTarget, Pattern[]> = {
  claude: ['relay', 'scatter', 'supervisor'],
  gemini: ['relay', 'scatter'],
  copilot: ['relay', 'scatter'],
};

const CLI_COLORS: Record<CliTarget, string> = {
  claude: 'bg-orange-500/15 text-orange-400 ring-orange-500/20',
  gemini: 'bg-blue-500/15 text-blue-400 ring-blue-500/20',
  copilot: 'bg-emerald-500/15 text-emerald-400 ring-emerald-500/20',
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

function phaseMembers(cfg: WorkflowPhaseConfig | undefined): string[] {
  if (!cfg) return [];
  if (cfg.pattern === 'relay') return cfg.steps ?? [];
  if (cfg.pattern === 'supervisor') return cfg.assistants ?? [];
  return cfg.parallel ?? [];
}

function buildPhaseConfig(pattern: Pattern, memberIds: string[]): WorkflowPhaseConfig {
  if (pattern === 'relay') return { pattern, steps: memberIds };
  if (pattern === 'supervisor') return { pattern, assistants: memberIds };
  return { pattern, parallel: memberIds };
}

// ============================================================================
// Node Graph Canvas — renders orchestration flow for a single phase
// ============================================================================

function NodeGraph({
  pattern,
  members,
  personaLabels,
  onRemoveMember,
  onReorderMember,
  onDrop,
}: {
  pattern: Pattern;
  members: string[];
  personaLabels: Record<string, string>;
  onRemoveMember: (id: string) => void;
  onReorderMember: (from: number, to: number) => void;
  onDrop: (personaId: string) => void;
}) {
  const canvasRef = useRef<HTMLDivElement>(null);
  const [dragOver, setDragOver] = useState(false);
  const [draggingIdx, setDraggingIdx] = useState<number | null>(null);

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    setDragOver(true);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const personaId = e.dataTransfer.getData('persona-id');
    if (personaId && !members.includes(personaId)) {
      onDrop(personaId);
    }
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
      onReorderMember(fromIdx, targetIdx);
    }
    setDraggingIdx(null);
  };

  if (members.length === 0) {
    return (
      <div
        ref={canvasRef}
        onDragOver={handleDragOver}
        onDragLeave={() => setDragOver(false)}
        onDrop={handleDrop}
        className={`flex-1 flex items-center justify-center rounded-2xl border-2 border-dashed transition-all duration-300 ${
          dragOver
            ? 'border-primary/50 bg-primary/[0.04] scale-[1.01]'
            : 'border-gray-200/60 dark:border-white/[0.06]'
        }`}
      >
        <div className="text-center py-16 px-8 max-w-sm">
          <div className="w-14 h-14 mx-auto mb-4 rounded-2xl bg-gray-100 dark:bg-white/[0.04] flex items-center justify-center">
            <GripVertical className="w-6 h-6 text-gray-300 dark:text-gray-600" />
          </div>
          <p className="text-base text-gray-500 dark:text-gray-400 font-semibold mb-1">Drop agents here</p>
          <p className="text-[12px] text-gray-400 dark:text-gray-500 leading-relaxed">
            Drag personas from the left panel into this canvas to build the pipeline for this phase.
            Choose a mode above to set how they coordinate.
          </p>
        </div>
      </div>
    );
  }

  // Relay: linear chain with arrows
  if (pattern === 'relay') {
    return (
      <div
        ref={canvasRef}
        onDragOver={handleDragOver}
        onDragLeave={() => setDragOver(false)}
        onDrop={handleDrop}
        className={`flex-1 flex items-center justify-center px-8 py-6 rounded-2xl border transition-all duration-300 ${
          dragOver ? 'border-primary/50 bg-primary/[0.03]' : 'border-gray-200/40 dark:border-white/[0.04] bg-gray-50/30 dark:bg-white/[0.01]'
        }`}
      >
        <div className="flex items-center gap-0 flex-wrap justify-center">
          {/* Start node */}
          <div className="w-10 h-10 rounded-full bg-primary/10 ring-1 ring-primary/20 flex items-center justify-center shrink-0">
            <Zap className="w-4 h-4 text-primary" />
          </div>
          {members.map((id, i) => (
            <div key={`${id}-${i}`} className="flex items-center">
              {/* Connector arrow */}
              <svg width="40" height="20" viewBox="0 0 40 20" className="shrink-0 mx-0.5">
                <line x1="0" y1="10" x2="32" y2="10" stroke="var(--eh-accent)" strokeWidth="1.5" strokeOpacity="0.4" />
                <polygon points="30,6 38,10 30,14" fill="var(--eh-accent)" fillOpacity="0.5" />
                <circle r="2" fill="var(--eh-accent)" opacity="0.7">
                  <animateMotion dur="1.5s" repeatCount="indefinite" path="M0,10 H32" />
                </circle>
              </svg>
              {/* Agent node */}
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
                <button
                  onClick={() => onRemoveMember(id)}
                  className="absolute -top-1.5 -right-1.5 w-4 h-4 rounded-full bg-red-500 text-white flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity shadow-sm"
                >
                  <X className="w-2.5 h-2.5" />
                </button>
              </div>
            </div>
          ))}
          {/* End connector */}
          <svg width="40" height="20" viewBox="0 0 40 20" className="shrink-0 mx-0.5">
            <line x1="0" y1="10" x2="32" y2="10" stroke="var(--eh-accent)" strokeWidth="1.5" strokeOpacity="0.4" />
            <polygon points="30,6 38,10 30,14" fill="var(--eh-accent)" fillOpacity="0.5" />
          </svg>
          {/* End node */}
          <div className="w-10 h-10 rounded-full bg-emerald-500/10 ring-1 ring-emerald-500/20 flex items-center justify-center shrink-0">
            <Check className="w-4 h-4 text-emerald-500" />
          </div>
        </div>
      </div>
    );
  }

  // Scatter: fan-out from start, fan-in to end
  if (pattern === 'scatter') {
    return (
      <div
        ref={canvasRef}
        onDragOver={handleDragOver}
        onDragLeave={() => setDragOver(false)}
        onDrop={handleDrop}
        className={`flex-1 flex items-center justify-center px-8 py-6 rounded-2xl border transition-all duration-300 ${
          dragOver ? 'border-primary/50 bg-primary/[0.03]' : 'border-gray-200/40 dark:border-white/[0.04] bg-gray-50/30 dark:bg-white/[0.01]'
        }`}
      >
        <div className="flex items-center">
          {/* Start node */}
          <div className="w-10 h-10 rounded-full bg-primary/10 ring-1 ring-primary/20 flex items-center justify-center shrink-0">
            <Zap className="w-4 h-4 text-primary" />
          </div>

          {/* Fan-out lines + parallel nodes */}
          <div className="relative mx-4">
            {/* SVG connections */}
            <svg className="absolute inset-0 w-full h-full pointer-events-none overflow-visible" preserveAspectRatio="none">
              {members.map((_, i) => {
                const totalH = members.length * 56;
                const y = (i * 56) + 28;
                const startY = totalH / 2;
                return (
                  <g key={i}>
                    <path
                      d={`M-20,${startY} C0,${startY} 0,${y} 20,${y}`}
                      stroke="var(--eh-accent)"
                      strokeWidth="1.5"
                      strokeOpacity="0.3"
                      fill="none"
                    />
                    <path
                      d={`M${220},${y} C${240},${y} ${240},${startY} ${260},${startY}`}
                      stroke="var(--eh-accent)"
                      strokeWidth="1.5"
                      strokeOpacity="0.3"
                      fill="none"
                    />
                  </g>
                );
              })}
            </svg>
            {/* Nodes */}
            <div className="flex flex-col gap-2 relative z-10 mx-6">
              {members.map((id, i) => (
                <div
                  key={`${id}-${i}`}
                  className="group relative flex items-center gap-2 px-4 py-2.5 rounded-xl border border-gray-200/60 dark:border-white/[0.08] bg-white dark:bg-[#1c1c1a] shadow-[0_2px_8px_rgba(0,0,0,0.04)] dark:shadow-[0_2px_8px_rgba(0,0,0,0.2)] hover:border-primary/30 transition-all duration-200"
                >
                  <Layers className="w-3 h-3 text-gray-300 shrink-0" />
                  <span className="text-[11px] font-semibold text-gray-800 dark:text-gray-100 truncate">{personaLabels[id] ?? id}</span>
                  <button
                    onClick={() => onRemoveMember(id)}
                    className="absolute -top-1.5 -right-1.5 w-4 h-4 rounded-full bg-red-500 text-white flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity shadow-sm"
                  >
                    <X className="w-2.5 h-2.5" />
                  </button>
                </div>
              ))}
            </div>
          </div>

          {/* End node */}
          <div className="w-10 h-10 rounded-full bg-emerald-500/10 ring-1 ring-emerald-500/20 flex items-center justify-center shrink-0">
            <GitMerge className="w-4 h-4 text-emerald-500" />
          </div>
        </div>
      </div>
    );
  }

  // Supervisor: hub-and-spoke
  return (
    <div
      ref={canvasRef}
      onDragOver={handleDragOver}
      onDragLeave={() => setDragOver(false)}
      onDrop={handleDrop}
      className={`flex-1 flex items-center justify-center px-8 py-6 rounded-2xl border transition-all duration-300 ${
        dragOver ? 'border-primary/50 bg-primary/[0.03]' : 'border-gray-200/40 dark:border-white/[0.04] bg-gray-50/30 dark:bg-white/[0.01]'
      }`}
    >
      <div className="relative flex items-center justify-center" style={{ minHeight: Math.max(200, members.length * 52) }}>
        {/* Supervisor hub (first member or labeled) */}
        <div className="relative z-10 flex flex-col items-center gap-2 px-5 py-4 rounded-2xl border-2 border-primary/30 bg-primary/[0.04] dark:bg-primary/[0.06]">
          <GitMerge className="w-5 h-5 text-primary" />
          <span className="text-[10px] font-bold text-primary uppercase tracking-wide">Supervisor</span>
          {members[0] && (
            <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white dark:bg-[#1c1c1a] border border-gray-200/60 dark:border-white/[0.08]">
              <span className="text-[11px] font-semibold text-gray-800 dark:text-gray-100">{personaLabels[members[0]] ?? members[0]}</span>
              <button onClick={() => onRemoveMember(members[0])} className="text-gray-400 hover:text-red-500 transition-colors">
                <X className="w-3 h-3" />
              </button>
            </div>
          )}
        </div>

        {/* Assistant spokes */}
        {members.length > 1 && (
          <div className="ml-8 flex flex-col gap-2">
            {members.slice(1).map((id, i) => (
              <div key={`${id}-${i}`} className="flex items-center gap-2">
                <svg width="32" height="2" className="shrink-0">
                  <line x1="0" y1="1" x2="32" y2="1" stroke="var(--eh-accent)" strokeWidth="1" strokeOpacity="0.3" strokeDasharray="4 2" />
                </svg>
                <div className="group relative flex items-center gap-2 px-3 py-2 rounded-xl border border-gray-200/60 dark:border-white/[0.08] bg-white dark:bg-[#1c1c1a] shadow-sm hover:border-primary/30 transition-all duration-200">
                  <span className="text-[11px] font-medium text-gray-700 dark:text-gray-200 truncate">{personaLabels[id] ?? id}</span>
                  <button
                    onClick={() => onRemoveMember(id)}
                    className="absolute -top-1 -right-1 w-4 h-4 rounded-full bg-red-500 text-white flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity shadow-sm"
                  >
                    <X className="w-2.5 h-2.5" />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
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
  const [phase, setPhase] = useState<WorkflowPhase>((initial?.phase as WorkflowPhase) ?? 'review');
  const [patterns, setPatterns] = useState<string[]>(initial?.compatiblePatterns ?? []);
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
  const togglePattern = (p: string) => setPatterns(prev => (prev.includes(p) ? prev.filter(x => x !== p) : [...prev, p]));

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    try {
      if (creating) await createPersona({ id, label: label.trim(), description: description.trim(), phase, compatiblePatterns: patterns, requiredCapabilities: [], prompt });
      else await updatePersona(initial!.id, { id, label: label.trim(), description: description.trim(), phase, compatiblePatterns: patterns, requiredCapabilities: [], prompt });
      onSaved();
    } catch (err: any) { setError(err?.message || 'Failed to save'); }
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
            <label className="text-[10px] font-bold text-gray-500 dark:text-gray-400 uppercase tracking-[0.08em]">Phase</label>
            <div className="mt-1.5 flex gap-1.5 flex-wrap">
              {PHASES.map(p => (
                <button key={p.key} onClick={() => setPhase(p.key)} disabled={readOnly} className={`px-3 py-1.5 rounded-lg text-[11px] font-bold transition-all duration-200 disabled:opacity-60 disabled:cursor-not-allowed ${phase === p.key ? 'bg-primary text-white' : 'bg-gray-100 dark:bg-white/10 text-gray-500 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-white/20'}`}>
                  {p.label}
                </button>
              ))}
            </div>
          </div>
          <div>
            <label className="text-[10px] font-bold text-gray-500 dark:text-gray-400 uppercase tracking-[0.08em]">Compatible Patterns</label>
            <div className="mt-1.5 flex gap-1.5 flex-wrap">
              {PATTERNS.map(p => (
                <button key={p.key} onClick={() => togglePattern(p.key)} disabled={readOnly} title={p.description} className={`px-3 py-1.5 rounded-lg text-[11px] font-bold transition-all duration-200 disabled:opacity-60 disabled:cursor-not-allowed ${patterns.includes(p.key) ? 'bg-primary/10 text-primary ring-1 ring-primary/20' : 'bg-gray-100 dark:bg-white/10 text-gray-500 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-white/20'}`}>
                  {p.label}
                </button>
              ))}
            </div>
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

export function WorkflowBuilder() {
  const [personas, setPersonas] = useState<OrchestrationPersonaMeta[]>([]);
  const [templates, setTemplates] = useState<WorkflowTemplate[]>([]);
  const [config, setConfigState] = useState<Config | null>(null);
  const [skills, setSkills] = useState<SkillDef[]>([]);
  const [loading, setLoading] = useState(true);
  const [skillSaving, setSkillSaving] = useState(false);

  // Active state
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
  }, []);

  const startNewTemplate = useCallback(() => {
    setActiveTemplate(null);
    setTemplateName('');
    setTemplateCliTarget('claude');
    setTemplatePhases({});
    setCreatingTemplate(true);
  }, []);

  const handleSaveTemplate = useCallback(async () => {
    setTemplateSaving(true);
    const supportedPatterns = CLI_PATTERN_SUPPORT[templateCliTarget];
    const cleaned: Partial<Record<WorkflowPhase, WorkflowPhaseConfig>> = {};
    for (const { key } of PHASES) {
      const cfg = templatePhases[key];
      if (!cfg || phaseMembers(cfg).length === 0) continue;
      const pattern = supportedPatterns.includes(cfg.pattern as Pattern) ? (cfg.pattern as Pattern) : 'relay';
      cleaned[key] = buildPhaseConfig(pattern, phaseMembers(cfg));
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

  // Phase-level actions
  const handleAddToPhase = useCallback((personaId: string) => {
    setTemplatePhases(prev => {
      const cfg = prev[activePhase];
      const pattern = (cfg?.pattern as Pattern) ?? 'relay';
      const members = phaseMembers(cfg);
      if (members.includes(personaId)) return prev;
      return { ...prev, [activePhase]: buildPhaseConfig(pattern, [...members, personaId]) };
    });
  }, [activePhase]);

  const handleRemoveFromPhase = useCallback((personaId: string) => {
    setTemplatePhases(prev => {
      const cfg = prev[activePhase];
      const pattern = (cfg?.pattern as Pattern) ?? 'relay';
      const members = phaseMembers(cfg).filter(m => m !== personaId);
      if (members.length === 0) { const next = { ...prev }; delete next[activePhase]; return next; }
      return { ...prev, [activePhase]: buildPhaseConfig(pattern, members) };
    });
  }, [activePhase]);

  const handleReorder = useCallback((from: number, to: number) => {
    setTemplatePhases(prev => {
      const cfg = prev[activePhase];
      const pattern = (cfg?.pattern as Pattern) ?? 'relay';
      const members = [...phaseMembers(cfg)];
      const [moved] = members.splice(from, 1);
      members.splice(to, 0, moved);
      return { ...prev, [activePhase]: buildPhaseConfig(pattern, members) };
    });
  }, [activePhase]);

  const handleSetPattern = useCallback((pattern: Pattern) => {
    setTemplatePhases(prev => {
      const cfg = prev[activePhase];
      const members = phaseMembers(cfg);
      return { ...prev, [activePhase]: buildPhaseConfig(pattern, members) };
    });
  }, [activePhase]);

  const personasByPhase = useMemo(() => {
    const map: Record<WorkflowPhase, OrchestrationPersonaMeta[]> = { grooming: [], implementation: [], review: [], finalize: [] };
    for (const p of personas) { if (map[p.phase as WorkflowPhase]) map[p.phase as WorkflowPhase].push(p); }
    return map;
  }, [personas]);

  const personaLabels = useMemo(() => {
    const map: Record<string, string> = {};
    for (const p of personas) map[p.id] = p.label;
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
  const currentMembers = phaseMembers(currentPhaseCfg);
  const supportedPatterns = CLI_PATTERN_SUPPORT[templateCliTarget];

  // Handlers
  const handleDeletePersona = useCallback(async (p: OrchestrationPersonaMeta) => { if (!window.confirm(`Delete persona "${p.label}"?`)) return; try { await deletePersona(p.id); await reloadPersonas(); } catch {} }, [reloadPersonas]);
  const handleDuplicatePersona = useCallback(async (p: OrchestrationPersonaMeta) => { try { const full = await fetchEditablePersona(p.id); const copy = await createPersona({ label: `${p.label} (Copy)`, description: p.description, phase: p.phase, compatiblePatterns: p.compatiblePatterns ?? [], requiredCapabilities: [], prompt: full.prompt }); await reloadPersonas(); setEditingPersona(copy); } catch {} }, [reloadPersonas]);
  const handleDeleteTemplate = useCallback(async (t: WorkflowTemplate) => { if (!window.confirm(`Delete "${t.name}"?`)) return; try { await deleteWorkflow(t.id); await reloadTemplates(); if (activeTemplate?.id === t.id) { setActiveTemplate(null); setTemplateName(''); setTemplatePhases({}); } if (config) { let next: Config = config; if (config.defaultWorkflowId === t.id) next = { ...next, defaultWorkflowId: '' }; if (next !== config) { await saveConfig(next); setConfigState(next); } } } catch {} }, [reloadTemplates, config, activeTemplate]);
  const handleSetPhaseDefault = useCallback(async (phase: WorkflowPhase, variant: 'single' | 'multi', templateId: string) => {
    if (!config) return;
    const current = config.phaseDefaults?.[phase]?.[variant];
    const nextVal = current === templateId ? undefined : templateId;
    const phaseDefaults = { ...config.phaseDefaults, [phase]: { ...config.phaseDefaults?.[phase], [variant]: nextVal } };
    const next = { ...config, phaseDefaults };
    try { await saveConfig(next); setConfigState(next); } catch {}
  }, [config]);
  const handleSaveSkill = useCallback(async (updated: SkillDef) => { setSkillSaving(true); try { if (updated.path) { await updateDoc(updated.path, { title: updated.name, body: updated.body }); setSkills(prev => prev.map(s => (s.id === updated.id ? updated : s))); } else { const slug = updated.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, ''); const doc = await createDoc({ path: `skills/${slug}.md`, title: updated.name, body: updated.body }); setSkills(prev => [...prev, docToSkill(doc)]); } setEditingSkill(null); } catch {} finally { setSkillSaving(false); } }, []);
  const handleDeleteSkill = useCallback(async (skill: SkillDef) => { if (!window.confirm(`Delete "${skill.name}"?`)) return; try { await deleteDoc(skill.path); setSkills(prev => prev.filter(s => s.id !== skill.id)); setEditingSkill(null); } catch {} }, []);
  const handleDuplicateSkill = useCallback(async (skill: SkillDef) => { try { const slug = `${skill.path.replace(/^skills\//, '').replace(/\.md$/, '')}-copy`; const doc = await createDoc({ path: `skills/${slug}.md`, title: `${skill.name} (Copy)`, body: skill.body }); const copy = docToSkill(doc); setSkills(prev => [...prev, copy]); setEditingSkill(copy); } catch {} }, []);

  // Compute whether current template is a default for this phase
  const currentVariant: 'single' | 'multi' = currentMembers.length <= 1 ? 'single' : 'multi';
  const isCurrentDefault = activeTemplate && (
    config?.phaseDefaults?.[activePhase]?.[currentVariant] === activeTemplate.id
  );

  if (loading) return <div className="h-full flex items-center justify-center"><Loader2 className="w-6 h-6 animate-spin text-gray-400" /></div>;

  return (
    <div className="h-full flex flex-col overflow-hidden">
      {/* ═══ TOP: Phase tabs + preset selector ═══ */}
      <div className="shrink-0 flex items-center gap-1 px-1 py-1.5 border-b border-gray-200/40 dark:border-white/[0.04]">
        {PHASES.map(({ key, label }) => {
          const cfg = templatePhases[key];
          const members = phaseMembers(cfg);
          const isActive = activePhase === key;
          return (
            <button
              key={key}
              onClick={() => setActivePhase(key)}
              className={`flex items-center gap-2 px-4 py-2 rounded-xl text-[11px] font-semibold transition-all duration-200 ${
                isActive
                  ? `bg-white dark:bg-white/[0.06] shadow-sm ring-1 ${PHASE_RING[key]} text-gray-800 dark:text-gray-100`
                  : 'text-gray-500 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-white/[0.03]'
              }`}
            >
              <div className={`w-2 h-2 rounded-full ${PHASE_DOT[key]} ${isActive ? 'scale-125' : ''} transition-transform`} />
              {label}
              {members.length > 0 && (
                <span className={`text-[9px] px-1.5 py-0.5 rounded-full font-bold ${isActive ? 'bg-primary/10 text-primary' : 'bg-gray-100 dark:bg-white/[0.06] text-gray-400'}`}>
                  {members.length}
                </span>
              )}
            </button>
          );
        })}
        {/* Preset selector — right side */}
        <div className="ml-auto flex items-center gap-1.5 pl-3 border-l border-gray-200/40 dark:border-white/[0.04]">
          {templates.filter(t => phaseMembers(t.phases[activePhase]).length > 0).map(t => {
            const isSelected = activeTemplate?.id === t.id && !creatingTemplate;
            const singleDefaultId = config?.phaseDefaults?.[activePhase]?.single;
            const multiDefaultId = config?.phaseDefaults?.[activePhase]?.multi;
            const isDefault = singleDefaultId === t.id || multiDefaultId === t.id;
            return (
              <button key={t.id} onClick={() => selectTemplate(t)} className={`shrink-0 flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-[10px] font-medium transition-all duration-200 border ${isSelected ? 'border-primary/40 bg-primary/[0.05] text-primary' : isDefault ? 'border-amber-400/30 bg-amber-400/[0.03] text-gray-600 dark:text-gray-300' : 'border-transparent text-gray-500 hover:bg-gray-50 dark:hover:bg-white/[0.03]'}`}>
                {isDefault && <span className="text-amber-500 text-[9px]">★</span>}
                {t.name}
              </button>
            );
          })}
          {creatingTemplate && (
            <span className="shrink-0 flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-[10px] font-medium border border-primary/40 bg-primary/[0.05] text-primary">
              <Zap className="w-3 h-3" />{templateName.trim() || 'Untitled'}
            </span>
          )}
          <button onClick={startNewTemplate} className="shrink-0 p-1.5 rounded-lg text-gray-400 hover:text-primary hover:bg-gray-50 dark:hover:bg-white/[0.04] transition-all">
            <Plus className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* ═══ MAIN: Dock | Canvas | Skill editor ═══ */}
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
              <div className="space-y-3">
                <button onClick={() => setCreatingPersona(true)} className="w-full flex items-center justify-center gap-1.5 py-2 rounded-lg text-[10px] font-semibold text-primary border border-dashed border-primary/30 hover:bg-primary/[0.04] transition-all">
                  <Plus className="w-3 h-3" /> New Persona
                </button>
                {PHASES.map(({ key, label }) => {
                  const phasePersonas = personasByPhase[key];
                  if (phasePersonas.length === 0) return null;
                  const isActivePhase = key === activePhase;
                  return (
                    <div key={key}>
                      <div className="flex items-center gap-1.5 mb-1 px-1">
                        <div className={`w-1.5 h-1.5 rounded-full ${PHASE_DOT[key]}`} />
                        <span className="text-[9px] font-bold uppercase tracking-[0.08em] text-gray-400">{label}</span>
                      </div>
                      <div className="space-y-0.5">
                        {phasePersonas.map(p => {
                          const inCurrentPhase = currentMembers.includes(p.id);
                          return (
                            <div
                              key={p.id}
                              draggable={isActivePhase}
                              onDragStart={e => { e.dataTransfer.setData('persona-id', p.id); e.dataTransfer.effectAllowed = 'copy'; }}
                              className={`group flex items-center gap-2 px-2 py-1.5 rounded-lg transition-all duration-150 ${isActivePhase ? inCurrentPhase ? 'bg-primary/[0.06] border border-primary/20 cursor-default' : 'hover:bg-gray-50 dark:hover:bg-white/[0.03] cursor-grab active:cursor-grabbing border border-transparent' : 'opacity-50 cursor-default border border-transparent'}`}
                            >
                              {isActivePhase && !inCurrentPhase && <GripVertical className="w-3 h-3 text-gray-300 shrink-0" />}
                              {inCurrentPhase && <Check className="w-3 h-3 text-primary shrink-0" />}
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
                  );
                })}
              </div>
            )}
            {dockSection === 'skills' && (
              <div className="space-y-1">
                <button onClick={() => setEditingSkill({ id: '', name: 'New Skill', body: '', path: '' })} className="w-full flex items-center justify-center gap-1.5 py-2 rounded-lg text-[10px] font-semibold text-primary border border-dashed border-primary/30 hover:bg-primary/[0.04] transition-all mb-2">
                  <Plus className="w-3 h-3" /> New Skill
                </button>
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

        {/* CENTER: Canvas with template controls inside */}
        <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
          {/* Canvas header: template name, mode, CLI, default, save */}
          <div className="shrink-0 px-4 pt-3 pb-2 flex flex-col gap-2">
            {/* Row 1: Name + CLI + Save */}
            <div className="flex items-center gap-3">
              <Workflow className="w-4 h-4 text-primary shrink-0" />
              <input
                value={templateName}
                onChange={e => setTemplateName(e.target.value)}
                placeholder="Untitled template…"
                className="flex-1 min-w-0 bg-transparent text-base font-bold text-gray-800 dark:text-gray-100 outline-none border-b border-transparent hover:border-gray-300 dark:hover:border-white/[0.1] focus:border-primary/50 transition-colors placeholder:text-gray-300 dark:placeholder:text-gray-600 pb-0.5"
              />
              {/* CLI target */}
              <div className="flex gap-0.5 p-0.5 rounded-lg bg-gray-100/60 dark:bg-white/[0.04] ring-1 ring-black/[0.03] dark:ring-white/[0.05] shrink-0">
                {(['claude', 'gemini', 'copilot'] as CliTarget[]).map(cli => (
                  <button key={cli} onClick={() => setTemplateCliTarget(cli)} className={`px-2 py-1 rounded-md text-[9px] font-bold uppercase transition-all duration-200 ${templateCliTarget === cli ? CLI_COLORS[cli] + ' ring-1' : 'text-gray-400 hover:text-gray-600 dark:hover:text-gray-300'}`}>
                    {cli}
                  </button>
                ))}
              </div>
              {/* Set as default button */}
              {activeTemplate && !creatingTemplate && (
                <button
                  onClick={() => handleSetPhaseDefault(activePhase, currentVariant, activeTemplate.id)}
                  className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[10px] font-semibold transition-all duration-200 shrink-0 ${
                    isCurrentDefault
                      ? 'bg-amber-500/10 text-amber-600 dark:text-amber-400 ring-1 ring-amber-500/20'
                      : 'text-gray-400 hover:text-amber-600 dark:hover:text-amber-400 hover:bg-amber-500/5 border border-gray-200/60 dark:border-white/[0.06]'
                  }`}
                >
                  <span className="text-[12px]">{isCurrentDefault ? '★' : '☆'}</span>
                  {isCurrentDefault ? 'Default' : 'Set Default'}
                </button>
              )}
              {/* Save */}
              <button
                onClick={handleSaveTemplate}
                disabled={templateSaving || !templateName.trim() || !hasChanges}
                className={`flex items-center gap-1.5 px-3.5 py-1.5 rounded-full text-[11px] font-semibold transition-all duration-300 active:scale-[0.97] shrink-0 ${hasChanges ? 'bg-primary text-white hover:bg-primary-hover shadow-[0_2px_8px_rgba(var(--eh-accent),0.2)]' : 'bg-gray-100 dark:bg-white/[0.04] text-gray-400 cursor-default'} disabled:opacity-50`}
              >
                {templateSaving ? <Loader2 className="w-3 h-3 animate-spin" /> : <Check className="w-3 h-3" />}
                {creatingTemplate ? 'Create' : 'Save'}
              </button>
            </div>
            {/* Row 2: Mode picker */}
            <div className="flex items-center gap-1.5">
              <span className="text-[9px] font-bold uppercase tracking-[0.06em] text-gray-400 mr-1">Mode</span>
              {PATTERNS.map(p => {
                const Icon = p.icon;
                const supported = supportedPatterns.includes(p.key);
                const active = currentPattern === p.key;
                return (
                  <button
                    key={p.key}
                    disabled={!supported}
                    onClick={() => handleSetPattern(p.key)}
                    title={p.description}
                    className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-[10px] font-semibold transition-all duration-200 ${active ? 'bg-primary/10 text-primary ring-1 ring-primary/20' : 'text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 hover:bg-gray-50 dark:hover:bg-white/[0.04]'} disabled:opacity-25 disabled:cursor-not-allowed`}
                  >
                    <Icon className="w-3 h-3" />
                    {p.label}
                  </button>
                );
              })}
              {creatingTemplate && <span className="ml-2 text-[9px] text-primary font-medium">New template — configure and save</span>}
            </div>
          </div>
          {/* Canvas */}
          <div className="flex-1 flex p-4 pt-2 overflow-auto">
            <NodeGraph
              pattern={currentPattern}
              members={currentMembers}
              personaLabels={personaLabels}
              onRemoveMember={handleRemoveFromPhase}
              onReorderMember={handleReorder}
              onDrop={handleAddToPhase}
            />
          </div>
        </div>

        {/* RIGHT PANEL: Skill editor */}
        {editingSkill && (
          <div className="w-[300px] shrink-0 border-l border-gray-200/60 dark:border-white/[0.05] overflow-hidden">
            <SkillInlineEditor skill={editingSkill} onClose={() => setEditingSkill(null)} onSave={handleSaveSkill} onDelete={editingSkill.path ? () => handleDeleteSkill(editingSkill) : undefined} isSaving={skillSaving} />
          </div>
        )}
      </div>

      {/* Persona modal */}
      {(creatingPersona || editingPersona) && (
        <PersonaEditPanel initial={editingPersona} onClose={() => { setCreatingPersona(false); setEditingPersona(null); }} onSaved={() => { setCreatingPersona(false); setEditingPersona(null); reloadPersonas(); }} />
      )}
    </div>
  );
}
