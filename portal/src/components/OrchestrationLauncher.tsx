import { useCallback, useEffect, useMemo, useRef, useState, useId } from 'react';
import { Check, ChevronDown, FileText, Lock, Rocket, X } from 'lucide-react';
import {
  ORCHESTRATION_MODES,
  getOrchestrationMode,
  phaseCombiner,
  resolvePhaseDefaultId,
  effortDisplayLabel,
  EFFORT_LEVELS,
  type EffortLevel,
  type LaunchPhase,
  type OrchestrationMode,
  type ReviewPersona,
} from '../agentActions';
import { fetchOrchestrationPersonas, fetchConfig, fetchWorkflows, fetchHealth, createBranch, joinWorktree, fetchWorktrees, type WorktreeInfo, type WorkflowPhaseConfig, type WorkflowTemplate } from '../api';
import type { CliFramework, CliSessionSummary } from '../types';
import { type SessionGroup } from '../orchestration';
import { useAppActions } from '../store/useAppSelector';
import { OrchestrationTopology, TopologyGlyph } from './OrchestrationTopology';
import { BranchSection, type StartMode } from './task-modal/BranchSection';
import { useEscapeKey } from '../hooks/useEscapeKey';

export interface LauncherTicketInfo {
  id: string;
  title: string;
  status?: string;
  branch?: string;
  effort?: string;
}

export interface OrchestrationLaunchPlan {
  mode: OrchestrationMode;
  /** Selected participants, in selection order (pipeline order for serialized). */
  personas: ReviewPersona[];
  comment: string;
  /** Explicit lead persona for supervisor mode. When set, overrides the phase default. */
  leadPersona?: ReviewPersona;
  /** Reasoning-effort override; undefined means inherit the ticket/global default. */
  effort?: EffortLevel;
  /** Branch created during launch (when user chose "Create a new branch" in the launcher). */
  branch?: string;
}

interface Props {
  open: boolean;
  ticket: LauncherTicketInfo | null;
  /** Framework all sessions launch with (Claude Code for now). */
  framework: CliFramework;
  /** Ticket phase — drives which personas are offered. Defaults to 'review'. */
  phase?: LaunchPhase;
  /** Template to pre-select on open (e.g. the Single/Multi choice from a card). Falls back to the board default. */
  initialTemplateId?: string;
  onClose: () => void;
  onLaunch: (plan: OrchestrationLaunchPlan) => void;
  busy?: boolean;
  error?: string;
}

/** Phase-aware dialog heading. */
const PHASE_HEADINGS: Record<LaunchPhase, string> = {
  grooming: 'Groom with agents',
  implementation: 'Implement with agents',
  review: 'Orchestrate agents',
  finalize: 'Finalize with agents',
  // FLUX-1380: fast-path launches directly (no template picker) — this heading is unused in v1
  // but kept for PHASE_HEADINGS' exhaustiveness over LaunchPhase.
  'fast-path': 'Fast-path (groom + implement)',
};

/** Map a stored workflow execution pattern onto a launcher orchestration mode. */
const PATTERN_TO_MODE: Record<string, OrchestrationMode> = {
  relay: 'serialized',
  scatter: 'scatter-gather',
  supervisor: 'handoff',
};

/** Persona ids configured for a phase, regardless of how the pattern stores them. */
function phaseConfigMembers(cfg: WorkflowPhaseConfig | undefined): string[] {
  if (!cfg) return [];
  if (cfg.pattern === 'relay') return cfg.steps ?? [];
  if (cfg.pattern === 'supervisor') return cfg.assistants ?? [];
  return cfg.parallel ?? [];
}

/** Build a synthetic run group so the topology preview matches what will launch. */
function buildPreviewGroup(
  mode: OrchestrationMode,
  personas: ReviewPersona[],
  framework: CliFramework,
): SessionGroup {
  const def = getOrchestrationMode(mode);
  const base = (role: string, seq: number, position: CliSessionSummary['patternPosition']): CliSessionSummary => ({
    id: `preview-${role}-${seq}`,
    taskId: 'preview',
    framework,
    status: 'pending',
    command: '',
    args: [],
    startedAt: new Date(seq).toISOString(),
    label: role,
    role,
    pattern: def.pattern,
    patternPosition: position,
    groupId: 'preview',
    groupSeq: seq,
    groupType: def.pattern,
    groupVariant: def.variant,
  });

  const stepPosition = def.pattern === 'supervisor' ? 'assistant' : 'step';
  const sessions: CliSessionSummary[] = personas.map((p, i) => base(`reviewer:${p.id}`, i, stepPosition));
  // A lead/combiner only participates when there are multiple workers to synthesize.
  if (def.hasLead && personas.length > 1) {
    sessions.unshift(base('orchestrator', -1, 'lead'));
  }

  return {
    groupId: 'preview',
    groupType: def.pattern,
    groupVariant: def.variant,
    sessions,
    isMulti: sessions.length > 1,
  };
}

export function OrchestrationLauncher({ open, ticket, framework, phase = 'review', initialTemplateId, onClose, onLaunch, busy, error }: Props) {
  const [mode, setMode] = useState<OrchestrationMode>('scatter-gather');
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [comment, setComment] = useState('');
  const [effort, setEffort] = useState<EffortLevel | ''>('');
  const [personas, setPersonas] = useState<ReviewPersona[]>([]);
  const [personasLoading, setPersonasLoading] = useState(false);
  const [templates, setTemplates] = useState<WorkflowTemplate[]>([]);
  const [templatesLoaded, setTemplatesLoaded] = useState(false);
  const [defaultResolved, setDefaultResolved] = useState(false);
  const [selectedTemplateId, setSelectedTemplateId] = useState<string>('');
  const [supervisorLeadId, setSupervisorLeadId] = useState<string>('');
  const [startMode, setStartMode] = useState<StartMode>('branch');
  const [joinBranch, setJoinBranch] = useState<string | null>(null);
  const [worktrees, setWorktrees] = useState<WorktreeInfo[]>([]);
  const [ghAvailable, setGhAvailable] = useState<boolean | null>(null);
  const [branchBusy, setBranchBusy] = useState(false);
  const [branchError, setBranchError] = useState<string | null>(null);
  const defaultAppliedRef = useRef(false);
  const overlayRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const [templateMenuOpen, setTemplateMenuOpen] = useState(false);
  const templateMenuRef = useRef<HTMLDivElement>(null);
  const headingId = useId();
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const { pushOverlay, popOverlay } = useAppActions();

  const showBranchSection = ticket?.status === 'Todo' && !ticket?.branch;

  // FLUX-1380: 'fast-path' is solo-session only (design decision 7) and never opens this
  // multi-persona launcher — it dispatches directly (see dispatchFastPath). Narrow to the
  // workflow-template phase set for the two template lookups below.
  const workflowPhase = phase !== 'fast-path' ? phase : undefined;

  // The interactive template/mode/persona controls are only revealed once personas + templates
  // have loaded and the default template has been resolved/applied — otherwise the form would
  // flash a blank `Custom` state before snapping to the real default. See FLUX-830.
  const ready = !personasLoading && templatesLoaded && defaultResolved;

  // While open, register as a blocking overlay so board hover popups (card description
  // previews, etc.) are suppressed and cannot render on top of the dialog.
  useEffect(() => {
    if (!open) return;
    pushOverlay();
    return () => popOverlay();
  }, [open, pushOverlay, popOverlay]);

  useEffect(() => {
    if (!open) {
      setMode('scatter-gather');
      setSelectedIds([]);
      setComment('');
      setEffort('');
      setSelectedTemplateId('');
      setTemplatesLoaded(false);
      setDefaultResolved(false);
      setSupervisorLeadId('');
      setStartMode('branch');
      setJoinBranch(null);
      setGhAvailable(null);
      setBranchBusy(false);
      setBranchError(null);
      defaultAppliedRef.current = false;
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    dialogRef.current?.focus();
  }, [open]);

  // Initialise branch default and fetch gh availability when launcher opens on a Todo with no branch.
  useEffect(() => {
    if (!open || !showBranchSection) return;
    // Default mirrors the old useBranch behavior: non-XS opts into a new branch,
    // XS continues on the current branch. worktreeByDefault upgrades to a worktree.
    setStartMode(ticket?.effort === 'XS' ? 'current' : 'branch');
    let cancelled = false;
    fetchHealth()
      .then((h) => { if (!cancelled) setGhAvailable(h.ghAuthAvailable); })
      .catch(() => { if (!cancelled) setGhAvailable(null); });
    fetchConfig()
      .then((c) => { if (!cancelled && c.worktreeByDefault && ticket?.effort !== 'XS') setStartMode('worktree'); })
      .catch(() => {});
    fetchWorktrees()
      .then((ws) => { if (!cancelled) setWorktrees(ws); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [open, showBranchSection, ticket?.effort]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setPersonasLoading(true);
    fetchOrchestrationPersonas(phase)
      .then((list) => { if (!cancelled) setPersonas(list); })
      .catch(() => { if (!cancelled) setPersonas([]); })
      .finally(() => { if (!cancelled) setPersonasLoading(false); });
    return () => { cancelled = true; };
  }, [open, phase]);

  // Apply a template's config for the current phase onto mode + selected personas.
  const applyTemplate = useCallback((wf: WorkflowTemplate | undefined) => {
    if (!wf) return;
    const cfg = workflowPhase ? wf.phases?.[workflowPhase] : undefined;
    if (!cfg) return;
    const memberIds = phaseConfigMembers(cfg).filter((id) => personas.some((p) => p.id === id));
    const resolvedMode = PATTERN_TO_MODE[cfg.pattern];
    if (resolvedMode) setMode(resolvedMode);
    if (cfg.pattern === 'supervisor') {
      // For supervisor, the template's lead is the orchestrator; assistants are recommendations only.
      setSupervisorLeadId(cfg.lead && personas.some((p) => p.id === cfg.lead) ? cfg.lead : '');
      setSelectedIds(memberIds);
    } else {
      setSelectedIds(memberIds);
    }
  }, [workflowPhase, personas]);

  // Load templates relevant to this phase when the launcher opens.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    fetchWorkflows()
      .then((list) => { if (!cancelled) setTemplates(list); })
      .catch(() => { if (!cancelled) setTemplates([]); })
      .finally(() => { if (!cancelled) setTemplatesLoaded(true); });
    return () => { cancelled = true; };
  }, [open]);

  // Templates that define a config for the current phase (the only ones worth offering).
  const templatesForPhase = useMemo(
    () => (workflowPhase ? templates.filter((w) => w.phases?.[workflowPhase]) : []),
    [templates, workflowPhase],
  );

  // Pre-populate from the card's chosen template, else the board default, once personas + templates load.
  useEffect(() => {
    if (!open || personasLoading || !templatesLoaded || defaultAppliedRef.current) return;
    let cancelled = false;
    (async () => {
      try {
        // Nothing to resolve against yet — fall through to mark resolved so the form reveals.
        if (personas.length === 0 || templates.length === 0) return;
        let targetId = initialTemplateId;
        if (!targetId) {
          const config = await fetchConfig();
          targetId = resolvePhaseDefaultId(config.phaseDefaults, phase, 'single');
        }
        if (cancelled || !targetId) return;
        const wf = templates.find((w) => w.id === targetId);
        if (!wf) return;
        setSelectedTemplateId(wf.id);
        applyTemplate(wf);
        defaultAppliedRef.current = true;
      } catch {
        // No default to apply — leave the launcher at its blank defaults.
      } finally {
        // Every terminal path (applied, no-default, empty, or error) is "resolved":
        // we've decided whether a default applies, so the form can be revealed.
        if (!cancelled) setDefaultResolved(true);
      }
    })();
    return () => { cancelled = true; };
  }, [open, phase, personas, personasLoading, templatesLoaded, templates, initialTemplateId, applyTemplate]);

  // FLUX-1022: routed through the shared Escape stack (instead of this component's own listener)
  // because the launcher can be nested inside TaskModal (opened for review from within an open
  // ticket) — without sharing the stack, both TaskModal's Escape handler and this one would fire
  // on the same press and close both surfaces at once.
  //
  // FLUX-1180: default `ignoreWhenTyping: true` (unlike ReleaseModal/ContextMenu/TicketActions,
  // which opt out) is intentional here, not an oversight — this is a deliberate, signed-off
  // behavior change from the pre-FLUX-1022 raw listener, which closed the launcher unconditionally
  // even while typing in the "Focus area" textarea below. That textarea is free-form prose with no
  // competing local Escape handler of its own to protect, so letting ESC bubble up while typing
  // risks silently discarding a half-written comment. Keep the default guard.
  useEscapeKey(() => onCloseRef.current(), { enabled: open });

  useEffect(() => {
    if (!open) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Tab' && dialogRef.current) {
        const focusable = dialogRef.current.querySelectorAll<HTMLElement>(
          'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
        );
        if (focusable.length === 0) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [open]);

  // Close the custom template dropdown when clicking outside it.
  useEffect(() => {
    if (!templateMenuOpen) return;
    const handleClick = (e: MouseEvent) => {
      if (templateMenuRef.current && !templateMenuRef.current.contains(e.target as Node)) {
        setTemplateMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [templateMenuOpen]);

  const togglePersona = useCallback((id: string) => {
    setSelectedTemplateId('');
    setSelectedIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  }, []);

  const def = getOrchestrationMode(mode);
  const isSupervisor = def.pattern === 'supervisor';

  // Lead personas available for supervisor mode.
  const leadPersonas = useMemo(
    () => personas.filter((p) => p.role === 'lead' || p.role === 'flex'),
    [personas],
  );
  // Resolve the effective supervisor lead: explicit pick > template default > phase default.
  const effectiveLeadId = supervisorLeadId || phaseCombiner(phase, 'handoff')?.personaId || 'supervisor';
  const effectiveLead = useMemo(
    () => personas.find((p) => p.id === effectiveLeadId),
    [personas, effectiveLeadId],
  );

  const selectedPersonas = useMemo(
    () => selectedIds.map((id) => personas.find((p) => p.id === id)).filter((p): p is ReviewPersona => Boolean(p)),
    [selectedIds, personas],
  );
  // For supervisor, the preview should only show the lead — selectedIds are recommendations, not launched agents.
  const previewGroup = useMemo(
    () => buildPreviewGroup(mode, isSupervisor ? [] : selectedPersonas, framework),
    [mode, isSupervisor, selectedPersonas, framework],
  );

  const enoughAgents = isSupervisor || selectedPersonas.length >= def.minAgents;
  // A single agent launches standalone — no orchestration pattern, always runnable.
  const isSingle = selectedPersonas.length === 1 && !isSupervisor;
  const canLaunch = (isSingle || (def.launchable && enoughAgents)) && !busy;

  const handleLaunch = async () => {
    if (!canLaunch) return;
    const plan: OrchestrationLaunchPlan = {
      mode,
      personas: selectedPersonas,
      comment: comment.trim(),
      effort: effort || undefined,
      leadPersona: isSupervisor ? effectiveLead : undefined,
    };
    if (showBranchSection && ticket && startMode !== 'current') {
      setBranchBusy(true);
      setBranchError(null);
      try {
        let branch: string;
        if (startMode === 'join') {
          if (!joinBranch) throw new Error('Pick a worktree to join.');
          branch = (await joinWorktree(ticket.id, joinBranch)).branch;
        } else {
          // 'worktree' creates a dedicated worktree; 'branch' just creates the branch.
          branch = (await createBranch(ticket.id, { worktree: startMode === 'worktree' })).branch;
        }
        onLaunch({ ...plan, branch });
      } catch (err) {
        setBranchError(err instanceof Error ? err.message : 'Failed to create branch');
        setBranchBusy(false);
      }
      return;
    }
    onLaunch(plan);
  };

  if (!open || !ticket) return null;

  return (
    <div className="fixed inset-0 z-[200] flex items-center justify-center" role="dialog" aria-modal="true" aria-labelledby={headingId}>
      <div ref={overlayRef} className="absolute inset-0 bg-black/40 backdrop-blur-sm" onClick={onClose} />
      <div ref={dialogRef} tabIndex={-1} className="relative z-10 flex max-h-[90vh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-gray-200 bg-white shadow-2xl outline-none dark:border-white/10 dark:bg-[#1a1b23]">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-gray-100 px-5 py-3 dark:border-white/5">
          <h3 id={headingId} className="text-sm font-bold text-gray-900 dark:text-gray-100">{PHASE_HEADINGS[phase] ?? 'Orchestrate agents'}</h3>
          <button
            onClick={onClose}
            className="rounded-lg p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-600 dark:hover:bg-white/10 dark:hover:text-gray-200"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-5">
          {/* Ticket context */}
          <div className="mb-4 rounded-lg border border-gray-100 bg-gray-50 px-3 py-2.5 dark:border-white/5 dark:bg-black/20">
            <div className="flex min-w-0 items-center gap-2">
              <span className="shrink-0 rounded bg-primary/10 px-1.5 py-0.5 text-[10px] font-bold text-primary">
                {ticket.id}
              </span>
              <span className="truncate text-xs font-semibold text-gray-800 dark:text-gray-100">{ticket.title}</span>
            </div>
            {ticket.branch && (
              <div className="mt-1.5 flex items-center gap-1.5 text-[10px] text-gray-500 dark:text-gray-400">
                <FileText className="h-3 w-3 shrink-0" />
                <span className="truncate font-mono">{ticket.branch}</span>
              </div>
            )}
          </div>

          {/* Gate the interactive controls behind `ready` so the resolved default template
              (+ its mode/personas) is in place before they're revealed — no blank-then-snap. */}
          {!ready ? (
            <div className="mb-4 flex min-h-[280px] flex-col items-center justify-center gap-2 rounded-xl border border-gray-100 bg-gray-50 dark:border-white/5 dark:bg-black/20">
              <div className="h-5 w-5 animate-spin rounded-full border-2 border-gray-300 border-t-primary dark:border-white/20 dark:border-t-primary" />
              <span className="text-xs text-gray-400">Preparing template…</span>
            </div>
          ) : (
          <>
          {/* Template + reasoning effort — share a row to save vertical space */}
          <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-start">
            {templatesForPhase.length > 0 && (
              <div className="sm:w-1/2">
                <label className="mb-1.5 block text-[10px] font-bold uppercase tracking-wider text-gray-400">
                  Template
                </label>
                <div ref={templateMenuRef} className="relative">
                  <button
                    type="button"
                    onClick={() => setTemplateMenuOpen((o) => !o)}
                    aria-haspopup="listbox"
                    aria-expanded={templateMenuOpen}
                    className="flex w-full items-center justify-between gap-2 rounded-lg border border-gray-200 bg-white px-3 py-2 text-xs font-semibold text-gray-800 outline-none transition-colors hover:border-primary/40 focus:border-primary dark:border-white/10 dark:bg-black/20 dark:text-gray-100"
                  >
                    <span className="truncate">
                      {templatesForPhase.find((w) => w.id === selectedTemplateId)?.name ?? 'Custom (manual selection)'}
                    </span>
                    <ChevronDown className={`h-3.5 w-3.5 shrink-0 text-gray-400 transition-transform ${templateMenuOpen ? 'rotate-180' : ''}`} />
                  </button>
                  {templateMenuOpen && (
                    <div
                      role="listbox"
                      className="absolute left-0 right-0 top-full z-20 mt-1 max-h-64 overflow-y-auto rounded-lg border border-gray-200 bg-white p-1 shadow-xl dark:border-white/10 dark:bg-[#1e1f2a]"
                    >
                      {[
                        { id: '', name: 'Custom (manual selection)', group: '' as string },
                        ...templatesForPhase.filter((w) => w.builtIn).map((w) => ({ id: w.id, name: w.name, group: 'Built-in' })),
                        ...templatesForPhase.filter((w) => !w.builtIn).map((w) => ({ id: w.id, name: w.name, group: 'Custom' })),
                      ].map((item, idx, arr) => {
                        const active = selectedTemplateId === item.id;
                        const showHeader = item.group && arr[idx - 1]?.group !== item.group;
                        return (
                          <div key={item.id || '__custom'}>
                            {showHeader && (
                              <div className="px-2.5 pb-1 pt-2 text-[9px] font-bold uppercase tracking-wider text-gray-400">
                                {item.group}
                              </div>
                            )}
                            <button
                              type="button"
                              role="option"
                              aria-selected={active}
                              onClick={() => {
                                setSelectedTemplateId(item.id);
                                applyTemplate(templatesForPhase.find((w) => w.id === item.id));
                                setTemplateMenuOpen(false);
                              }}
                              className={`flex w-full items-center justify-between gap-2 rounded-md px-2.5 py-1.5 text-left text-xs font-semibold transition-colors ${
                                active
                                  ? 'bg-primary/10 text-primary'
                                  : 'text-gray-700 hover:bg-gray-100 dark:text-gray-200 dark:hover:bg-white/5'
                              }`}
                            >
                              <span className="truncate">{item.name}</span>
                              {active && <Check className="h-3.5 w-3.5 shrink-0" />}
                            </button>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              </div>
            )}

            <div className={templatesForPhase.length > 0 ? 'sm:flex-1' : 'w-full'}>
              <div className="mb-1.5 flex items-center justify-between">
                <label className="text-[10px] font-bold uppercase tracking-wider text-gray-400">
                  Reasoning effort
                </label>
                <span className="text-[10px] font-bold text-primary">
                  {effort === '' ? 'Default' : effortDisplayLabel(effort)}
                </span>
              </div>
              <input
                type="range"
                min={0}
                max={EFFORT_LEVELS.length}
                step={1}
                value={effort === '' ? 0 : EFFORT_LEVELS.indexOf(effort) + 1}
                onChange={(e) => {
                  const v = Number(e.target.value);
                  setEffort(v === 0 ? '' : EFFORT_LEVELS[v - 1]);
                }}
                aria-label="Reasoning effort"
                className="h-1.5 w-full cursor-pointer appearance-none rounded-full bg-gray-200 accent-primary dark:bg-white/10"
              />
              <div className="mt-1 flex justify-between text-[8px] font-semibold uppercase tracking-wide text-gray-400">
                <span>Default</span>
                {EFFORT_LEVELS.map((lvl) => (
                  <span key={lvl} className={effort === lvl ? 'text-primary' : undefined}>{effortDisplayLabel(lvl)}</span>
                ))}
              </div>
            </div>
          </div>

          {/* Pattern selector — hidden for a single standalone agent (no orchestration needed) */}
          {isSingle ? (
            <div className="mb-4 rounded-lg border border-gray-100 bg-gray-50 px-3 py-2 text-[11px] text-gray-500 dark:border-white/5 dark:bg-black/20 dark:text-gray-400">
              Single agent — launches standalone with full access. Add another agent to orchestrate a team.
            </div>
          ) : (
          <div className="mb-4">
            <label className="mb-1.5 block text-[10px] font-bold uppercase tracking-wider text-gray-400">
              Orchestration pattern
            </label>
            <div className="grid grid-cols-2 gap-1.5">
              {ORCHESTRATION_MODES.map((m) => {
                const active = m.id === mode;
                const disabled = !m.launchable;
                return (
                  <button
                    key={m.id}
                    type="button"
                    disabled={disabled}
                    onClick={() => { if (!disabled) { setSelectedTemplateId(''); setMode(m.id); } }}
                    aria-disabled={disabled || undefined}
                    title={disabled ? 'Engine sequencing for this pattern is coming soon' : m.blurb}
                    className={`flex items-center gap-2 rounded-lg border px-2.5 py-2 text-left transition-colors ${
                      disabled
                        ? 'cursor-not-allowed border-gray-100 opacity-50 dark:border-white/5'
                        : active
                          ? 'border-primary bg-primary/5 dark:bg-primary/10'
                          : 'border-gray-200 hover:bg-gray-50 dark:border-white/10 dark:hover:bg-white/5'
                    }`}
                  >
                    <span className={active ? 'text-primary' : 'text-gray-400'}>
                      <TopologyGlyph shape={m.topology} className="h-4 w-4" />
                    </span>
                    <span className="flex min-w-0 flex-col">
                      <span className="flex items-center gap-1 text-xs font-semibold text-gray-800 dark:text-gray-100">
                        {m.label}
                        {disabled && <Lock className="h-2.5 w-2.5 text-gray-400" />}
                      </span>
                      {disabled && <span className="text-[9px] text-gray-400">Coming soon</span>}
                    </span>
                  </button>
                );
              })}
            </div>
            <p className="mt-1.5 text-[10px] leading-snug text-gray-500 dark:text-gray-400">{def.blurb}</p>
          </div>
          )}

          {/* Supervisor: lead picker + optional recommended agents */}
          {isSupervisor ? (
            <div className="mb-4 space-y-3">
              {/* Lead persona picker */}
              <div>
                <label className="mb-1.5 block text-[10px] font-bold uppercase tracking-wider text-gray-400">
                  Lead agent
                </label>
                <select
                  value={supervisorLeadId || effectiveLeadId}
                  onChange={(e) => { setSupervisorLeadId(e.target.value); setSelectedTemplateId(''); }}
                  className="w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-xs font-semibold text-gray-800 outline-none transition-colors hover:border-primary/40 focus:border-primary dark:border-white/10 dark:bg-black/20 dark:text-gray-100"
                >
                  {leadPersonas.map((p) => (
                    <option key={p.id} value={p.id}>{p.label} — {p.description}</option>
                  ))}
                </select>
              </div>
              {/* Recommended specialists (optional hints to the supervisor) */}
              <div>
                <div className="mb-1.5 flex items-center justify-between">
                  <label className="text-[10px] font-bold uppercase tracking-wider text-gray-400">
                    Recommend specialists <span className="font-normal normal-case">(optional — passed as hints)</span>
                  </label>
                  {selectedPersonas.length > 0 && (
                    <button
                      type="button"
                      onClick={() => { setSelectedIds([]); setSelectedTemplateId(''); }}
                      className="text-[10px] font-semibold text-gray-400 hover:text-red-500 transition-colors"
                    >
                      Clear all
                    </button>
                  )}
                </div>
                {selectedPersonas.length > 0 && (
                  <div className="mb-2 flex flex-wrap gap-1.5">
                    {selectedPersonas.map((p) => (
                      <span
                        key={p.id}
                        className="inline-flex items-center gap-1 rounded-full border border-gray-200 bg-gray-50 px-2 py-0.5 text-[10px] font-semibold text-gray-600 dark:border-white/10 dark:bg-white/5 dark:text-gray-300"
                      >
                        {p.label}
                        <button
                          type="button"
                          onClick={() => setSelectedIds((prev) => prev.filter((id) => id !== p.id))}
                          className="ml-0.5 flex min-h-[24px] min-w-[24px] items-center justify-center text-gray-400 hover:text-red-500"
                        >
                          <X className="h-2.5 w-2.5" />
                        </button>
                      </span>
                    ))}
                  </div>
                )}
                {/* Add specialist picker — shows workers not already selected */}
                {(() => {
                  const available = personas.filter((p) => p.role !== 'lead' && !selectedIds.includes(p.id));
                  if (available.length === 0) return null;
                  return (
                    <select
                      value=""
                      onChange={(e) => {
                        if (e.target.value) {
                          setSelectedIds((prev) => [...prev, e.target.value]);
                          setSelectedTemplateId('');
                        }
                      }}
                      className="w-full rounded-lg border border-dashed border-gray-300 bg-transparent px-3 py-1.5 text-[11px] text-gray-500 outline-none transition-colors hover:border-primary/40 focus:border-primary dark:border-white/15 dark:text-gray-400"
                    >
                      <option value="">+ Add a specialist…</option>
                      {available.map((p) => (
                        <option key={p.id} value={p.id}>{p.label} — {p.description}</option>
                      ))}
                    </select>
                  );
                })()}
                <p className="mt-1.5 text-[10px] text-gray-400 dark:text-gray-500">
                  {selectedPersonas.length > 0
                    ? 'These are suggested to the supervisor — it may also discover others via list_available_agents.'
                    : 'None selected — the supervisor will discover specialists dynamically.'}
                </p>
              </div>
            </div>
          ) : (
          <div className="mb-4">
            <div className="mb-2 flex items-center justify-between">
              <span className="text-[10px] font-bold uppercase tracking-wider text-gray-400">
                {def.hasLead ? 'Select agents' : 'Select agents (peers)'}
              </span>
              {selectedPersonas.length > 0 && (
                <span className="rounded-full bg-primary/10 px-1.5 py-0.5 text-[10px] font-semibold text-primary">
                  {selectedPersonas.length} selected
                </span>
              )}
            </div>
            <div className="max-h-44 space-y-1 overflow-y-auto rounded-xl border border-gray-100 bg-gray-50 p-1 dark:border-white/5 dark:bg-black/20">
              {personasLoading && personas.length === 0 && (
                <div className="px-3 py-2 text-xs text-gray-400">Loading agents…</div>
              )}
              {!personasLoading && personas.length === 0 && (
                <div className="px-3 py-2 text-xs text-gray-400">No agents available.</div>
              )}
              {personas.map((persona) => {
                const order = selectedIds.indexOf(persona.id);
                const isSelected = order >= 0;
                const incompatible =
                  persona.role === 'lead' && def.pattern !== 'supervisor';
                return (
                  <button
                    key={persona.id}
                    type="button"
                    disabled={incompatible}
                    aria-disabled={incompatible}
                    onClick={() => togglePersona(persona.id)}
                    className={`flex w-full items-start gap-2.5 rounded-lg px-3 py-2 text-left transition-colors ${
                      incompatible
                        ? 'cursor-not-allowed opacity-40'
                        : isSelected
                          ? 'bg-primary/5 dark:bg-primary/10'
                          : 'hover:bg-white dark:hover:bg-white/5'
                    }`}
                  >
                    <div
                      className={`mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded border text-[9px] font-bold transition-colors ${
                        isSelected ? 'border-primary bg-primary text-white' : 'border-gray-300 dark:border-white/20'
                      }`}
                    >
                      {isSelected ? (def.pattern === 'relay' ? order + 1 : <Check className="h-3 w-3" />) : null}
                    </div>
                    <div className="flex min-w-0 flex-col gap-0.5">
                      <span className="text-sm font-semibold text-gray-800 dark:text-gray-100">{persona.label}</span>
                      <span className="text-xs text-gray-500 dark:text-gray-400">{persona.description}</span>
                    </div>
                  </button>
                );
              })}
            </div>
          </div>
          )}

          {/* Live topology preview — hidden for supervisor (lead-only, not useful) */}
          {!isSupervisor && selectedPersonas.length > 0 && (
            <div className="mb-4">
              <label className="mb-1.5 block text-[10px] font-bold uppercase tracking-wider text-gray-400">Preview</label>
              <div className="overflow-x-auto rounded-lg border border-gray-100 bg-gray-50 px-3 py-2.5 dark:border-white/5 dark:bg-black/20">
                <OrchestrationTopology group={previewGroup} variant="map" />
              </div>
            </div>
          )}
          </>
          )}

          {/* Focus area */}
          <div className="mb-1">
            <label className="mb-1.5 block text-[10px] font-bold uppercase tracking-wider text-gray-400">
              Focus area <span className="font-normal normal-case">(optional)</span>
            </label>
            <textarea
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              placeholder="Anything specific to focus on? Appended to every agent's prompt."
              className="w-full resize-none rounded-lg border border-gray-200 bg-white px-3 py-2 text-xs outline-none placeholder:text-gray-400 focus:border-primary dark:border-white/10 dark:bg-black/20 dark:text-gray-200 dark:placeholder:text-gray-500"
              rows={2}
            />
          </div>

          {/* Branch section — only for Todo tickets with no existing branch */}
          {showBranchSection && (
            <div className="mt-4">
              <BranchSection
                taskId={ticket!.id}
                taskTitle={ticket!.title}
                effort={ticket!.effort}
                ghAvailable={ghAvailable}
                mode={startMode}
                setMode={setStartMode}
                worktrees={worktrees}
                joinBranch={joinBranch}
                setJoinBranch={setJoinBranch}
              />
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="border-t border-gray-100 px-5 py-3 dark:border-white/5">
          {(error || branchError) && (
            <div className="mb-3 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700 dark:bg-red-500/10 dark:text-red-300">
              {error || branchError}
            </div>
          )}
          <button
            type="button"
            onClick={() => void handleLaunch()}
            disabled={!canLaunch || branchBusy}
            className="flex w-full items-center justify-center gap-2 rounded-lg bg-primary px-4 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-50"
          >
            {branchBusy && !busy ? (
              'Creating branch…'
            ) : busy ? (
              'Launching…'
            ) : isSupervisor ? (
              <>
                <Rocket className="h-4 w-4" />
                Launch supervisor
              </>
            ) : isSingle ? (
              <>
                <Rocket className="h-4 w-4" />
                Launch agent
              </>
            ) : !def.launchable ? (
              'Pattern coming soon — pick Scatter-gather or Parallel'
            ) : !enoughAgents ? (
              `Select at least ${def.minAgents} agent${def.minAgents === 1 ? '' : 's'}`
            ) : (
              <>
                <Rocket className="h-4 w-4" />
                Launch {selectedPersonas.length} agent{selectedPersonas.length === 1 ? '' : 's'}
                {def.hasLead && selectedPersonas.length > 1 ? ' + combiner' : ''}
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
