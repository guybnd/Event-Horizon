import { useCallback, useEffect, useState } from 'react';

/**
 * FLUX-695: desktop (OS) notifications when a turn finishes in an unfocused chat.
 *
 * The setting is a pure client/browser concern — browser Notification permission is per-origin
 * and the OS surface is local — so it lives in `localStorage` (like the theme + dock state),
 * not the server-side board config. A module-level store mirrors the persisted value so the
 * Settings toggle and the ChatDock observe the same `enabled` flag without prop-threading.
 *
 * Firing is gated on the user setting + browser permission; *visibility/focus* gating is the
 * caller's job (only the dock knows whether the chat that finished is actually unattended).
 */

const STORAGE_KEY = 'eh-desktop-notifications';

declare global {
  interface Window {
    /**
     * FLUX-695: optional extension-host notification bridge. When the portal runs inside the
     * VS Code extension webview, the host may inject this function to route turn-complete
     * notifications through the native VS Code notification surface instead of the web
     * `Notification` API (which is unavailable / awkward inside a webview). When present it is
     * preferred over the web API and is assumed to need no separate permission grant.
     */
    __ehNativeNotify?: (opts: { title: string; body?: string; tag?: string }) => void;
  }
}

function readEnabled(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

// In-memory mirror of the persisted flag + the set of hook instances to notify on change.
let enabledValue = typeof window !== 'undefined' ? readEnabled() : false;
const listeners = new Set<() => void>();

function emit() {
  listeners.forEach((l) => l());
}

function setEnabledValue(v: boolean) {
  enabledValue = v;
  try {
    localStorage.setItem(STORAGE_KEY, v ? '1' : '0');
  } catch {
    /* storage unavailable (private mode) — in-memory value still drives this session */
  }
  emit();
}

/** True when an extension-native notification bridge is available (preferred path). */
export function nativeNotifyAvailable(): boolean {
  return typeof window !== 'undefined' && typeof window.__ehNativeNotify === 'function';
}

/**
 * Fire a desktop notification, respecting the user setting + permission + native bridge.
 * Returns true when a notification was dispatched. The caller owns the visibility/focus gate
 * (this only knows the global enable flag, not which chat is attended). The native bridge is
 * preferred; otherwise it falls back to the web `Notification` API when permission is granted.
 */
export function fireDesktopNotification(opts: { title: string; body?: string; tag?: string }): boolean {
  if (!enabledValue) return false;
  if (nativeNotifyAvailable()) {
    try {
      window.__ehNativeNotify!(opts);
      return true;
    } catch {
      /* fall through to the web API */
    }
  }
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return false;
  try {
    // `tag` collapses repeated notifications for the same chat into one (no stacking spam).
    new Notification(opts.title, { body: opts.body, tag: opts.tag });
    return true;
  } catch {
    return false;
  }
}

export interface DesktopNotificationsControls {
  /** User setting is on (and, for the web path, permission was granted). */
  enabled: boolean;
  /** Current browser permission ('default' | 'granted' | 'denied'). */
  permission: NotificationPermission;
  /** Web Notification API is present in this environment. */
  supported: boolean;
  /** An extension-native bridge is available (preferred over the web API). */
  native: boolean;
  /** Turn notifications on — requests browser permission first when needed. Resolves true on success. */
  enable: () => Promise<boolean>;
  /** Turn notifications off. */
  disable: () => void;
}

export function useDesktopNotifications(): DesktopNotificationsControls {
  const [enabled, setEnabled] = useState(enabledValue);
  const [permission, setPermission] = useState<NotificationPermission>(
    typeof Notification !== 'undefined' ? Notification.permission : 'denied',
  );

  // Subscribe to the module-level store so every instance (Settings + dock) stays in sync.
  useEffect(() => {
    const l = () => setEnabled(enabledValue);
    listeners.add(l);
    return () => {
      listeners.delete(l);
    };
  }, []);

  // Cross-tab sync: a toggle in one tab updates the others.
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === STORAGE_KEY) {
        enabledValue = readEnabled();
        emit();
      }
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  const enable = useCallback(async () => {
    // Native bridge needs no web permission grant.
    if (nativeNotifyAvailable()) {
      setEnabledValue(true);
      return true;
    }
    if (typeof Notification === 'undefined') return false;
    let perm = Notification.permission;
    if (perm === 'default') {
      try {
        perm = await Notification.requestPermission();
      } catch {
        perm = Notification.permission;
      }
    }
    setPermission(perm);
    if (perm === 'granted') {
      setEnabledValue(true);
      return true;
    }
    // Permission denied/blocked — keep the setting off so the toggle reflects reality.
    setEnabledValue(false);
    return false;
  }, []);

  const disable = useCallback(() => setEnabledValue(false), []);

  return {
    enabled,
    permission,
    supported: typeof Notification !== 'undefined',
    native: nativeNotifyAvailable(),
    enable,
    disable,
  };
}
