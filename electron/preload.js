'use strict';
// Preload runs with contextIsolation. We load our OWN trusted localhost app, so this is the
// safe seam that hands the portal a small, explicit native surface — nothing more than the
// taskbar "action needed" badge + native OS toasts (FLUX-796). The browser portal never sees
// `window.electronAPI`, so every call site there optional-chains through it.

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  /**
   * Set the taskbar "action needed" badge. `count` drives the macOS dock / Linux badge via
   * app.setBadgeCount; `iconDataUrl` is a renderer-drawn numbered PNG (data URL) that the main
   * process turns into a nativeImage for the Windows taskbar overlay icon (setBadgeCount is a
   * no-op on Windows). Pass count 0 / null icon to clear.
   */
  setActionCount(count, iconDataUrl) {
    ipcRenderer.send('eh:set-action-count', { count, iconDataUrl: iconDataUrl ?? null });
  },
  /** Pop a native OS toast for an action-required / completion notification. */
  notify(payload) {
    ipcRenderer.send('eh:notify', payload);
  },
  /**
   * Subscribe to native-toast clicks (the user clicked a toast → focus + navigate to its ticket).
   * Returns an unsubscribe function.
   */
  onNotificationClick(cb) {
    const listener = (_e, ticketId) => cb(ticketId);
    ipcRenderer.on('eh:notification-click', listener);
    return () => ipcRenderer.removeListener('eh:notification-click', listener);
  },
});
