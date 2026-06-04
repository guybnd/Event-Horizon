import { useCallback, useEffect, useRef, useState } from 'react';
import { Check, ChevronDown, FileText, Users, X } from 'lucide-react';
import { REVIEW_PERSONAS, type ReviewPersona } from '../agentActions';

export interface ReviewModalTicketInfo {
  id: string;
  title: string;
  status?: string;
  branch?: string;
}

interface Props {
  open: boolean;
  ticket: ReviewModalTicketInfo | null;
  onClose: () => void;
  onLaunch: (personas: ReviewPersona[], withOrchestrator: boolean, userComment: string) => void;
  busy?: boolean;
  error?: string;
}

export function ReviewModal({ open, ticket, onClose, onLaunch, busy, error }: Props) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [withOrchestrator, setWithOrchestrator] = useState(true);
  const [comment, setComment] = useState('');
  const overlayRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) {
      setSelected(new Set());
      setComment('');
      setWithOrchestrator(true);
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [open, onClose]);

  const togglePersona = useCallback((id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const handleLaunch = () => {
    const personas = REVIEW_PERSONAS.filter((p) => selected.has(p.id));
    if (personas.length === 0) return;
    onLaunch(personas, personas.length >= 2 ? withOrchestrator : false, comment.trim());
  };

  if (!open || !ticket) return null;

  return (
    <div className="fixed inset-0 z-[200] flex items-center justify-center">
      <div
        ref={overlayRef}
        className="absolute inset-0 bg-black/40 backdrop-blur-sm"
        onClick={onClose}
      />
      <div className="relative z-10 w-full max-w-md rounded-2xl border border-gray-200 bg-white p-5 shadow-2xl dark:border-white/10 dark:bg-[#1a1b23]">
        {/* Header */}
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-bold text-gray-900 dark:text-gray-100">Send for Code Review</h3>
          <button
            onClick={onClose}
            className="rounded-lg p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-600 dark:hover:bg-white/10 dark:hover:text-gray-200"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Ticket context */}
        <div className="mb-4 rounded-lg border border-gray-100 bg-gray-50 px-3 py-2.5 dark:border-white/5 dark:bg-black/20">
          <div className="flex items-center gap-2 min-w-0">
            <span className="shrink-0 rounded bg-primary/10 px-1.5 py-0.5 text-[10px] font-bold text-primary">
              {ticket.id}
            </span>
            <span className="truncate text-xs font-semibold text-gray-800 dark:text-gray-100">
              {ticket.title}
            </span>
          </div>
          {ticket.branch && (
            <div className="mt-1.5 flex items-center gap-1.5 text-[10px] text-gray-500 dark:text-gray-400">
              <FileText className="h-3 w-3 shrink-0" />
              <span className="truncate font-mono">{ticket.branch}</span>
            </div>
          )}
        </div>

        {/* Template selector (placeholder for orchestration templates) */}
        <div className="mb-4">
          <label className="block text-[10px] font-bold uppercase tracking-wider text-gray-400 mb-1.5">
            Review template
          </label>
          <button
            type="button"
            disabled
            className="flex w-full items-center justify-between rounded-lg border border-dashed border-gray-200 bg-white px-3 py-2 text-xs text-gray-400 dark:border-white/10 dark:bg-black/20 dark:text-gray-500"
          >
            <span>Default (select reviewers below)</span>
            <ChevronDown className="h-3.5 w-3.5" />
          </button>
        </div>

        {/* Persona selection */}
        <div className="mb-4">
          <div className="flex items-center justify-between mb-2">
            <span className="text-[10px] font-bold uppercase tracking-wider text-gray-400">Select reviewers</span>
            {selected.size > 0 && (
              <span className="rounded-full bg-primary/10 px-1.5 py-0.5 text-[10px] font-semibold text-primary">
                {selected.size} selected
              </span>
            )}
          </div>
          <div className="space-y-1 max-h-52 overflow-y-auto rounded-xl border border-gray-100 bg-gray-50 p-1 dark:border-white/5 dark:bg-black/20">
            {REVIEW_PERSONAS.map((persona) => (
              <button
                key={persona.id}
                type="button"
                onClick={() => togglePersona(persona.id)}
                className={`flex w-full items-start gap-2.5 rounded-lg px-3 py-2 text-left transition-colors ${
                  selected.has(persona.id)
                    ? 'bg-primary/5 dark:bg-primary/10'
                    : 'hover:bg-white dark:hover:bg-white/5'
                }`}
              >
                <div className={`mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded border transition-colors ${
                  selected.has(persona.id)
                    ? 'border-primary bg-primary text-white'
                    : 'border-gray-300 dark:border-white/20'
                }`}>
                  {selected.has(persona.id) && <Check className="h-3 w-3" />}
                </div>
                <div className="flex flex-col gap-0.5 min-w-0">
                  <span className="text-sm font-semibold text-gray-800 dark:text-gray-100">{persona.label}</span>
                  <span className="text-xs text-gray-500 dark:text-gray-400">{persona.description}</span>
                </div>
              </button>
            ))}
          </div>
        </div>

        {/* User comment */}
        <div className="mb-4">
          <label className="block text-[10px] font-bold uppercase tracking-wider text-gray-400 mb-1.5">
            Focus area <span className="normal-case font-normal">(optional)</span>
          </label>
          <textarea
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            placeholder="Anything specific to look at? e.g. 'Check the error handling in api.ts'"
            className="w-full resize-none rounded-lg border border-gray-200 bg-white px-3 py-2 text-xs outline-none placeholder:text-gray-400 focus:border-primary dark:border-white/10 dark:bg-black/20 dark:text-gray-200 dark:placeholder:text-gray-500"
            rows={2}
          />
        </div>

        {/* Orchestrator toggle */}
        {selected.size >= 2 && (
          <div className="mb-4">
            <label className="flex items-center gap-2.5 cursor-pointer rounded-lg border border-gray-100 bg-gray-50 px-3 py-2.5 dark:border-white/5 dark:bg-black/20">
              <input
                type="checkbox"
                checked={withOrchestrator}
                onChange={(e) => setWithOrchestrator(e.target.checked)}
                className="h-3.5 w-3.5 rounded border-gray-300 text-primary focus:ring-primary dark:border-white/20"
              />
              <div>
                <span className="text-xs font-semibold text-gray-700 dark:text-gray-200">Launch with Orchestrator</span>
                <p className="text-[10px] text-gray-500 dark:text-gray-400 mt-0.5">
                  Synthesizes all reviews and decides next status automatically
                </p>
              </div>
            </label>
          </div>
        )}

        {/* Error */}
        {error && (
          <div className="mb-3 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700 dark:bg-red-500/10 dark:text-red-300">
            {error}
          </div>
        )}

        {/* Launch button */}
        <button
          type="button"
          onClick={handleLaunch}
          disabled={selected.size === 0 || busy}
          className="flex w-full items-center justify-center gap-2 rounded-lg bg-primary px-4 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-50"
        >
          {busy ? (
            'Launching…'
          ) : selected.size === 0 ? (
            'Select at least one reviewer'
          ) : (
            <>
              <Users className="h-4 w-4" />
              {selected.size === 1 ? 'Launch reviewer' : `Launch ${selected.size} reviewers`}
            </>
          )}
        </button>
      </div>
    </div>
  );
}
