// FLUX-1459: shared toast primitive replacing native alert() at pure-notification call sites.
// Generalizes the local `showToast` closure in components/Settings.tsx (pill shape, emerald/red
// tones, 3s auto-dismiss) into an app-wide stack that supports more than one visible toast and an
// `info` tone. Mount ToastProvider once near the app root; call sites use `useNotify()`.
import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react';
import { Check, AlertTriangle, Info, X } from 'lucide-react';

export type ToastKind = 'success' | 'error' | 'info';

interface ToastEntry {
  id: number;
  kind: ToastKind;
  message: string;
}

export interface NotifyApi {
  success: (message: string) => void;
  error: (message: string) => void;
  info: (message: string) => void;
}

const TOAST_DURATION_MS = 3000;

const TONE_CLASSES: Record<ToastKind, string> = {
  success: 'bg-emerald-600 text-white',
  error: 'bg-red-600 text-white',
  info: 'bg-gray-700 text-white',
};

const NotifyContext = createContext<NotifyApi | null>(null);

// eslint-disable-next-line react-refresh/only-export-components -- canonical context hook, colocated with its provider.
export function useNotify(): NotifyApi {
  const ctx = useContext(NotifyContext);
  if (!ctx) throw new Error('useNotify must be used within a ToastProvider');
  return ctx;
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastEntry[]>([]);
  const nextId = useRef(0);
  const timers = useRef(new Map<number, number>());

  const dismiss = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
    const timer = timers.current.get(id);
    if (timer !== undefined) {
      window.clearTimeout(timer);
      timers.current.delete(id);
    }
  }, []);

  const notify = useCallback((kind: ToastKind, message: string) => {
    const id = nextId.current++;
    setToasts((prev) => [...prev, { id, kind, message }]);
    timers.current.set(id, window.setTimeout(() => dismiss(id), TOAST_DURATION_MS));
  }, [dismiss]);

  const api = useMemo<NotifyApi>(() => ({
    success: (message) => notify('success', message),
    error: (message) => notify('error', message),
    info: (message) => notify('info', message),
  }), [notify]);

  return (
    <NotifyContext.Provider value={api}>
      {children}
      <div className="pointer-events-none fixed bottom-6 right-6 z-[9999] flex flex-col items-end gap-2">
        {toasts.map((t) => (
          <div
            key={t.id}
            className={`pointer-events-auto flex items-center gap-2 rounded-full px-4 py-2 text-sm font-medium shadow-lg ${TONE_CLASSES[t.kind]}`}
          >
            {t.kind === 'success' && <Check className="h-4 w-4 shrink-0" />}
            {t.kind === 'error' && <AlertTriangle className="h-4 w-4 shrink-0" />}
            {t.kind === 'info' && <Info className="h-4 w-4 shrink-0" />}
            <span>{t.message}</span>
            <button
              onClick={() => dismiss(t.id)}
              aria-label="Dismiss"
              className="ml-1 rounded-full p-0.5 opacity-80 hover:opacity-100"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        ))}
      </div>
    </NotifyContext.Provider>
  );
}
