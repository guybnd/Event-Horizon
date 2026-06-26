import { useEffect, useState } from 'react';
import type { Notification } from '../api';
import { notificationCategory } from '../components/notificationCategory';

/**
 * FLUX-726: which notification categories the user wants surfaced in the panel + counter.
 *
 * A pure client/browser concern (like desktop notifications + theme), so it lives in
 * `localStorage` with a module-level store + cross-tab sync — mirroring `useDesktopNotifications`
 * exactly — rather than the server-side board config. No engine schema, no migration.
 *
 * Only **Updates** (completion / info) are mutable. **Action-needed** (prompt / error) can never
 * be hidden — muting Require Input / errors would reintroduce the "missed on the board" failure
 * mode (FLUX-570 / FLUX-651).
 */

const STORAGE_KEY = 'eh-notification-prefs';

export interface NotificationPrefs {
  /** Show `completion` updates (a ticket finished). */
  showCompletion: boolean;
  /** Show `info` updates (e.g. an app update is available). */
  showInfo: boolean;
}

const DEFAULTS: NotificationPrefs = { showCompletion: true, showInfo: true };

function readPrefs(): NotificationPrefs {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULTS };
    const parsed = JSON.parse(raw) as Partial<NotificationPrefs>;
    // Default-on: only an explicit `false` hides a category.
    return { showCompletion: parsed.showCompletion !== false, showInfo: parsed.showInfo !== false };
  } catch {
    return { ...DEFAULTS };
  }
}

let prefsValue: NotificationPrefs = typeof window !== 'undefined' ? readPrefs() : { ...DEFAULTS };
const listeners = new Set<() => void>();

function emit() {
  listeners.forEach((l) => l());
}

function writePrefs(next: NotificationPrefs) {
  prefsValue = next;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    /* storage unavailable (private mode) — in-memory value still drives this session */
  }
  emit();
}

/**
 * Pure predicate: should this notification appear given the prefs? Action-needed is ALWAYS
 * visible (cannot be muted); only Update types are filterable.
 */
export function isNotificationVisible(n: Pick<Notification, 'type'>, prefs: NotificationPrefs): boolean {
  if (notificationCategory(n.type) === 'action') return true;
  if (n.type === 'completion') return prefs.showCompletion;
  if (n.type === 'info') return prefs.showInfo;
  return true;
}

export interface NotificationPrefsControls {
  prefs: NotificationPrefs;
  setShowCompletion: (v: boolean) => void;
  setShowInfo: (v: boolean) => void;
}

export function useNotificationPrefs(): NotificationPrefsControls {
  const [prefs, setPrefs] = useState(prefsValue);

  // Subscribe to the module-level store so the panel, counter, and Settings card stay in sync.
  useEffect(() => {
    const l = () => setPrefs(prefsValue);
    listeners.add(l);
    return () => {
      listeners.delete(l);
    };
  }, []);

  // Cross-tab sync.
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === STORAGE_KEY) {
        prefsValue = readPrefs();
        emit();
      }
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  return {
    prefs,
    setShowCompletion: (v) => writePrefs({ ...prefsValue, showCompletion: v }),
    setShowInfo: (v) => writePrefs({ ...prefsValue, showInfo: v }),
  };
}
