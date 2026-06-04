import { useState, useCallback, useEffect, useMemo } from 'react';
import {
  Workflow, Plus, X, Pencil, Trash2, Loader2, BookOpen, Check, Users, Network, Star, Lock, Copy, Eye,
  Info, ChevronDown, GitBranch, Layers, GitMerge,
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

const PATTERNS: { key: Pattern; label: string; description: string }[] = [
  { key: 'relay', label: 'Relay', description: 'Personas run one after another' },
  { key: 'scatter', label: 'Scatter-Gather', description: 'Personas run in parallel, then a combiner synthesizes' },
  { key: 'supervisor', label: 'Supervisor', description: 'A lead persona coordinates assistants' },
];

const CLI_PATTERN_SUPPORT: Record<CliTarget, Pattern[]> = {
  claude: ['relay', 'scatter', 'supervisor'],
  gemini: ['relay', 'scatter'],
  copilot: ['relay', 'scatter'],
};

const CLI_COLORS: Record<CliTarget, string> = {
  claude: 'bg-orange-100 text-orange-700 dark:bg-orange-500/20 dark:text-orange-300',
  gemini: 'bg-blue-100 text-blue-700 dark:bg-blue-500/20 dark:text-blue-300',
  copilot: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-500/20 dark:text-emerald-300',
};


// --- Skill helpers (skills persist as docs under the skills/ directory) ---

interface SkillDef { id: string; name: string; body: string; path: string; }
function docToSkill(doc: Doc): SkillDef {
  return { id: doc.path, name: doc.title, body: doc.body, path: doc.path };
}

// Persona ids configured for a phase, regardless of pattern storage shape.
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
// Persona editor
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
  // A built-in is shown read-only until the user forks it with "Duplicate & Edit".
  const [forked, setForked] = useState(false);
  const readOnly = !!initial?.builtIn && !forked;
  // "creating" covers brand-new personas and forks of a built-in/custom one.
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

  // Load the full prompt for any existing persona — built-ins are viewable too.
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

  // Auto-derive a slug id from the label while creating/forking a persona.
  useEffect(() => {
    if (!creating) return;
    setId(label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, ''));
  }, [label, creating]);

  // Fork a viewed persona into a new editable copy.
  const handleFork = () => {
    setLabel(prev => `${prev} (Copy)`);
    setForked(true);
    setError(null);
  };

  const togglePattern = (p: string) =>
    setPatterns(prev => (prev.includes(p) ? prev.filter(x => x !== p) : [...prev, p]));

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    const payload: PersonaInput = {
      id,
      label: label.trim(),
      description: description.trim(),
      phase,
      compatiblePatterns: patterns,
      requiredCapabilities: [],
      prompt,
    };
    try {
      if (creating) await createPersona(payload);
      else await updatePersona(initial!.id, payload);
      onSaved();
    } catch (err: any) {
      setError(err?.message || 'Failed to save persona');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm" onClick={onClose}>
      <div className="bg-white dark:bg-[#1f2028] rounded-2xl shadow-2xl w-full max-w-xl max-h-[88vh] overflow-y-auto p-6 border border-gray-200 dark:border-white/10" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-lg font-bold text-gray-800 dark:text-gray-100 flex items-center gap-2">
            {readOnly ? 'View Persona' : creating ? 'New Persona' : 'Edit Persona'}
            {readOnly && (
              <span className="flex items-center gap-1 text-[10px] font-bold uppercase text-gray-400">
                <Lock className="w-3 h-3" /> Built-in
              </span>
            )}
          </h3>
          <button onClick={onClose} className="p-1 rounded hover:bg-gray-100 dark:hover:bg-white/10 text-gray-400">
            <X className="w-5 h-5" />
          </button>
        </div>

        {readOnly && (
          <p className="text-xs text-gray-500 dark:text-gray-400 mb-4 -mt-1">
            Built-in personas are read-only and maintained by Event Horizon. Use <strong>Duplicate &amp; Edit</strong> to make your own editable copy.
          </p>
        )}

        <div className="space-y-4">
          <div>
            <label className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider">Name</label>
            <input
              value={label}
              onChange={e => setLabel(e.target.value)}
              disabled={readOnly}
              placeholder="e.g. Security Auditor"
              className="mt-1 w-full px-3 py-2 rounded-lg border border-gray-200 dark:border-white/10 bg-gray-50 dark:bg-black/30 text-sm text-gray-800 dark:text-gray-100 outline-none focus:border-primary disabled:opacity-60 disabled:cursor-not-allowed"
            />
            {creating && id && <p className="mt-1 text-[11px] text-gray-400 font-mono">id: {id}</p>}
          </div>

          <div>
            <label className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider">Description</label>
            <input
              value={description}
              onChange={e => setDescription(e.target.value)}
              disabled={readOnly}
              placeholder="Short summary shown in the launcher"
              className="mt-1 w-full px-3 py-2 rounded-lg border border-gray-200 dark:border-white/10 bg-gray-50 dark:bg-black/30 text-sm text-gray-800 dark:text-gray-100 outline-none focus:border-primary disabled:opacity-60 disabled:cursor-not-allowed"
            />
          </div>

          <div>
            <label className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider">Phase</label>
            <div className="mt-1 flex gap-2 flex-wrap">
              {PHASES.map(p => (
                <button
                  key={p.key}
                  onClick={() => setPhase(p.key)}
                  disabled={readOnly}
                  className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all disabled:opacity-60 disabled:cursor-not-allowed ${
                    phase === p.key
                      ? 'bg-primary text-white'
                      : 'bg-gray-100 dark:bg-white/10 text-gray-500 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-white/20'
                  }`}
                >
                  {p.label}
                </button>
              ))}
            </div>
          </div>

          <div>
            <label className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider">Compatible Patterns</label>
            <div className="mt-1 flex gap-2 flex-wrap">
              {PATTERNS.map(p => (
                <button
                  key={p.key}
                  onClick={() => togglePattern(p.key)}
                  disabled={readOnly}
                  title={p.description}
                  className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all disabled:opacity-60 disabled:cursor-not-allowed ${
                    patterns.includes(p.key)
                      ? 'bg-primary/10 text-primary border border-primary/30'
                      : 'bg-gray-100 dark:bg-white/10 text-gray-500 dark:text-gray-400 border border-transparent hover:bg-gray-200 dark:hover:bg-white/20'
                  }`}
                >
                  {p.label}
                </button>
              ))}
            </div>
            <p className="text-[11px] text-gray-400 mt-1">Leave empty to allow the persona in any orchestration mode.</p>
          </div>

          <div>
            <label className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider">Prompt</label>
            {loadingPrompt ? (
              <div className="mt-1 flex items-center gap-2 text-gray-400 text-sm"><Loader2 className="w-4 h-4 animate-spin" /> Loading…</div>
            ) : (
              <textarea
                value={prompt}
                onChange={e => setPrompt(e.target.value)}
                readOnly={readOnly}
                rows={8}
                placeholder="The full instructions this persona launches with…"
                className={`mt-1 w-full px-3 py-2 rounded-lg border border-gray-200 dark:border-white/10 bg-gray-50 dark:bg-black/30 text-sm text-gray-800 dark:text-gray-100 outline-none focus:border-primary resize-y font-mono leading-relaxed ${readOnly ? 'opacity-70 cursor-default' : ''}`}
              />
            )}
          </div>

          {error && <p className="text-sm text-red-500">{error}</p>}
        </div>

        <div className="flex items-center justify-end gap-2 mt-6 pt-4 border-t border-gray-200 dark:border-white/10">
          <button onClick={onClose} className="px-4 py-2 rounded-lg text-sm font-medium text-gray-500 hover:bg-gray-100 dark:hover:bg-white/10 transition-colors">
            {readOnly ? 'Close' : 'Cancel'}
          </button>
          {readOnly ? (
            <button
              onClick={handleFork}
              disabled={loadingPrompt}
              className="px-4 py-2 rounded-lg text-sm font-semibold bg-primary text-white hover:bg-primary-hover transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1.5"
            >
              <Copy className="w-3.5 h-3.5" /> Duplicate &amp; Edit
            </button>
          ) : (
            <button
              onClick={handleSave}
              disabled={!label.trim() || !prompt.trim() || saving || loadingPrompt}
              className="px-4 py-2 rounded-lg text-sm font-semibold bg-primary text-white hover:bg-primary-hover transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1.5"
            >
              {saving && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
              Save
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// ============================================================================
// Template editor
// ============================================================================

function TemplateEditPanel({
  initial,
  personas,
  onClose,
  onSaved,
}: {
  initial: WorkflowTemplate | null;
  personas: OrchestrationPersonaMeta[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const isNew = !initial;
  const [name, setName] = useState(initial?.name ?? '');
  const [cliTarget, setCliTarget] = useState<CliTarget>((initial?.cliTarget as CliTarget) ?? 'claude');
  const [phases, setPhases] = useState<Partial<Record<WorkflowPhase, WorkflowPhaseConfig>>>(initial?.phases ?? {});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const supportedPatterns = CLI_PATTERN_SUPPORT[cliTarget];

  const setPhasePattern = (phase: WorkflowPhase, pattern: Pattern) => {
    setPhases(prev => {
      const members = phaseMembers(prev[phase]);
      return { ...prev, [phase]: buildPhaseConfig(pattern, members) };
    });
  };

  const togglePhaseMember = (phase: WorkflowPhase, personaId: string) => {
    setPhases(prev => {
      const existing = prev[phase];
      const pattern = (existing?.pattern as Pattern) ?? 'relay';
      const members = phaseMembers(existing);
      const next = members.includes(personaId)
        ? members.filter(m => m !== personaId)
        : [...members, personaId];
      return { ...prev, [phase]: buildPhaseConfig(pattern, next) };
    });
  };

  const clearPhase = (phase: WorkflowPhase) => {
    setPhases(prev => {
      const next = { ...prev };
      delete next[phase];
      return next;
    });
  };

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    // Drop empty phases and coerce unsupported patterns to relay before saving.
    const cleaned: Partial<Record<WorkflowPhase, WorkflowPhaseConfig>> = {};
    for (const { key } of PHASES) {
      const cfg = phases[key];
      if (!cfg || phaseMembers(cfg).length === 0) continue;
      const pattern = supportedPatterns.includes(cfg.pattern as Pattern) ? (cfg.pattern as Pattern) : 'relay';
      cleaned[key] = buildPhaseConfig(pattern, phaseMembers(cfg));
    }
    try {
      if (isNew) await createWorkflow({ name: name.trim(), cliTarget, phases: cleaned });
      else await updateWorkflow(initial!.id, { name: name.trim(), cliTarget, phases: cleaned });
      onSaved();
    } catch (err: any) {
      setError(err?.message || 'Failed to save template');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-md" onClick={onClose}>
      <div className="bg-white dark:bg-[#18181a] rounded-2xl shadow-[0_24px_80px_rgba(0,0,0,0.25)] dark:shadow-[0_24px_80px_rgba(0,0,0,0.6)] w-full max-w-2xl max-h-[88vh] overflow-hidden border border-gray-200/60 dark:border-white/[0.08]" onClick={e => e.stopPropagation()}>
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200/60 dark:border-white/[0.06]">
          <div className="flex items-center gap-3">
            <div className="flex items-center justify-center w-8 h-8 rounded-xl bg-primary/8 ring-1 ring-primary/10">
              <Network className="w-4 h-4 text-primary" />
            </div>
            <h3 className="text-base font-bold text-gray-800 dark:text-gray-100">{isNew ? 'New Template' : 'Edit Template'}</h3>
          </div>
          <button onClick={onClose} className="p-2 rounded-xl hover:bg-gray-100 dark:hover:bg-white/10 text-gray-400 transition-all duration-200">
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Body */}
        <div className="overflow-y-auto max-h-[calc(88vh-130px)] px-6 py-5 space-y-5">
          {/* Name + CLI target row */}
          <div className="flex gap-4 items-end">
            <div className="flex-1">
              <label className="text-[10px] font-bold text-gray-500 dark:text-gray-400 uppercase tracking-[0.08em]">Name</label>
              <input
                value={name}
                onChange={e => setName(e.target.value)}
                placeholder="e.g. Thorough Review"
                className="mt-1.5 w-full px-3.5 py-2.5 rounded-xl border border-gray-200/60 dark:border-white/[0.08] bg-gray-50/50 dark:bg-black/20 text-sm text-gray-800 dark:text-gray-100 outline-none focus:border-primary/50 focus:ring-2 focus:ring-primary/10 transition-all duration-200"
              />
            </div>
            <div>
              <label className="text-[10px] font-bold text-gray-500 dark:text-gray-400 uppercase tracking-[0.08em]">Target</label>
              <div className="mt-1.5 flex gap-1 p-1 rounded-xl bg-gray-100/60 dark:bg-white/[0.04] ring-1 ring-black/[0.03] dark:ring-white/[0.05]">
                {(['claude', 'gemini', 'copilot'] as CliTarget[]).map(cli => (
                  <button
                    key={cli}
                    onClick={() => setCliTarget(cli)}
                    className={`px-3 py-2 rounded-[10px] text-[11px] font-bold uppercase transition-all duration-200 ease-[cubic-bezier(0.32,0.72,0,1)] ${
                      cliTarget === cli
                        ? CLI_COLORS[cli] + ' shadow-sm'
                        : 'text-gray-400 hover:text-gray-600 dark:hover:text-gray-300'
                    }`}
                  >
                    {cli}
                  </button>
                ))}
              </div>
            </div>
          </div>

          {/* Phase pipeline */}
          <div className="space-y-3">
            <span className="text-[10px] font-bold text-gray-500 dark:text-gray-400 uppercase tracking-[0.08em]">Pipeline Phases</span>
            {PHASES.map(({ key, label }, idx) => {
              const cfg = phases[key];
              const pattern = (cfg?.pattern as Pattern) ?? 'relay';
              const members = phaseMembers(cfg);
              const phasePersonas = personas.filter(p => p.phase === key);
              const dotClass = key === 'grooming' ? 'bg-purple-400' : key === 'implementation' ? 'bg-blue-400' : key === 'review' ? 'bg-amber-400' : 'bg-emerald-400';
              return (
                <div key={key}>
                  {idx > 0 && (
                    <div className="flex justify-center py-1">
                      <div className="w-px h-3 bg-gray-200 dark:bg-white/[0.08]" />
                    </div>
                  )}
                  <div className={`rounded-xl border border-gray-200/60 dark:border-white/[0.06] bg-gray-50/30 dark:bg-white/[0.015] p-4 relative overflow-hidden`}>
                    <div className={`absolute left-0 top-0 bottom-0 w-1 ${dotClass}`} />
                    <div className="flex items-center justify-between ml-2">
                      <div className="flex items-center gap-2">
                        <div className={`w-2 h-2 rounded-full ${dotClass}`} />
                        <span className="text-[11px] font-bold uppercase tracking-[0.06em] text-gray-700 dark:text-gray-200">{label}</span>
                        {members.length > 0 && (
                          <span className="text-[10px] text-gray-400 font-medium">{members.length} agent{members.length > 1 ? 's' : ''}</span>
                        )}
                      </div>
                      {members.length > 0 && (
                        <button onClick={() => clearPhase(key)} className="text-[10px] font-medium text-gray-400 hover:text-red-500 transition-colors duration-200 px-2 py-1 rounded-md hover:bg-red-50 dark:hover:bg-red-500/10">Clear</button>
                      )}
                    </div>

                    <div className="flex items-center gap-1 mt-3 ml-2">
                      {PATTERNS.map(p => {
                        const supported = supportedPatterns.includes(p.key);
                        return (
                          <button
                            key={p.key}
                            disabled={!supported}
                            onClick={() => setPhasePattern(key, p.key)}
                            title={supported ? p.description : `Not supported by ${cliTarget}`}
                            className={`px-2.5 py-1.5 rounded-lg text-[10px] font-semibold transition-all duration-200 ${
                              pattern === p.key && members.length > 0
                                ? 'bg-primary/10 text-primary ring-1 ring-primary/20'
                                : 'text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300 hover:bg-gray-100 dark:hover:bg-white/[0.05]'
                            } disabled:opacity-25 disabled:cursor-not-allowed`}
                          >
                            {p.label}
                          </button>
                        );
                      })}
                    </div>

                    <div className="mt-3 ml-2 flex flex-wrap gap-2">
                      {phasePersonas.length === 0 && (
                        <span className="text-[11px] text-gray-400 italic">No personas for this phase yet.</span>
                      )}
                      {phasePersonas.map(p => {
                        const selected = members.includes(p.id);
                        return (
                          <button
                            key={p.id}
                            onClick={() => togglePhaseMember(key, p.id)}
                            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[11px] font-medium border transition-all duration-200 ease-[cubic-bezier(0.32,0.72,0,1)] ${
                              selected
                                ? 'border-primary/50 bg-primary/[0.06] text-primary dark:bg-primary/10 shadow-[0_0_0_1px_rgba(var(--eh-accent),0.15)]'
                                : 'border-gray-200/80 dark:border-white/[0.08] text-gray-600 dark:text-gray-300 hover:border-primary/30 hover:bg-primary/[0.02]'
                            }`}
                          >
                            {selected && <Check className="w-3 h-3" />}
                            {p.label}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>

          {error && <p className="text-sm text-red-500">{error}</p>}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-3 px-6 py-4 border-t border-gray-200/60 dark:border-white/[0.06]">
          <button onClick={onClose} className="px-4 py-2 rounded-xl text-sm font-medium text-gray-500 hover:bg-gray-100 dark:hover:bg-white/10 transition-all duration-200">
            Cancel
          </button>
          <button
            onClick={handleSave}
            disabled={!name.trim() || saving}
            className="flex items-center gap-1.5 px-5 py-2.5 rounded-full text-sm font-semibold bg-primary text-white hover:bg-primary-hover transition-all duration-300 ease-[cubic-bezier(0.32,0.72,0,1)] active:scale-[0.97] disabled:opacity-50 disabled:cursor-not-allowed shadow-[0_2px_8px_rgba(var(--eh-accent),0.2)]"
          >
            {saving && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
            Save
          </button>
        </div>
      </div>
    </div>
  );
}

// ============================================================================
// Skill inline editor (right-side panel, replaces modal)
// ============================================================================

function SkillInlineEditor({
  skill,
  onClose,
  onSave,
  onDelete,
  isSaving,
}: {
  skill: SkillDef;
  onClose: () => void;
  onSave: (updated: SkillDef) => void;
  onDelete?: () => void;
  isSaving?: boolean;
}) {
  const [name, setName] = useState(skill.name);
  const [body, setBody] = useState(skill.body);

  useEffect(() => {
    setName(skill.name);
    setBody(skill.body);
  }, [skill.id, skill.name, skill.body]);

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between px-5 py-4 border-b border-gray-200/60 dark:border-white/[0.06]">
        <div className="flex items-center gap-2.5">
          <div className="flex items-center justify-center w-7 h-7 rounded-lg bg-primary/8 ring-1 ring-primary/10">
            <BookOpen className="w-3.5 h-3.5 text-primary/70" />
          </div>
          <h3 className="text-sm font-bold text-gray-800 dark:text-gray-100">Edit Skill</h3>
        </div>
        <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-gray-100 dark:hover:bg-white/10 text-gray-400 transition-all duration-200">
          <X className="w-4 h-4" />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-5 py-5 space-y-5">
        <div>
          <label className="text-[10px] font-bold text-gray-500 dark:text-gray-400 uppercase tracking-[0.08em]">Name</label>
          <input
            value={name}
            onChange={e => setName(e.target.value)}
            className="mt-1.5 w-full px-3 py-2.5 rounded-xl border border-gray-200/60 dark:border-white/[0.08] bg-gray-50/50 dark:bg-black/20 text-sm text-gray-800 dark:text-gray-100 outline-none focus:border-primary/50 focus:ring-2 focus:ring-primary/10 transition-all duration-200"
          />
        </div>
        {skill.path && (
          <div>
            <label className="text-[10px] font-bold text-gray-500 dark:text-gray-400 uppercase tracking-[0.08em]">Source</label>
            <p className="mt-1 text-[11px] text-gray-500 dark:text-gray-400 font-mono bg-gray-50/50 dark:bg-black/20 px-3 py-2 rounded-lg">{skill.path}</p>
          </div>
        )}
        <div className="flex-1">
          <label className="text-[10px] font-bold text-gray-500 dark:text-gray-400 uppercase tracking-[0.08em]">Content</label>
          <textarea
            value={body}
            onChange={e => setBody(e.target.value)}
            className="mt-1.5 w-full px-3 py-3 rounded-xl border border-gray-200/60 dark:border-white/[0.08] bg-gray-50/50 dark:bg-black/20 text-[12px] text-gray-800 dark:text-gray-100 outline-none focus:border-primary/50 focus:ring-2 focus:ring-primary/10 resize-y font-mono leading-relaxed min-h-[300px] transition-all duration-200"
          />
        </div>
      </div>

      <div className="flex items-center justify-between px-5 py-4 border-t border-gray-200/60 dark:border-white/[0.06]">
        {onDelete ? (
          <button onClick={onDelete} className="px-3 py-2 rounded-lg text-[12px] font-medium text-red-500 hover:bg-red-50 dark:hover:bg-red-500/10 transition-all duration-200">
            Delete
          </button>
        ) : <div />}
        <button
          onClick={() => onSave({ ...skill, name, body })}
          disabled={!name.trim() || isSaving}
          className="flex items-center gap-1.5 px-4 py-2 rounded-full text-[12px] font-semibold bg-primary text-white hover:bg-primary-hover transition-all duration-300 ease-[cubic-bezier(0.32,0.72,0,1)] active:scale-[0.97] disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {isSaving && <Loader2 className="w-3 h-3 animate-spin" />}
          Save
        </button>
      </div>
    </div>
  );
}

// ============================================================================
// Main component
// ============================================================================

type Tab = 'personas' | 'templates' | 'skills';

export function WorkflowBuilder() {
  const [tab, setTab] = useState<Tab>('personas');

  const [personas, setPersonas] = useState<OrchestrationPersonaMeta[]>([]);
  const [templates, setTemplates] = useState<WorkflowTemplate[]>([]);
  const [config, setConfigState] = useState<Config | null>(null);
  const [skills, setSkills] = useState<SkillDef[]>([]);
  const [loading, setLoading] = useState(true);
  const [skillSaving, setSkillSaving] = useState(false);

  const [editingPersona, setEditingPersona] = useState<OrchestrationPersonaMeta | null>(null);
  const [creatingPersona, setCreatingPersona] = useState(false);
  const [editingTemplate, setEditingTemplate] = useState<WorkflowTemplate | null>(null);
  const [creatingTemplate, setCreatingTemplate] = useState(false);
  const [templatesHelpOpen, setTemplatesHelpOpen] = useState(false);
  const [editingSkill, setEditingSkill] = useState<SkillDef | null>(null);

  const reloadPersonas = useCallback(() => fetchOrchestrationPersonas().then(setPersonas).catch(() => {}), []);
  const reloadTemplates = useCallback(() => fetchWorkflows().then(setTemplates).catch(() => {}), []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    Promise.all([
      fetchOrchestrationPersonas(),
      fetchWorkflows(),
      fetchConfig(),
      fetchDocs(),
    ])
      .then(([p, w, c, docs]) => {
        if (cancelled) return;
        setPersonas(p);
        setTemplates(w);
        setConfigState(c);
        setSkills(docs.filter(d => d.directory === 'skills').map(docToSkill));
      })
      .catch(() => {})
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  const personasByPhase = useMemo(() => {
    const map: Record<WorkflowPhase, OrchestrationPersonaMeta[]> = {
      grooming: [], implementation: [], review: [], finalize: [],
    };
    for (const p of personas) {
      if (map[p.phase as WorkflowPhase]) map[p.phase as WorkflowPhase].push(p);
    }
    return map;
  }, [personas]);

  // Persona id → display label, for rendering ordered chips on template cards.
  const personaLabels = useMemo(() => {
    const map: Record<string, string> = {};
    for (const p of personas) map[p.id] = p.label;
    return map;
  }, [personas]);

  const handleDeletePersona = useCallback(async (p: OrchestrationPersonaMeta) => {
    if (!window.confirm(`Delete persona "${p.label}"?`)) return;
    try {
      await deletePersona(p.id);
      await reloadPersonas();
    } catch (err) {
      console.error('Failed to delete persona:', err);
    }
  }, [reloadPersonas]);

  const handleDuplicatePersona = useCallback(async (p: OrchestrationPersonaMeta) => {
    try {
      const full = await fetchEditablePersona(p.id);
      const copy = await createPersona({
        label: `${p.label} (Copy)`,
        description: p.description,
        phase: p.phase,
        compatiblePatterns: p.compatiblePatterns ?? [],
        requiredCapabilities: p.requiredCapabilities ?? [],
        prompt: full.prompt,
      });
      await reloadPersonas();
      setEditingPersona(copy);
    } catch (err) {
      console.error('Failed to duplicate persona:', err);
    }
  }, [reloadPersonas]);

  const handleDuplicateTemplate = useCallback(async (t: WorkflowTemplate) => {
    try {
      const copy = await createWorkflow({
        name: `Copy of ${t.name}`,
        cliTarget: t.cliTarget,
        phases: t.phases,
      });
      await reloadTemplates();
      setEditingTemplate(copy);
    } catch (err) {
      console.error('Failed to duplicate template:', err);
    }
  }, [reloadTemplates]);

  const handleDeleteTemplate = useCallback(async (t: WorkflowTemplate) => {
    if (!window.confirm(`Delete template "${t.name}"?`)) return;
    try {
      await deleteWorkflow(t.id);
      await reloadTemplates();
      if (!config) return;
      // Drop any board/phase default references to the deleted template.
      let next: Config = config;
      if (config.defaultWorkflowId === t.id) next = { ...next, defaultWorkflowId: '' };
      if (config.phaseDefaults) {
        const pd: NonNullable<Config['phaseDefaults']> = {};
        let changed = false;
        for (const [phase, variants] of Object.entries(config.phaseDefaults)) {
          const cleaned = { ...variants };
          if (cleaned.single === t.id) { delete cleaned.single; changed = true; }
          if (cleaned.multi === t.id) { delete cleaned.multi; changed = true; }
          pd[phase as WorkflowPhase] = cleaned;
        }
        if (changed) next = { ...next, phaseDefaults: pd };
      }
      if (next !== config) {
        await saveConfig(next);
        setConfigState(next);
      }
    } catch (err) {
      console.error('Failed to delete template:', err);
    }
  }, [reloadTemplates, config]);

  // Toggle the per-phase single/multi default to a template (writes config.phaseDefaults).
  const handleSetPhaseDefault = useCallback(async (phase: WorkflowPhase, variant: 'single' | 'multi', templateId: string) => {
    if (!config) return;
    const current = config.phaseDefaults?.[phase]?.[variant];
    const nextVal = current === templateId ? undefined : templateId;
    const phaseDefaults = {
      ...config.phaseDefaults,
      [phase]: { ...config.phaseDefaults?.[phase], [variant]: nextVal },
    };
    const next = { ...config, phaseDefaults };
    try {
      await saveConfig(next);
      setConfigState(next);
    } catch (err) {
      console.error('Failed to set phase default:', err);
    }
  }, [config]);

  const handleSaveSkill = useCallback(async (updated: SkillDef) => {
    setSkillSaving(true);
    try {
      if (updated.path) {
        await updateDoc(updated.path, { title: updated.name, body: updated.body });
        setSkills(prev => prev.map(s => (s.id === updated.id ? updated : s)));
      } else {
        const slug = updated.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
        const doc = await createDoc({ path: `skills/${slug}.md`, title: updated.name, body: updated.body });
        setSkills(prev => [...prev, docToSkill(doc)]);
      }
      setEditingSkill(null);
    } catch (err) {
      console.error('Failed to save skill:', err);
    } finally {
      setSkillSaving(false);
    }
  }, []);

  const handleDeleteSkill = useCallback(async (skill: SkillDef) => {
    if (!window.confirm(`Delete skill "${skill.name}"? This removes the file.`)) return;
    try {
      await deleteDoc(skill.path);
      setSkills(prev => prev.filter(s => s.id !== skill.id));
      setEditingSkill(null);
    } catch (err) {
      console.error('Failed to delete skill:', err);
    }
  }, []);

  const handleDuplicateSkill = useCallback(async (skill: SkillDef) => {
    try {
      const slug = `${skill.path.replace(/^skills\//, '').replace(/\.md$/, '')}-copy`;
      const doc = await createDoc({ path: `skills/${slug}.md`, title: `${skill.name} (Copy)`, body: skill.body });
      const copy = docToSkill(doc);
      setSkills(prev => [...prev, copy]);
      setEditingSkill(copy);
    } catch (err) {
      console.error('Failed to duplicate skill:', err);
    }
  }, []);

  const TABS: { key: Tab; label: string; icon: typeof Users }[] = [
    { key: 'personas', label: 'Personas', icon: Users },
    { key: 'templates', label: 'Templates', icon: Network },
    { key: 'skills', label: 'Skills', icon: BookOpen },
  ];

  return (
    <div className="h-full flex flex-col">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3.5">
          <div className="bg-primary/8 p-2.5 rounded-2xl ring-1 ring-primary/10">
            <Workflow className="w-5 h-5 text-primary" />
          </div>
          <div>
            <h2 className="text-xl font-bold text-gray-800 dark:text-gray-100 tracking-tight">Workflow Builder</h2>
            <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">Personas, templates &amp; board defaults for the agent launcher</p>
          </div>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex items-center gap-0.5 mb-6 bg-gray-100/80 dark:bg-white/[0.04] p-1 rounded-xl w-fit ring-1 ring-black/[0.04] dark:ring-white/[0.06]">
        {TABS.map(t => {
          const Icon = t.icon;
          return (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              className={`flex items-center gap-1.5 px-4 py-2 rounded-[10px] text-sm font-semibold transition-all duration-200 ease-[cubic-bezier(0.32,0.72,0,1)] ${
                tab === t.key
                  ? 'bg-white dark:bg-white/10 text-gray-800 dark:text-gray-100 shadow-[0_1px_3px_rgba(0,0,0,0.08),0_1px_1px_rgba(0,0,0,0.04)] dark:shadow-[0_1px_3px_rgba(0,0,0,0.3)] ring-1 ring-black/[0.04] dark:ring-white/[0.08]'
                  : 'text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300 hover:bg-white/50 dark:hover:bg-white/[0.04]'
              }`}
            >
              <Icon className="w-4 h-4" />
              {t.label}
            </button>
          );
        })}
      </div>

      {loading ? (
        <div className="flex items-center justify-center flex-1 text-gray-400">
          <Loader2 className="w-6 h-6 animate-spin" />
        </div>
      ) : (
        <div className="flex-1 overflow-y-auto">
          {/* Personas tab */}
          {tab === 'personas' && (
            <div className="space-y-8">
              <div className="flex justify-end">
                <button
                  onClick={() => setCreatingPersona(true)}
                  className="group flex items-center gap-2 pl-4 pr-3 py-2 rounded-full text-sm font-semibold bg-primary text-white hover:bg-primary-hover transition-all duration-300 ease-[cubic-bezier(0.32,0.72,0,1)] active:scale-[0.97] shadow-[0_2px_8px_rgba(var(--eh-accent),0.2)]"
                >
                  New Persona
                  <span className="flex items-center justify-center w-6 h-6 rounded-full bg-white/20">
                    <Plus className="w-3.5 h-3.5" />
                  </span>
                </button>
              </div>
              {PHASES.map(({ key, label }) => (
                <div key={key}>
                  <div className="flex items-center gap-2.5 mb-3">
                    <div className={`w-2 h-2 rounded-full ${key === 'grooming' ? 'bg-purple-400' : key === 'implementation' ? 'bg-blue-400' : key === 'review' ? 'bg-amber-400' : 'bg-emerald-400'}`} />
                    <h3 className="text-[11px] font-bold uppercase tracking-[0.08em] text-gray-600 dark:text-gray-300">{label}</h3>
                  </div>
                  <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
                    {personasByPhase[key].length === 0 && (
                      <p className="text-xs text-gray-400 italic">No personas.</p>
                    )}
                    {personasByPhase[key].map(p => (
                      <div
                        key={p.id}
                        className={`group relative p-[1px] rounded-2xl transition-all duration-300 ease-[cubic-bezier(0.32,0.72,0,1)] hover:-translate-y-[1px] hover:shadow-[0_4px_12px_rgba(0,0,0,0.06)] dark:hover:shadow-[0_4px_16px_rgba(0,0,0,0.3)] ${
                          key === 'grooming' ? 'bg-gradient-to-b from-purple-400/20 to-transparent' : key === 'implementation' ? 'bg-gradient-to-b from-blue-400/20 to-transparent' : key === 'review' ? 'bg-gradient-to-b from-amber-400/20 to-transparent' : 'bg-gradient-to-b from-emerald-400/20 to-transparent'
                        }`}
                      >
                        <div className="p-3.5 rounded-[calc(1rem-1px)] bg-white dark:bg-[#1c1c1a] border border-gray-200/60 dark:border-white/[0.06] shadow-[inset_0_1px_0_rgba(255,255,255,0.8)] dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]">
                          <div className="flex items-center gap-2">
                            <span className="text-[13px] font-semibold text-gray-800 dark:text-gray-100 flex-1 truncate">{p.label}</span>
                            {p.builtIn ? (
                              <div className="flex items-center gap-1.5">
                                <span className="flex items-center gap-1 text-[10px] font-semibold uppercase text-gray-400/80 tracking-wide">
                                  <Lock className="w-3 h-3" /> Built-in
                                </span>
                                <button onClick={() => setEditingPersona(p)} title="View & duplicate" className="p-1.5 rounded-lg hover:bg-gray-100 dark:hover:bg-white/10 text-gray-400 hover:text-primary transition-all duration-200">
                                  <Eye className="w-3.5 h-3.5" />
                                </button>
                                <button onClick={() => handleDuplicatePersona(p)} title="Duplicate" className="p-1.5 rounded-lg hover:bg-gray-100 dark:hover:bg-white/10 text-gray-400 hover:text-primary transition-all duration-200">
                                  <Copy className="w-3.5 h-3.5" />
                                </button>
                              </div>
                            ) : (
                              <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-all duration-200">
                                <button onClick={() => setEditingPersona(p)} title="Edit" className="p-1.5 rounded-lg hover:bg-gray-100 dark:hover:bg-white/10 text-gray-400 hover:text-primary transition-all duration-200">
                                  <Pencil className="w-3.5 h-3.5" />
                                </button>
                                <button onClick={() => handleDuplicatePersona(p)} title="Duplicate" className="p-1.5 rounded-lg hover:bg-gray-100 dark:hover:bg-white/10 text-gray-400 hover:text-primary transition-all duration-200">
                                  <Copy className="w-3.5 h-3.5" />
                                </button>
                                <button onClick={() => handleDeletePersona(p)} title="Delete" className="p-1.5 rounded-lg hover:bg-red-50 dark:hover:bg-red-500/10 text-gray-400 hover:text-red-500 transition-all duration-200">
                                  <Trash2 className="w-3.5 h-3.5" />
                                </button>
                              </div>
                            )}
                          </div>
                          {p.description && <p className="text-[11px] text-gray-500 dark:text-gray-400 mt-1.5 line-clamp-2 leading-relaxed">{p.description}</p>}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* Templates tab — grouped by phase, with single/multi defaults per phase */}
          {tab === 'templates' && (
            <div className="space-y-8">
              {/* How-to / orchestration mode reference */}
              <div className="rounded-2xl border border-primary/15 bg-primary/[0.02] dark:border-primary/20 dark:bg-primary/[0.03] overflow-hidden">
                <button
                  onClick={() => setTemplatesHelpOpen(o => !o)}
                  className="flex w-full items-center gap-2.5 px-5 py-3.5 text-left"
                  aria-expanded={templatesHelpOpen}
                >
                  <Info className="h-4 w-4 shrink-0 text-primary/70" />
                  <span className="text-[13px] font-semibold text-gray-700 dark:text-gray-200">
                    How templates &amp; orchestration modes work
                  </span>
                  <ChevronDown className={`ml-auto h-4 w-4 text-gray-400 transition-transform duration-300 ease-[cubic-bezier(0.32,0.72,0,1)] ${templatesHelpOpen ? 'rotate-180' : ''}`} />
                </button>
                {templatesHelpOpen && (
                  <div className="space-y-4 border-t border-primary/10 px-5 py-5 text-[12px] leading-relaxed text-gray-600 dark:border-primary/10 dark:text-gray-300">
                    <div>
                      <p className="mb-2 font-semibold text-gray-800 dark:text-gray-100">Building a template</p>
                      <ol className="ml-4 list-decimal space-y-1.5">
                        <li>Click <strong>New Template</strong>, give it a name, and pick the CLI target (Claude / Gemini / Copilot).</li>
                        <li>The editor shows one block per <strong>phase</strong> — Grooming, Implementation, Review, Release. A template belongs to a phase simply by having one or more personas selected in that block; leave a block empty to skip it.</li>
                        <li>For each phase you use, choose an <strong>orchestration mode</strong> and click the personas to include.</li>
                        <li>Selecting <strong>one</strong> persona makes it a <strong>Single</strong> template; <strong>two or more</strong> makes it a <strong>Multi</strong> template. They're sorted into those columns automatically.</li>
                        <li>Back on this page, click the <Star className="inline h-3 w-3 -mt-0.5 text-amber-400" /> star to set a template as the default Single or Multi launch for that phase.</li>
                      </ol>
                    </div>
                    <div>
                      <p className="mb-2 font-semibold text-gray-800 dark:text-gray-100">Orchestration modes</p>
                      <ul className="space-y-2.5">
                        <li className="flex gap-2.5">
                          <GitBranch className="mt-0.5 h-3.5 w-3.5 shrink-0 text-gray-400" />
                          <span><strong>Relay</strong> — personas run one after another in a pipeline (A → B → C), each handing its output to the next. Good for sequenced work like test-first then implement.</span>
                        </li>
                        <li className="flex gap-2.5">
                          <Layers className="mt-0.5 h-3.5 w-3.5 shrink-0 text-gray-400" />
                          <span><strong>Scatter-Gather</strong> — personas run in parallel, then a combiner synthesizes their findings and decides the next step. Good for multi-perspective review.</span>
                        </li>
                        <li className="flex gap-2.5">
                          <GitMerge className="mt-0.5 h-3.5 w-3.5 shrink-0 text-gray-400" />
                          <span><strong>Supervisor</strong> — a lead persona coordinates assistants, delegating and resuming once they report back.</span>
                        </li>
                      </ul>
                      <p className="mt-3 text-[11px] text-gray-500 dark:text-gray-400">
                        A <strong>Single</strong> agent always launches standalone — the orchestration mode only applies once two or more personas are involved. All four patterns (Scatter-Gather, Parallel, Relay, Supervisor) are fully functional.
                      </p>
                    </div>
                  </div>
                )}
              </div>
              <div className="flex items-center justify-between">
                <p className="text-[12px] text-gray-500 dark:text-gray-400">
                  Templates are grouped by phase. Star a template to make it the default <strong>single</strong> or <strong>multi</strong> launch for that phase.
                </p>
                <button
                  onClick={() => setCreatingTemplate(true)}
                  className="group flex shrink-0 items-center gap-2 pl-4 pr-3 py-2 rounded-full text-sm font-semibold bg-primary text-white hover:bg-primary-hover transition-all duration-300 ease-[cubic-bezier(0.32,0.72,0,1)] active:scale-[0.97] shadow-[0_2px_8px_rgba(var(--eh-accent),0.2)]"
                >
                  New Template
                  <span className="flex items-center justify-center w-6 h-6 rounded-full bg-white/20">
                    <Plus className="w-3.5 h-3.5" />
                  </span>
                </button>
              </div>
              {templates.length === 0 && (
                <div className="flex flex-col items-center justify-center py-20 text-gray-400">
                  <Network className="w-8 h-8 mb-3 opacity-20" />
                  <span className="text-sm">No templates yet. Create one to set a phase default.</span>
                </div>
              )}
              {templates.length > 0 && PHASES.map(({ key: phase, label: phaseLabel }) => {
                const inPhase = templates.filter(t => phaseMembers(t.phases[phase]).length > 0);
                const singles = inPhase.filter(t => phaseMembers(t.phases[phase]).length === 1);
                const multis = inPhase.filter(t => phaseMembers(t.phases[phase]).length >= 2);
                const singleDefaultId = config?.phaseDefaults?.[phase]?.single;
                const multiDefaultId = config?.phaseDefaults?.[phase]?.multi;

                const renderCard = (t: WorkflowTemplate, variant: 'single' | 'multi') => {
                  const cfg = t.phases[phase];
                  const members = phaseMembers(cfg);
                  const patternLabel = PATTERNS.find(p => p.key === cfg?.pattern)?.label ?? cfg?.pattern;
                  const isDefault = (variant === 'single' ? singleDefaultId : multiDefaultId) === t.id;
                  return (
                    <div
                      key={t.id}
                      className={`group p-[1px] rounded-2xl transition-all duration-300 ease-[cubic-bezier(0.32,0.72,0,1)] hover:-translate-y-[1px] ${
                        isDefault ? 'bg-gradient-to-b from-primary/30 to-primary/5' : 'bg-gradient-to-b from-black/[0.04] dark:from-white/[0.06] to-transparent'
                      }`}
                    >
                      <div className={`p-3.5 rounded-[calc(1rem-1px)] transition-all ${
                        isDefault
                          ? 'bg-primary/[0.02] dark:bg-primary/[0.04] shadow-[inset_0_1px_0_rgba(255,255,255,0.8)] dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]'
                          : 'bg-white dark:bg-[#1c1c1a] shadow-[inset_0_1px_0_rgba(255,255,255,0.8)] dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]'
                      }`}>
                        <div className="flex items-start gap-2.5">
                          <button
                            onClick={() => handleSetPhaseDefault(phase, variant, t.id)}
                            title={isDefault ? `Default ${variant} for ${phaseLabel} (click to unset)` : `Set as default ${variant} for ${phaseLabel}`}
                            className={`mt-0.5 shrink-0 rounded-lg p-1 transition-all duration-200 ${
                              isDefault ? 'text-amber-400 scale-110' : 'text-gray-300 hover:text-amber-400 hover:scale-110 dark:text-gray-600'
                            }`}
                          >
                            <Star className="h-4 w-4" fill={isDefault ? 'currentColor' : 'none'} />
                          </button>
                          <div className="min-w-0 flex-1">
                            <div className="flex flex-wrap items-center gap-2">
                              <span className="truncate text-[13px] font-semibold text-gray-800 dark:text-gray-100">{t.name}</span>
                              {isDefault && <span className="rounded-full bg-primary/10 px-2 py-0.5 text-[9px] font-bold uppercase text-primary tracking-wide">Default</span>}
                              {t.builtIn && <span className="rounded-full bg-gray-100 px-2 py-0.5 text-[9px] font-bold uppercase text-gray-500 dark:bg-white/10 dark:text-gray-400 tracking-wide">Built-in</span>}
                              <span className={`rounded-full px-2 py-0.5 text-[9px] font-bold uppercase tracking-wide ${CLI_COLORS[t.cliTarget as CliTarget] ?? 'bg-gray-100 text-gray-500'}`}>{t.cliTarget}</span>
                            </div>
                            <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[10px] text-gray-500 dark:text-gray-400">
                              <span className="inline-flex items-center gap-1 rounded-md bg-gray-100/80 px-2 py-1 font-semibold dark:bg-white/[0.07]">
                                <Network className="h-2.5 w-2.5" />{patternLabel}
                              </span>
                              {members.map((id, i) => (
                                <span key={`${id}-${i}`} className="inline-flex items-center gap-1 rounded-md bg-gray-100/80 px-2 py-1 dark:bg-white/[0.07]">
                                  {variant === 'multi' && cfg?.pattern === 'relay' && <span className="font-mono text-gray-400">{i + 1}.</span>}
                                  {personaLabels[id] ?? id}
                                </span>
                              ))}
                            </div>
                          </div>
                          <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-all duration-200 group-hover:opacity-100">
                            {!t.builtIn && (
                              <button onClick={() => setEditingTemplate(t)} title="Edit" className="rounded-lg p-1.5 text-gray-400 transition-all duration-200 hover:bg-gray-100 hover:text-primary dark:hover:bg-white/10">
                                <Pencil className="h-3.5 w-3.5" />
                              </button>
                            )}
                            <button onClick={() => handleDuplicateTemplate(t)} title="Duplicate" className="rounded-lg p-1.5 text-gray-400 transition-all duration-200 hover:bg-gray-100 hover:text-primary dark:hover:bg-white/10">
                              <Copy className="h-3.5 w-3.5" />
                            </button>
                            {!t.builtIn && (
                              <button onClick={() => handleDeleteTemplate(t)} title="Delete" className="rounded-lg p-1.5 text-gray-400 transition-all duration-200 hover:bg-red-50 hover:text-red-500 dark:hover:bg-red-500/10">
                                <Trash2 className="h-3.5 w-3.5" />
                              </button>
                            )}
                          </div>
                        </div>
                      </div>
                    </div>
                  );
                };

                return (
                  <div key={phase} className="rounded-2xl p-[1px] bg-gradient-to-b from-black/[0.04] dark:from-white/[0.06] to-transparent">
                    <div className={`rounded-[calc(1rem-1px)] p-5 bg-gray-50/70 dark:bg-white/[0.015] shadow-[inset_0_1px_0_rgba(255,255,255,0.6)] dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.03)]`}>
                      <div className="flex items-center gap-2.5 mb-4">
                        <div className={`w-2.5 h-2.5 rounded-full ${phase === 'grooming' ? 'bg-purple-400' : phase === 'implementation' ? 'bg-blue-400' : phase === 'review' ? 'bg-amber-400' : 'bg-emerald-400'}`} />
                        <h3 className="text-sm font-bold text-gray-800 dark:text-gray-100">{phaseLabel}</h3>
                      </div>
                      {inPhase.length === 0 ? (
                        <p className="text-[11px] text-gray-400">No templates configure this phase yet.</p>
                      ) : (
                        <div className="grid gap-5 md:grid-cols-2">
                          <div>
                            <p className="mb-2 text-[10px] font-bold uppercase tracking-[0.08em] text-gray-400">Single agent</p>
                            <div className="space-y-2.5">
                              {singles.length === 0 && <p className="text-[11px] text-gray-400">None</p>}
                              {singles.map(t => renderCard(t, 'single'))}
                            </div>
                          </div>
                          <div>
                            <p className="mb-2 text-[10px] font-bold uppercase tracking-[0.08em] text-gray-400">Multi-agent team</p>
                            <div className="space-y-2.5">
                              {multis.length === 0 && <p className="text-[11px] text-gray-400">None</p>}
                              {multis.map(t => renderCard(t, 'multi'))}
                            </div>
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {/* Skills tab — split layout: list left, editor right */}
          {tab === 'skills' && (
            <div className="flex gap-0 h-full min-h-[500px]">
              {/* Skill list */}
              <div className={`space-y-2 overflow-y-auto pr-4 transition-all duration-300 ease-[cubic-bezier(0.32,0.72,0,1)] ${editingSkill ? 'w-[280px] shrink-0' : 'flex-1 max-w-xl'}`}>
                <div className="flex justify-between items-center mb-3">
                  <span className="text-[10px] font-bold uppercase tracking-[0.08em] text-gray-500 dark:text-gray-400">{skills.length} skills</span>
                  <button
                    onClick={() => setEditingSkill({ id: '', name: 'New Skill', body: '', path: '' })}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-full text-[11px] font-semibold bg-primary text-white hover:bg-primary-hover transition-all duration-300 ease-[cubic-bezier(0.32,0.72,0,1)] active:scale-[0.97]"
                  >
                    <Plus className="w-3 h-3" /> New
                  </button>
                </div>
                {skills.map(skill => (
                  <div
                    key={skill.id}
                    className={`group p-3 rounded-xl cursor-pointer transition-all duration-200 ease-[cubic-bezier(0.32,0.72,0,1)] border ${
                      editingSkill?.id === skill.id
                        ? 'bg-primary/[0.04] dark:bg-primary/[0.06] border-primary/30 ring-1 ring-primary/15'
                        : 'border-gray-200/60 dark:border-white/[0.06] hover:border-gray-300 dark:hover:border-white/[0.1] bg-white dark:bg-white/[0.02] hover:bg-gray-50/50 dark:hover:bg-white/[0.03]'
                    }`}
                    onClick={() => setEditingSkill(skill)}
                  >
                    <div className="flex items-center gap-2">
                      <BookOpen className={`w-3.5 h-3.5 shrink-0 transition-colors duration-200 ${editingSkill?.id === skill.id ? 'text-primary' : 'text-gray-400 dark:text-gray-500'}`} />
                      <span className="text-[12px] font-semibold text-gray-800 dark:text-gray-100 flex-1 truncate">{skill.name}</span>
                      <button
                        onClick={e => { e.stopPropagation(); handleDuplicateSkill(skill); }}
                        title="Duplicate"
                        className="p-1 rounded-md opacity-0 group-hover:opacity-100 hover:bg-gray-100 dark:hover:bg-white/10 text-gray-400 hover:text-primary transition-all duration-200"
                      >
                        <Copy className="w-3 h-3" />
                      </button>
                    </div>
                    {!editingSkill && <p className="text-[10px] text-gray-500 dark:text-gray-400 mt-1 ml-[22px] line-clamp-1 leading-relaxed">{skill.body.split('\n')[0]}</p>}
                  </div>
                ))}
              </div>
              {/* Editor panel */}
              {editingSkill && (
                <div className="flex-1 ml-4 rounded-2xl border border-gray-200/60 dark:border-white/[0.06] bg-white dark:bg-[#1a1a18] shadow-[0_4px_24px_rgba(0,0,0,0.04)] dark:shadow-[0_4px_24px_rgba(0,0,0,0.3)] overflow-hidden">
                  <SkillInlineEditor
                    skill={editingSkill}
                    onClose={() => setEditingSkill(null)}
                    onSave={handleSaveSkill}
                    onDelete={editingSkill.path ? () => handleDeleteSkill(editingSkill) : undefined}
                    isSaving={skillSaving}
                  />
                </div>
              )}
              {!editingSkill && (
                <div className="flex-1 flex items-center justify-center">
                  <div className="text-center">
                    <BookOpen className="w-8 h-8 mx-auto mb-3 text-gray-300 dark:text-gray-600" />
                    <p className="text-sm text-gray-400 dark:text-gray-500">Select a skill to edit</p>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* Modals */}
      {(creatingPersona || editingPersona) && (
        <PersonaEditPanel
          initial={editingPersona}
          onClose={() => { setCreatingPersona(false); setEditingPersona(null); }}
          onSaved={() => { setCreatingPersona(false); setEditingPersona(null); reloadPersonas(); }}
        />
      )}
      {(creatingTemplate || editingTemplate) && (
        <TemplateEditPanel
          initial={editingTemplate}
          personas={personas}
          onClose={() => { setCreatingTemplate(false); setEditingTemplate(null); }}
          onSaved={() => { setCreatingTemplate(false); setEditingTemplate(null); reloadTemplates(); }}
        />
      )}
    </div>
  );
}
