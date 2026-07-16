/**
 * FLUX-796: typed accessor + helpers for the Electron desktop shell's native bridge.
 *
 * The shell's preload (`electron/preload.js`) exposes `window.electronAPI`. It is ABSENT in the
 * plain browser portal, so every consumer must go through `getElectronAPI()` and optional-chain —
 * the browser build then becomes a clean no-op with no errors.
 */

export interface ElectronAPI {
  /**
   * Set the taskbar "action needed" badge. `count` drives the macOS dock / Linux badge; `iconDataUrl`
   * is a numbered PNG (data URL, drawn by `renderBadgeDataUrl`) used for the Windows overlay-icon
   * path (`app.setBadgeCount` is a no-op on Windows). Pass count 0 / null icon to clear.
   */
  setActionCount: (count: number, iconDataUrl: string | null) => void;
  /** Pop a native OS toast. */
  notify: (opts: { title: string; body?: string; ticketId?: string }) => void;
  /** Subscribe to native-toast clicks; the callback gets the clicked ticket id. Returns an unsubscribe fn. */
  onNotificationClick?: (cb: (ticketId?: string) => void) => (() => void) | void;
  /**
   * Report whether there are unsaved doc changes, so main can guard window-close / quit with a
   * native confirm dialog (`beforeunload` is silently cancelled with no dialog in Electron).
   */
  setUnsavedGuard?: (isDirty: boolean) => void;
}

declare global {
  interface Window {
    electronAPI?: ElectronAPI;
  }
}

/** The Electron native bridge, or `undefined` in the plain browser portal. */
export function getElectronAPI(): ElectronAPI | undefined {
  return typeof window !== 'undefined' ? window.electronAPI : undefined;
}

/**
 * Draw a small circular "N" badge to an offscreen canvas and return a PNG data URL — or `null` when
 * there's nothing to show (count <= 0) so the caller clears the badge. The canvas lives in the
 * renderer (only it has a DOM); the Electron main process turns the data URL into a nativeImage for
 * the Windows taskbar overlay icon.
 */
export function renderBadgeDataUrl(count: number): string | null {
  if (count <= 0 || typeof document === 'undefined') return null;
  const size = 32;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;

  const label = count > 99 ? '99+' : String(count);

  // Red disc.
  ctx.fillStyle = '#e5484d';
  ctx.beginPath();
  ctx.arc(size / 2, size / 2, size / 2, 0, Math.PI * 2);
  ctx.fill();

  // White number — shrink the font for wider labels so it stays inside the disc.
  ctx.fillStyle = '#ffffff';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const fontSize = label.length >= 3 ? 13 : label.length === 2 ? 17 : 21;
  ctx.font = `bold ${fontSize}px -apple-system, "Segoe UI", system-ui, sans-serif`;
  ctx.fillText(label, size / 2, size / 2 + 1);

  return canvas.toDataURL('image/png');
}
