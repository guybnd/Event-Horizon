// Shared Furnace duration formatter (FLUX-1039) — used by both FurnaceDrawer's burning-batch stats
// row and FurnaceReportModal's terminal-batch report. Lives outside FurnaceDrawer.tsx because a
// component file may only export components (react-refresh/only-export-components).
export function fmtDuration(from?: string, to?: string): string | null {
  if (!from) return null;
  const start = Date.parse(from);
  const end = to ? Date.parse(to) : Date.now();
  if (Number.isNaN(start) || Number.isNaN(end) || end < start) return null;
  const mins = Math.round((end - start) / 60000);
  if (mins < 60) return `${mins}m`;
  return `${Math.floor(mins / 60)}h ${mins % 60}m`;
}
