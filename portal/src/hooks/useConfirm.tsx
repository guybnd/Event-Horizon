// FLUX-1459: generic promise-based replacement for native window.confirm()/alert(), generalizing
// the FLUX-815 FinishMergeConfirm chrome (fixed inset-0 z-[9999] backdrop-blur-sm card) into a
// single shared dialog any component can drive via `const ok = await confirm({ title, body })`.
// Mount ConfirmProvider once near the app root; it renders at most one dialog at a time, so a
// second confirm() call while one is open queues behind the first's resolution.
import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from 'react';
import { AlertTriangle } from 'lucide-react';
import { useEscapeKey } from './useEscapeKey';

export type ConfirmTone = 'default' | 'danger';

export interface ConfirmOptions {
  title: string;
  body?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: ConfirmTone;
}

type ConfirmFn = (opts: ConfirmOptions) => Promise<boolean>;

type ConfirmRequest = ConfirmOptions & { resolve: (result: boolean) => void };

const ConfirmContext = createContext<ConfirmFn | null>(null);

// eslint-disable-next-line react-refresh/only-export-components -- canonical context hook, colocated with its provider.
export function useConfirm(): ConfirmFn {
  const ctx = useContext(ConfirmContext);
  if (!ctx) throw new Error('useConfirm must be used within a ConfirmProvider');
  return ctx;
}

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [request, setRequest] = useState<ConfirmRequest | null>(null);
  // Read through a ref in `settle` so it always resolves the request that's actually on screen,
  // not a stale one captured by an earlier render's closure.
  const requestRef = useRef<ConfirmRequest | null>(null);
  requestRef.current = request;

  const confirm = useCallback<ConfirmFn>((opts) => {
    return new Promise<boolean>((resolve) => {
      setRequest({ ...opts, resolve });
    });
  }, []);

  const settle = useCallback((result: boolean) => {
    const current = requestRef.current;
    if (!current) return;
    setRequest(null);
    current.resolve(result);
  }, []);

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      {request && <ConfirmDialog request={request} onSettle={settle} />}
    </ConfirmContext.Provider>
  );
}

function ConfirmDialog({ request, onSettle }: { request: ConfirmRequest; onSettle: (result: boolean) => void }) {
  const dismiss = () => onSettle(false);
  useEscapeKey(dismiss);
  const tone = request.tone ?? 'default';
  const confirmClasses = tone === 'danger' ? 'bg-red-500 hover:bg-red-600' : 'bg-primary hover:bg-primary-hover';

  return (
    <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/40 backdrop-blur-sm" onClick={dismiss}>
      <div
        role="dialog"
        aria-modal="true"
        className="w-96 rounded-xl border border-gray-200 bg-white p-5 shadow-2xl dark:border-white/10 dark:bg-[#1a1b23]"
        onClick={(e) => e.stopPropagation()}
      >
        <p className="mb-1 flex items-center gap-1.5 text-sm font-semibold text-gray-900 dark:text-white">
          {tone === 'danger' && <AlertTriangle className="h-4 w-4 shrink-0 text-red-500" />}
          {request.title}
        </p>
        {request.body && <div className="mb-4 text-xs text-gray-500 dark:text-gray-400">{request.body}</div>}
        <div className="flex justify-end gap-2">
          <button
            onClick={dismiss}
            className="rounded-md px-3 py-1.5 text-xs font-medium text-gray-500 hover:text-gray-700 disabled:opacity-50 dark:text-gray-400 dark:hover:text-gray-200"
          >
            {request.cancelLabel ?? 'Cancel'}
          </button>
          <button
            onClick={() => onSettle(true)}
            className={`rounded-md px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-50 ${confirmClasses}`}
          >
            {request.confirmLabel ?? 'Confirm'}
          </button>
        </div>
      </div>
    </div>
  );
}
