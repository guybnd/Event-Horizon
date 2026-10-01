// The Benchmark Analyst — wiring for the persona that has existed since FLUX-1739 and was never
// dispatched.
//
// The analyst is ADVISORY. Every number a report carries is computed from stored records and is
// reproducible without it; the analyst's job is the part a formula cannot do — read the evidence and
// say, in plain language, what EventHorizon cost the agent. So this module is deliberately shaped so
// the analyst can add nothing to the record except text that cites the record:
//
//   - it is briefed from the SAME persisted sidecar the report is built from, never from live state;
//   - its output is harvested from a ticket comment and parsed into `BenchmarkNarrative`, and a claim
//     without a `runId` is dropped at parse time rather than surfaced — the design's one hard rule;
//   - it is stored BESIDE the report (`record.narrative`), never folded into it, and a suite is
//     complete and fully scoreable whether or not the analyst ever ran.
//
// It runs as an ordinary ticket-bound chat session on a throwaway `kind:'benchmark'` ticket, because
// that is the only shape the engine knows how to launch, observe, and clean up. The analysis ticket
// inherits every benchmark refusal (no branch, no PR, no merge) for free.

import { createTask, updateTaskWithHistory } from './task-store.js';
import { getWorkspace } from './workspace-context.js';
import { getEnginePort } from './packaged-mode.js';
import { log } from './log.js';
import { withTicketMintLock } from './benchmark-runner.js';
import type { BenchmarkRecord } from './benchmark-store.js';
import {
  BENCHMARK_KIND,
  type BenchmarkNarrative,
  type BenchmarkRun,
  type FrictionGrade,
  type NarrativeClaim,
} from './models/benchmark.js';

export const BENCHMARK_ANALYST_PERSONA_ID = 'benchmark-analyst';

/** Bounded so a 20-run suite does not brief the analyst with a novel. */
const OUTPUT_TAIL_IN_BRIEF = 600;
const EVIDENCE_PER_SIGNAL = 3;

const engineBase = () => `http://127.0.0.1:${getEnginePort()}`;

// ── The brief ─────────────────────────────────────────────────────────────────

function fmtMoney(v: number | null | undefined): string {
  return v == null ? 'n/a' : `$${v.toFixed(2)}`;
}
function fmtDuration(ms: number | undefined): string {
  if (ms == null) return 'n/a';
  const m = Math.floor(ms / 60_000);
  const s = Math.round((ms % 60_000) / 1000);
  return `${m}m${String(s).padStart(2, '0')}s`;
}
function cellLabel(run: BenchmarkRun): string {
  const c = run.cell;
  return [c.framework, c.model ?? 'default', c.effortOverride ?? 'default-effort', c.phase].join(' / ');
}
function tail(s: string | undefined, n: number): string {
  if (!s) return '';
  return s.length > n ? `…${s.slice(-n)}` : s;
}

function frictionLines(run: BenchmarkRun): string[] {
  const f = run.friction;
  if (!f) return ['  friction: not collected'];
  const out: string[] = [];
  for (const [key, value] of Object.entries(f)) {
    if (!value || typeof value !== 'object' || !('count' in value)) continue;
    const sig = value as { count: number; evidence: { locator: string; detail?: string }[] };
    if (sig.count === 0) continue;
    const ev = sig.evidence.slice(0, EVIDENCE_PER_SIGNAL).map((e) => `${e.locator}${e.detail ? ` (${e.detail.slice(0, 120)})` : ''}`).join('; ');
    out.push(`  ${key}: ${sig.count}${ev ? ` — ${ev}` : ''}`);
  }
  if (typeof f.orientationCost === 'number') out.push(`  orientationCost: ${f.orientationCost.toFixed(3)}`);
  return out.length > 0 ? out : ['  friction: none recorded'];
}

/**
 * Everything the analyst is allowed to know, in one document, built from the persisted record.
 *
 * The report is QUOTED into the brief so the analyst cannot recompute anything — it has the numbers
 * as given and nothing to derive them from. Per-run evidence is the L0 record plus friction
 * locators; the run ticket ids are named so the analyst can pull a transcript digest with
 * `get_ticket` when a locator needs context.
 */
export function buildAnalystBrief(record: BenchmarkRecord): string {
  const { suite, runs, report } = record;
  const lines: string[] = [];

  lines.push(`# Benchmark analysis brief — suite \`${suite.id}\``);
  lines.push('');
  lines.push(`Seed: **${suite.seedTitle}** at base commit \`${suite.baseCommit.slice(0, 12)}\`.`);
  lines.push(`Matrix: ${suite.matrix.length} cell(s) × ${suite.repetitions} repetition(s) = ${runs.length} run(s). Status: ${suite.status}${suite.abortReason ? ` (${suite.abortReason})` : ''}.`);
  if (suite.validation) lines.push(`Held-out check: \`${[suite.validation.command, ...suite.validation.args].join(' ')}\` over ${suite.validation.paths.join(', ')}.`);
  if (suite.regression) lines.push(`Regression check: \`${[suite.regression.command, ...suite.regression.args].join(' ')}\` (baseline exit ${suite.regression.baselineExitCode ?? 'unknown'}).`);
  lines.push('');

  lines.push('## Computed report (quote these; never recompute, re-round or re-rank)');
  lines.push('');
  if (!report) {
    lines.push('_No report was built for this suite._');
  } else {
    for (const [i, cell] of report.cells.entries()) {
      const c = cell.cell;
      const label = [c.framework, c.model ?? 'default', c.effortOverride ?? 'default-effort', c.phase].join(' / ');
      const iv = cell.solveRateInterval;
      lines.push(`- cell ${i} **${label}** — scored ${cell.scoredRuns}, solved ${cell.solvedRuns}, solveRate ${cell.solveRate == null ? 'n/a' : cell.solveRate.toFixed(2)} (Wilson ${iv ? `${(iv.low * 100).toFixed(0)}–${(iv.high * 100).toFixed(0)}%` : 'n/a'}), attrition ${cell.attritionRuns}, tamper ${cell.tamperRate ?? 0}, costPerSolve ${fmtMoney(cell.costPerSolve)}, frictionGrade **${cell.friction.grade}** (ehToolFailures ${cell.friction.ehToolFailureTotal}, protocolViolationRuns ${cell.friction.protocolViolationRuns}, blockedRuns ${cell.friction.blockedRuns}).`);
    }
    lines.push('');
    lines.push(`Pareto frontier: cells [${report.frontier.join(', ')}]; zero-solve cells [${report.zeroSolveCells.join(', ')}].`);
  }
  lines.push('');

  lines.push('## Runs (L0 record + friction evidence)');
  lines.push('');
  for (const run of runs) {
    lines.push(`### run \`${run.runId}\` — ${cellLabel(run)} #${run.repetitionIndex}`);
    lines.push(`  ticket: ${run.ticketId ?? 'not minted'} · status ${run.status}${run.failureClass ? ` · failureClass ${run.failureClass}` : ''}${run.sessionOutcome ? ` · sessionOutcome ${run.sessionOutcome}` : ''}`);
    lines.push(`  solved: ${run.solved === undefined ? 'unscored' : run.solved} · tampered: ${run.tampered ?? false} · regressed: ${run.regressed ?? 'n/a'} · cost ${fmtMoney(run.costUSD)} · duration ${fmtDuration(run.durationMs)} · changed ${run.changedFileCount ?? 0} file(s)${run.changedPaths && run.changedPaths.length ? `: ${run.changedPaths.slice(0, 8).join(', ')}${run.changedPaths.length > 8 ? ', …' : ''}` : ''}`);
    if (run.validation) lines.push(`  validation: exit ${run.validation.exitCode}${run.validation.timedOut ? ' (timed out)' : ''}${run.validation.outputTail ? `\n  validation tail: ${tail(run.validation.outputTail, OUTPUT_TAIL_IN_BRIEF).replace(/\n/g, '\n    ')}` : ''}`);
    if (run.regression && !run.regression.passed) lines.push(`  regression tail: ${tail(run.regression.outputTail, OUTPUT_TAIL_IN_BRIEF).replace(/\n/g, '\n    ')}`);
    lines.push(...frictionLines(run));
    if (run.engine) lines.push(`  engine: ${run.engine.version}@${run.engine.commit?.slice(0, 8) ?? '?'}${run.engine.dirty ? ' DIRTY' : ''}`);
    lines.push('');
  }

  lines.push('## What to produce');
  lines.push('');
  lines.push('Read the evidence above. Use `get_ticket(<run ticket id>, expand)` when a locator needs the surrounding progress. The run tickets are archived; that is expected.');
  lines.push('');
  lines.push('When you are done, call `change_status` on THIS ticket to `Ready` with a completion comment that contains exactly one fenced ```json block of this shape:');
  lines.push('');
  lines.push('```json');
  lines.push(JSON.stringify({
    summary: 'Two or three plain-language paragraphs about what EventHorizon cost the agents in this suite.',
    claims: [{ statement: 'One specific, falsifiable observation.', runId: '<runId from above>', locator: '<turn id or progress timestamp>', attribution: 'eventhorizon | adapter | effort | unknown' }],
    proposedDefects: ['Ranked, most important first. Describe; do not file.'],
    dissent: [{ cellIndex: 0, grade: 'clean | noisy | obstructive | blocking', reasoning: 'Only if you disagree with a computed frictionGrade.' }],
  }, null, 2));
  lines.push('```');
  lines.push('');
  lines.push('A claim without a `runId` from this brief is discarded at parse time. Do not restate the computed numbers as findings. Do not file tickets. Do not touch code or the run branches.');

  return lines.join('\n');
}

// ── The narrative ─────────────────────────────────────────────────────────────

const ATTRIBUTIONS = new Set<NarrativeClaim['attribution']>(['eventhorizon', 'adapter', 'effort', 'unknown']);
const GRADES = new Set<FrictionGrade>(['clean', 'noisy', 'obstructive', 'blocking']);

export interface ParsedNarrative {
  narrative: BenchmarkNarrative;
  /** Claims the analyst wrote that named no admissible run. Reported so the drop is visible. */
  droppedClaims: number;
}

/**
 * Parse the analyst's completion comment into a narrative.
 *
 * Takes the LAST fenced json block, because an agent that thinks out loud may quote the schema
 * before writing its answer. Returns null when there is no block or it is not an object — a
 * free-text answer is not silently promoted to a narrative, because a narrative with no admissible
 * claims is worth less than an honest "the analyst did not produce one".
 */
export function parseNarrative(text: string, suiteId: string, knownRunIds: ReadonlySet<string>, cells: BenchmarkRecord['suite']['matrix']): ParsedNarrative | null {
  const blocks = [...text.matchAll(/```(?:json)?\s*\n([\s\S]*?)```/g)].map((m) => m[1] ?? '');
  const last = blocks[blocks.length - 1];
  if (!last) return null;

  let raw: unknown;
  try { raw = JSON.parse(last); } catch { return null; }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;

  const claims: NarrativeClaim[] = [];
  let dropped = 0;
  for (const c of Array.isArray(obj.claims) ? obj.claims : []) {
    const claim = c as Partial<NarrativeClaim>;
    const runId = typeof claim.runId === 'string' ? claim.runId : '';
    if (!knownRunIds.has(runId) || typeof claim.statement !== 'string' || !claim.statement.trim()) { dropped++; continue; }
    claims.push({
      statement: claim.statement.trim(),
      runId,
      locator: typeof claim.locator === 'string' ? claim.locator : '',
      attribution: ATTRIBUTIONS.has(claim.attribution as NarrativeClaim['attribution']) ? (claim.attribution as NarrativeClaim['attribution']) : 'unknown',
    });
  }

  const dissent: NonNullable<BenchmarkNarrative['dissent']> = [];
  for (const d of Array.isArray(obj.dissent) ? obj.dissent : []) {
    const item = d as { cellIndex?: unknown; grade?: unknown; reasoning?: unknown };
    const idx = typeof item.cellIndex === 'number' ? item.cellIndex : -1;
    const cell = cells[idx];
    if (!cell || !GRADES.has(item.grade as FrictionGrade) || typeof item.reasoning !== 'string') continue;
    dissent.push({ cell, grade: item.grade as FrictionGrade, reasoning: item.reasoning });
  }

  const narrative: BenchmarkNarrative = {
    suiteId,
    generatedAt: new Date().toISOString(),
    summary: typeof obj.summary === 'string' ? obj.summary.trim() : '',
    claims,
    proposedDefects: (Array.isArray(obj.proposedDefects) ? obj.proposedDefects : []).filter((s): s is string => typeof s === 'string' && s.trim().length > 0),
    ...(dissent.length > 0 ? { dissent } : {}),
  };
  return { narrative, droppedClaims: dropped };
}

/**
 * Look for the analyst's answer on its ticket. Newest comment first, so a corrected answer wins.
 * Returns null while the analyst is still working (or never answered).
 */
export function harvestNarrative(record: BenchmarkRecord): ParsedNarrative | null {
  const ticketId = record.suite.analysis?.ticketId;
  if (!ticketId) return null;
  const task = getWorkspace().tasks[ticketId] as { history?: unknown[] } | undefined;
  const history = Array.isArray(task?.history) ? task.history : [];
  const known = new Set(record.runs.map((r) => r.runId));
  for (let i = history.length - 1; i >= 0; i--) {
    const entry = history[i] as { type?: string; comment?: string };
    if (entry?.type !== 'comment' || typeof entry.comment !== 'string') continue;
    const parsed = parseNarrative(entry.comment, record.suite.id, known, record.suite.matrix);
    if (parsed) return parsed;
  }
  return null;
}

// ── Dispatch ──────────────────────────────────────────────────────────────────

export interface AnalysisDispatchOptions {
  framework?: string | undefined;
  model?: string | undefined;
}

export interface AnalysisDispatchResult {
  ticketId: string;
  sessionId: string | null;
  error?: string;
}

/**
 * Mint the analysis ticket and start the analyst on it.
 *
 * Minting goes through the runner's mint lock for the same reason runs do — `createTask` is not
 * concurrency-safe and a suite may still be tearing down. The dispatch is an ordinary start-route
 * call, `phase: 'chat'` (no code, no worktree, no isolation), with the persona id so the engine owns
 * the prompt and the brief travels as the launch focus.
 */
export async function requestAnalysis(record: BenchmarkRecord, workspaceRoot: string, opts: AnalysisDispatchOptions = {}): Promise<AnalysisDispatchResult> {
  const brief = buildAnalystBrief(record);
  const created = await withTicketMintLock(() => createTask({
    title: `Benchmark analysis: ${record.suite.id}`,
    body: `> **TL;DR** Analyst pass over benchmark suite \`${record.suite.id}\` (${record.suite.seedTitle}). Advisory only — the suite is complete and scoreable without it.\n\nThe brief is the launch focus of the analyst session; its answer is the Ready completion comment.`,
    status: 'Todo',
    kind: BENCHMARK_KIND,
    createdBy: 'Benchmark',
  } as never));
  const ticketId = (created as { id?: string })?.id ?? String(created);

  const body: Record<string, unknown> = {
    phase: 'chat',
    personaId: BENCHMARK_ANALYST_PERSONA_ID,
    focusComment: brief,
    skipPermissions: true,
    patternPosition: 'standalone',
    user: 'Benchmark',
    supersedeParked: true,
  };
  if (opts.framework) body.framework = opts.framework;
  if (opts.model) body.model = opts.model;

  try {
    const res = await fetch(`${engineBase()}/api/tasks/${encodeURIComponent(ticketId)}/cli-session/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-EH-Workspace': workspaceRoot },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const err = (await res.json().catch(() => ({}))) as { error?: string };
      const message = err?.error || res.statusText;
      log.warn(`[benchmark-analyst] dispatch for ${record.suite.id} refused: ${message}`);
      await archiveAnalysisTicket(ticketId, `analyst dispatch refused: ${message}`);
      return { ticketId, sessionId: null, error: message };
    }
    const j = (await res.json().catch(() => ({}))) as { session?: { id?: string } };
    return { ticketId, sessionId: j.session?.id ?? null };
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    await archiveAnalysisTicket(ticketId, `analyst dispatch failed: ${message}`);
    return { ticketId, sessionId: null, error: message };
  }
}

async function archiveAnalysisTicket(ticketId: string, reason: string): Promise<void> {
  await updateTaskWithHistory(ticketId, {
    updatedBy: 'Benchmark',
    extraFields: { status: 'Archived' },
    entries: [{ type: 'activity', user: 'Benchmark', comment: reason, date: new Date().toISOString() }],
  }).catch((err) => log.warn(`[benchmark-analyst] archive of ${ticketId} failed: ${err instanceof Error ? err.message : String(err)}`));
}
