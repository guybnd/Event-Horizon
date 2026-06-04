import { useCallback, useEffect, useMemo, useRef, useState, useId } from 'react';
import { Check, FileText, Lock, Rocket, X } from 'lucide-react';
import {
  ORCHESTRATION_MODES,
  getOrchestrationMode,
  type OrchestrationMode,
  type ReviewPersona,
} from '../agentActions';
import { fetchOrchestrationPersonas, fetchConfig, fetchWorkflows, type WorkflowPhaseConfig } from '../api';
import type { CliFramework, CliSessionSummary } from '../types';
import { type SessionGroup } from '../orchestration';
import { OrchestrationTopology, TopologyGlyph } from './OrchestrationTopology';

export interface LauncherTicketInfo {
  id: string;
  title: string;
  status?: string;
  branch?: string;
}

export interface OrchestrationLaunchPlan {
  mode: OrchestrationMode;
  /** Selected participants, in selection order (pipeline order for serialized). */
  personas: ReviewPersona[];
  comment: string;
}

interface Props {
  open: boolean;
  ticket: LauncherTicketInfo | null;
  /** Framework all sessions launch with (Claude Code for now). */
  framework: CliFramework;
  /** Ticket phase — drives which personas are offered. Defaults to 'review'. */
  phase?: string;
  onClose: () => void;
  onLaunch: (plan: OrchestrationLaunchPlan) => void;
  busy?: boolean;
  error?: string;
}

/** Phase-aware dialog heading. */
const PHASE_HEADINGS: Record<string, string> = {
  grooming: 'Groom with agents',
  implementation: 'Implement with agents',
  review: 'Orchestrate agents',
  release: 'Release with agents',
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

export function OrchestrationLauncher({ open, ticket, framework, phase = 'review', onClose, onLaunch, busy, error }: Props) {
  const [mode, setMode] = useState<OrchestrationMode>('scatter-gather');
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [comment, setComment] = useState('');
  const [personas, setPersonas] = useState<ReviewPersona[]>([]);
  const [personasLoading, setPersonasLoading] = useState(false);
  const defaultAppliedRef = useRef(false);
  const overlayRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const headingId = useId();
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!open) {
      setMode('scatter-gather');
      setSelectedIds([]);
      setComment('');
      defaultAppliedRef.current = false;
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    dialogRef.current?.focus();
  }, [open]);

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

  // Pre-populate mode + personas from the board default workflow for this phase.
  useEffect(() => {
    if (!open || personasLoading || defaultAppliedRef.current || personas.length === 0) return;
    let cancelled = false;
    (async () => {
      try {
        const config = await fetchConfig();
        const defaultId = config.defaultWorkflowId;
        if (!defaultId) return;
        const workflows = await fetchWorkflows();
        const wf = workflows.find((w) => w.id === defaultId);
        const cfg = wf?.phases?.[phase as keyof typeof wf.phases];
        if (!cfg) return;
        const memberIds = phaseConfigMembers(cfg).filter((id) => personas.some((p) => p.id === id));
        if (cancelled || memberIds.length === 0) return;
        const resolvedMode = PATTERN_TO_MODE[cfg.pattern];
        if (resolvedMode) setMode(resolvedMode);
        setSelectedIds(memberIds);
        defaultAppliedRef.current = true;
      } catch {
        // No default to apply — leave the launcher at its blank defaults.
      }
    })();
    return () => { cancelled = true; };
  }, [open, phase, personas, personasLoading]);

  useEffect(() => {
    if (!open) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCloseRef.current();
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

  const togglePersona = useCallback((id: string) => {
    setSelectedIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  }, []);

  const def = getOrchestrationMode(mode);
  const selectedPersonas = useMemo(
    () => selectedIds.map((id) => personas.find((p) => p.id === id)).filter((p): p is ReviewPersona => Boolean(p)),
    [selectedIds, personas],
  );
  const previewGroup = useMemo(
    () => buildPreviewGroup(mode, selectedPersonas, framework),
    [mode, selectedPersonas, framework],
  );

  const enoughAgents = selectedPersonas.length >= def.minAgents;
  const canLaunch = def.launchable && enoughAgents && !busy;

  const handleLaunch = () => {
    if (!canLaunch) return;
    onLaunch({ mode, personas: selectedPersonas, comment: comment.trim() });
  };

  if (!open || !ticket) return null;

  return (
    <div className="fixed inset-0 z-[200] flex items-center justify-center" role="dialog" aria-modal="true" aria-labelledby={headingId}>
      <div ref={overlayRef} className="absolute inset-0 bg-black/40 backdrop-blur-sm" onClick={onClose} />
      <div ref={dialogRef} tabIndex={-1} className="relative z-10 flex max-h-[90vh] w-full max-w-md flex-col overflow-hidden rounded-2xl border border-gray-200 bg-white shadow-2xl outline-none dark:border-white/10 dark:bg-[#1a1b23]">
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

          {/* Pattern selector */}
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
                    onClick={() => !disabled && setMode(m.id)}
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

          {/* Participant selection */}
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
                  persona.compatiblePatterns.length > 0 && !persona.compatiblePatterns.includes(def.pattern);
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

          {/* Live topology preview */}
          {selectedPersonas.length > 0 && (
            <div className="mb-4">
              <label className="mb-1.5 block text-[10px] font-bold uppercase tracking-wider text-gray-400">Preview</label>
              <div className="overflow-x-auto rounded-lg border border-gray-100 bg-gray-50 px-3 py-2.5 dark:border-white/5 dark:bg-black/20">
                <OrchestrationTopology group={previewGroup} variant="map" />
              </div>
            </div>
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
        </div>

        {/* Footer */}
        <div className="border-t border-gray-100 px-5 py-3 dark:border-white/5">
          {error && (
            <div className="mb-3 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700 dark:bg-red-500/10 dark:text-red-300">
              {error}
            </div>
          )}
          <button
            type="button"
            onClick={handleLaunch}
            disabled={!canLaunch}
            className="flex w-full items-center justify-center gap-2 rounded-lg bg-primary px-4 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-50"
          >
            {busy ? (
              'Launching…'
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
