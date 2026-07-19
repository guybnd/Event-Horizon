import { Search, Code2, Eye, Flag, Zap, Layers } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { TranscriptMessage } from '../api';

/**
 * FLUX-849 / FLUX-867: short, friendly stage labels for a dispatched session's lifecycle — mirrors
 * the engine's `DISPATCH_LIFECYCLE_LABEL`. The raw enum (`waiting-input` / `cancelled`) is the wrong
 * thing to show a board-watcher; this maps it to `needs input` / `stopped`. Extracted from ChatView
 * (FLUX-867) so the board `DispatchChip` and the Activity screen share one source of truth — the
 * friendly labels can never drift between the two surfaces.
 */
export const DISPATCH_STAGE_LABEL: Record<string, string> = {
  started: 'started',
  working: 'working',
  completed: 'completed',
  failed: 'failed',
  cancelled: 'stopped',
  'waiting-input': 'needs input',
};

/**
 * FLUX-865 / FLUX-867: compact phase labels for a dispatched session (groom / impl / review /
 * finalize). Mirrors the engine's `AgentSession.phase` union; an unknown/absent phase has no label
 * (the caller renders an "unknown" bucket instead of leaking `undefined`). Extracted from ChatView
 * (FLUX-867) so the chip and the Activity screen agree.
 */
export const DISPATCH_PHASE_LABEL: Record<string, string> = {
  grooming: 'groom',
  implementation: 'impl',
  review: 'review',
  finalize: 'final',
  // FLUX-1380: one session grooms + implements a Grooming-column XS/S ticket.
  'fast-path': 'fast-path',
  // FLUX-1383: one session grooms up to 5 sibling tickets sharing one parent.
  'batch-grooming': 'batch-groom',
};

/**
 * FLUX-869 / FLUX-1281: phase → lucide glyph for a dispatched session. Born in ChatView's dispatch
 * chip (a single tooltip'd icon replacing the uppercase phase pill); moved here (FLUX-1281) so the
 * ChatDock's ticket-tab phase iconography and the chip render the same shapes from one source.
 */
export const DISPATCH_PHASE_ICON: Record<NonNullable<TranscriptMessage['phase']>, LucideIcon> = {
  grooming: Search,
  implementation: Code2,
  review: Eye,
  finalize: Flag,
  'fast-path': Zap,
  'batch-grooming': Layers,
};

/** The dispatch lifecycle stages, in lifecycle order — drives the Activity outcome filter. */
export const DISPATCH_LIFECYCLES: Array<NonNullable<TranscriptMessage['lifecycle']>> = [
  'started', 'working', 'completed', 'failed', 'cancelled', 'waiting-input',
];

/** The dispatch phases, in workflow order — drives the Activity phase filter. */
export const DISPATCH_PHASES: Array<NonNullable<TranscriptMessage['phase']>> = [
  'grooming', 'implementation', 'review', 'finalize', 'fast-path', 'batch-grooming',
];
