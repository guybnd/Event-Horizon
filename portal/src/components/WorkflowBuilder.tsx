import React, { useState, useCallback, useMemo, useEffect } from 'react';
import { DndContext, DragOverlay, useDroppable, useDraggable, type DragEndEvent, type DragStartEvent } from '@dnd-kit/core';
import { SortableContext, verticalListSortingStrategy, useSortable, arrayMove } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { GripVertical, Plus, Check, X, ChevronDown, Copy, Play, Save, Workflow, Bot, Pencil, BookOpen, ArrowRight, GitBranch, Layers, Trash2, Loader2 } from 'lucide-react';
import { fetchDocs, updateDoc, createDoc, deleteDoc } from '../api';
import type { Doc } from '../types';

// --- Types ---

export type CliTarget = 'claude' | 'gemini' | 'copilot';

export type WorkflowMode = 'sequential' | 'parallel' | 'scatter-gather';

export interface SkillDef {
  id: string;
  name: string;
  body: string;
  path: string;
}

export interface AgentDef {
  id: string;
  name: string;
  category: 'grooming' | 'execution' | 'validation' | 'release';
  prompt: string;
  skillIds: string[];
}

export interface WorkflowStep {
  id: string;
  agentId: string;
  enabled: boolean;
}

export interface WorkflowTemplate {
  id: string;
  name: string;
  mode: WorkflowMode;
  steps: WorkflowStep[];
}

export interface PhaseWorkflows {
  [phase: string]: {
    templates: WorkflowTemplate[];
    activeTemplateId: string;
  };
}

const MODE_ALLOWED_CLIS: Record<WorkflowMode, CliTarget[]> = {
  sequential: ['claude', 'gemini', 'copilot'],
  parallel: ['claude', 'gemini'],
  'scatter-gather': ['claude', 'gemini'],
};

const MODE_INFO: Record<WorkflowMode, { label: string; description: string; icon: typeof ArrowRight }> = {
  sequential: { label: 'Sequential', description: 'Agents run one after another', icon: ArrowRight },
  parallel: { label: 'Parallel', description: 'All agents run simultaneously', icon: GitBranch },
  'scatter-gather': { label: 'Scatter-Gather', description: 'Parallel agents then synthesis agent', icon: Layers },
};

// --- Default Data ---

function docToSkill(doc: Doc): SkillDef {
  return { id: doc.path, name: doc.title, body: doc.body, path: doc.path };
}

const DEFAULT_AGENTS: AgentDef[] = [
  { id: 'interrogator', name: 'Interrogator', category: 'grooming', prompt: 'Analyze requirements and ask clarifying questions to refine the ticket scope. Identify ambiguities, missing acceptance criteria, and implementation-critical decisions that need resolution before coding begins.', skillIds: ['skills/event-horizon-grooming'] },
  { id: 'context-scout', name: 'Context Scout', category: 'execution', prompt: 'Gather relevant context from the codebase, docs, and related tickets. Map the affected surface area, identify dependencies, and report what files/patterns the implementer needs to know about.', skillIds: [] },
  { id: 'spec-writer', name: 'Spec Writer', category: 'grooming', prompt: 'Synthesize findings from research agents into a concrete implementation plan with clear sequential steps. The plan should be specific enough that another agent can execute without re-discovery.', skillIds: ['skills/event-horizon-grooming'] },
  { id: 'implementer', name: 'Implementer', category: 'execution', prompt: 'Execute the implementation plan, writing minimal focused code changes. Make small edits and validate immediately. Prefer the smallest owning surface area.', skillIds: ['skills/event-horizon-implementation'] },
  { id: 'refactorer', name: 'Refactorer', category: 'execution', prompt: 'Review implementation for code quality. Simplify overly complex code, remove duplication, improve naming, and ensure consistency with surrounding patterns. Do not change behavior.', skillIds: ['skills/event-horizon-implementation'] },
  { id: 'pedant', name: 'Pedant', category: 'validation', prompt: 'Perform strict code review focusing on correctness, edge cases, type safety, and adherence to project standards. Flag anything that could break in production. Be specific and cite line numbers.', skillIds: [] },
  { id: 'product-proxy', name: 'Product Proxy', category: 'validation', prompt: 'Review from the user perspective. Does this solve the stated problem? Are there UX issues, missing error states, or confusing flows? Think like a user encountering this for the first time.', skillIds: [] },
  { id: 'qa-automator', name: 'QA Automator', category: 'validation', prompt: 'Write or verify test coverage for the changes made. Ensure edge cases are covered, integration points are tested, and the tests actually validate the described behavior (not just that code runs).', skillIds: [] },
  { id: 'documenter', name: 'Documenter', category: 'release', prompt: 'Update documentation to reflect the changes. Keep docs concise and current. Remove outdated sections, add new behavior descriptions, and ensure examples still work.', skillIds: [] },
  { id: 'release-agent', name: 'Release Agent', category: 'release', prompt: 'Orchestrate the release process. Gather completed work, generate changelog entries, bump version numbers, create the release commit and tag. Follow semantic versioning.', skillIds: ['skills/event-horizon-release'] },
];

const PHASES = ['Grooming', 'Implementation', 'Review', 'Release'] as const;

function createDefaultWorkflows(): PhaseWorkflows {
  return {
    Grooming: {
      templates: [{
        id: 'default-grooming',
        name: 'Default',
        mode: 'sequential',
        steps: [
          { id: 'gs1', agentId: 'interrogator', enabled: true },
          { id: 'gs2', agentId: 'context-scout', enabled: true },
          { id: 'gs3', agentId: 'spec-writer', enabled: true },
        ],
      }],
      activeTemplateId: 'default-grooming',
    },
    Implementation: {
      templates: [{
        id: 'default-impl',
        name: 'Default',
        mode: 'sequential',
        steps: [
          { id: 'is1', agentId: 'context-scout', enabled: true },
          { id: 'is2', agentId: 'implementer', enabled: true },
          { id: 'is3', agentId: 'refactorer', enabled: false },
        ],
      }],
      activeTemplateId: 'default-impl',
    },
    Review: {
      templates: [{
        id: 'default-review',
        name: 'Default',
        mode: 'parallel',
        steps: [
          { id: 'rs1', agentId: 'pedant', enabled: true },
          { id: 'rs2', agentId: 'product-proxy', enabled: true },
          { id: 'rs3', agentId: 'qa-automator', enabled: true },
        ],
      }],
      activeTemplateId: 'default-review',
    },
    Release: {
      templates: [{
        id: 'default-release',
        name: 'Default',
        mode: 'sequential',
        steps: [
          { id: 'les1', agentId: 'documenter', enabled: true },
          { id: 'les2', agentId: 'release-agent', enabled: true },
        ],
      }],
      activeTemplateId: 'default-release',
    },
  };
}

// --- Helpers ---

const CLI_COLORS: Record<CliTarget, string> = {
  claude: 'bg-orange-100 text-orange-700 dark:bg-orange-500/20 dark:text-orange-300',
  gemini: 'bg-blue-100 text-blue-700 dark:bg-blue-500/20 dark:text-blue-300',
  copilot: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-500/20 dark:text-emerald-300',
};

const CATEGORY_COLORS: Record<string, string> = {
  grooming: 'border-l-purple-400',
  execution: 'border-l-blue-400',
  validation: 'border-l-amber-400',
  release: 'border-l-emerald-400',
};

let idCounter = 1000;
function nextId(prefix: string) {
  return `${prefix}-${Date.now()}-${idCounter++}`;
}

// --- DnD Sub-components ---

function DraggableLibraryCard({ agent, onEdit }: { agent: AgentDef; onEdit: () => void }) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: `library-${agent.id}`,
    data: { type: 'library-agent', agentId: agent.id },
  });

  const style = transform ? { transform: `translate(${transform.x}px, ${transform.y}px)` } : undefined;

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`group p-3 rounded-xl border border-gray-200 dark:border-white/10 bg-white dark:bg-white/5 transition-all border-l-4 ${CATEGORY_COLORS[agent.category]} ${isDragging ? 'opacity-40 shadow-lg' : 'hover:border-primary/40 hover:shadow-sm'}`}
    >
      <div className="flex items-center gap-2">
        <div {...listeners} {...attributes} className="cursor-grab active:cursor-grabbing shrink-0 touch-none">
          <GripVertical className="w-3.5 h-3.5 text-gray-300 dark:text-gray-600" />
        </div>
        <span className="text-sm font-semibold text-gray-800 dark:text-gray-100 flex-1 truncate">{agent.name}</span>
        <button
          onClick={onEdit}
          className="p-1 rounded opacity-0 group-hover:opacity-100 hover:bg-gray-100 dark:hover:bg-white/10 text-gray-400 hover:text-primary transition-all"
        >
          <Pencil className="w-3 h-3" />
        </button>
      </div>
      <p className="text-[11px] text-gray-500 dark:text-gray-400 mt-1 ml-5.5 line-clamp-1">{agent.prompt}</p>
    </div>
  );
}

function SortableStepCard({
  step,
  agent,
  index,
  onToggle,
  onRemove,
  onEdit,
}: {
  step: WorkflowStep;
  agent: AgentDef | undefined;
  index: number;
  onToggle: () => void;
  onRemove: () => void;
  onEdit: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: step.id });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  if (!agent) return null;

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`group relative p-3 rounded-xl border bg-white dark:bg-white/5 transition-all border-l-4 ${CATEGORY_COLORS[agent.category]} ${
        isDragging ? 'opacity-40 shadow-lg z-10' :
        step.enabled
          ? 'border-gray-200 dark:border-white/10'
          : 'border-gray-100 dark:border-white/5 opacity-50'
      }`}
    >
      <div className="flex items-center gap-2">
        <div {...listeners} {...attributes} className="cursor-grab active:cursor-grabbing shrink-0 touch-none">
          <GripVertical className="w-3.5 h-3.5 text-gray-300 dark:text-gray-600" />
        </div>
        <button onClick={onToggle} className="shrink-0">
          {step.enabled ? (
            <div className="w-4 h-4 rounded border-2 border-primary bg-primary flex items-center justify-center">
              <Check className="w-3 h-3 text-white" />
            </div>
          ) : (
            <div className="w-4 h-4 rounded border-2 border-gray-300 dark:border-gray-600" />
          )}
        </button>
        <span className={`text-sm font-semibold flex-1 truncate ${step.enabled ? 'text-gray-800 dark:text-gray-100' : 'text-gray-400 dark:text-gray-500 line-through'}`}>
          {agent.name}
        </span>
        <span className="text-[10px] text-gray-400 dark:text-gray-500 font-mono">#{index + 1}</span>
      </div>
      <div className="absolute top-2 right-2 hidden group-hover:flex items-center gap-1">
        <button onClick={onEdit} className="p-1 rounded hover:bg-gray-100 dark:hover:bg-white/10 text-gray-400 hover:text-primary transition-colors">
          <Pencil className="w-3 h-3" />
        </button>
        <button onClick={onRemove} className="p-1 rounded hover:bg-red-50 dark:hover:bg-red-500/10 text-gray-400 hover:text-red-500 transition-colors">
          <X className="w-3 h-3" />
        </button>
      </div>
    </div>
  );
}

function DroppablePhaseColumn({ phase, children }: { phase: string; children: React.ReactNode }) {
  const { setNodeRef, isOver } = useDroppable({ id: `phase-${phase}` });

  return (
    <div
      ref={setNodeRef}
      className={`flex-1 overflow-y-auto rounded-2xl bg-gray-100/50 dark:bg-black/20 p-3 border transition-colors ${
        isOver ? 'border-primary/40 bg-primary/5' : 'border-transparent'
      }`}
    >
      {children}
    </div>
  );
}

function StepConnector({ mode }: { mode: WorkflowMode }) {
  if (mode === 'parallel') {
    return (
      <div className="flex justify-center py-1">
        <div className="flex items-center gap-1">
          <div className="w-1 h-1 rounded-full bg-blue-400/60" />
          <div className="w-1 h-1 rounded-full bg-blue-400/60" />
          <div className="w-1 h-1 rounded-full bg-blue-400/60" />
        </div>
      </div>
    );
  }
  return (
    <div className="flex justify-center py-1">
      <div className="w-px h-4 bg-gray-300 dark:bg-white/20" />
    </div>
  );
}

// --- Edit Panels ---

function AgentEditPanel({
  agent,
  skills,
  onClose,
  onSave,
  onDelete,
}: {
  agent: AgentDef;
  skills: SkillDef[];
  onClose: () => void;
  onSave: (updated: AgentDef) => void;
  onDelete?: () => void;
}) {
  const [name, setName] = useState(agent.name);
  const [category, setCategory] = useState(agent.category);
  const [prompt, setPrompt] = useState(agent.prompt);
  const [selectedSkillIds, setSelectedSkillIds] = useState<string[]>(agent.skillIds);

  const toggleSkill = (skillId: string) => {
    setSelectedSkillIds(prev =>
      prev.includes(skillId) ? prev.filter(s => s !== skillId) : [...prev, skillId]
    );
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm" onClick={onClose}>
      <div className="bg-white dark:bg-[#1f2028] rounded-2xl shadow-2xl w-full max-w-xl max-h-[85vh] overflow-y-auto p-6 border border-gray-200 dark:border-white/10" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-lg font-bold text-gray-800 dark:text-gray-100">Configure Agent</h3>
          <button onClick={onClose} className="p-1 rounded hover:bg-gray-100 dark:hover:bg-white/10 text-gray-400">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="space-y-4">
          <div>
            <label className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider">Name</label>
            <input
              value={name}
              onChange={e => setName(e.target.value)}
              className="mt-1 w-full px-3 py-2 rounded-lg border border-gray-200 dark:border-white/10 bg-gray-50 dark:bg-black/30 text-sm text-gray-800 dark:text-gray-100 outline-none focus:border-primary"
            />
          </div>

          <div>
            <label className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider">Category</label>
            <div className="mt-1 flex gap-2 flex-wrap">
              {(['grooming', 'execution', 'validation', 'release'] as const).map(cat => (
                <button
                  key={cat}
                  onClick={() => setCategory(cat)}
                  className={`px-3 py-1.5 rounded-lg text-xs font-bold capitalize transition-all ${
                    category === cat
                      ? 'bg-primary text-white'
                      : 'bg-gray-100 dark:bg-white/10 text-gray-500 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-white/20'
                  }`}
                >
                  {cat}
                </button>
              ))}
            </div>
          </div>

          <div>
            <label className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider">System Prompt</label>
            <textarea
              value={prompt}
              onChange={e => setPrompt(e.target.value)}
              rows={6}
              className="mt-1 w-full px-3 py-2 rounded-lg border border-gray-200 dark:border-white/10 bg-gray-50 dark:bg-black/30 text-sm text-gray-800 dark:text-gray-100 outline-none focus:border-primary resize-y font-mono leading-relaxed"
            />
          </div>

          <div>
            <label className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider">Attached Skills</label>
            <div className="mt-2 space-y-1.5">
              {skills.map(skill => (
                <button
                  key={skill.id}
                  onClick={() => toggleSkill(skill.id)}
                  className={`w-full flex items-start gap-2.5 px-3 py-2.5 rounded-lg text-left text-xs transition-all border ${
                    selectedSkillIds.includes(skill.id)
                      ? 'border-primary bg-primary/5 dark:bg-primary/10'
                      : 'border-gray-200 dark:border-white/10 hover:border-primary/30'
                  }`}
                >
                  <div className="mt-0.5 shrink-0">
                    {selectedSkillIds.includes(skill.id) ? (
                      <div className="w-3.5 h-3.5 rounded border-2 border-primary bg-primary flex items-center justify-center">
                        <Check className="w-2.5 h-2.5 text-white" />
                      </div>
                    ) : (
                      <div className="w-3.5 h-3.5 rounded border-2 border-gray-300 dark:border-gray-600" />
                    )}
                  </div>
                  <div className="flex-1 min-w-0">
                    <span className={`font-semibold ${selectedSkillIds.includes(skill.id) ? 'text-primary' : 'text-gray-700 dark:text-gray-200'}`}>{skill.name}</span>
                    <p className="text-gray-500 dark:text-gray-400 mt-0.5 line-clamp-1">{skill.body.split('\n')[0]}</p>
                  </div>
                </button>
              ))}
            </div>
          </div>
        </div>

        <div className="flex items-center justify-between mt-6 pt-4 border-t border-gray-200 dark:border-white/10">
          <div>
            {onDelete && (
              <button onClick={onDelete} className="px-3 py-2 rounded-lg text-sm font-medium text-red-500 hover:bg-red-50 dark:hover:bg-red-500/10 transition-colors">
                Delete Agent
              </button>
            )}
          </div>
          <div className="flex gap-2">
            <button onClick={onClose} className="px-4 py-2 rounded-lg text-sm font-medium text-gray-500 hover:bg-gray-100 dark:hover:bg-white/10 transition-colors">
              Cancel
            </button>
            <button
              onClick={() => onSave({ ...agent, name, category, prompt, skillIds: selectedSkillIds })}
              disabled={!name.trim()}
              className="px-4 py-2 rounded-lg text-sm font-semibold bg-primary text-white hover:bg-primary-hover transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              Save
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function SkillEditPanel({
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

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm" onClick={onClose}>
      <div className="bg-white dark:bg-[#1f2028] rounded-2xl shadow-2xl w-full max-w-xl max-h-[85vh] overflow-y-auto p-6 border border-gray-200 dark:border-white/10" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-lg font-bold text-gray-800 dark:text-gray-100">Configure Skill</h3>
          <button onClick={onClose} className="p-1 rounded hover:bg-gray-100 dark:hover:bg-white/10 text-gray-400">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="space-y-4">
          <div>
            <label className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider">Name</label>
            <input
              value={name}
              onChange={e => setName(e.target.value)}
              className="mt-1 w-full px-3 py-2 rounded-lg border border-gray-200 dark:border-white/10 bg-gray-50 dark:bg-black/30 text-sm text-gray-800 dark:text-gray-100 outline-none focus:border-primary"
            />
          </div>

          <div>
            <label className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider">Source File</label>
            <p className="mt-1 text-xs text-gray-500 dark:text-gray-400 font-mono">{skill.path}</p>
          </div>

          <div>
            <label className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider">Skill Content</label>
            <p className="text-[11px] text-gray-400 dark:text-gray-500 mt-0.5">The markdown instructions injected when this skill is attached to an agent.</p>
            <textarea
              value={body}
              onChange={e => setBody(e.target.value)}
              rows={12}
              className="mt-1.5 w-full px-3 py-2 rounded-lg border border-gray-200 dark:border-white/10 bg-gray-50 dark:bg-black/30 text-sm text-gray-800 dark:text-gray-100 outline-none focus:border-primary resize-y font-mono leading-relaxed"
            />
          </div>
        </div>

        <div className="flex items-center justify-between mt-6 pt-4 border-t border-gray-200 dark:border-white/10">
          <div>
            {onDelete && (
              <button onClick={onDelete} className="px-3 py-2 rounded-lg text-sm font-medium text-red-500 hover:bg-red-50 dark:hover:bg-red-500/10 transition-colors">
                Delete Skill
              </button>
            )}
          </div>
          <div className="flex gap-2">
            <button onClick={onClose} className="px-4 py-2 rounded-lg text-sm font-medium text-gray-500 hover:bg-gray-100 dark:hover:bg-white/10 transition-colors">
              Cancel
            </button>
            <button
              onClick={() => onSave({ ...skill, name, body })}
              disabled={!name.trim() || isSaving}
              className="px-4 py-2 rounded-lg text-sm font-semibold bg-primary text-white hover:bg-primary-hover transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1.5"
            >
              {isSaving && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
              Save
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// --- Main Component ---

export function WorkflowBuilder() {
  const [agents, setAgents] = useState<AgentDef[]>(DEFAULT_AGENTS);
  const [skills, setSkills] = useState<SkillDef[]>([]);
  const [skillsLoading, setSkillsLoading] = useState(true);
  const [skillSaving, setSkillSaving] = useState(false);
  const [workflows, setWorkflows] = useState<PhaseWorkflows>(createDefaultWorkflows);
  const [editingAgent, setEditingAgent] = useState<AgentDef | null>(null);
  const [editingSkill, setEditingSkill] = useState<SkillDef | null>(null);
  const [libraryTab, setLibraryTab] = useState<'agents' | 'skills'>('agents');
  const [activeDragId, setActiveDragId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setSkillsLoading(true);
    fetchDocs()
      .then(docs => {
        if (cancelled) return;
        const skillDocs = docs.filter(d => d.directory === 'skills');
        setSkills(skillDocs.map(docToSkill));
      })
      .catch(() => {})
      .finally(() => { if (!cancelled) setSkillsLoading(false); });
    return () => { cancelled = true; };
  }, []);

  const getAgent = useCallback((id: string) => agents.find(a => a.id === id), [agents]);

  const getActiveTemplate = useCallback((phase: string): WorkflowTemplate | undefined => {
    const pw = workflows[phase];
    if (!pw) return undefined;
    return pw.templates.find(t => t.id === pw.activeTemplateId);
  }, [workflows]);

  const setActiveTemplate = useCallback((phase: string, templateId: string) => {
    setWorkflows(prev => ({ ...prev, [phase]: { ...prev[phase], activeTemplateId: templateId } }));
  }, []);

  const setTemplateMode = useCallback((phase: string, mode: WorkflowMode) => {
    setWorkflows(prev => {
      const pw = prev[phase];
      const tpl = pw.templates.find(t => t.id === pw.activeTemplateId);
      if (!tpl) return prev;
      return { ...prev, [phase]: { ...pw, templates: pw.templates.map(t => t.id === tpl.id ? { ...t, mode } : t) } };
    });
  }, []);

  const addTemplateToPhase = useCallback((phase: string) => {
    const id = nextId('tpl');
    const name = `Template ${(workflows[phase]?.templates.length ?? 0) + 1}`;
    setWorkflows(prev => ({
      ...prev,
      [phase]: { ...prev[phase], templates: [...prev[phase].templates, { id, name, mode: 'sequential', steps: [] }], activeTemplateId: id },
    }));
  }, [workflows]);

  const duplicateTemplate = useCallback((phase: string) => {
    const current = getActiveTemplate(phase);
    if (!current) return;
    const id = nextId('tpl');
    const copy: WorkflowTemplate = { id, name: `${current.name} (copy)`, mode: current.mode, steps: current.steps.map(s => ({ ...s, id: nextId('s') })) };
    setWorkflows(prev => ({ ...prev, [phase]: { ...prev[phase], templates: [...prev[phase].templates, copy], activeTemplateId: id } }));
  }, [getActiveTemplate]);

  const renameTemplate = useCallback((phase: string) => {
    const current = getActiveTemplate(phase);
    if (!current) return;
    const newName = window.prompt('Rename template:', current.name);
    if (!newName || !newName.trim()) return;
    setWorkflows(prev => {
      const pw = prev[phase];
      return { ...prev, [phase]: { ...pw, templates: pw.templates.map(t => t.id === current.id ? { ...t, name: newName.trim() } : t) } };
    });
  }, [getActiveTemplate]);

  const deleteTemplate = useCallback((phase: string) => {
    const pw = workflows[phase];
    if (!pw || pw.templates.length <= 1) return;
    const current = getActiveTemplate(phase);
    if (!current) return;
    if (!window.confirm(`Delete template "${current.name}"?`)) return;
    const remaining = pw.templates.filter(t => t.id !== current.id);
    setWorkflows(prev => ({ ...prev, [phase]: { ...prev[phase], templates: remaining, activeTemplateId: remaining[0].id } }));
  }, [workflows, getActiveTemplate]);

  const toggleStep = useCallback((phase: string, stepId: string) => {
    setWorkflows(prev => {
      const pw = prev[phase];
      const tpl = pw.templates.find(t => t.id === pw.activeTemplateId);
      if (!tpl) return prev;
      return { ...prev, [phase]: { ...pw, templates: pw.templates.map(t => t.id === tpl.id ? { ...t, steps: t.steps.map(s => s.id === stepId ? { ...s, enabled: !s.enabled } : s) } : t) } };
    });
  }, []);

  const removeStep = useCallback((phase: string, stepId: string) => {
    setWorkflows(prev => {
      const pw = prev[phase];
      const tpl = pw.templates.find(t => t.id === pw.activeTemplateId);
      if (!tpl) return prev;
      return { ...prev, [phase]: { ...pw, templates: pw.templates.map(t => t.id === tpl.id ? { ...t, steps: t.steps.filter(s => s.id !== stepId) } : t) } };
    });
  }, []);

  const addAgentToPhase = useCallback((phase: string, agentId: string) => {
    setWorkflows(prev => {
      const pw = prev[phase];
      const tpl = pw.templates.find(t => t.id === pw.activeTemplateId);
      if (!tpl) return prev;
      const newStep: WorkflowStep = { id: nextId('s'), agentId, enabled: true };
      return { ...prev, [phase]: { ...pw, templates: pw.templates.map(t => t.id === tpl.id ? { ...t, steps: [...t.steps, newStep] } : t) } };
    });
  }, []);

  // DnD handlers
  const handleDragStart = useCallback((event: DragStartEvent) => {
    setActiveDragId(event.active.id as string);
  }, []);

  const handleDragEnd = useCallback((event: DragEndEvent) => {
    setActiveDragId(null);
    const { active, over } = event;
    if (!over) return;

    const activeData = active.data.current;
    const overId = over.id as string;

    // Library agent dropped onto a phase column
    if (activeData?.type === 'library-agent' && overId.startsWith('phase-')) {
      const phase = overId.replace('phase-', '');
      addAgentToPhase(phase, activeData.agentId);
      return;
    }

    // Sortable reorder within same column
    if (active.id !== over.id) {
      // Find which phase contains this step
      for (const phase of PHASES) {
        const tpl = getActiveTemplate(phase);
        if (!tpl) continue;
        const oldIndex = tpl.steps.findIndex(s => s.id === active.id);
        const newIndex = tpl.steps.findIndex(s => s.id === over.id);
        if (oldIndex !== -1 && newIndex !== -1) {
          setWorkflows(prev => {
            const pw = prev[phase];
            const t = pw.templates.find(t => t.id === pw.activeTemplateId)!;
            const reordered = arrayMove(t.steps, oldIndex, newIndex);
            return { ...prev, [phase]: { ...pw, templates: pw.templates.map(tp => tp.id === t.id ? { ...tp, steps: reordered } : tp) } };
          });
          return;
        }
      }
    }
  }, [addAgentToPhase, getActiveTemplate]);

  const handleSaveAgent = useCallback((updated: AgentDef) => {
    setAgents(prev => {
      const exists = prev.some(a => a.id === updated.id);
      return exists ? prev.map(a => a.id === updated.id ? updated : a) : [...prev, updated];
    });
    setEditingAgent(null);
  }, []);

  const handleDeleteAgent = useCallback((agentId: string) => {
    setAgents(prev => prev.filter(a => a.id !== agentId));
    setEditingAgent(null);
  }, []);

  const handleSaveSkill = useCallback(async (updated: SkillDef) => {
    setSkillSaving(true);
    try {
      const exists = skills.some(s => s.id === updated.id);
      if (exists) {
        await updateDoc(updated.path, { title: updated.name, body: updated.body });
      } else {
        const slug = updated.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
        const path = `skills/${slug}.md`;
        const doc = await createDoc({ path, title: updated.name, body: updated.body });
        updated = docToSkill(doc);
      }
      setSkills(prev => {
        const idx = prev.findIndex(s => s.id === updated.id);
        return idx >= 0 ? prev.map(s => s.id === updated.id ? updated : s) : [...prev, updated];
      });
      setEditingSkill(null);
    } catch (err) {
      console.error('Failed to save skill:', err);
    } finally {
      setSkillSaving(false);
    }
  }, [skills]);

  const handleDeleteSkill = useCallback(async (skillId: string) => {
    const skill = skills.find(s => s.id === skillId);
    if (!skill) return;
    if (!window.confirm(`Delete skill "${skill.name}"? This will remove the file.`)) return;
    try {
      await deleteDoc(skill.path);
      setSkills(prev => prev.filter(s => s.id !== skillId));
      setAgents(prev => prev.map(a => ({ ...a, skillIds: a.skillIds.filter(s => s !== skillId) })));
      setEditingSkill(null);
    } catch (err) {
      console.error('Failed to delete skill:', err);
    }
  }, [skills]);

  const handleNewAgent = useCallback(() => {
    setEditingAgent({ id: nextId('agent'), name: 'New Agent', category: 'execution', prompt: '', skillIds: [] });
  }, []);

  const handleNewSkill = useCallback(() => {
    setEditingSkill({ id: '', name: 'New Skill', body: '', path: '' });
  }, []);

  // Drag overlay content
  const dragOverlayContent = useMemo(() => {
    if (!activeDragId) return null;
    if (activeDragId.startsWith('library-')) {
      const agentId = activeDragId.replace('library-', '');
      const agent = getAgent(agentId);
      if (!agent) return null;
      return (
        <div className={`p-3 rounded-xl border border-primary/40 bg-white dark:bg-[#1f2028] shadow-xl border-l-4 ${CATEGORY_COLORS[agent.category]} w-[230px]`}>
          <span className="text-sm font-semibold text-gray-800 dark:text-gray-100">{agent.name}</span>
        </div>
      );
    }
    return null;
  }, [activeDragId, getAgent]);

  return (
    <DndContext onDragStart={handleDragStart} onDragEnd={handleDragEnd}>
      <div className="h-full flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between mb-6">
          <div className="flex items-center gap-3">
            <div className="bg-primary/10 p-2 rounded-xl">
              <Workflow className="w-5 h-5 text-primary" />
            </div>
            <div>
              <h2 className="text-xl font-bold text-gray-800 dark:text-gray-100">Workflow Builder</h2>
              <p className="text-xs text-gray-500 dark:text-gray-400">Configure agent pipelines per phase</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium bg-gray-100 dark:bg-white/10 text-gray-600 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-white/20 transition-colors">
              <Save className="w-3.5 h-3.5" />
              Save
            </button>
            <button className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-semibold bg-primary text-white hover:bg-primary-hover transition-colors">
              <Play className="w-3.5 h-3.5" />
              Run
            </button>
          </div>
        </div>

        {/* Kanban Layout */}
        <div className="flex-1 flex gap-4 overflow-x-auto min-h-0">

          {/* Library Column */}
          <div className="flex flex-col w-[260px] shrink-0">
            <div className="flex items-center gap-1 mb-3 bg-gray-100 dark:bg-black/30 p-0.5 rounded-lg">
              <button
                onClick={() => setLibraryTab('agents')}
                className={`flex-1 flex items-center justify-center gap-1.5 py-1.5 rounded-md text-xs font-semibold transition-all ${
                  libraryTab === 'agents'
                    ? 'bg-white dark:bg-white/10 text-gray-800 dark:text-gray-100 shadow-sm'
                    : 'text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300'
                }`}
              >
                <Bot className="w-3.5 h-3.5" />
                Agents
              </button>
              <button
                onClick={() => setLibraryTab('skills')}
                className={`flex-1 flex items-center justify-center gap-1.5 py-1.5 rounded-md text-xs font-semibold transition-all ${
                  libraryTab === 'skills'
                    ? 'bg-white dark:bg-white/10 text-gray-800 dark:text-gray-100 shadow-sm'
                    : 'text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300'
                }`}
              >
                <BookOpen className="w-3.5 h-3.5" />
                Skills
              </button>
            </div>

            <div className="flex-1 overflow-y-auto rounded-2xl bg-gray-100/50 dark:bg-black/20 p-3 space-y-2 border border-transparent">
              {libraryTab === 'agents' && (
                <>
                  {agents.map(agent => (
                    <DraggableLibraryCard key={agent.id} agent={agent} onEdit={() => setEditingAgent(agent)} />
                  ))}
                  <button
                    onClick={handleNewAgent}
                    className="w-full flex items-center justify-center gap-2 py-2.5 rounded-xl border border-dashed border-gray-300 dark:border-white/20 text-gray-400 dark:text-gray-500 hover:text-primary hover:border-primary transition-colors text-sm font-medium cursor-pointer"
                  >
                    <Plus className="w-4 h-4" />
                    New Agent
                  </button>
                </>
              )}
              {libraryTab === 'skills' && (
                <>
                  {skillsLoading ? (
                    <div className="flex items-center justify-center py-8 text-gray-400">
                      <Loader2 className="w-5 h-5 animate-spin" />
                    </div>
                  ) : (
                    skills.map(skill => (
                      <div key={skill.id} className="group p-3 rounded-xl border border-gray-200 dark:border-white/10 bg-white dark:bg-white/5 hover:border-primary/40 hover:shadow-sm transition-all cursor-pointer" onClick={() => setEditingSkill(skill)}>
                        <div className="flex items-center gap-2">
                          <BookOpen className="w-3.5 h-3.5 text-primary/60 shrink-0" />
                          <span className="text-sm font-semibold text-gray-800 dark:text-gray-100 flex-1 truncate">{skill.name}</span>
                          <Pencil className="w-3 h-3 opacity-0 group-hover:opacity-100 text-gray-400 transition-opacity" />
                        </div>
                        <p className="text-[11px] text-gray-500 dark:text-gray-400 mt-1 ml-5.5 line-clamp-2">{skill.body.split('\n')[0]}</p>
                      </div>
                    ))
                  )}
                  <button
                    onClick={handleNewSkill}
                    className="w-full flex items-center justify-center gap-2 py-2.5 rounded-xl border border-dashed border-gray-300 dark:border-white/20 text-gray-400 dark:text-gray-500 hover:text-primary hover:border-primary transition-colors text-sm font-medium cursor-pointer"
                  >
                    <Plus className="w-4 h-4" />
                    New Skill
                  </button>
                </>
              )}
            </div>
          </div>

          {/* Phase Columns */}
          {PHASES.map(phase => {
            const pw = workflows[phase];
            const activeTemplate = getActiveTemplate(phase);
            const steps = activeTemplate?.steps ?? [];
            const mode = activeTemplate?.mode ?? 'sequential';
            const allowedClis = MODE_ALLOWED_CLIS[mode];

            return (
              <div key={phase} className="flex flex-col w-[280px] shrink-0">
                {/* Column Header */}
                <div className="mb-3 px-1">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-bold uppercase tracking-wider text-gray-500 dark:text-gray-400">{phase}</span>
                    <span className="text-[10px] bg-gray-200 dark:bg-white/10 text-gray-500 dark:text-gray-400 px-2 py-0.5 rounded-full font-medium">
                      {steps.filter(s => s.enabled).length}/{steps.length}
                    </span>
                  </div>

                  {/* Template Picker */}
                  <div className="flex items-center gap-1 mt-2">
                    <div className="relative flex-1">
                      <select
                        value={pw.activeTemplateId}
                        onChange={e => setActiveTemplate(phase, e.target.value)}
                        className="w-full appearance-none pl-2.5 pr-7 py-1.5 rounded-lg text-xs font-medium bg-white dark:bg-white/5 border border-gray-200 dark:border-white/10 text-gray-700 dark:text-gray-200 outline-none focus:border-primary cursor-pointer"
                      >
                        {pw.templates.map(t => (
                          <option key={t.id} value={t.id}>{t.name}</option>
                        ))}
                      </select>
                      <ChevronDown className="absolute right-2 top-1/2 -translate-y-1/2 w-3 h-3 text-gray-400 pointer-events-none" />
                    </div>
                    <button onClick={() => renameTemplate(phase)} title="Rename template" className="p-1.5 rounded-lg hover:bg-gray-100 dark:hover:bg-white/10 text-gray-400 hover:text-primary transition-colors">
                      <Pencil className="w-3.5 h-3.5" />
                    </button>
                    <button onClick={() => duplicateTemplate(phase)} title="Duplicate template" className="p-1.5 rounded-lg hover:bg-gray-100 dark:hover:bg-white/10 text-gray-400 hover:text-primary transition-colors">
                      <Copy className="w-3.5 h-3.5" />
                    </button>
                    <button onClick={() => addTemplateToPhase(phase)} title="New template" className="p-1.5 rounded-lg hover:bg-gray-100 dark:hover:bg-white/10 text-gray-400 hover:text-primary transition-colors">
                      <Plus className="w-3.5 h-3.5" />
                    </button>
                    <button
                      onClick={() => deleteTemplate(phase)}
                      title="Delete template"
                      disabled={pw.templates.length <= 1}
                      className="p-1.5 rounded-lg hover:bg-red-50 dark:hover:bg-red-500/10 text-gray-400 hover:text-red-500 transition-colors disabled:opacity-30 disabled:cursor-not-allowed disabled:hover:bg-transparent disabled:hover:text-gray-400"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>

                  {/* Workflow Mode Selector + CLI compatibility */}
                  <div className="mt-2">
                    <div className="flex items-center gap-1">
                      {(Object.keys(MODE_INFO) as WorkflowMode[]).map(m => {
                        const info = MODE_INFO[m];
                        const Icon = info.icon;
                        return (
                          <button
                            key={m}
                            onClick={() => setTemplateMode(phase, m)}
                            title={info.description}
                            className={`flex items-center gap-1 px-2 py-1 rounded-md text-[10px] font-semibold transition-all ${
                              mode === m
                                ? 'bg-primary/10 text-primary border border-primary/30'
                                : 'text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300 border border-transparent'
                            }`}
                          >
                            <Icon className="w-3 h-3" />
                            {info.label}
                          </button>
                        );
                      })}
                    </div>
                    {/* CLI compatibility badges at template level */}
                    <div className="flex items-center gap-1.5 mt-1.5">
                      <span className="text-[9px] text-gray-400 dark:text-gray-500 uppercase font-bold tracking-wider">Supports:</span>
                      {(['claude', 'gemini', 'copilot'] as CliTarget[]).map(cli => (
                        <span
                          key={cli}
                          className={`text-[9px] font-bold uppercase px-1.5 py-0.5 rounded ${
                            allowedClis.includes(cli) ? CLI_COLORS[cli] : 'bg-gray-100 dark:bg-white/5 text-gray-300 dark:text-gray-600 line-through'
                          }`}
                        >
                          {cli}
                        </span>
                      ))}
                    </div>
                  </div>
                </div>

                {/* Steps Drop Zone */}
                <DroppablePhaseColumn phase={phase}>
                  <SortableContext items={steps.map(s => s.id)} strategy={verticalListSortingStrategy}>
                    <div className="space-y-0">
                      {steps.map((step, index) => (
                        <div key={step.id}>
                          <SortableStepCard
                            step={step}
                            agent={getAgent(step.agentId)}
                            index={index}
                            onToggle={() => toggleStep(phase, step.id)}
                            onRemove={() => removeStep(phase, step.id)}
                            onEdit={() => {
                              const a = getAgent(step.agentId);
                              if (a) setEditingAgent(a);
                            }}
                          />
                          {index < steps.length - 1 && <StepConnector mode={mode} />}
                        </div>
                      ))}
                    </div>
                  </SortableContext>
                  {steps.length === 0 && (
                    <div className="flex flex-col items-center justify-center h-32 text-gray-400 dark:text-gray-500">
                      <Bot className="w-8 h-8 mb-2 opacity-30" />
                      <span className="text-xs font-medium">Drag agents here</span>
                    </div>
                  )}
                </DroppablePhaseColumn>
              </div>
            );
          })}
        </div>

        {/* Drag Overlay */}
        <DragOverlay>{dragOverlayContent}</DragOverlay>

        {/* Edit Modals */}
        {editingAgent && (
          <AgentEditPanel
            agent={editingAgent}
            skills={skills}
            onClose={() => setEditingAgent(null)}
            onSave={handleSaveAgent}
            onDelete={agents.some(a => a.id === editingAgent.id) ? () => handleDeleteAgent(editingAgent.id) : undefined}
          />
        )}
        {editingSkill && (
          <SkillEditPanel
            skill={editingSkill}
            onClose={() => setEditingSkill(null)}
            onSave={handleSaveSkill}
            onDelete={editingSkill.id && skills.some(s => s.id === editingSkill.id) ? () => handleDeleteSkill(editingSkill.id) : undefined}
            isSaving={skillSaving}
          />
        )}
      </div>
    </DndContext>
  );
}
