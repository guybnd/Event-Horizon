/**
 * Shared `Intl.DateTimeFormat` for the terminal panel's Engine-events and Operations logs
 * (FLUX-1139). Constructing a formatter is the expensive part of `toLocaleTimeString` — hoisting
 * one instance to module scope and reusing it per row (instead of building one per row per
 * render) is what makes a new SSE tick cheap to render.
 */
const formatter = new Intl.DateTimeFormat([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

export function formatClockTime(ms: number): string {
  return formatter.format(ms);
}
