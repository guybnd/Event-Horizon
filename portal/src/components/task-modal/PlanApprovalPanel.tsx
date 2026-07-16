import { useEffect, useMemo, useState } from 'react';
import {
  X, Check, Undo2, RefreshCw, MessageCircleQuestion, LayoutTemplate, AlignLeft, ListChecks, FlaskConical,
  ClipboardCheck, ClipboardX, Loader2, Plus, Tag, Play, ChevronDown, ChevronUp,
} from 'lucide-react';
import { startPlanReview, startPlanRevise, createBranch } from '../../api';
import { launchPhaseDefault } from '../../agentActions';
import { resolveEffectiveAgent, frameworkSupports } from '../../utils';
import { isActiveSession } from '../../orchestration';
import { ArtifactPanel } from './ArtifactPanel';
import { AnnotationPill } from './AnnotationPill';
import { TaskMarkdown } from '../TaskMarkdown';
import { TagSelector } from '../TagSelector';
import { getPriorityIcon } from './taskModalHelpers';
import { canApprovePlan, dismissPlanReview, feedbackAuthorLabel, isPlanApprovalPending, isPlanGateRevising, planReviewFeedback, resolvePlanGateValue } from '../pendingInteractions';
import { buildStatusChangeHistory, statusAfterGrooming } from '../../lib/ticketActions';
import { planBodyHash } from '../../lib/planBodyHash';
import {
  clipExcerpt, clearPlanReviewDraft, formatArtifactAnnotations, formatRegroomNotes, loadPlanReviewDraft,
  savePlanReviewDraft, type ArtifactAnnotation, type PlanAnnotation,
} from '../../lib/planAnnotations';
import type { HistoryEntry } from '../../types';
import type { TicketSideViewController } from '../../hooks/useTicketSideView';
import { useConfirm } from '../../hooks/useConfirm';
import { useNotify } from '../../hooks/useNotify';

/** Mirrors ChatMetadataBar's local effort ladder (FLUX-740) — kept as a small duplicated constant
 *  rather than exporting ChatDock's private one, so this panel has no dependency on that file. */
const EFFORT_OPTIONS = ['None', 'XS', 'S', 'M', 'L', 'XL'];

const HEADING_RE = /^(#{1,6})\s+(.+?)\s*$/;
const CHECKBOX_RE = /^(\s*)-\s*\[( |x|X)\]\s+/;
const BULLET_RE = /^(\s*)[-*]\s+(?!\[)(.+)$/;

interface SectionItem {
  text: string;
  checked?: boolean;
}

/** Extract a top-level (`##`) markdown section's raw body + its own (non-nested) list items, stopping
 *  at the next heading of the same or higher level. Generalizes `parseAcceptanceCriteriaProgress`
 *  (`lib/acceptanceCriteria.ts`) to any heading name and to plain bullets (not just checkboxes) so it
 *  also covers a "Recommended Tests"/"Test plan" section, which has no checkbox convention. */
function extractMarkdownSection(body: string | undefined | null, headingMatch: RegExp): { raw: string; items: SectionItem[] } | null {
  if (!body) return null;
  const lines = body.replace(/\r\n/g, '\n').split('\n');
  let sectionLevel: number | null = null;
  const raw: string[] = [];
  const items: SectionItem[] = [];

  for (const line of lines) {
    const heading = line.match(HEADING_RE);
    if (heading) {
      const level = heading[1]!.length;
      if (sectionLevel !== null) {
        if (level <= sectionLevel) break;
      } else if (level === 2 && headingMatch.test(heading[2]!.trim())) {
        sectionLevel = level;
        continue;
      }
    }
    if (sectionLevel === null) continue;
    raw.push(line);
    const checkbox = line.match(CHECKBOX_RE);
    if (checkbox && checkbox[1]!.length === 0) {
      items.push({ text: line.slice(checkbox[0].length).trim(), checked: checkbox[2]!.toLowerCase() === 'x' });
      continue;
    }
    const bullet = line.match(BULLET_RE);
    if (bullet && bullet[1]!.length === 0) {
      items.push({ text: bullet[2]!.trim() });
    }
  }

  return sectionLevel !== null ? { raw: raw.join('\n').trim(), items } : null;
}

type TabId = 'artifact' | 'plan' | 'ac' | 'tests';

const TABS: { id: TabId; label: string; icon: typeof LayoutTemplate }[] = [
  { id: 'artifact', label: 'Artifact', icon: LayoutTemplate },
  { id: 'plan', label: 'Plan', icon: AlignLeft },
  { id: 'ac', label: 'Acceptance Criteria', icon: ListChecks },
  { id: 'tests', label: 'Tests', icon: FlaskConical },
];

/**
 * FLUX-1273: the full-screen plan-review panel — the rich surface `## Implementation plan` item #2
 * describes, reusing the artifact viewer/annotation machinery (FLUX-874/875/892) instead of new pin/
 * notes UI. Opened from the AttentionDock 📋 item, the in-chat plan-approval card, and (once resolved)
 * the ticket sideview's persistent "View Plan" affordance — always the SAME `c` (the chat window's one
 * `useTicketSideView` controller, shared with `ChatMetadataBar`/`TicketSideView`) so header-field edits
 * staged here are the exact same staged state the metadata bar already shows, never a second form.
 *
 * Two modes, derived from `isPlanApprovalPending` (not a prop) so the panel flips the instant the
 * flag resolves, with no separate "resolved" field to thread through — FLUX-1296 made that flag
 * gate-VALUE-agnostic, so a `you`-gate manual review pass lands in **review** mode exactly like an
 * `auto-then-you` one:
 *  - **review** — a verdict is pending confirmation: Approve / Send-back-to-Grooming / Set aside,
 *    notes are a review note attached to the commit.
 *  - **later** — opened any other time: the verdict area becomes a neutral reference card, Approve/
 *    Send-back collapse into one "Ask in chat" action, and notes post straight into the ticket's real
 *    conversation via `onSendToChat` instead of a review note. FLUX-1296: for a `you`-gate ticket
 *    that has never been reviewed, this mode also offers "Start plan review" — the one portal entry
 *    point for the `POST /plan-review/start` route, since nothing auto-triggers it under `you`.
 *
 * Same VERBS as the AttentionDock tray item and `ChatPlanApprovalCard` (Send for re-grooming /
 * Approve[-anyway] / Set aside), sharing their underlying action functions and attribution/TL;DR
 * helpers (`pendingInteractions.tsx`) — but NOT their `PlanReviewActions`/`PlanReviewFeedbackBlock`
 * React components: this panel's footer also carries staged header edits, tabbed AC/Tests views, and
 * inline plan annotations that the compact card affordance has no room for, so it hand-rolls its own
 * composer/footer around the same shared actions instead of embedding those two components.
 */
export function PlanApprovalPanel({
  c,
  onClose,
  onSendToChat,
}: {
  c: TicketSideViewController;
  onClose: () => void;
  onSendToChat: (text: string) => void;
}) {
  const task = c.task;
  const confirm = useConfirm();
  const notify = useNotify();
  const mode: 'review' | 'later' = isPlanApprovalPending(task, c.config) ? 'review' : 'later';
  // FLUX-1296: the `you` gate never auto-starts a review (see `gate-runner.ts`'s trigger-semantics
  // doc) — a Grooming ticket resolved to `you` with no verdict yet has NO other way to reach
  // `start_plan_review` from the portal at all. Offered only for `you`: `auto`/`auto-then-you`
  // tickets get reviewed by the loop-driver within one poll tick, so a manual button there would
  // just race it.
  const noVerdictYouGate = mode === 'later' && task.status === 'Grooming' && task.planReviewState == null
    && resolvePlanGateValue(task, c.config) === 'you';
  const awaitingFirstReview = noVerdictYouGate && !task.planGateRunning;
  // FLUX-1324: the one-pass review triggered by that button (or the `start_plan_review` MCP tool
  // directly, or another tab) can run for minutes with `planReviewState` still null the whole time
  // — without this, the panel kept showing "Start plan review" / "nothing reviews this on its own"
  // while a review was actively running (clicking just hit the engine's 409 `already-running`).
  const firstReviewRunning = noVerdictYouGate && !!task.planGateRunning;
  // FLUX-1339: a STANDING Approve — available any time a Grooming ticket has a plan body, decoupled
  // from `planReviewState` (a fresh verdict). Once a user iterates on the plan conversationally in
  // chat (no formal re-review re-triggered) the verdict clears, and the old panel offered no way to
  // approve short of the status dropdown. In `review` mode Approve is already present (see below), so
  // this only adds it to `later` mode; either way the verdict is advisory, never a gate.
  const canApproveNow = canApprovePlan(task);
  const hasArtifact = (task.artifacts?.revisions?.length ?? 0) > 0;
  // FLUX-1289/FLUX-1303: verdict-aware footer — one verb set (Send for re-grooming / Approve[-anyway])
  // with emphasis flipped by verdict; the notes composer exists in BOTH verdict states (notes are
  // optional on changes-requested, required to override an approval). `planGateRunning` suppresses
  // the actions so a manual click never races FLUX-1288's own auto-loop revise dispatch.
  const changesRequested = mode === 'review' && task.planReviewState === 'changes-requested';
  const feedback = changesRequested ? planReviewFeedback(task) : null;
  // FLUX-1303: who wrote the surfaced feedback — one shared rule with the cards (pendingInteractions).
  const feedbackLabel = feedbackAuthorLabel(feedback?.user, c.currentUser);
  // FLUX-1303: has the plan body changed since the current verdict was recorded? An unchanged plan
  // will USUALLY re-produce the same verdict, so "Re-review plan" warns on this — but stays enabled
  // (reviews are non-deterministic; a second opinion is the only recovery from a wrong verdict).
  // Fail open when the hash is absent (older verdicts). Memoized: the body can be 10KB+ and this
  // component re-renders per keystroke.
  const currentBodyHash = useMemo(() => planBodyHash(task.body || ''), [task.body]);
  const planChanged = useMemo(
    () => !task.planReviewBodyHash || currentBodyHash !== task.planReviewBodyHash,
    [currentBodyHash, task.planReviewBodyHash],
  );

  const [activeTab, setActiveTab] = useState<TabId>(hasArtifact ? 'artifact' : 'plan');
  // FLUX-1381: the reviewer-feedback box is height-capped (internal scroll) and collapsible — a long
  // changes-requested comment must never starve the Artifact/Plan/AC/Tests tab body of space. The
  // one-line verdict summary above it stays visible either way.
  const [feedbackExpanded, setFeedbackExpanded] = useState(true);
  const [busy, setBusy] = useState(false);
  const [revising, setRevising] = useState(false);
  const [startingImpl, setStartingImpl] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  // FLUX-1303: inline plan annotations — select text in the Plan/AC/Tests tab body, attach a note
  // via a floating composer at the selection, and ACCUMULATE several before sending them together
  // with Send for re-grooming / Ask in chat (the plan-view sibling of the artifact viewer's
  // in-iframe annotation flow, FLUX-874/875/892). Anchored by quoted excerpt, not CSS path.
  // The draft (annotations + freeform notes) hydrates from and persists to the module-level
  // per-ticket store (planAnnotations.ts) so closing the panel never eats unsent feedback.
  // FLUX-1306: keyed against `currentBodyHash` so a draft composed against a since-superseded plan
  // (revised + re-reviewed elsewhere while the panel was closed) is dropped as stale on load instead
  // of silently rehydrating notes anchored to text that no longer exists in the ticket.
  const [annotations, setAnnotations] = useState<PlanAnnotation[]>(() => loadPlanReviewDraft(task.id, currentBodyHash).annotations);
  const [notes, setNotes] = useState(() => loadPlanReviewDraft(task.id, currentBodyHash).notes);
  const [pendingSel, setPendingSel] = useState<{ text: string; x: number; y: number } | null>(null);
  const [selNote, setSelNote] = useState('');
  useEffect(() => { savePlanReviewDraft(task.id, { annotations, notes, bodyHash: currentBodyHash }); }, [task.id, annotations, notes, currentBodyHash]);

  // FLUX-1362: artifact-region annotations, mirrored live out of the iframe by `ArtifactPanel` (this
  // panel is the CONTROLLED owner so both surfaces converge on ONE unified list — the floating pill).
  // Deliberately NOT persisted into the plan-review draft (they live in the iframe/session, not the
  // durable plan text), so the draft contract is unchanged.
  const [artifactItems, setArtifactItems] = useState<ArtifactAnnotation[]>([]);
  // FLUX-1440: whether the shown artifact revision exposes guided controls — reported by `ArtifactPanel`
  // (it owns the iframe bridge) via `onHasGuidedControlsChange`, threaded to the pill below so its
  // empty state can invite interaction instead of staying hidden.
  const [hasGuidedControls, setHasGuidedControls] = useState(false);

  // The ONE derivation of "is there anything to send" — the exact string every send handler uses,
  // so the buttons' enabled-state can never disagree with what the handler would actually send.
  // FLUX-1362: plan-text annotations + freeform notes + the artifact-region block, in one payload.
  const combinedNotes = useMemo(() => {
    const planPart = formatRegroomNotes(annotations, notes);
    const artifactPart = formatArtifactAnnotations(artifactItems);
    return [planPart, artifactPart].filter(Boolean).join('\n\n');
  }, [annotations, notes, artifactItems]);
  // FLUX-1339/1362: how the "N notes — not sent yet" marker (and the pill) count the batch — each
  // inline plan annotation, each artifact annotation, plus the freeform box (as one).
  const unsentCount = annotations.length + artifactItems.length + (notes.trim() ? 1 : 0);

  // FLUX-1339: panel-level Esc (minimize) is owned by the hosting FloatingPanel; Esc inside the
  // selection composer only cancels that composer (handled on its textarea's onKeyDown below), so
  // the two never fight over one keypress.

  const handleTabBodyMouseUp = () => {
    if (activeTab === 'artifact') return; // the artifact viewer has its own in-iframe annotation flow
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed) return;
    const text = sel.toString();
    if (!text.trim()) return;
    // FLUX-1306: a multi-line/multi-paragraph selection's range `getBoundingClientRect()` spans the
    // WHOLE selection, not just its end — anchor on the LAST client rect instead, which sits at the
    // selection's actual end point, so the composer doesn't appear visually detached from it.
    const range = sel.getRangeAt(0);
    const rects = range.getClientRects();
    const rect = rects.length > 0 ? rects[rects.length - 1]! : range.getBoundingClientRect();
    setSelNote('');
    setPendingSel({ text: clipExcerpt(text), x: rect.left + rect.width / 2, y: rect.bottom });
  };

  const acSection = useMemo(() => extractMarkdownSection(task.body, /^acceptance criteria$/i), [task.body]);
  const testsSection = useMemo(
    () => extractMarkdownSection(task.body, /^(recommended tests|test plan)$/i),
    [task.body],
  );

  const pendingEditCount = useMemo(() => {
    let n = 0;
    if (c.title !== (task.title || '')) n++;
    if (c.priority !== (task.priority || 'None')) n++;
    if (c.effort !== (task.effort || 'None')) n++;
    const priorTags = task.tags || [];
    if (c.tags.length !== priorTags.length || c.tags.some((t, i) => t !== priorTags[i])) n++;
    return n;
  }, [c.title, c.priority, c.effort, c.tags, task.title, task.priority, task.effort, task.tags]);

  const cyclePriority = () => {
    const names = c.availablePriorities.map((p) => p.name);
    const i = names.indexOf(c.priority);
    c.setPriority(names[(i + 1) % names.length] ?? names[0]!);
  };
  const cycleEffort = () => {
    const i = EFFORT_OPTIONS.indexOf(c.effort);
    c.setEffort(EFFORT_OPTIONS[(i + 1) % EFFORT_OPTIONS.length]!);
  };

  const elaborate = (item: SectionItem) => {
    setNotes((prev) => `${prev ? `${prev}\n\n` : ''}Re: "${item.text}" — `);
  };

  // Mirrors `ApprovalCard.decide()`'s convention (`ApprovalPrompts.tsx`): only reset `busy` on
  // FAILURE. On success `onClose()` unmounts this panel, so there's nothing left to reset.
  // FLUX-1303 (ex-FLUX-1301): history travels as an `appendHistory` DELTA, never a rebuilt full
  // array — the engine PUT reconciles submitted full histories by length, so a client snapshot
  // stale by even one entry silently dropped the first novel entries (this is exactly how the
  // FLUX-1298 send-back notes were lost: the Plan Gate had appended an activity ~20s earlier).
  async function commit(fields: Record<string, unknown>, historyEntries: HistoryEntry[]) {
    setBusy(true);
    setActionError(null);
    const updated = await c.persist({
      title: c.title,
      priority: c.priority,
      effort: c.effort,
      tags: c.tags,
      ...fields,
      appendHistory: historyEntries,
    });
    // persist reports failure as null (it never throws) — keep the panel open with a visible error
    // instead of closing over a swallowed failure (FLUX-1302's silent-catch class).
    if (!updated) {
      setActionError('Failed to save — is the engine running?');
      setBusy(false);
      return;
    }
    clearPlanReviewDraft(task.id);
    onClose();
  }

  // Shared "Approve → Todo" commit shape for both plain Approve and Approve & start (FLUX-1294) —
  // one place computing the target status + history entry so the two buttons can never drift.
  const buildApproveUpdate = () => {
    const todoStatus = statusAfterGrooming((c.config?.columns ?? []).map((s) => s.name));
    return {
      fields: { status: todoStatus, planReviewState: null, planReviewBodyHash: null },
      historyEntries: buildStatusChangeHistory(task, todoStatus, c.currentUser, combinedNotes),
    };
  };

  const handleApprove = () => {
    const { fields, historyEntries } = buildApproveUpdate();
    void commit(fields, historyEntries);
  };

  // FLUX-1294: "Approve & start" — identical commit to plain Approve, then (best-effort) an
  // implementation dispatch. The two steps are deliberately NOT one transaction: once the approve
  // commit succeeds the ticket IS correctly in Todo, so a dispatch failure must never look like the
  // approval itself failed — it surfaces via `alert()` (this codebase's convention for this class of
  // post-close async failure) instead of `actionError`, since the panel is already closed by then.
  const handleApproveAndStart = async () => {
    if (busy || startingImpl || revising) return;
    setStartingImpl(true);
    setActionError(null);
    const { fields, historyEntries } = buildApproveUpdate();
    const updated = await c.persist({
      title: c.title,
      priority: c.priority,
      effort: c.effort,
      tags: c.tags,
      ...fields,
      appendHistory: historyEntries,
    });
    if (!updated) {
      setActionError('Failed to save — is the engine running?');
      setStartingImpl(false);
      return;
    }
    clearPlanReviewDraft(task.id);
    onClose(); // ticket is now correctly in Todo — everything below is best-effort dispatch only.

    if (updated.cliSession && isActiveSession(updated.cliSession)) {
      notify.info(`${updated.id} approved, but a session is already running on it — no new session was started.`);
      return;
    }

    try {
      if (updated.effort !== 'XS') {
        await createBranch(updated.id, { worktree: !!c.config?.worktreeByDefault });
      }
      const framework = resolveEffectiveAgent(undefined, c.config?.defaultFramework);
      const focusComment = `Plan approved via "Approve & start."${combinedNotes ? `\n\n${combinedNotes}` : ''}`;
      const result = await launchPhaseDefault({
        taskId: updated.id,
        framework,
        phase: 'implementation',
        currentUser: c.currentUser,
        phaseDefaults: c.config?.phaseDefaults,
        supervisorCapable: frameworkSupports(c.config, framework, 'supervisor'),
        focusComment,
      });
      if (!result) {
        notify.info(`${updated.id} approved, but no default implementation persona is configured — start it manually.`);
      }
    } catch (err) {
      notify.error(`${updated.id} approved, but couldn't auto-start implementation: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  // The staged header edits are promised to be "applied together with" every action (the pending-
  // edits badge) — so a failed save must ABORT the action, not silently drop the edits (persist
  // returns null on failure; it never throws).
  const persistPendingEdits = async (): Promise<boolean> => {
    if (pendingEditCount === 0) return true;
    const saved = await c.persist({ title: c.title, priority: c.priority, effort: c.effort, tags: c.tags });
    if (!saved) setActionError('Failed to save your header edits — nothing was sent; try again.');
    return !!saved;
  };

  const handleAskInChat = async () => {
    if (!combinedNotes) return;
    setBusy(true);
    setActionError(null);
    try {
      if (!(await persistPendingEdits())) return;
      onSendToChat(combinedNotes);
      setNotes('');
      setAnnotations([]);
      setArtifactItems([]); // clears the pins in the iframe too (reverse-sync)
      clearPlanReviewDraft(task.id);
    } finally {
      setBusy(false);
    }
  };

  // FLUX-1303: "Send for re-grooming" — ONE atomic engine call (`POST /plan-review/revise`) that
  // records the notes as an attributed comment, stamps the changes-requested verdict, dispatches
  // the grooming revise session, and registers it with the plan-gate runner so the revision is
  // re-reviewed. Replaces both FLUX-1289's "Revise plan" (dispatch + follow-up verdict clear that
  // could fail silently) and the old record-only "Send back to Grooming" two-step. Notes are
  // REQUIRED when overriding an `approved` verdict, optional on `changes-requested` (the reviewer's
  // feedback already exists and is included automatically).
  const handleSendForRegroom = async () => {
    if (revising || busy) return;
    if (!changesRequested && !combinedNotes) return;
    setRevising(true);
    setActionError(null);
    try {
      if (!(await persistPendingEdits())) {
        setRevising(false);
        return;
      }
      await startPlanRevise(task.id, { ...(combinedNotes ? { notes: combinedNotes } : {}), user: c.currentUser });
      clearPlanReviewDraft(task.id);
      onClose();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : 'Failed to send for re-grooming — is the engine running?');
      setRevising(false);
    }
  };

  // FLUX-1303: panel-only (removed from the dock/chat cards). Warns — but stays enabled — when the
  // plan is unchanged since the verdict (`planChanged` above). FLUX-1296: also backs the `you`-gate
  // "Start plan review" button (mode 'later', no verdict yet) — same one-pass call either way.
  const handleRerunReview = async () => {
    if (revising || busy) return;
    setRevising(true);
    setActionError(null);
    try {
      if (!(await persistPendingEdits())) {
        setRevising(false);
        return;
      }
      await startPlanReview(task.id);
      onClose();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : 'Failed to start the review — is the engine running?');
      setRevising(false);
    }
  };

  // FLUX-1303: "Set aside" — the same one dismiss level as the dock tray item / chat card
  // (`dismissPlanReview`, pendingInteractions.tsx): clears the verdict with no revise dispatch, so
  // this card and the compact ones all disappear together. The panel didn't expose this action at
  // all until now — closing the panel without Approve/Send-for-re-grooming left no way to dismiss
  // a verdict except going to another surface first.
  const handleSetAside = async () => {
    if (busy || revising) return;
    // FLUX-1306: Set aside silently discarded any composed-but-unsent notes/annotations, unlike
    // Approve/Send-for-re-grooming (both fold `combinedNotes` in) — confirm before throwing them away.
    if (combinedNotes && !(await confirm({
      title: 'Discard your unsent notes and set the plan review aside?',
      tone: 'danger',
      confirmLabel: 'Discard',
    }))) return;
    setBusy(true);
    setActionError(null);
    try {
      await dismissPlanReview(task.id, c.currentUser);
      clearPlanReviewDraft(task.id);
      onClose();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : 'Failed to set aside — is the engine running?');
      setBusy(false);
    }
  };

  return (
    // FLUX-1339: no longer a `fixed inset-0` full-screen overlay — the panel now FILLS its host
    // (a chat-anchored FloatingPanel in ChatDock), so the chat's live Working/progress strip stays
    // visible beside it. Close/minimize are owned by the FloatingPanel chrome above this content.
    <div className="flex min-h-0 w-full flex-col">
      {/* Header — editable title/priority/effort/tags, all staged via `c` and committed only by
          Approve/Send-back/Ask-in-chat below (never saved independently). */}
      <div className="eh-border flex flex-col gap-2 border-b px-4 py-3">
        <div className="flex items-start justify-between gap-3">
          <input
            value={c.title}
            onChange={(e) => c.setTitle(e.target.value)}
            className="min-w-0 flex-1 bg-transparent text-lg font-bold text-[var(--eh-text-primary)] outline-none"
            placeholder="Ticket title"
          />
        </div>
        <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
          <span className="font-mono text-[var(--eh-text-muted)]">{task.id}</span>
          <button
            type="button"
            onClick={cyclePriority}
            title="Click to change priority (staged)"
            className="eh-border flex items-center gap-1 rounded-full border bg-[var(--eh-input-bg)] px-2 py-0.5 font-semibold text-[var(--eh-text-secondary)] transition-colors hover:border-primary"
          >
            {getPriorityIcon(c.priority, c.config ?? null, 'h-3 w-3')}
            {c.priority}
          </button>
          <button
            type="button"
            onClick={cycleEffort}
            title="Click to change effort (staged)"
            className="eh-border rounded-full border bg-[var(--eh-input-bg)] px-2 py-0.5 font-semibold text-[var(--eh-text-secondary)] transition-colors hover:border-primary"
          >
            {c.effort}
          </button>
          <div className="flex min-w-[160px] items-center gap-1">
            <Tag className="h-3 w-3 flex-shrink-0 text-[var(--eh-text-muted)]" />
            {c.config && <TagSelector tags={c.tags} onChange={c.setTags} availableTags={c.allTags} configTags={c.config.tags} />}
          </div>
          {pendingEditCount > 0 && (
            <span className="rounded-full bg-primary/10 px-2 py-0.5 font-semibold text-primary" title="Applied together with Approve / Send for re-grooming / Ask in chat — never saved on its own">
              {pendingEditCount} pending edit{pendingEditCount === 1 ? '' : 's'}
            </span>
          )}
        </div>
      </div>

      {/* Verdict / reference strip */}
      <div className={`eh-border-subtle border-b px-4 py-2.5 text-[12px] ${changesRequested ? 'bg-amber-50 dark:bg-amber-950/30' : ''}`}>
        {mode === 'review' ? (
          <div className="flex flex-col gap-1.5">
            <div className="flex items-center gap-2">
              {changesRequested
                ? <ClipboardX className="h-4 w-4 flex-shrink-0 text-amber-500" />
                : <ClipboardCheck className="h-4 w-4 flex-shrink-0 text-sky-500" />}
              <span className="text-[var(--eh-text-secondary)]">
                Auto-reviewed — verdict:{' '}
                <span className="font-semibold text-[var(--eh-text-primary)]">
                  {changesRequested ? 'changes requested' : 'approved'}
                </span>
                . Confirm to continue.
              </span>
            </div>
            {/* FLUX-1289: the reviewer's actual feedback, surfaced prominently instead of requiring a
                dig into history/chat. FLUX-1303: attributed — never an anonymous blob (the FLUX-1298
                incident rendered a stale reviewer APPROVED comment under this amber banner with
                nothing saying who wrote it). FLUX-1381: capped with internal scroll + a chevron to
                collapse the text entirely, so a long comment can't squeeze the tab body to a sliver. */}
            {changesRequested && (
              <div className="rounded-lg border border-amber-200 bg-white/60 px-3 py-2 dark:border-amber-500/20 dark:bg-black/20">
                <div className="flex items-center justify-between gap-2">
                  <div className="text-[10px] font-bold uppercase tracking-wide text-amber-600 dark:text-amber-400">
                    {feedback ? feedbackLabel : 'Reviewer feedback'}
                  </div>
                  <button
                    type="button"
                    onClick={() => setFeedbackExpanded((v) => !v)}
                    title={feedbackExpanded ? 'Collapse reviewer feedback' : 'Expand reviewer feedback'}
                    className="rounded p-0.5 text-amber-600 transition-colors hover:bg-black/5 dark:text-amber-400 dark:hover:bg-white/5"
                  >
                    {feedbackExpanded ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
                  </button>
                </div>
                {feedbackExpanded && (
                  <div className="mt-0.5 max-h-40 overflow-y-auto whitespace-pre-wrap break-words text-[var(--eh-text-primary)]">
                    {feedback?.text || 'Changes requested — no feedback comment found in history.'}
                  </div>
                )}
              </div>
            )}
          </div>
        ) : (
          <div className="flex items-center gap-2 text-[var(--eh-text-muted)]">
            {firstReviewRunning
              ? <Loader2 className="h-4 w-4 flex-shrink-0 animate-spin" />
              : <ClipboardCheck className="h-4 w-4 flex-shrink-0" />}
            <span>
              {firstReviewRunning
                ? "A review pass is already running for this plan — check back shortly, or annotate to ask a question in this ticket's chat instead."
                : awaitingFirstReview
                  ? "This board's plan gate is manual (you) — nothing reviews this plan on its own. Start a review below, or annotate to ask a question in this ticket's chat instead."
                  : "Reference only — this plan has already been resolved. Annotating below asks a question in this ticket's chat instead of recording a review note."}
            </span>
          </div>
        )}
      </div>

      {/* Tabs */}
      <div className="eh-border-subtle flex flex-shrink-0 gap-1 border-b px-3 pt-2">
        {TABS.filter((t) => t.id !== 'artifact' || hasArtifact).map((t) => {
          const Icon = t.icon;
          const active = activeTab === t.id;
          return (
            <button
              key={t.id}
              type="button"
              onClick={() => setActiveTab(t.id)}
              className={`flex items-center gap-1.5 rounded-t-lg border-b-2 px-3 py-1.5 text-[12px] font-semibold transition-colors ${
                active
                  ? 'border-primary text-primary'
                  : 'border-transparent text-[var(--eh-text-muted)] hover:text-[var(--eh-text-secondary)]'
              }`}
            >
              <Icon className="h-3.5 w-3.5" />
              {t.label}
              {t.id === 'ac' && acSection && (
                <span className="ml-0.5 rounded-full bg-black/5 px-1.5 text-[10px] dark:bg-white/10">
                  {acSection.items.filter((i) => i.checked).length}/{acSection.items.length}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {/* Tab body — mouseup drives the inline-annotation selection composer (FLUX-1303). */}
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3" onMouseUp={handleTabBodyMouseUp}>
        {/* FLUX-1303: stay MOUNTED across tab switches (display:none, not unmounted) — the artifact's
            annotation batch lives INSIDE the iframe, so a conditional unmount here silently ate every
            collected annotation the moment the user peeked at the Plan tab. Same pattern + rationale
            as TicketSideView's collapsed artifact section (FLUX-1136); ArtifactPanel stops paying any
            reload/compile cost while `visible` is false. */}
        {hasArtifact && (
          <div className={activeTab === 'artifact' ? 'flex h-full min-h-0 flex-col' : ''} style={activeTab === 'artifact' ? undefined : { display: 'none' }}>
            {/* FLUX-1362: this panel is the CONTROLLED owner of the artifact annotations — they mirror
                live into `artifactItems` and merge with the plan-text annotations in ONE floating pill
                (rendered below). `onSendToChat` here is only the audit "Send to agent" route. */}
            <ArtifactPanel
              task={task}
              visible={activeTab === 'artifact'}
              fillHeight
              artifactAnnotations={artifactItems}
              onArtifactAnnotationsChange={setArtifactItems}
              onHasGuidedControlsChange={setHasGuidedControls}
              onSendToChat={onSendToChat}
            />
          </div>
        )}
        {activeTab === 'plan' && <TaskMarkdown body={task.body || ''} taskId={task.id} emptyMessage="No plan written yet." />}
        {activeTab === 'ac' && (
          acSection ? (
            <div className="flex flex-col gap-3">
              <TaskMarkdown body={acSection.raw} taskId={task.id} />
              <div className="flex flex-col gap-1">
                {acSection.items.map((item, i) => (
                  <div key={i} className="flex items-start gap-2 text-[12px] text-[var(--eh-text-muted)]">
                    <button
                      type="button"
                      onClick={() => elaborate(item)}
                      title={mode === 'later' ? 'Ask about this in chat' : 'Add a note about this item'}
                      className="mt-0.5 flex-shrink-0 rounded p-0.5 hover:bg-black/5 hover:text-primary dark:hover:bg-white/5"
                    >
                      <Plus className="h-3 w-3" />
                    </button>
                    <span className="truncate">{item.text}</span>
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <p className="text-[12px] text-[var(--eh-text-muted)]">No `## Acceptance criteria` section in this ticket yet.</p>
          )
        )}
        {activeTab === 'tests' && (
          testsSection ? (
            <div className="flex flex-col gap-3">
              <TaskMarkdown body={testsSection.raw} taskId={task.id} />
              <div className="flex flex-col gap-1">
                {testsSection.items.map((item, i) => (
                  <div key={i} className="flex items-start gap-2 text-[12px] text-[var(--eh-text-muted)]">
                    <button
                      type="button"
                      onClick={() => elaborate(item)}
                      title={mode === 'later' ? 'Ask about this in chat' : 'Add a note about this item'}
                      className="mt-0.5 flex-shrink-0 rounded p-0.5 hover:bg-black/5 hover:text-primary dark:hover:bg-white/5"
                    >
                      <Plus className="h-3 w-3" />
                    </button>
                    <span className="truncate">{item.text}</span>
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <p className="text-[12px] text-[var(--eh-text-muted)]">No recommended-tests section documented in this ticket's plan yet.</p>
          )
        )}
      </div>

      {/* Footer — notes composer + the mode-appropriate commit action(s). FLUX-1303: the composer
          exists in BOTH verdict states (it was deliberately removed on changes-requested by
          FLUX-1289, which left no way anywhere to attach your own notes to a revise — the core
          complaint of the FLUX-1298 incident). Notes are optional on changes-requested (the
          reviewer's feedback is included automatically) and required to override an approval. */}
      <div className="eh-border flex flex-col gap-2 border-t px-4 py-3">
        {/* FLUX-1362: the accumulated annotations (plan-text + artifact) no longer sit in a footer tray
            eating working space — they live in the floating "N changes" pill (rendered below), which
            follows the user and expands to edit. Only the compact "not sent yet" marker stays here so
            the draft can never LOOK already-sent when it isn't. Cleared once an explicit send action
            empties the batch (Ask in chat / Send for re-grooming clear the draft; Approve folds the
            notes into the approval comment and clears it too). */}
        {combinedNotes && (
          <div className="flex items-center gap-1.5 text-[11px] font-semibold text-amber-600 dark:text-amber-400">
            <span className="inline-block h-1.5 w-1.5 rounded-full bg-amber-500" />
            {unsentCount} note{unsentCount === 1 ? '' : 's'} — not sent yet
          </div>
        )}
        <textarea
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder={
            mode === 'review'
              ? changesRequested
                ? 'Notes for the re-groom (optional) — or select text in the plan to attach inline notes…'
                : 'Notes — required to send for re-grooming (or select plan text for inline notes), optional on approve…'
              : "Ask a question about this plan — posts into this ticket's chat (select plan text for inline notes)..."
          }
          rows={2}
          className="eh-border w-full resize-none rounded-lg border bg-[var(--eh-input-bg)] px-3 py-2 text-[13px] outline-none focus:border-primary"
        />
        {actionError && (
          <div className="text-[12px] font-medium text-red-600 dark:text-red-400">{actionError}</div>
        )}
        <div className="flex items-center justify-end gap-2">
          {mode === 'review' ? (
            isPlanGateRevising(task) ? (
              <span className="flex items-center gap-1.5 text-[12px] italic text-[var(--eh-text-muted)]">
                <Loader2 className="h-3.5 w-3.5 animate-spin" /> Revising — a grooming session is addressing the feedback…
              </span>
            ) : (
              <>
                <button
                  type="button"
                  onClick={() => void handleSetAside()}
                  disabled={busy || revising || startingImpl}
                  title="Set aside — clears the pending verdict everywhere; the review comment stays in history"
                  className="mr-auto flex items-center gap-1 rounded-md p-1.5 text-[var(--eh-text-muted)] transition-colors hover:bg-black/5 hover:text-[var(--eh-text-primary)] disabled:opacity-50 dark:hover:bg-white/5"
                >
                  <X className="h-3.5 w-3.5" /> Set aside
                </button>
                {changesRequested && (
                  <button
                    type="button"
                    onClick={() => void handleRerunReview()}
                    disabled={revising || busy}
                    title={planChanged
                      ? 'Run one fresh review pass on the current plan'
                      : 'The plan has not changed since this verdict — a re-review will usually re-produce the same result (still allowed: reviews are not deterministic)'}
                    className="flex items-center gap-1.5 rounded-md px-3 py-1.5 text-[12px] font-semibold text-[var(--eh-text-secondary)] transition-colors hover:bg-black/5 disabled:opacity-50 dark:hover:bg-white/5"
                  >
                    {revising ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />} Re-review plan{planChanged ? '' : ' (unchanged)'}
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => void handleSendForRegroom()}
                  disabled={revising || busy || startingImpl || (!changesRequested && !combinedNotes)}
                  title={!changesRequested && !combinedNotes ? 'Add notes (typed or inline on the plan) — overriding an approved plan needs a stated reason' : undefined}
                  className={changesRequested
                    ? 'flex items-center gap-1.5 rounded-md bg-amber-500 px-3 py-1.5 text-[12px] font-semibold text-white shadow-sm transition-colors hover:bg-amber-600 disabled:opacity-50'
                    : 'flex items-center gap-1.5 rounded-md border border-amber-500/40 px-3 py-1.5 text-[12px] font-semibold text-amber-700 transition-colors hover:bg-amber-500/10 disabled:opacity-50 dark:text-amber-300'}
                >
                  {revising ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Undo2 className="h-3.5 w-3.5" />} Send for re-grooming
                </button>
                {!changesRequested && (
                  <button
                    type="button"
                    onClick={() => void handleApproveAndStart()}
                    disabled={revising || busy || startingImpl}
                    title="Approve into Todo, then immediately create a branch/worktree and dispatch an implementation session"
                    className="flex items-center gap-1.5 rounded-md border border-emerald-500/40 px-3 py-1.5 text-[12px] font-semibold text-emerald-700 transition-colors hover:bg-emerald-500/10 disabled:opacity-50 dark:text-emerald-300"
                  >
                    {startingImpl ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />} Approve & start
                  </button>
                )}
                <button
                  type="button"
                  onClick={handleApprove}
                  disabled={revising || busy || startingImpl}
                  title={changesRequested ? 'Explicit override — moves to Todo despite the changes-requested verdict' : 'Move to Todo'}
                  className={changesRequested
                    ? 'flex items-center gap-1.5 rounded-md border border-emerald-500/40 px-3 py-1.5 text-[12px] font-semibold text-emerald-700 transition-colors hover:bg-emerald-500/10 disabled:opacity-50 dark:text-emerald-300'
                    : 'flex items-center gap-1.5 rounded-md bg-emerald-500 px-3 py-1.5 text-[12px] font-semibold text-white shadow-sm transition-colors hover:bg-emerald-600 disabled:opacity-50'}
                >
                  {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />} {changesRequested ? 'Approve anyway' : 'Approve'}
                </button>
              </>
            )
          ) : (
            <>
              {firstReviewRunning && (
                <span className="mr-auto flex items-center gap-1.5 text-[12px] italic text-[var(--eh-text-muted)]">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" /> Reviewing — a review pass is already running…
                </span>
              )}
              {awaitingFirstReview && (
                <button
                  type="button"
                  onClick={() => void handleRerunReview()}
                  disabled={revising}
                  title="Run one review pass on the current plan — this board's plan gate is manual, so nothing reviews it on its own"
                  className="mr-auto flex items-center gap-1.5 rounded-md px-3 py-1.5 text-[12px] font-semibold text-[var(--eh-text-secondary)] transition-colors hover:bg-black/5 disabled:opacity-50 dark:hover:bg-white/5"
                >
                  {revising ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />} Start plan review
                </button>
              )}
              <button
                type="button"
                onClick={() => void handleAskInChat()}
                disabled={busy || !combinedNotes}
                className={canApproveNow
                  ? 'flex items-center gap-1.5 rounded-md border border-primary/40 px-3 py-1.5 text-[12px] font-semibold text-primary transition-colors hover:bg-primary/10 disabled:opacity-50'
                  : 'flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-[12px] font-semibold text-white shadow-sm transition-colors hover:bg-primary-hover disabled:opacity-50'}
              >
                {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <MessageCircleQuestion className="h-3.5 w-3.5" />} Ask in chat
              </button>
              {/* FLUX-1339: standing Approve — decoupled from a fresh verdict, shown whenever a
                  Grooming ticket has a plan. Reuses the exact `buildApproveUpdate`/`commit` path as
                  review mode (any batched notes fold into the approval comment). */}
              {canApproveNow && (
                <>
                  <button
                    type="button"
                    onClick={() => void handleApproveAndStart()}
                    disabled={revising || busy || startingImpl}
                    title="Approve into Todo, then immediately create a branch/worktree and dispatch an implementation session"
                    className="flex items-center gap-1.5 rounded-md border border-emerald-500/40 px-3 py-1.5 text-[12px] font-semibold text-emerald-700 transition-colors hover:bg-emerald-500/10 disabled:opacity-50 dark:text-emerald-300"
                  >
                    {startingImpl ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />} Approve & start
                  </button>
                  <button
                    type="button"
                    onClick={handleApprove}
                    disabled={revising || busy || startingImpl}
                    title="Approve this plan and move the ticket to Todo"
                    className="flex items-center gap-1.5 rounded-md bg-emerald-500 px-3 py-1.5 text-[12px] font-semibold text-white shadow-sm transition-colors hover:bg-emerald-600 disabled:opacity-50"
                  >
                    {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />} Approve
                  </button>
                </>
              )}
            </>
          )}
        </div>
      </div>

      {/* FLUX-1303: floating selection composer — appears at the text selection in the Plan/AC/Tests
          tab body; "Add note" accumulates into the footer tray (nothing is sent until a send action). */}
      {pendingSel && (
        <div
          className="fixed z-[140] w-80 max-w-[calc(100vw-24px)] -translate-x-1/2 rounded-xl border border-amber-400/50 bg-[var(--eh-surface)] p-2.5 shadow-xl"
          style={{
            left: Math.min(Math.max(pendingSel.x, 170), window.innerWidth - 170),
            top: Math.min(pendingSel.y + 8, window.innerHeight - 190),
          }}
        >
          <div className="mb-1.5 max-h-16 overflow-hidden border-l-2 border-amber-400 pl-2 text-[11.5px] italic leading-snug text-[var(--eh-text-muted)]">
            {pendingSel.text}
          </div>
          <textarea
            autoFocus
            value={selNote}
            onChange={(e) => setSelNote(e.target.value)}
            // FLUX-1339: Esc here only dismisses the selection composer (and is stopped from bubbling
            // up to the FloatingPanel's minimize-on-Esc).
            onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); setPendingSel(null); } }}
            placeholder="Note about this part of the plan…"
            rows={2}
            className="eh-border w-full resize-none rounded-lg border bg-[var(--eh-input-bg)] px-2.5 py-1.5 text-[12.5px] outline-none focus:border-amber-500"
          />
          <div className="mt-1.5 flex items-center justify-end gap-1.5">
            <button
              type="button"
              onClick={() => setPendingSel(null)}
              className="rounded-md px-2 py-1 text-[11.5px] font-semibold text-[var(--eh-text-muted)] hover:bg-black/5 dark:hover:bg-white/5"
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={!selNote.trim()}
              onClick={() => {
                setAnnotations((prev) => [...prev, { excerpt: pendingSel.text, note: selNote.trim() }]);
                setPendingSel(null);
                window.getSelection()?.removeAllRanges();
              }}
              className="rounded-md bg-amber-500 px-2.5 py-1 text-[11.5px] font-semibold text-white transition-colors hover:bg-amber-600 disabled:opacity-50"
            >
              Add note
            </button>
          </div>
        </div>
      )}

      {/* FLUX-1362: the unified floating pill — plan-text + artifact annotations in one place, follows
          the user, expands to edit. Sending is driven by the footer actions (Approve / Send for
          re-grooming / Ask in chat), so the pill has no Send of its own here. FLUX-1381: raised above
          this panel's own footer (notes composer + action buttons, ~120-150px tall depending on the
          unsent-marker/error rows), whose buttons also sit bottom-right when the panel is maximized —
          bottom-4 landed the pill directly on top of them. Static approximation: the bar is "no
          overlap with the actions", not pixel-perfect stacking against a variable-height footer. */}
      <AnnotationPill
        bottomClass="bottom-36"
        planItems={annotations}
        artifactItems={artifactItems}
        onEditPlan={(index, note) => setAnnotations((prev) => prev.map((a, i) => (i === index ? { ...a, note } : a)))}
        onRemovePlan={(index) => setAnnotations((prev) => prev.filter((_, i) => i !== index))}
        onEditArtifact={(id, note) => setArtifactItems((prev) => prev.map((a) => (a.id === id ? { ...a, note } : a)))}
        onRemoveArtifact={(id) => setArtifactItems((prev) => prev.filter((a) => a.id !== id))}
        hasGuidedControls={hasGuidedControls}
      />
    </div>
  );
}
