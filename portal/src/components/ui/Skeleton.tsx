import type { CSSProperties, ReactNode } from 'react';
import { useMotionTokens } from '../../motion/tokens';

export type SkeletonVariant = 'bar' | 'avatar' | 'card';

interface SkeletonProps {
  /** bar: a rounded rectangle (text line / block, the default). avatar: a rounded-full dot/circle.
   *  card: a bordered frame with no fill — compose bars/avatars inside it for a ghost tile. */
  variant?: SkeletonVariant;
  className?: string;
  style?: CSSProperties;
  /** Only meaningful for `variant="card"` — the bars/avatars composed inside the frame. */
  children?: ReactNode;
}

/**
 * FLUX-1506: the one shared skeleton primitive every cold-load surface composes from — extracted
 * from the two ad-hoc `animate-pulse` patterns that existed before this ticket (TaskModalPopupView's
 * content bars, ActivityPanel's row list) rather than written parallel to them. `instant` (OS
 * prefers-reduced-motion or the user's `animationsEnabled=false`) degrades the shimmer to a flat
 * static placeholder, matching the contract every other animation in the portal already follows
 * (see `useMotionTokens`) instead of re-deriving its own reduced-motion check.
 */
export function Skeleton({ variant = 'bar', className = '', style, children }: SkeletonProps) {
  const { instant } = useMotionTokens();
  const shape = variant === 'avatar' ? 'rounded-full' : 'rounded';
  const isCard = variant === 'card';
  // The card frame is a static border, not a filled shape — only bar/avatar fills pulse; a pulsing
  // border around already-pulsing children inside it would double up the shimmer.
  const fill = isCard ? 'border border-gray-200 dark:border-white/10' : 'bg-gray-200 dark:bg-white/10';
  const pulse = !isCard && !instant ? 'animate-pulse' : '';
  return (
    <div aria-hidden className={`${pulse} ${shape} ${fill} ${className}`.trim()} style={style}>
      {children}
    </div>
  );
}

const LINE_WIDTHS = ['w-1/3', 'w-2/3', 'w-1/2', 'w-3/4', 'w-2/5', 'w-3/5'];

/** A stack of `count` skeleton text lines with varying widths for a natural ragged edge — the
 *  TaskModalPopupView content-column shape. */
export function SkeletonLines({ count = 4, className = '' }: { count?: number; className?: string }) {
  return (
    <div className={`flex flex-col gap-4 ${className}`.trim()} aria-busy="true" aria-label="Loading">
      {Array.from({ length: count }).map((_, i) => (
        <Skeleton key={i} variant="bar" className={`h-4 ${LINE_WIDTHS[i % LINE_WIDTHS.length]}`} />
      ))}
    </div>
  );
}

/** A leading dot + two stacked bars — the ActivityPanel list-row shape. Reusable anywhere a "list of
 *  things with a marker and a couple lines" cold-loads (backlog rows, chat message rows). */
export function SkeletonRow({ className = '' }: { className?: string }) {
  return (
    <div className={`flex min-w-0 items-start gap-3 ${className}`.trim()}>
      <Skeleton variant="avatar" className="mt-1.5 h-2 w-2 flex-none" />
      <div className="min-w-0 flex-1">
        <Skeleton variant="bar" className="h-4 w-2/3" />
        <Skeleton variant="bar" className="mt-1.5 h-3 w-1/3" />
      </div>
    </div>
  );
}

/** A ghost board card — a bordered tile the size/shape of a real `TaskCard` (title bar + two body
 *  lines + a footer chip), for the board's cold-load ghost columns. */
export function SkeletonCard({ className = '' }: { className?: string }) {
  return (
    <Skeleton variant="card" className={`flex flex-col gap-2.5 p-3.5 ${className}`.trim()}>
      <Skeleton variant="bar" className="h-3.5 w-4/5" />
      <Skeleton variant="bar" className="h-3 w-full" />
      <Skeleton variant="bar" className="h-3 w-3/5" />
      <Skeleton variant="bar" className="mt-1 h-4 w-1/4" />
    </Skeleton>
  );
}
