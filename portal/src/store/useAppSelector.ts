import { createContext, useContext } from 'react';
import { useSyncExternalStoreWithSelector } from 'use-sync-external-store/shim/with-selector';
import type { Task } from '../types';
import { appStore } from './appStore';
import type { AppActions, AppStoreState } from './appStore';

/**
 * Subscribe to a slice of the app store. The component re-renders only when the
 * selected value changes (per `isEqual`, default `Object.is`). Built on the
 * official `useSyncExternalStoreWithSelector` shim — memoizes the selection so
 * top-level snapshot churn doesn't cause spurious re-renders or tearing
 * (FLUX-625).
 */
export function useAppSelector<Selection>(
  selector: (state: AppStoreState) => Selection,
  isEqual?: (a: Selection, b: Selection) => boolean,
): Selection {
  return useSyncExternalStoreWithSelector(
    appStore.subscribe,
    appStore.getState,
    appStore.getState,
    selector,
    isEqual,
  );
}

/** Shallow-equality for object/array-returning selectors. Pass as the second
 *  arg to `useAppSelector` when a selector builds a new object/array each call. */
export function shallowEqual<T>(a: T, b: T): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== 'object' || a === null || typeof b !== 'object' || b === null) {
    return false;
  }
  const aKeys = Object.keys(a as object);
  const bKeys = Object.keys(b as object);
  if (aKeys.length !== bKeys.length) return false;
  for (const key of aKeys) {
    if (!Object.is((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key])) {
      return false;
    }
  }
  return true;
}

// ---- Slice hooks ---------------------------------------------------------

/** Select a single task by id. Re-renders only when that task's reference changes. */
export function useTaskById(id: string | undefined): Task | undefined {
  return useAppSelector((s) => (id ? s.taskById.get(id) : undefined));
}

export function useConfig() {
  return useAppSelector((s) => s.config);
}

/** Select a task's live session slice (currentActivity/liveOutput/status/progress). */
export function useLiveSession(id: string | undefined) {
  return useAppSelector((s) => (id ? s.liveSessions[id] : undefined));
}

/** Select a task's Furnace batch-ticket state (FLUX-1503), if it belongs to a known batch. */
export function useFurnaceTicket(id: string | undefined) {
  return useAppSelector((s) => (id ? s.furnaceTicketById[id] : undefined));
}

/** Every task id → its first epic parent (FLUX-1553) — the store-level `resolveParentByChildId`
 *  map, shared by every card instead of each recomputing it per render. */
export function useParentByChildId(): Map<string, Task> {
  return useAppSelector((s) => s.parentByChildId);
}

/** Select a task's owning Furnace batch identity (FLUX-1539) — id/icon/title, for the card's
 *  batch badge + border tint. */
export function useFurnaceBatchMeta(id: string | undefined) {
  return useAppSelector((s) => (id ? s.furnaceBatchMetaByTicketId[id] : undefined));
}

// ---- Actions -------------------------------------------------------------

/** Provided once by AppProvider with a stable (frozen) handler set. */
export const AppActionsContext = createContext<AppActions | undefined>(undefined);

/** The stable app action set. Never changes identity, so action-only consumers
 *  never re-render on data updates. */
export function useAppActions(): AppActions {
  const ctx = useContext(AppActionsContext);
  if (!ctx) throw new Error('useAppActions must be used within AppProvider');
  return ctx;
}
