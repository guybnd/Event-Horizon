#!/usr/bin/env node
/**
 * seed-demo — regenerate the committed demo workspace at `demo/`.
 *
 * The demo board is a self-contained Event Horizon workspace used for the
 * README showcase GIFs (see docs/media/RECORDING.md). It is NOT the real FLUX
 * board — it is seeded with a fictional product ("Trailhead", a hiking
 * companion app) so screenshots read instantly and never leak FLUX internals.
 *
 * This script is the sanctioned way to (re)build that board. It is modeled on
 * engine/src/patch-ticket.ts: it writes `.flux` files directly with gray-matter
 * using the SAME frontmatter schema `createTask` produces, and it validates
 * every ticket through the engine's own `validateTicketFrontmatter` before
 * writing. That gives schema safety without booting the server, and keeps the
 * demo regenerable as the schema evolves.
 *
 * Design notes that keep the committed files stable (so opening the workspace
 * does not dirty the working tree):
 *   - Every ticket history starts with a `Created ticket.` activity, so
 *     ensureCreationActivity() is a no-op on load.
 *   - Every comment entry has a pre-assigned `id`, so normalizeHistoryEntries()
 *     does not mint one and rewrite the file.
 *   - Every history entry carries a fixed ISO `date`, so no date is injected.
 *   - "Require Input" is modeled the current way: a `swimlane: 'require-input'`
 *     overlay on a real status (Grooming) plus the question comment — not a
 *     board column.
 *
 * Usage (from repo root):
 *   npx tsx engine/src/seed-demo.ts            # writes ./demo
 *   npx tsx engine/src/seed-demo.ts --out path # custom output dir
 */

import fs from 'fs';
import path from 'path';
import matter from 'gray-matter';
import { validateTicketFrontmatter, formatValidationErrors } from './schema.js';

// ── Output dir ─────────────────────────────────────────────────────────────

function outDir(): string {
  const argv = process.argv.slice(2);
  const idx = argv.indexOf('--out');
  if (idx !== -1 && argv[idx + 1]) return path.resolve(argv[idx + 1]!);
  // Default: <repo-root>/demo. This file lives at engine/src/, so go up two.
  return path.resolve(__dirname ?? path.join(process.cwd(), 'engine', 'src'), '..', '..', 'demo');
}

// ── Demo board config (project key TRAIL) ────────────────────────────────────

const config = {
  columns: [
    { name: 'Grooming', color: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300' },
    { name: 'Todo', color: 'bg-sky-100 text-sky-700 dark:bg-sky-900/30 dark:text-sky-300' },
    { name: 'In Progress', color: 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300' },
    { name: 'Ready', color: 'bg-teal-100 text-teal-700 dark:bg-teal-900/30 dark:text-teal-300' },
    { name: 'Done', color: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300' },
    { name: 'Archived', color: 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300' },
  ],
  hiddenStatuses: [
    { name: 'Backlog', color: 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300' },
    { name: 'Released', color: 'bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-300' },
  ],
  projects: ['TRAIL'],
  users: [{ name: 'Maya' }, { name: 'Devin' }, { name: 'Agent' }],
  tags: [
    { name: 'bug', color: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400' },
    { name: 'feature', color: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400' },
    { name: 'docs', color: 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400' },
    { name: 'ui', color: 'bg-violet-100 text-violet-700 dark:bg-violet-900/30 dark:text-violet-400' },
    { name: 'maps', color: 'bg-teal-100 text-teal-700 dark:bg-teal-900/30 dark:text-teal-400' },
    { name: 'offline', color: 'bg-cyan-100 text-cyan-700 dark:bg-cyan-900/30 dark:text-cyan-400' },
    { name: 'perf', color: 'bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-400' },
    { name: 'onboarding', color: 'bg-pink-100 text-pink-700 dark:bg-pink-900/30 dark:text-pink-400' },
  ],
  priorities: [
    { name: 'Critical', icon: 'AlertCircle', color: 'text-red-500' },
    { name: 'High', icon: 'ChevronUp', color: 'text-orange-500' },
    { name: 'Medium', icon: 'Equal', color: 'text-amber-500' },
    { name: 'Low', icon: 'ChevronDown', color: 'text-emerald-500' },
    { name: 'None', icon: 'Equal', color: 'text-gray-400' },
  ],
  enableBacklogScreen: true,
  requireCommentOnStatusChange: true,
  boardCardOpenMode: 'full',
  animationsEnabled: true,
  enableFireworks: true,
  requireInputStatus: 'Require Input',
  readyForMergeStatus: 'Ready',
  archiveStatus: 'Archived',
  swimlanes: [
    { id: 'require-input', label: 'Require Input', color: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300', commentRequired: true },
  ],
  docsEditPermissions: 'all',
  docsAllowedUsers: [],
  releaseSettings: { generateDistinctFiles: true, releaseNotesPath: 'release-notes' },
  defaultAgent: 'claude',
  defaultWorkflowId: '',
  modules: [],
};

// ── Ticket definitions ───────────────────────────────────────────────────────

type Hist = Record<string, unknown>;

interface TicketDef {
  id: string;
  title: string;
  status: string;
  priority: string;
  effort: string;
  assignee?: string;
  tags: string[];
  parentId?: string;
  subtasks?: string[];
  swimlane?: string;
  branch?: string;
  implementationLink?: string;
  tokenMetadata?: Record<string, unknown>;
  createdBy?: string;
  history: Hist[];
  body: string;
}

// Helpers to build history entries with the exact engine shapes.
const created = (date: string, user = 'Maya'): Hist => ({ type: 'activity', user, date, comment: 'Created ticket.' });
const statusChange = (date: string, from: string, to: string, user = 'Agent'): Hist => ({ type: 'status_change', from, to, user, date });
const comment = (id: string, date: string, text: string, user = 'Agent', extra: Hist = {}): Hist => ({ type: 'comment', id, user, date, comment: text, ...extra });
const session = (sessionId: string, startedAt: string, endedAt: string, user: string, progress: Hist[], finalMessage: string, outcome = 'Claude Code session ended with code 0.'): Hist => ({
  type: 'agent_session',
  sessionId,
  startedAt,
  endedAt,
  date: startedAt,
  user,
  status: 'completed',
  outcome,
  progress,
  finalMessage,
  originalProgressCount: progress.length + 18,
});
const prog = (timestamp: string, message: string, type: 'text' | 'topic' | 'tool' | 'info' = 'text'): Hist => ({ timestamp, message, type });

const tickets: TicketDef[] = [
  // ── TRAIL-1: In Progress, live-agent flagship card ────────────────────────
  {
    id: 'TRAIL-1',
    title: 'Record GPS breadcrumb trail while hiking',
    status: 'In Progress',
    priority: 'High',
    effort: 'L',
    assignee: 'Maya',
    tags: ['feature', 'maps'],
    branch: 'flux/TRAIL-1-gps-breadcrumb-trail',
    tokenMetadata: { inputTokens: 412880, outputTokens: 7340, costUSD: 0.71, costIsEstimated: false, cacheReadTokens: 388120, cacheCreationTokens: 41200 },
    history: [
      created('2026-06-08T09:12:00.000Z'),
      statusChange('2026-06-08T09:40:00.000Z', 'Grooming', 'Todo'),
      comment('c-trail1-plan', '2026-06-08T14:05:00.000Z',
        'Plan: tap into the existing `LocationService` stream, persist points to a ring buffer, flush to SQLite every 5s. Render the polyline incrementally so the map stays smooth on long hikes. Sampling adapts to speed (denser on switchbacks, sparser on straightaways) to keep point count bounded.',
        'Maya',
        { summary: 'TRAIL-1 plan: subscribe to LocationService, ring-buffer points, flush to SQLite every 5s, incremental polyline render, speed-adaptive sampling to bound point count.' }),
      statusChange('2026-06-09T10:02:00.000Z', 'Todo', 'In Progress'),
      session('11d2e0a4-7c3b-4f6e-9a21-2b8e5f0c4a10', '2026-06-09T10:05:00.000Z', '2026-06-09T10:38:00.000Z', 'Claude Code', [
        prog('2026-06-09T10:05:30.000Z', 'Reading LocationService and the map render pipeline', 'topic'),
        prog('2026-06-09T10:08:12.000Z', 'Read src/location/LocationService.ts', 'tool'),
        prog('2026-06-09T10:11:48.000Z', 'Added BreadcrumbRecorder with a 256-point ring buffer', 'tool'),
        prog('2026-06-09T10:19:05.000Z', 'Wired SQLite flush on a 5s timer; added the trails table migration', 'tool'),
        prog('2026-06-09T10:27:41.000Z', 'Incremental polyline now appends points instead of re-drawing the layer', 'tool'),
        prog('2026-06-09T10:34:10.000Z', 'Recorder is in place and the polyline updates live; speed-adaptive sampling still TODO before review.', 'text'),
      ], 'Recorder is in place and the polyline updates live; speed-adaptive sampling still TODO before review.'),
      comment('c-trail1-progress', '2026-06-09T10:40:00.000Z',
        'Recorder + live polyline landed. Remaining before Ready: speed-adaptive sampling and a battery-impact check (coordinate with TRAIL-10).',
        'Agent',
        { summary: 'TRAIL-1 progress: recorder + live polyline done; remaining = speed-adaptive sampling + battery check (see TRAIL-10).' }),
    ],
    body: `# Record GPS breadcrumb trail while hiking

## Problem / Motivation
Hikers want to see the path they've actually walked, not just their current pin. A live breadcrumb trail is the backbone for stats, sharing, and "find my way back".

## Implementation plan
1. Subscribe to \`LocationService\` updates and buffer points in a bounded ring buffer.
2. Flush to SQLite every 5s so a crash loses at most a few seconds.
3. Render the polyline incrementally — append, don't redraw — to keep the map smooth on multi-hour hikes.
4. Adapt sampling rate to speed so point count stays bounded.

## Acceptance criteria
- [x] Points stream into a recorder and persist across app restarts.
- [x] Polyline updates live on the map.
- [ ] Sampling adapts to speed; verified battery impact is acceptable.`,
  },

  // ── TRAIL-2: Grooming + Require-Input swimlane (the question shot) ─────────
  {
    id: 'TRAIL-2',
    title: 'Cache offline map tiles for no-signal hikes',
    status: 'Grooming',
    priority: 'High',
    effort: 'L',
    tags: ['feature', 'offline', 'maps'],
    swimlane: 'require-input',
    history: [
      created('2026-06-10T08:30:00.000Z'),
      comment('c-trail2-q', '2026-06-11T15:20:00.000Z',
        'Need a product decision before grooming further: **what hard cap should we put on the offline tile cache?**\n\nProposed default: **2 GB**, evict least-recently-viewed regions first, with a per-region "keep offline" pin that is exempt from eviction. Alternatives: 1 GB (safer on low-end devices) or user-configurable (more work, more support load).\n\nDefault if no answer: ship 2 GB + LRU eviction + pinned regions.',
        'Maya',
        { summary: 'Require Input on TRAIL-2: what hard cap for offline tile cache? Proposed default 2 GB + LRU eviction + pinned regions exempt; alternatives 1 GB or user-configurable.' }),
    ],
    body: `# Cache offline map tiles for no-signal hikes

## Problem / Motivation
Trails routinely lose cell signal. Without pre-cached tiles the map goes blank exactly when navigation matters most.

## Open question (blocking)
What hard cap should bound the offline tile cache, and what eviction policy? See the Require Input comment — proposed default is 2 GB + LRU eviction with pinned regions exempt.

## Sketch (pending the decision above)
- Download tiles for a user-selected region at chosen zoom levels.
- Store in a dedicated cache with a size ceiling + eviction policy.
- Surface cache usage in Settings so users can manage space.`,
  },

  // ── TRAIL-3: Done with implementationLink + completed session ─────────────
  {
    id: 'TRAIL-3',
    title: 'Dark mode theme',
    status: 'Done',
    priority: 'Medium',
    effort: 'M',
    assignee: 'Devin',
    tags: ['feature', 'ui'],
    implementationLink: 'https://github.com/trailhead-app/trailhead/pull/142',
    createdBy: 'Devin',
    tokenMetadata: { inputTokens: 198400, outputTokens: 4120, costUSD: 0.34, costIsEstimated: false, cacheReadTokens: 180200, cacheCreationTokens: 22100 },
    history: [
      created('2026-05-20T11:00:00.000Z', 'Devin'),
      statusChange('2026-05-20T11:30:00.000Z', 'Grooming', 'Todo'),
      statusChange('2026-05-21T09:00:00.000Z', 'Todo', 'In Progress'),
      session('aa31f9c2-1e44-4c8d-bb70-9f2a6d1e3c55', '2026-05-21T09:05:00.000Z', '2026-05-21T11:50:00.000Z', 'Claude Code', [
        prog('2026-05-21T09:06:00.000Z', 'Auditing hard-coded colors across the component library', 'topic'),
        prog('2026-05-21T09:40:00.000Z', 'Extracted a semantic color token layer', 'tool'),
        prog('2026-05-21T10:55:00.000Z', 'Added a theme toggle that follows the system setting by default', 'tool'),
        prog('2026-05-21T11:48:00.000Z', 'Dark mode complete; all screens audited and the toggle persists.', 'text'),
      ], 'Dark mode complete; all screens audited and the toggle persists.'),
      statusChange('2026-05-21T12:30:00.000Z', 'In Progress', 'Ready'),
      comment('c-trail3-ready', '2026-05-21T12:31:00.000Z', 'Implemented semantic tokens + a system-following toggle. Every screen audited; contrast checked against WCAG AA.', 'Devin', { summary: 'TRAIL-3 ready: semantic color tokens + system-following dark mode toggle, all screens audited, WCAG AA contrast checked.' }),
      statusChange('2026-05-22T16:00:00.000Z', 'Ready', 'Done'),
      comment('c-trail3-done', '2026-05-22T16:00:30.000Z', 'Merged in #142. Shipped in 2.4.', 'Devin'),
    ],
    body: `# Dark mode theme

## Problem / Motivation
Early-morning and dusk hikers want a dark UI that doesn't blind them on the trailhead.

## What shipped
- A semantic color-token layer replacing hard-coded colors.
- A theme toggle that follows the system setting by default.
- WCAG AA contrast verified across every screen.`,
  },

  // ── TRAIL-4: parent (Todo) with two subtasks ──────────────────────────────
  {
    id: 'TRAIL-4',
    title: 'Redesign first-run onboarding flow',
    status: 'Todo',
    priority: 'Medium',
    effort: 'L',
    tags: ['feature', 'onboarding'],
    subtasks: ['TRAIL-5', 'TRAIL-6'],
    history: [
      created('2026-06-05T13:00:00.000Z'),
      comment('c-trail4-scope', '2026-06-05T13:20:00.000Z', 'Split into two subtasks: the welcome carousel (TRAIL-5) and location-permission priming (TRAIL-6). Ship the carousel first; priming depends on its final screen.', 'Maya', { summary: 'TRAIL-4 scoped into TRAIL-5 (welcome carousel) + TRAIL-6 (location permission priming); carousel ships first.' }),
      statusChange('2026-06-05T13:25:00.000Z', 'Grooming', 'Todo'),
    ],
    body: `# Redesign first-run onboarding flow

## Problem / Motivation
First-run drop-off is high — users hit a raw map and a system location prompt with no context. A short, friendly intro should lift activation.

## Plan
Two subtasks:
- **TRAIL-5** — welcome carousel introducing the three core features.
- **TRAIL-6** — prime the location permission *before* the OS dialog so users understand why it's needed.`,
  },

  // ── TRAIL-5: subtask of TRAIL-4 ───────────────────────────────────────────
  {
    id: 'TRAIL-5',
    title: 'Welcome carousel screens',
    status: 'Todo',
    priority: 'Low',
    effort: 'S',
    tags: ['feature', 'onboarding', 'ui'],
    parentId: 'TRAIL-4',
    history: [
      { type: 'activity', user: 'Maya', date: '2026-06-05T13:21:00.000Z', comment: 'Created as subtask of TRAIL-4.' },
    ],
    body: `# Welcome carousel screens

Three swipeable intro screens: record your trail, navigate offline, share your hike. Skippable, shown once.`,
  },

  // ── TRAIL-6: subtask of TRAIL-4 ───────────────────────────────────────────
  {
    id: 'TRAIL-6',
    title: 'Prime the location permission request',
    status: 'Todo',
    priority: 'Medium',
    effort: 'S',
    tags: ['feature', 'onboarding'],
    parentId: 'TRAIL-4',
    history: [
      { type: 'activity', user: 'Maya', date: '2026-06-05T13:22:00.000Z', comment: 'Created as subtask of TRAIL-4.' },
    ],
    body: `# Prime the location permission request

Show a context screen explaining why Trailhead needs "Always" location (background breadcrumb recording) before triggering the OS dialog. Pre-priming meaningfully raises grant rates.`,
  },

  // ── TRAIL-7: Ready, the diff→finish shot, critical bug ────────────────────
  {
    id: 'TRAIL-7',
    title: 'Crash when exporting an empty route',
    status: 'Ready',
    priority: 'Critical',
    effort: 'S',
    assignee: 'Devin',
    tags: ['bug'],
    branch: 'flux/TRAIL-7-crash-empty-route-export',
    createdBy: 'Devin',
    tokenMetadata: { inputTokens: 96200, outputTokens: 2010, costUSD: 0.16, costIsEstimated: false, cacheReadTokens: 88400, cacheCreationTokens: 9800 },
    history: [
      created('2026-06-13T18:45:00.000Z', 'Devin'),
      comment('c-trail7-repro', '2026-06-13T18:47:00.000Z', 'Repro: open a brand-new trail with zero recorded points → tap Export GPX → hard crash. Stack points at `route.points[0]` in the GPX serializer.', 'Devin', { summary: 'TRAIL-7 repro: exporting a trail with zero points crashes at route.points[0] in the GPX serializer.' }),
      statusChange('2026-06-14T09:00:00.000Z', 'Grooming', 'Todo'),
      statusChange('2026-06-14T09:30:00.000Z', 'Todo', 'In Progress'),
      session('c7e1b8d0-5a92-4d3f-8e10-6b4c2f9a7d33', '2026-06-14T09:32:00.000Z', '2026-06-14T09:58:00.000Z', 'Claude Code', [
        prog('2026-06-14T09:33:00.000Z', 'Reproducing the empty-route crash', 'topic'),
        prog('2026-06-14T09:41:00.000Z', 'Guard added: GPX export now returns an empty-track file instead of indexing points[0]', 'tool'),
        prog('2026-06-14T09:50:00.000Z', 'Added a regression test for the zero-point export path', 'tool'),
        prog('2026-06-14T09:57:00.000Z', 'Crash fixed and covered by a test; export of an empty route now yields a valid empty GPX.', 'text'),
      ], 'Crash fixed and covered by a test; export of an empty route now yields a valid empty GPX.'),
      statusChange('2026-06-14T10:15:00.000Z', 'In Progress', 'Ready'),
      comment('c-trail7-ready', '2026-06-14T10:16:00.000Z', 'Fixed: guarded the GPX serializer against zero-point routes (returns a valid empty `<trk>` instead of crashing). Added a regression test. Ready for review — diff is on the PR branch.', 'Agent', { pin: true, summary: 'REVIEW HANDOFF — TRAIL-7 ready: guarded GPX serializer against zero-point routes (valid empty <trk> instead of crash) + regression test. Diff on PR branch.' }),
    ],
    body: `# Crash when exporting an empty route

## Bug
Exporting a trail with zero recorded points crashes the app — the GPX serializer assumes \`route.points[0]\` exists.

## Fix
Guard the serializer: a zero-point route now produces a valid empty \`<trk>\` document. Added a regression test covering the empty-export path.`,
  },

  // ── TRAIL-8..9: more Done cards ───────────────────────────────────────────
  {
    id: 'TRAIL-8',
    title: 'Elevation profile chart for a hike',
    status: 'Done',
    priority: 'Medium',
    effort: 'M',
    assignee: 'Maya',
    tags: ['feature', 'ui'],
    implementationLink: 'https://github.com/trailhead-app/trailhead/pull/131',
    history: [
      created('2026-05-12T10:00:00.000Z'),
      statusChange('2026-05-12T10:30:00.000Z', 'Grooming', 'Todo'),
      statusChange('2026-05-13T09:00:00.000Z', 'Todo', 'In Progress'),
      statusChange('2026-05-14T15:00:00.000Z', 'In Progress', 'Ready'),
      comment('c-trail8-ready', '2026-05-14T15:01:00.000Z', 'Interactive elevation chart with a draggable scrubber synced to the map marker.', 'Maya', { summary: 'TRAIL-8 ready: interactive elevation profile chart with a scrubber synced to the map marker.' }),
      statusChange('2026-05-15T11:00:00.000Z', 'Ready', 'Done'),
    ],
    body: `# Elevation profile chart for a hike

A scrubber-driven elevation chart under the trail; dragging it moves a marker along the route on the map. Shipped in 2.3.`,
  },
  {
    id: 'TRAIL-9',
    title: 'Share a trail as a GPX file',
    status: 'Done',
    priority: 'Low',
    effort: 'S',
    assignee: 'Devin',
    tags: ['feature'],
    implementationLink: 'https://github.com/trailhead-app/trailhead/pull/118',
    createdBy: 'Devin',
    history: [
      created('2026-05-02T14:00:00.000Z', 'Devin'),
      statusChange('2026-05-02T14:20:00.000Z', 'Grooming', 'Todo'),
      statusChange('2026-05-03T10:00:00.000Z', 'Todo', 'In Progress'),
      statusChange('2026-05-03T16:00:00.000Z', 'In Progress', 'Ready'),
      comment('c-trail9-ready', '2026-05-03T16:01:00.000Z', 'Export + native share sheet wired up. (This is the path TRAIL-7 later found a crash in for empty routes.)', 'Devin', { summary: 'TRAIL-9 ready: GPX export via the native share sheet.' }),
      statusChange('2026-05-04T12:00:00.000Z', 'Ready', 'Done'),
    ],
    body: `# Share a trail as a GPX file

Export the recorded route to standard GPX and hand it to the OS share sheet so it opens in any mapping app.`,
  },

  // ── TRAIL-10: second In Progress (perf bug) ───────────────────────────────
  {
    id: 'TRAIL-10',
    title: 'Battery drains fast during long recordings',
    status: 'In Progress',
    priority: 'High',
    effort: 'M',
    assignee: 'Maya',
    tags: ['bug', 'perf'],
    history: [
      created('2026-06-11T08:00:00.000Z'),
      comment('c-trail10-data', '2026-06-11T08:30:00.000Z', 'Field reports: ~18%/hr battery during recording. Profiler points at GPS polling at max accuracy + frequent screen wakeups.', 'Maya', { summary: 'TRAIL-10: ~18%/hr battery drain during recording; cause = max-accuracy GPS polling + frequent screen wakeups.' }),
      statusChange('2026-06-11T08:35:00.000Z', 'Grooming', 'Todo'),
      statusChange('2026-06-12T09:00:00.000Z', 'Todo', 'In Progress'),
      comment('c-trail10-progress', '2026-06-12T16:00:00.000Z', 'Switched to balanced-accuracy polling when stationary; investigating deferred location updates next. Coordinating with TRAIL-1 sampling.', 'Maya', { summary: 'TRAIL-10 progress: balanced-accuracy polling when stationary; next is deferred location updates; coordinating with TRAIL-1 sampling.' }),
    ],
    body: `# Battery drains fast during long recordings

## Problem
Recording a multi-hour hike eats ~18%/hr of battery. Root cause: GPS polling at maximum accuracy plus frequent screen wakeups.

## Plan
- Drop to balanced accuracy when the hiker is stationary.
- Batch deferred location updates.
- Re-check against TRAIL-1's speed-adaptive sampling so the two don't fight.`,
  },

  // ── TRAIL-11: Todo ────────────────────────────────────────────────────────
  {
    id: 'TRAIL-11',
    title: 'Weather overlay on the trail map',
    status: 'Todo',
    priority: 'Medium',
    effort: 'M',
    tags: ['feature', 'maps'],
    history: [
      created('2026-06-09T11:00:00.000Z'),
      statusChange('2026-06-09T11:30:00.000Z', 'Grooming', 'Todo'),
    ],
    body: `# Weather overlay on the trail map

Toggleable radar + hourly forecast overlay so hikers can see incoming weather along the route before heading out.`,
  },

  // ── TRAIL-12: second Grooming ─────────────────────────────────────────────
  {
    id: 'TRAIL-12',
    title: 'Community trail difficulty ratings',
    status: 'Grooming',
    priority: 'Low',
    effort: 'M',
    tags: ['feature'],
    history: [
      created('2026-06-14T19:00:00.000Z'),
    ],
    body: `# Community trail difficulty ratings

## Problem / Motivation
"Moderate" means different things to different people. Let hikers rate difficulty (terrain, grade, exposure) so others can self-select.

## To groom
- Rating dimensions and scale.
- Moderation / spam handling.
- How ratings aggregate and display on a trail.`,
  },

  // ── TRAIL-13: Backlog (hidden status) ─────────────────────────────────────
  {
    id: 'TRAIL-13',
    title: 'Apple Watch companion app',
    status: 'Backlog',
    priority: 'Low',
    effort: 'XL',
    tags: ['feature'],
    history: [
      created('2026-04-28T09:00:00.000Z'),
    ],
    body: `# Apple Watch companion app

Glanceable stats (distance, pace, elevation) and start/stop recording from the wrist. Large effort — parked in the backlog until the core recording loop (TRAIL-1) is solid.`,
  },

  // ── TRAIL-14: Done, big migration ─────────────────────────────────────────
  {
    id: 'TRAIL-14',
    title: 'Migrate map renderer to MapLibre GL',
    status: 'Done',
    priority: 'High',
    effort: 'XL',
    assignee: 'Devin',
    tags: ['feature', 'maps', 'perf'],
    implementationLink: 'https://github.com/trailhead-app/trailhead/pull/97',
    createdBy: 'Devin',
    history: [
      created('2026-04-10T10:00:00.000Z', 'Devin'),
      statusChange('2026-04-12T10:00:00.000Z', 'Grooming', 'Todo'),
      statusChange('2026-04-15T09:00:00.000Z', 'Todo', 'In Progress'),
      statusChange('2026-04-28T15:00:00.000Z', 'In Progress', 'Ready'),
      comment('c-trail14-ready', '2026-04-28T15:01:00.000Z', 'Replaced the legacy raster renderer with MapLibre GL: vector tiles, smoother pan/zoom, and the foundation for the offline-tile work (TRAIL-2).', 'Devin', { summary: 'TRAIL-14 ready: migrated to MapLibre GL vector renderer — smoother pan/zoom, foundation for offline tiles (TRAIL-2).' }),
      statusChange('2026-04-30T12:00:00.000Z', 'Ready', 'Done'),
    ],
    body: `# Migrate map renderer to MapLibre GL

Replaced the legacy raster map with MapLibre GL (vector tiles). Smoother pan/zoom, smaller download sizes, and the groundwork for offline tile caching (TRAIL-2). Shipped in 2.2.`,
  },

  // ── TRAIL-15: Archived ────────────────────────────────────────────────────
  {
    id: 'TRAIL-15',
    title: 'Settings shows "mi" label while using kilometers',
    status: 'Archived',
    priority: 'None',
    effort: 'XS',
    assignee: 'Devin',
    tags: ['bug', 'docs'],
    createdBy: 'Devin',
    history: [
      created('2026-05-25T10:00:00.000Z', 'Devin'),
      comment('c-trail15-note', '2026-05-25T10:05:00.000Z', 'Duplicate of a label fix that already shipped in 2.4 alongside the units refactor. Archiving.', 'Devin', { summary: 'TRAIL-15 archived as a duplicate — the mislabeled-units fix already shipped in 2.4.' }),
      statusChange('2026-05-25T10:06:00.000Z', 'Grooming', 'Archived'),
    ],
    body: `# Settings shows "mi" label while using kilometers

The distance-units row in Settings showed the wrong unit label. Already fixed by the 2.4 units refactor — archived as a duplicate.`,
  },
];

// ── Write ────────────────────────────────────────────────────────────────────

function buildFrontmatter(t: TicketDef): Record<string, unknown> {
  const fm: Record<string, unknown> = {
    id: t.id,
    title: t.title,
    status: t.status,
    priority: t.priority,
    effort: t.effort,
    assignee: t.assignee ?? 'unassigned',
    tags: t.tags,
    createdBy: t.createdBy ?? (t.history.find((h) => h.comment === 'Created ticket.')?.user as string) ?? 'Maya',
    updatedBy: 'Agent',
  };
  if (t.parentId) fm.parentId = t.parentId;
  if (t.subtasks) fm.subtasks = t.subtasks;
  if (t.swimlane) fm.swimlane = t.swimlane;
  if (t.branch) fm.branch = t.branch;
  if (t.implementationLink) fm.implementationLink = t.implementationLink;
  if (t.tokenMetadata) fm.tokenMetadata = t.tokenMetadata;
  fm.history = t.history;
  return fm;
}

function main() {
  const dir = outDir();
  const fluxDir = path.join(dir, '.flux');
  fs.mkdirSync(fluxDir, { recursive: true });

  // config.json
  fs.writeFileSync(path.join(fluxDir, 'config.json'), JSON.stringify(config, null, 2) + '\n', 'utf-8');

  let failures = 0;
  for (const t of tickets) {
    const fm = buildFrontmatter(t);
    const errors = validateTicketFrontmatter(fm);
    if (errors.length > 0) {
      console.error(`\n[seed-demo] ${t.id} FAILED schema validation:\n${formatValidationErrors(errors)}`);
      failures += 1;
      continue;
    }
    const content = matter.stringify(t.body.endsWith('\n') ? t.body : t.body + '\n', fm);
    fs.writeFileSync(path.join(fluxDir, `${t.id}.md`), content, 'utf-8');
  }

  if (failures > 0) {
    console.error(`\n[seed-demo] ${failures} ticket(s) failed validation — aborting.`);
    process.exit(1);
  }

  console.log(`[seed-demo] Wrote ${tickets.length} tickets + config.json to ${fluxDir}`);
}

main();
