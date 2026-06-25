// FLUX-715: the unified ticket-action renderer. One kind-switch (`engine` | `agent` | `link` |
// `launch` | `picker`) draws every inline ticket control; `variant` ("card" | "compact") only
// swaps chrome (the board card's hover-reveal split-buttons vs the chat bar's flat row). It is
// driven entirely by the `useTicketActions` controller, so the board card, the chat mini-card and
// the chat composer bar share one action model with zero duplicated status→action logic.
//
// Adding a new action ⇒ one entry in lib/ticketActions.actionsForStatus. Adding a new *kind* ⇒
// one extra arm in the `ActionControl` switch below. Nothing is re-plumbed per surface.
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { LucideIcon } from 'lucide-react';
import { Bot, ChevronDown, ExternalLink, FileText, Layers, Loader2, Play, SendHorizontal, Sparkles, Undo2 } from 'lucide-react';
import type { Task } from '../../types';
import type { TicketAction, TicketActionIcon, TicketActionSurface, LaunchTemplateOption } from '../../lib/ticketActions';
import { useTicketActions, type UseTicketActions } from '../../hooks/useTicketActions';
import { useConfig } from '../../store/useAppSelector';
import { resolveEffectiveAgent } from '../../utils';
import { OrchestrationLauncher } from '../OrchestrationLauncher';
import { StartTaskPrompt } from '../task-modal/StartTaskPrompt';

type Variant = TicketActionSurface;

const ICONS: Record<TicketActionIcon, LucideIcon> = {
  bot: Bot,
  layers: Layers,
  file: FileText,
  play: Play,
  send: SendHorizontal,
  undo: Undo2,
  sparkles: Sparkles,
  external: ExternalLink,
};

/**
 * Self-contained entry point for the chat surfaces (mini-card + composer bar): builds its own
 * controller and renders the buttons plus the launcher / start-prompt portals. The board card
 * instead shares the controller it already holds — see `TicketActionsView` + `TicketActionsLaunchers`.
 */
export function TicketActions({ task, variant }: { task: Task; variant: Variant }) {
  const ctl = useTicketActions(task);
  return (
    <>
      <TicketActionsView ctl={ctl} variant={variant} />
      <TicketActionsLaunchers ctl={ctl} />
    </>
  );
}

/** The buttons only. The board card renders this from its controller's shared `useTicketActions`. */
export function TicketActionsView({
  ctl,
  variant,
  onActiveChange,
}: {
  ctl: UseTicketActions;
  variant: Variant;
  /** Reports whether any launch menu / picker is open (the card uses it to suppress its hover popup). */
  onActiveChange?: (active: boolean) => void;
}) {
  // The board card's controls are hidden until hover; they must also stay open while any menu /
  // picker is open, so each control reports its open state up here.
  const [openKeys, setOpenKeys] = useState<Set<string>>(new Set());
  const reportOpen = (key: string, open: boolean) =>
    setOpenKeys((prev) => {
      if (open === prev.has(key)) return prev;
      const next = new Set(prev);
      if (open) next.add(key);
      else next.delete(key);
      return next;
    });
  useEffect(() => onActiveChange?.(openKeys.size > 0), [openKeys, onActiveChange]);

  const actions = ctl.actions.filter((a) => (a.surfaces ?? ['card', 'compact']).includes(variant));
  if (actions.length === 0) return null;

  const body = actions.map((action) => (
    <ActionControl key={action.key} action={action} ctl={ctl} variant={variant} onOpenChange={(o) => reportOpen(action.key, o)} />
  ));

  if (variant === 'compact') {
    return <div className="flex flex-wrap items-center gap-1.5">{body}</div>;
  }

  // Card: a hover-revealed cluster (kept open while a menu/picker is). `group-hover` keys off the
  // card's own `group` class (the card wraps this).
  const expanded = openKeys.size > 0;
  return (
    <div
      className={`relative flex items-center justify-end gap-1.5 transition-all duration-300 ease-[cubic-bezier(0.32,0.72,0,1)] ${
        expanded
          ? 'mt-2 max-h-40 overflow-visible opacity-100'
          : 'mt-0 max-h-0 overflow-hidden opacity-0 group-hover:mt-2 group-hover:max-h-40 group-hover:overflow-visible group-hover:opacity-100'
      }`}
    >
      {body}
    </div>
  );
}

/** The launcher modal + Todo start-prompt portals. Rendered once per controller instance. */
export function TicketActionsLaunchers({ ctl }: { ctl: UseTicketActions }) {
  const config = useConfig();
  const framework = resolveEffectiveAgent(undefined, config?.defaultAgent);
  const task = ctl.task;
  return (
    <>
      {ctl.launcherOpen && (
        <OrchestrationLauncher
          open={ctl.launcherOpen}
          ticket={{ id: task.id, title: task.title || 'Untitled', status: task.status, branch: task.branch, effort: task.effort }}
          framework={framework}
          phase={ctl.launcherPhase}
          initialTemplateId={ctl.launcherTemplateId}
          onClose={ctl.closeLauncher}
          onLaunch={(plan) => void ctl.onLaunch(plan)}
          busy={ctl.launcherBusy}
        />
      )}
      {ctl.startPromptOpen &&
        createPortal(
          <StartTaskPrompt task={task} onConfirm={(branch) => void ctl.confirmStartPrompt(branch)} onCancel={ctl.cancelStartPrompt} />,
          document.body,
        )}
    </>
  );
}

// ── Per-action renderer: the one kind-switch ────────────────────────────────

function ActionControl({
  action,
  ctl,
  variant,
  onOpenChange,
}: {
  action: TicketAction;
  ctl: UseTicketActions;
  variant: Variant;
  onOpenChange?: (open: boolean) => void;
}) {
  switch (action.kind) {
    case 'link':
      return <LinkControl action={action} variant={variant} />;
    case 'launch':
      return <LaunchControl action={action} ctl={ctl} variant={variant} onOpenChange={onOpenChange} />;
    case 'picker':
      return <PickerControl action={action} ctl={ctl} variant={variant} onOpenChange={onOpenChange} />;
    case 'engine':
    case 'agent':
    default:
      return <SimpleControl action={action} ctl={ctl} variant={variant} />;
  }
}

// ── Shared class helpers ────────────────────────────────────────────────────

/** Solid primary button (the card's `bg-primary` + the chat bar's primary share this look). */
function primaryClass(variant: Variant): string {
  return variant === 'card'
    ? 'flex items-center gap-1 bg-primary px-2.5 py-1 text-[10px] font-semibold text-white transition-colors hover:bg-primary-hover disabled:opacity-50'
    : 'inline-flex items-center gap-1 rounded-md bg-primary px-2.5 py-1 text-[11px] font-semibold text-white transition-colors hover:bg-primary/90 disabled:opacity-50';
}

/** Bordered/ghost default button. */
function defaultClass(variant: Variant): string {
  return variant === 'card'
    ? 'flex items-center gap-1 rounded-md border border-gray-200 bg-white/80 px-2 py-1 text-[10px] font-semibold text-gray-600 transition-colors hover:border-primary/40 hover:bg-primary/5 hover:text-primary disabled:opacity-50 dark:border-white/10 dark:bg-white/5 dark:text-gray-300 dark:hover:bg-primary/10'
    : 'eh-border inline-flex items-center gap-1 rounded-md border bg-[var(--eh-input-bg)] px-2.5 py-1 text-[11px] font-semibold text-[var(--eh-text-primary)] transition-colors hover:bg-black/5 disabled:opacity-50 dark:hover:bg-white/5';
}

// ── engine / agent (a plain button) ─────────────────────────────────────────

function SimpleControl({ action, ctl, variant }: { action: TicketAction; ctl: UseTicketActions; variant: Variant }) {
  const busy = ctl.busyKey === action.key;
  const Icon = action.icon ? ICONS[action.icon] : null;
  const danger = action.tone === 'danger';
  const tone =
    action.tone === 'primary'
      ? `${primaryClass(variant)} rounded-md`
      : danger
        ? 'inline-flex items-center gap-1 rounded-md px-2.5 py-1 text-[11px] font-semibold text-red-500 transition-colors hover:bg-red-500/10 disabled:opacity-50'
        : defaultClass(variant);
  return (
    <button
      type="button"
      onClick={(e) => { e.stopPropagation(); void ctl.fire(action.key, action.run); }}
      disabled={!!ctl.busyKey}
      title={action.kind === 'agent' ? 'Starts a tokenized agent session' : 'Instant — no agent, no tokens'}
      className={tone}
    >
      {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : action.kind === 'agent' ? <Sparkles className="h-3 w-3" /> : Icon ? <Icon className="h-3 w-3" /> : null}
      {action.label}
    </button>
  );
}

// ── link (open PR) ──────────────────────────────────────────────────────────

function LinkControl({ action, variant }: { action: TicketAction; variant: Variant }) {
  const cls =
    variant === 'card'
      ? 'flex items-center gap-1 rounded-md border border-gray-200 bg-white/80 px-2 py-1 text-[10px] font-semibold text-gray-600 transition-colors hover:border-primary/40 hover:text-primary dark:border-white/10 dark:bg-white/5 dark:text-gray-300'
      : 'eh-border inline-flex items-center gap-1 rounded-md border bg-transparent px-2.5 py-1 text-[11px] font-semibold text-[var(--eh-text-muted)] transition-colors hover:bg-black/5 hover:text-[var(--eh-text-primary)] dark:hover:bg-white/5';
  return (
    <a href={action.href} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()} className={cls}>
      <ExternalLink className="h-3 w-3" /> {action.label}
    </a>
  );
}

// ── launch (split: one-click default + ▾ template menu) ─────────────────────

function LaunchControl({
  action,
  ctl,
  variant,
  onOpenChange,
}: {
  action: TicketAction;
  ctl: UseTicketActions;
  variant: Variant;
  onOpenChange?: (open: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useOutsideClose(ref, open, () => setOpen(false));
  useEffect(() => onOpenChange?.(open), [open, onOpenChange]);

  const busy = ctl.busyKey === action.key;
  const primary = action.tone === 'primary';
  const Icon = action.icon ? ICONS[action.icon] : Bot;

  const toggle = () => {
    setOpen((o) => {
      if (!o) ctl.loadTemplates();
      return !o;
    });
  };

  const primaryBtn = primary ? primaryClass(variant) : defaultClass(variant);
  const chevronBtn =
    variant === 'card'
      ? primary
        ? 'flex items-center border-l border-white/25 bg-primary px-1 py-1 text-white transition-colors hover:bg-primary-hover disabled:opacity-50'
        : 'flex items-center border border-l-0 border-gray-200 bg-white/80 px-1 py-1 text-gray-500 transition-colors hover:border-primary/40 hover:bg-primary/5 hover:text-primary disabled:opacity-50 dark:border-white/10 dark:bg-white/5 dark:text-gray-300 dark:hover:bg-primary/10'
      : primary
        ? 'flex items-center border-l border-white/20 bg-primary px-1.5 py-1 text-white transition-colors hover:bg-primary/90 disabled:opacity-50'
        : 'eh-border flex items-center border bg-[var(--eh-input-bg)] px-1.5 py-1 text-[var(--eh-text-muted)] transition-colors hover:bg-black/5 disabled:opacity-50 dark:hover:bg-white/5';

  return (
    <div ref={ref} className="relative flex items-stretch overflow-visible rounded-md">
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); void ctl.fire(action.key, action.run); }}
        disabled={!!ctl.busyKey}
        title={`${action.label} — runs the phase default`}
        className={`${primaryBtn} rounded-l-md`}
      >
        {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Icon className="h-3 w-3" />}
        {busy ? '…' : action.label}
      </button>
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); toggle(); }}
        disabled={!!ctl.busyKey}
        aria-haspopup="menu"
        aria-expanded={open}
        title="Choose an agent or template"
        className={`${chevronBtn} rounded-r-md`}
      >
        <ChevronDown className={`h-3 w-3 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && (
        <TemplateMenu
          templates={action.templates ?? []}
          onPick={(id) => {
            setOpen(false);
            action.onTemplate?.(id);
          }}
        />
      )}
    </div>
  );
}

function TemplateMenu({ templates, onPick }: { templates: LaunchTemplateOption[]; onPick: (id: string) => void }) {
  const firstOther = templates.findIndex((t) => t.variant === 'other');
  return (
    <div
      role="menu"
      onClick={(e) => e.stopPropagation()}
      className="absolute bottom-full right-0 z-[90] mb-1.5 w-60 rounded-xl border border-[var(--eh-border)] bg-[var(--eh-surface)] p-1.5 shadow-xl"
    >
      <p className="px-2 py-1 text-[9px] font-bold uppercase tracking-wider text-[var(--eh-text-muted)]">Launch agents</p>
      {templates.map((t, i) => {
        const Icon = t.variant === 'single' ? Bot : t.variant === 'multi' ? Layers : FileText;
        const label = t.variant === 'single' ? `Single${t.name ? ` · ${t.name}` : ''}` : t.variant === 'multi' ? `Multi${t.name ? ` · ${t.name}` : ''}` : t.name ?? t.id;
        return (
          <div key={`${t.variant}:${t.id ?? i}`} className="contents">
            {i === firstOther && firstOther > 0 && <div className="my-1 border-t border-[var(--eh-border)]" />}
            <button
              type="button"
              onClick={() => onPick(t.id)}
              className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[11px] font-semibold text-[var(--eh-text-primary)] hover:bg-primary/5 hover:text-primary dark:hover:bg-primary/10"
            >
              <Icon className="h-3.5 w-3.5 shrink-0" />
              <span className="min-w-0 truncate">{label}</span>
            </button>
          </div>
        );
      })}
    </div>
  );
}

// ── picker (inline reason textarea — the Ready "Return") ────────────────────

function PickerControl({
  action,
  ctl,
  variant,
  onOpenChange,
}: {
  action: TicketAction;
  ctl: UseTicketActions;
  variant: Variant;
  onOpenChange?: (open: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState('');
  const ref = useRef<HTMLDivElement>(null);
  useOutsideClose(ref, open, () => setOpen(false));
  useEffect(() => onOpenChange?.(open), [open, onOpenChange]);

  const picker = action.picker;
  const busy = ctl.busyKey === action.key;
  const Icon = action.icon ? ICONS[action.icon] : Undo2;
  if (!picker) return null;

  const btnClass =
    variant === 'card'
      ? 'flex items-center gap-1 rounded-md border border-amber-300 bg-white/80 px-2 py-1 text-[10px] font-semibold text-amber-700 transition-colors hover:border-amber-400 hover:bg-amber-50 disabled:opacity-50 dark:border-amber-500/35 dark:bg-white/5 dark:text-amber-300 dark:hover:border-amber-400 dark:hover:bg-amber-500/12'
      : 'eh-border inline-flex items-center gap-1 rounded-md border bg-[var(--eh-input-bg)] px-2.5 py-1 text-[11px] font-semibold text-amber-600 transition-colors hover:bg-black/5 disabled:opacity-50 dark:text-amber-300 dark:hover:bg-white/5';

  const submit = async () => {
    if (!value.trim()) return;
    await ctl.fire(action.key, () => picker.onSubmit(value.trim()));
    setOpen(false);
    setValue('');
  };

  return (
    <div ref={ref} className="relative flex items-stretch">
      <button type="button" onClick={() => setOpen((o) => !o)} disabled={busy} title={picker.title} className={btnClass}>
        <Icon className="h-3 w-3" />
        {busy ? picker.busyLabel : action.label}
      </button>
      {open && (
        <div
          onClick={(e) => e.stopPropagation()}
          className="absolute bottom-full right-0 z-[90] mb-1.5 w-64 rounded-xl border border-[var(--eh-border)] bg-[var(--eh-surface)] p-3 shadow-xl"
        >
          <p className="mb-1.5 text-[10px] font-bold uppercase tracking-wider text-[var(--eh-text-muted)]">{picker.title}</p>
          <textarea
            autoFocus
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void submit();
            }}
            placeholder={picker.placeholder}
            rows={3}
            className="w-full resize-none rounded-lg border border-[var(--eh-border)] bg-[var(--eh-input-bg)] px-2.5 py-2 text-xs text-[var(--eh-text-primary)] outline-none focus:border-primary"
          />
          <div className="mt-2 flex justify-end gap-1.5">
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                setValue('');
              }}
              className="rounded-md px-2 py-1 text-[10px] font-semibold text-[var(--eh-text-muted)] hover:bg-black/5 dark:hover:bg-white/10"
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={!value.trim() || busy}
              onClick={() => void submit()}
              className="rounded-md bg-amber-500 px-2 py-1 text-[10px] font-semibold text-white hover:bg-amber-600 disabled:opacity-50"
            >
              {busy ? picker.busyLabel : picker.submitLabel}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ── small shared outside-click/Esc closer ───────────────────────────────────

function useOutsideClose(ref: React.RefObject<HTMLElement | null>, open: boolean, close: () => void) {
  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, ref, close]);
}
