/**
 * Extensions rendered as looping muted video. Sniffing is extension-driven (NOT MIME)
 * because at render time only a URL string exists; the upload allowlist guarantees the
 * extension on disk is trustworthy.
 */
export const VIDEO_EXTS = new Set(['.mp4', '.webm', '.mov']);

/**
 * One-shot prefers-reduced-motion read (no matchMedia listener — onboarding renders
 * once). The single implementation; callers import this rather than keeping a local copy.
 */
export function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}
