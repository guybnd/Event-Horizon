import { startTransition, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { ColumnLiveEvent, Config, Task, TaskLiveEvent } from './types';
import { fetchConfig, fetchTasks, fetchWorktrees, fetchHealth, saveConfig as apiSaveConfig, fetchReadState, saveReadState, fetchWorkspace, fetchParseErrors, fetchNotifications, fetchWorkspaces, switchWorkspace as apiSwitchWorkspace, type ParseError, type Notification, type WorkspaceInfo, type WorktreeInfo } from './api';
import { getArchiveStatus } from './workflow';
import { collectPrMemberIds } from './lib/decks';
import { tasksEqual } from './lib/tasksEqual';
import { appStore, ENGINE_EVENTS_MAX } from './store/appStore';
import { appendEngineEvents } from './lib/coalesceEngineEvents';
import type { AppStoreState, AppActions, AppView, AppTheme, TaskSortOption, OperationFailure, EngineEvent } from './store/appStore';
import { AppActionsContext } from './store/useAppSelector';
import { getElectronAPI, renderBadgeDataUrl } from './electronApi';
import { incr, recordDuration, recordSseEvent } from './perfClient';
import { useConfirm } from './hooks/useConfirm';

export type { AppView, TaskSortOption, AppTheme };

export interface ThemeDef {
  name: AppTheme;
  label: string;
  baseMode: 'light' | 'dark';
}

// eslint-disable-next-line react-refresh/only-export-components -- theme table colocated with the app context that owns it; consumed as data, not a component.
export const THEMES: ThemeDef[] = [
  { name: 'light', label: 'Light', baseMode: 'light' },
  { name: 'dark', label: 'Dark', baseMode: 'dark' },
  { name: 'matrix', label: 'Matrix', baseMode: 'dark' },
  { name: 'cyber', label: 'Cyber', baseMode: 'dark' },
  { name: 'midnight', label: 'Midnight', baseMode: 'dark' },
];

const VALID_THEMES = new Set<string>(THEMES.map(t => t.name));

function getInitialTheme(): AppTheme {
  const stored = localStorage.getItem('eh-theme');
  if (stored && VALID_THEMES.has(stored)) return stored as AppTheme;
  return 'matrix';
}

function applyTheme(theme: AppTheme) {
  const def = THEMES.find(t => t.name === theme)!;
  document.documentElement.classList.toggle('dark', def.baseMode === 'dark');
  document.documentElement.setAttribute('data-theme', theme);
}

const VIEW_PATHS: Record<AppView, string> = {
  board: '/board',
  backlog: '/backlog',
  changes: '/changes',
  docs: '/docs',
  settings: '/settings',
  releases: '/releases',
  workflows: '/workflows',
  epics: '/epics',
  'dev-onboarding': '/dev/onboarding',
};

const LIVE_TASK_POLL_INTERVAL_MS = 3000;
const LIVE_EVENT_DURATION_MS = 2200;
/** FLUX-1300: how long a freshly-created ticket sorts first in its column (client-side "top-pin"),
 *  regardless of the board's configured sort option, before settling into its normal position. */
const NEW_TASK_PIN_DURATION_MS = 15_000;
/** FLUX-1189: how long the board can sit untouched before the purely-ambient CSS loops
 *  (`.eh-idle` in index.css) pause. Long enough that normal reading/thinking pauses don't
 *  flicker the effect off and on. */
const USER_IDLE_AFTER_MS = 20_000;

function normalizeTaskList(tasks: Task[]) {
  return [...tasks].sort((left, right) => left.id.localeCompare(right.id));
}

function removeKey<TValue>(record: Record<string, TValue>, key: string) {
  const next = { ...record };
  delete next[key];
  return next;
}

function getViewFromLocation(): AppView {
  const path = window.location.pathname.toLowerCase();
  if (path === '/backlog') return 'backlog';
  if (path === '/changes') return 'changes';
  if (path === '/docs') return 'docs';
  if (path === '/settings') return 'settings';
  if (path === '/releases') return 'releases';
  if (path === '/workflows') return 'workflows';
  if (path === '/epics') return 'epics';
  // Dev-only editor route (FLUX-755). Gated by import.meta.env.DEV so that in a
  // production build a hand-typed /dev/onboarding falls through to the board.
  if (import.meta.env.DEV && path === '/dev/onboarding') return 'dev-onboarding';
  return 'board';
}

function updateViewUrl(view: AppView, mode: 'push' | 'replace') {
  const url = new URL(window.location.href);
  url.pathname = VIEW_PATHS[view];
  window.history[mode === 'push' ? 'pushState' : 'replaceState']({}, '', url);
}

function getTaskFiltersFromLocation() {
  const params = new URLSearchParams(window.location.search);
  return {
    searchQuery: params.get('search') || '',
    sortOption: (params.get('sort') as TaskSortOption) || 'default',
    filterAssignee: params.get('assignee') || 'all',
    filterPriority: params.get('priority') || 'all',
    filterTag: params.get('tag') || 'all',
    filterUnreadOnly: params.get('unread') === '1',
    // '' = off, 'any' = any worktree, '<branch>' = isolate to that one worktree.
    filterWorktree: params.get('worktree') || '',
  };
}

function updateTaskFilterUrl(filters: {
  searchQuery: string;
  sortOption: TaskSortOption;
  filterAssignee: string;
  filterPriority: string;
  filterTag: string;
  filterUnreadOnly: boolean;
  filterWorktree: string;
}) {
  const url = new URL(window.location.href);
  const entries: Array<[string, string, string]> = [
    ['search', filters.searchQuery, ''],
    ['sort', filters.sortOption, 'default'],
    ['assignee', filters.filterAssignee, 'all'],
    ['priority', filters.filterPriority, 'all'],
    ['tag', filters.filterTag, 'all'],
    ['unread', filters.filterUnreadOnly ? '1' : '', ''],
    ['worktree', filters.filterWorktree, ''],
  ];

  entries.forEach(([key, value, fallback]) => {
    if (!value || value === fallback) {
      url.searchParams.delete(key);
    } else {
      url.searchParams.set(key, value);
    }
  });

  window.history.replaceState({}, '', url);
}

/**
 * Public contract of `useApp()` — the union of the data store and the stable
 * action set. Defined as an intersection so it can never drift from the store
 * shape (FLUX-625). Subscribe-narrowly via `useAppSelector`/`useAppActions`
 * instead of `useApp()` to avoid re-rendering on unrelated changes.
 */
export type AppState = AppStoreState & AppActions;

// Keep the selected project key in sync with the active workspace's config.
// If the previous selection is still valid for this workspace, keep it;
// otherwise adopt the workspace's first project. This prevents a stale key
// (e.g. from a previously open workspace) leaking into new tickets.
function reconcileProject(prev: string, projects: string[] | undefined): string {
  const list = projects ?? [];
  if (prev && list.includes(prev)) return prev;
  return list[0] || 'PROJECT';
}

// FLUX-785: the active identity used to default to the literal 'Guy' (the maintainer) and was
// never reconciled or persisted — so every new user's tickets were attributed updatedBy:'Guy'.
// Persist an explicit choice in localStorage; otherwise adopt the first non-Agent config user;
// otherwise a neutral 'You'. Mirrors reconcileProject.
const CURRENT_USER_KEY = 'eh-current-user';
function getInitialUser(): string {
  try { return localStorage.getItem(CURRENT_USER_KEY) || ''; } catch { return ''; }
}
function reconcileUser(prev: string, users: unknown[] | undefined): string {
  if (prev && prev.trim()) return prev; // an explicit/persisted choice always wins
  const names = (users ?? [])
    .map((u) => (typeof u === 'string' ? u : (u as { name?: string } | null)?.name))
    .filter((n): n is string => !!n && !!n.trim());
  return names.find((n) => n.toLowerCase() !== 'agent') || names[0] || 'You';
}

export function AppProvider({ children }: { children: ReactNode }) {
  const confirm = useConfirm();
  const initialFilters = getTaskFiltersFromLocation();
  const [currentUser, setCurrentUser] = useState(getInitialUser);
  const [currentProject, setCurrentProject] = useState('');
  const [searchQuery, setSearchQuery] = useState(initialFilters.searchQuery);
  const [sortOption, setSortOption] = useState<TaskSortOption>(initialFilters.sortOption);
  const [filterAssignee, setFilterAssignee] = useState(initialFilters.filterAssignee);
  const [filterPriority, setFilterPriority] = useState(initialFilters.filterPriority);
  const [filterTag, setFilterTag] = useState(initialFilters.filterTag);
  const [filterUnreadOnly, setFilterUnreadOnly] = useState(initialFilters.filterUnreadOnly);
  const [filterWorktree, setFilterWorktree] = useState(initialFilters.filterWorktree);
  const [view, setCurrentView] = useState<AppView>(() => getViewFromLocation());
  const [settingsTab, setSettingsTab] = useState<string | null>(null);
  const [modalTask, setModalTask] = useState<Partial<Task> | null>(null);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [overlayCount, setOverlayCount] = useState(0);
  const pushOverlay = useCallback(() => setOverlayCount((n) => n + 1), []);
  const popOverlay = useCallback(() => setOverlayCount((n) => Math.max(0, n - 1)), []);
  const [openModalScrollToComments, setOpenModalScrollToComments] = useState(false);
  const [openModalInFullView, setOpenModalInFullView] = useState(false);
  const [tasks, setTasks] = useState<Task[]>([]);
  // Branches that currently hold a worktree — refreshed whenever tasks change
  // (a worktree create/detach broadcasts taskUpdated → loadTasks → this) (FLUX-516).
  const [worktreeBranches, setWorktreeBranches] = useState<Set<string>>(new Set());
  // Full worktree list (path, branch, ticket, changedFiles count) — drives the
  // card change-count badge and the worktrees panel; the Set is its branch index.
  const [worktrees, setWorktrees] = useState<WorktreeInfo[]>([]);
  const refreshWorktrees = useCallback(() => {
    fetchWorktrees()
      .then((ws) => {
        setWorktrees(ws);
        setWorktreeBranches(new Set(ws.map((w) => w.branch)));
      })
      .catch(() => {});
  }, []);
  // FLUX-627: refetch worktrees only when the SET of task branches actually changes
  // (a worktree create/detach, or a newly branched ticket) — NOT on every `tasks`
  // identity churn from an SSE activity/progress tick, which used to storm
  // /api/worktrees during a live session. Explicit refreshWorktrees() (e.g. after a
  // detach) still fires immediately via the exposed action.
  const branchSignature = useMemo(
    () => Array.from(new Set(tasks.map((t) => t.branch).filter((b): b is string => !!b))).sort().join('|'),
    [tasks],
  );
  useEffect(() => { refreshWorktrees(); }, [branchSignature, refreshWorktrees]);
  // Pending focus (a branch) for the Changes view when navigated from a board click-through.
  const [changesFocus, setChangesFocus] = useState<string | null>(null);
  const taskById = useMemo(() => {
    const map = new Map<string, Task>();
    for (const t of tasks) map.set(t.id, t);
    return map;
  }, [tasks]);
  // branch → PR ticket id (FLUX-567). A rendered normal ticket whose branch is in this map
  // is a "pile" ticket linked to that PR (members fold into the deck and aren't rendered),
  // so it gets a `→ PR-n` marker on its card.
  const prByBranch = useMemo(() => {
    const map = new Map<string, string>();
    for (const t of tasks) if (t.kind === 'pr' && t.branch) map.set(t.branch, t.id);
    return map;
  }, [tasks]);
  // Ids folded into a PR deck (FLUX-580). Computed once here so the epic card can apply
  // PR precedence (a PR-folded subtask is never also epic-folded) without each card
  // re-scanning every PR ticket's members.
  const prMemberIds = useMemo(() => collectPrMemberIds(tasks), [tasks]);
  const [tasksLoading, setTasksLoading] = useState(true);
  const [taskLiveEvents, setTaskLiveEvents] = useState<Record<string, TaskLiveEvent>>({});
  const [columnLiveEvents, setColumnLiveEvents] = useState<Record<string, ColumnLiveEvent>>({});
  // FLUX-1300: task id → epoch ms until which it top-pins in its column (see NEW_TASK_PIN_DURATION_MS).
  const [pinnedTasks, setPinnedTasks] = useState<Record<string, number>>({});
  const [refreshTrigger, setRefreshTrigger] = useState(0);
  const [lastRefreshAt, setLastRefreshAt] = useState<number | null>(null);
  const [isWindowVisible, setIsWindowVisible] = useState(() => (typeof document === 'undefined' ? true : !document.hidden));
  const [isConnected, setIsConnected] = useState(true);
  const [workspaceConfigured, setWorkspaceConfigured] = useState(false);
  const [workspacePath, setWorkspacePath] = useState<string | null>(null);
  const [config, setConfig] = useState<Config | null>(null);
  const [readComments, setReadComments] = useState<Record<string, string[]>>({});
  const [theme, setTheme] = useState<AppTheme>(() => {
    const initial = getInitialTheme();
    applyTheme(initial);
    return initial;
  });
  const [parseErrors, setParseErrors] = useState<ParseError[]>([]);
  const [parseErrorsLoading] = useState(false);
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [notificationUnreadCount, setNotificationUnreadCount] = useState(0);
  // FLUX-796: ids we've already surfaced as native toasts, so per-ticket-dedup re-broadcasts and
  // the initial load don't re-pop. A ref (not state) because the SSE handler closes over it stalely.
  const seenNotificationIds = useRef<Set<string>>(new Set());
  const [restartPending, setRestartPending] = useState(false);
  const [workspaces, setWorkspaces] = useState<WorkspaceInfo[]>([]);
  // FLUX-758: reactive mirror of the onboarding-complete localStorage flag. App
  // gates the wizard on this store field, so flipping it dismisses the wizard
  // immediately (no manual reload), while localStorage remains the persistence layer.
  const [onboardingComplete, setOnboardingComplete] = useState(
    () => localStorage.getItem('eh-onboarding-complete') === '1',
  );
  const readCommentsLoadedRef = useRef(false);
  const configRef = useRef<Config | null>(null);
  const tasksRef = useRef<Task[]>([]);
  const isFetchingTasksRef = useRef(false);
  const hasLoadedTasksRef = useRef(false);
  const taskEventTimeoutsRef = useRef<Record<string, number>>({});
  const columnEventTimeoutsRef = useRef<Record<string, number>>({});
  const taskPinTimeoutsRef = useRef<Record<string, number>>({});
  const liveEventSequenceRef = useRef(0);
  const pendingReadStateRef = useRef<Record<string, string[]>>({});
  const readStateFlushTimerRef = useRef<number | null>(null);

  const scheduleTaskEventClear = useCallback((taskId: string, sequence: number) => {
    const existingTimeout = taskEventTimeoutsRef.current[taskId];
    if (existingTimeout) {
      window.clearTimeout(existingTimeout);
    }

    taskEventTimeoutsRef.current[taskId] = window.setTimeout(() => {
      setTaskLiveEvents((current) => {
        if (!current[taskId] || current[taskId].sequence !== sequence) {
          return current;
        }

        return removeKey(current, taskId);
      });
      delete taskEventTimeoutsRef.current[taskId];
    }, LIVE_EVENT_DURATION_MS);
  }, []);

  const scheduleColumnEventClear = useCallback((columnId: string, sequence: number) => {
    const existingTimeout = columnEventTimeoutsRef.current[columnId];
    if (existingTimeout) {
      window.clearTimeout(existingTimeout);
    }

    columnEventTimeoutsRef.current[columnId] = window.setTimeout(() => {
      setColumnLiveEvents((current) => {
        if (!current[columnId] || current[columnId].sequence !== sequence) {
          return current;
        }

        return removeKey(current, columnId);
      });
      delete columnEventTimeoutsRef.current[columnId];
    }, LIVE_EVENT_DURATION_MS);
  }, []);

  const applyLiveEvents = useCallback((nextTaskEvents: Record<string, TaskLiveEvent>, nextColumnEvents: Record<string, ColumnLiveEvent>) => {
    const taskEntries = Object.entries(nextTaskEvents);
    if (taskEntries.length > 0) {
      setTaskLiveEvents((current) => ({ ...current, ...nextTaskEvents }));
      taskEntries.forEach(([taskId, event]) => scheduleTaskEventClear(taskId, event.sequence));
    }

    const columnEntries = Object.entries(nextColumnEvents);
    if (columnEntries.length > 0) {
      setColumnLiveEvents((current) => ({ ...current, ...nextColumnEvents }));
      columnEntries.forEach(([columnId, event]) => scheduleColumnEventClear(columnId, event.sequence));
    }
  }, [scheduleColumnEventClear, scheduleTaskEventClear]);

  // FLUX-1300: schedule a pinned task's expiry — a plain per-id timeout (ids are never re-pinned
  // once minted) instead of the sequence-guarded pattern above.
  const scheduleTaskPinClear = useCallback((taskId: string) => {
    const existingTimeout = taskPinTimeoutsRef.current[taskId];
    if (existingTimeout) {
      window.clearTimeout(existingTimeout);
    }

    taskPinTimeoutsRef.current[taskId] = window.setTimeout(() => {
      setPinnedTasks((current) => removeKey(current, taskId));
      delete taskPinTimeoutsRef.current[taskId];
    }, NEW_TASK_PIN_DURATION_MS);
  }, []);

  const applyPins = useCallback((nextPinnedTasks: Record<string, number>) => {
    const entries = Object.entries(nextPinnedTasks);
    if (entries.length === 0) return;
    setPinnedTasks((current) => ({ ...current, ...nextPinnedTasks }));
    entries.forEach(([taskId]) => scheduleTaskPinClear(taskId));
  }, [scheduleTaskPinClear]);

  const loadTasks = useCallback(async (activeOnly = false) => {
    if (isFetchingTasksRef.current) {
      return;
    }

    isFetchingTasksRef.current = true;

    if (!hasLoadedTasksRef.current) {
      setTasksLoading(true);
    }

    try {
      const previousTasks = tasksRef.current;
      const fetchStartedAt = performance.now();
      const rawFetch = await fetchTasks(activeOnly ? { active: true } : undefined);
      recordDuration('refresh.fetchTasks', performance.now() - fetchStartedAt);
      // FLUX-1144: `null` means the server answered 304 — this exact query variant hasn't
      // changed since our last fetch (conditional GET via ETag/If-None-Match). Nothing to
      // reconcile; keep the current state and skip straight to clearing the loading flag.
      if (rawFetch === null) {
        hasLoadedTasksRef.current = true;
        startTransition(() => setTasksLoading(false));
        return;
      }
      const fetchedActiveOrAll = normalizeTaskList(rawFetch);
      // FLUX-970: the routine 3s poll only fetches non-terminal tickets (the board already filters
      // Released/Archived/Done out client-side, so they're dead weight on the hot path). Preserve
      // previously-known terminal tickets — and anything the interval raced past mid-transition —
      // instead of letting them vanish from `tasks`; SSE's `taskUpdated`/`open` handlers run a full
      // (non-active-only) `loadTasks()` that authoritatively reconciles any real status transition.
      // FLUX-980: re-sort back to the same id order a full fetch would produce. Board (App.tsx)
      // conditionally mounts/unmounts on view switch, so it re-derives columns from whatever order
      // `tasks` is in the moment it remounts — leaving this as [actives][preserved terminals]
      // instead of a stable global order made cards visibly reshuffle position every time you
      // navigated back to it, since the background poll kept flip-flopping the array shape.
      const fetchedTasks = activeOnly
        ? (() => {
            const fetchedIds = new Set(fetchedActiveOrAll.map((task) => task.id));
            return normalizeTaskList([...fetchedActiveOrAll, ...previousTasks.filter((task) => !fetchedIds.has(task.id))]);
          })()
        : fetchedActiveOrAll;
      const previousTasksById = new Map(previousTasks.map((task) => [task.id, task]));
      const nextTaskEvents: Record<string, TaskLiveEvent> = {};
      const nextColumnEvents: Record<string, ColumnLiveEvent> = {};
      const nextPinnedTasks: Record<string, number> = {};
      const shouldEmitLiveEvents = previousTasks.length > 0;
      let changed = previousTasks.length !== fetchedTasks.length;

      const nextSequence = () => {
        liveEventSequenceRef.current += 1;
        return liveEventSequenceRef.current;
      };

      for (const task of fetchedTasks) {
        const previousTask = previousTasksById.get(task.id);

        if (!previousTask) {
          changed = true;

          if (shouldEmitLiveEvents) {
            nextTaskEvents[task.id] = {
              kind: 'created',
              sequence: nextSequence(),
              at: Date.now(),
              toStatus: task.status,
            };
            nextColumnEvents[task.status] = {
              kind: 'created',
              sequence: nextSequence(),
              at: Date.now(),
              taskId: task.id,
            };
            // FLUX-1300: top-pin a newly-appeared ticket in its column for everyone (not just the
            // creator's tab) — SSE's `taskCreated` drives this same reconciliation for other viewers.
            nextPinnedTasks[task.id] = Date.now() + NEW_TASK_PIN_DURATION_MS;
          }

          continue;
        }

        if (previousTask.status !== task.status) {
          changed = true;

          if (shouldEmitLiveEvents) {
            nextTaskEvents[task.id] = {
              kind: 'moved',
              sequence: nextSequence(),
              at: Date.now(),
              fromStatus: previousTask.status,
              toStatus: task.status,
            };
            nextColumnEvents[task.status] = {
              kind: 'received',
              sequence: nextSequence(),
              at: Date.now(),
              taskId: task.id,
            };
            
            if (task.status.toLowerCase() === 'done') {
              const fireworksEnabled = configRef.current?.enableFireworks !== false;
              const animationsEnabled = configRef.current?.animationsEnabled !== false;
              if (fireworksEnabled && animationsEnabled) {
                import('canvas-confetti').then((module) => {
                  module.default({
                    particleCount: 150,
                    spread: 80,
                    origin: { y: 0.6 }
                  });
                }).catch(console.error);
              }
            }
          }

          continue;
        }

        if (!tasksEqual(previousTask, task)) {
          changed = true;

          if (shouldEmitLiveEvents) {
            nextTaskEvents[task.id] = {
              kind: 'updated',
              sequence: nextSequence(),
              at: Date.now(),
              toStatus: task.status,
            };
          }
        }
      }

      if (!changed) {
        const nextTaskIds = new Set(fetchedTasks.map((task) => task.id));
        changed = previousTasks.some((task) => !nextTaskIds.has(task.id));
      }

      hasLoadedTasksRef.current = true;

      if (!changed && previousTasks.length > 0) {
        startTransition(() => setTasksLoading(false));
        return;
      }

      // Preserve object identity for unchanged tasks (FLUX-724). `fetchedTasks` is a fresh
      // JSON parse, so every element is a new reference; handing that straight to `setTasks`
      // gives EVERY card a new `task` prop and breaks `TaskCardInner`'s `prev.task === next.task`
      // memo — the whole board re-renders on each poll/SSE diff (continuous during a live session,
      // since cliSession activity + tokenMetadata churn `tasksEqual`). Reuse the previous object
      // wherever it's value-equal so only genuinely-changed cards get a new ref and re-render.
      const nextTasks = fetchedTasks.map((task) => {
        const previousTask = previousTasksById.get(task.id);
        return previousTask && tasksEqual(previousTask, task) ? previousTask : task;
      });
      tasksRef.current = nextTasks;
      startTransition(() => {
        setTasksLoading(false);
        setTasks(nextTasks);
        setLastRefreshAt(Date.now());
        if (shouldEmitLiveEvents) {
          applyLiveEvents(nextTaskEvents, nextColumnEvents);
          applyPins(nextPinnedTasks);
        }
      });
    } catch (error) {
      console.error(error);

      if (!hasLoadedTasksRef.current) {
        setTasksLoading(true);
      }
    } finally {
      isFetchingTasksRef.current = false;
    }
  }, [applyLiveEvents, applyPins]);

  const loadParseErrors = useCallback(async () => {
    if (!workspaceConfigured) return;

    try {
      const errors = await fetchParseErrors();
      setParseErrors(errors);
    } catch (error) {
      console.error('Failed to fetch parse errors:', error);
    }
  }, [workspaceConfigured]);

  const refreshNotifications = useCallback(() => {
    fetchNotifications().then(data => {
      // FLUX-796: notifications already present at load are NOT "new" — record their ids so the
      // first SSE re-broadcast of any of them doesn't fire a native toast.
      for (const n of data.notifications) seenNotificationIds.current.add(n.id);
      setNotifications(data.notifications);
      setNotificationUnreadCount(data.unreadCount);
    }).catch(() => {});
  }, []);

  // FLUX-796 — Electron native toast gating. Policy: suppress ALL toasts while the window is
  // focused (you're already looking at the board — only the badge updates). When unfocused, pop
  // for action-required ('prompt') and ticket-Done ('completion'); 'info'/'error' never pop.
  const maybeNotifyNative = useCallback((n: Notification) => {
    const api = getElectronAPI();
    if (!api?.notify) return; // plain browser portal → no-op
    if (typeof document !== 'undefined' && document.hasFocus()) return;
    if (n.type !== 'prompt' && n.type !== 'completion') return;
    api.notify({ title: n.title, body: n.message, ticketId: n.ticketId });
  }, []);

  // FLUX-1423: returns the in-flight refetch so a caller that just kicked off a fire-and-forget
  // agent launch (e.g. fast-path) can `await` it and hold its button's busy state until the new
  // session data has actually landed, instead of reverting to idle before there's anything on the
  // card to show for the click.
  const triggerRefresh = useCallback(async () => {
    setRefreshTrigger((prev) => prev + 1);
    await Promise.all([loadTasks(), loadParseErrors()]);
  }, [loadTasks, loadParseErrors]);

  const updateTicketViewUrl = (taskId: string, viewMode: 'popup' | 'full') => {
    const url = new URL(window.location.href);
    url.searchParams.set('ticket', taskId);
    url.searchParams.set('view', viewMode);
    window.history.replaceState({}, '', url);
  };

  const setView = (nextView: AppView) => {
    setCurrentView(nextView);
    updateViewUrl(nextView, 'push');
  };

  const clearTaskFilters = () => {
    setSearchQuery('');
    setSortOption('default');
    setFilterAssignee('all');
    setFilterPriority('all');
    setFilterTag('all');
    setFilterUnreadOnly(false);
    setFilterWorktree('');
  };

  const openTaskModal = (task?: Partial<Task>) => {
    setOpenModalInFullView(false);
    const nextTask = task || { status: 'Todo' };
    if (nextTask.id) {
      updateTicketViewUrl(nextTask.id, 'popup');
    }
    setModalTask(nextTask);
    setIsModalOpen(true);
  };

  const openTaskFullView = (task: Partial<Task>, options?: { scrollToComments?: boolean }) => {
    if (task.id) {
      updateTicketViewUrl(task.id, 'full');
    }
    setModalTask(task);
    setIsModalOpen(true);
    setOpenModalInFullView(true);
    setOpenModalScrollToComments(options?.scrollToComments ?? false);
  };

  const openTask = (task: Task) => {
    // FLUX-744: the default open mode is now 'chat' — open the ticket in the chat-aligned view with
    // its sideview. The dock lives BELOW this provider, so we hand off via a window event that ChatDock
    // listens for (it calls the dock's `openTicket`). 'full'/'popup' keep opening the center modal.
    const mode = configRef.current?.boardCardOpenMode || 'chat';
    if (mode === 'full') { openTaskFullView(task); return; }
    if (mode === 'popup') { openTaskModal(task); return; }
    if (task.id) {
      window.dispatchEvent(new CustomEvent('flux:open-ticket', { detail: { id: task.id } }));
    } else {
      // A not-yet-created draft has no chat to open — fall back to the popup editor.
      openTaskModal(task);
    }
  };

  const clearOpenModalScrollToComments = () => setOpenModalScrollToComments(false);

  const closeModal = () => {
    // Clear URL params synchronously before the state update so the "reopen from URL"
    // effect can't race and re-open the modal when it sees ?ticket still set.
    const url = new URL(window.location.href);
    if (url.searchParams.has('ticket')) {
      url.searchParams.delete('ticket');
      url.searchParams.delete('view');
      window.history.replaceState({}, '', url);
    }
    setIsModalOpen(false);
    setOpenModalInFullView(false);
    setTimeout(() => setModalTask(null), 1000);
  };

  const setAppTheme = (next: AppTheme) => {
    setTheme(() => {
      applyTheme(next);
      localStorage.setItem('eh-theme', next);
      return next;
    });
  };

  const toggleTheme = () => {
    setTheme((prev) => {
      const idx = THEMES.findIndex(t => t.name === prev);
      const next = THEMES[(idx + 1) % THEMES.length].name;
      applyTheme(next);
      localStorage.setItem('eh-theme', next);
      return next;
    });
  };

  // FLUX-1138: events buffered here between animation frames before a single batched
  // `appStore.patch` applies them — see the `eh-event` listener below. Refs (not state) so
  // pushing to the buffer never itself triggers a render. Flushing on `requestAnimationFrame`
  // (rather than a trailing timer) ties the batch to the browser's own paint cadence: it can't
  // flush faster than a frame can render anyway, and a backgrounded tab throttles rAF for free
  // (no separate visibility check needed).
  const pendingEngineEventsRef = useRef<EngineEvent[]>([]);
  const engineEventsFlushHandleRef = useRef<number | null>(null);
  const nextEngineEventIdRef = useRef(0);

  const flushEngineEvents = useCallback(() => {
    engineEventsFlushHandleRef.current = null;
    const pending = pendingEngineEventsRef.current;
    if (pending.length === 0) return;
    pendingEngineEventsRef.current = [];
    appStore.patch({ engineEvents: appendEngineEvents(appStore.getState().engineEvents, pending, ENGINE_EVENTS_MAX) });
  }, []);

  // FLUX-1030: clear the shared Engine-events ring buffer (terminal "Clear log" / "Clear").
  const clearEngineEvents = useCallback(() => {
    pendingEngineEventsRef.current = [];
    if (engineEventsFlushHandleRef.current !== null) {
      cancelAnimationFrame(engineEventsFlushHandleRef.current);
      engineEventsFlushHandleRef.current = null;
    }
    appStore.patch({ engineEvents: [] });
  }, []);

  const saveConfig = async (newConfig: Config) => {
    try {
      const updated = await apiSaveConfig(newConfig);
      setConfig(updated);
      configRef.current = updated;
    } catch (err) {
      console.error(err);
    }
  };

  // Load full read-state from server once the workspace is ready (and when user changes)
  useEffect(() => {
    if (!workspaceConfigured) return;
    readCommentsLoadedRef.current = false;
    setReadComments({});
    fetchReadState()
      .then(state => {
        const userState = state[currentUser] ?? {};
        setReadComments(userState);
        readCommentsLoadedRef.current = true;
      })
      .catch(() => { readCommentsLoadedRef.current = true; });
  }, [currentUser, workspaceConfigured]);

  const ensureReadStateLoaded = useCallback((_ticketId: string) => {
    // no-op: full state is loaded on mount; kept for API compatibility
  }, []);

  const flushReadState = useCallback(() => {
    const patch = pendingReadStateRef.current;
    if (Object.keys(patch).length === 0) return;
    pendingReadStateRef.current = {};
    saveReadState({ [currentUser]: patch }).catch((err) => {
      console.warn('[read-state] persist failed, retrying once', err);
      saveReadState({ [currentUser]: patch }).catch(() => {});
    });
  }, [currentUser]);

  const scheduleReadStateFlush = useCallback(() => {
    if (readStateFlushTimerRef.current !== null) return;
    readStateFlushTimerRef.current = window.setTimeout(() => {
      readStateFlushTimerRef.current = null;
      flushReadState();
    }, 50);
  }, [flushReadState]);

  const markCommentRead = useCallback((ticketId: string, commentId: string) => {
    setReadComments(prev => {
      const existing = prev[ticketId] ?? [];
      if (existing.includes(commentId)) return prev;
      const next = [...existing, commentId];
      const pending = pendingReadStateRef.current;
      pending[ticketId] = next;
      scheduleReadStateFlush();
      return { ...prev, [ticketId]: next };
    });
  }, [scheduleReadStateFlush]);

  const markAllCommentsRead = useCallback((ticketId: string, commentIds: string[]) => {
    setReadComments(prev => {
      const existing = new Set(prev[ticketId] ?? []);
      commentIds.forEach(id => existing.add(id));
      const next = [...existing];
      const pending = pendingReadStateRef.current;
      pending[ticketId] = next;
      scheduleReadStateFlush();
      return { ...prev, [ticketId]: next };
    });
  }, [scheduleReadStateFlush]);

  useEffect(() => {
    return () => {
      Object.values(taskEventTimeoutsRef.current).forEach((timeoutId) => window.clearTimeout(timeoutId));
      Object.values(columnEventTimeoutsRef.current).forEach((timeoutId) => window.clearTimeout(timeoutId));
      Object.values(taskPinTimeoutsRef.current).forEach((timeoutId) => window.clearTimeout(timeoutId));
      if (readStateFlushTimerRef.current !== null) {
        window.clearTimeout(readStateFlushTimerRef.current);
        flushReadState();
      }
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    let cancelled = false;
    let retryTimeout: number | undefined;

    const loadConfig = async () => {
      try {
        const loadedConfig = await fetchConfig();
        if (cancelled) return;
        setConfig(loadedConfig);
        configRef.current = loadedConfig;
        setCurrentProject((prev) => reconcileProject(prev, loadedConfig.projects));
        setCurrentUser((prev) => reconcileUser(prev, loadedConfig.users)); // FLUX-785
      } catch (error) {
        console.error(error);
        if (cancelled) return;
        retryTimeout = window.setTimeout(() => {
          void loadConfig();
        }, 3000);
      }
    };

    void loadConfig();

    return () => {
      cancelled = true;
      if (retryTimeout) {
        window.clearTimeout(retryTimeout);
      }
    };
  }, []);

  useEffect(() => {
    void loadTasks();
    void loadParseErrors();
  }, [loadTasks, loadParseErrors]);

  const refreshWorkspaces = useCallback(() => {
    fetchWorkspaces().then(setWorkspaces).catch(() => {});
  }, []);

  // FLUX-785: persist the active identity so it survives reloads and seeds getInitialUser on the
  // next boot. Skip the neutral 'You' placeholder so we never lock it in over a real name.
  useEffect(() => {
    try {
      if (currentUser && currentUser.trim() && currentUser !== 'You') {
        localStorage.setItem(CURRENT_USER_KEY, currentUser.trim());
      }
    } catch { /* localStorage unavailable — non-fatal */ }
  }, [currentUser]);

  // FLUX-758: owns the onboarding-complete localStorage write AND flips the
  // reactive store field so App re-renders and dismisses the wizard at once.
  const markOnboardingComplete = useCallback(() => {
    localStorage.setItem('eh-onboarding-complete', '1');
    setOnboardingComplete(true);
  }, []);

  const notifyWorkspaceSet = useCallback(() => {
    fetchWorkspace()
      .then(({ configured, path: wp }) => {
        setWorkspaceConfigured(configured);
        setWorkspacePath(wp);
        if (configured) {
          // FLUX-1465: `loadTasks` diffs the fresh fetch against `tasksRef.current` to emit
          // live events (status-change confetti, column pins, etc). Ticket IDs are workspace-
          // scoped, so a stale `tasksRef` from the *previous* workspace can collide by ID with
          // the new workspace's tasks and look like a wave of "moved to Done" transitions —
          // firing a confetti burst per card and jank-freezing the board on every swap. Clear
          // the ref (and `hasLoadedTasksRef`) first so the post-switch fetch is treated as an
          // initial load, which `loadTasks` already skips live-event emission for.
          tasksRef.current = [];
          hasLoadedTasksRef.current = false;
          setTasks([]);
          void loadTasks();
          fetchConfig().then((c) => {
            setConfig(c);
            configRef.current = c;
            setCurrentProject((prev) => reconcileProject(prev, c.projects));
            setCurrentUser((prev) => reconcileUser(prev, c.users)); // FLUX-785
          }).catch(() => {});
          refreshWorkspaces();
          refreshNotifications();
        }
      })
      .catch(() => {});
  }, [loadTasks, refreshWorkspaces, refreshNotifications]);

  const switchWorkspace = useCallback(async (wsPath: string, force?: boolean) => {
    const result = await apiSwitchWorkspace(wsPath, force);
    if ('blocked' in result && result.blocked) {
      const proceed = await confirm({ title: 'Stop live sessions and switch?', body: result.message, tone: 'danger', confirmLabel: 'Stop & switch' });
      if (proceed) {
        await switchWorkspace(wsPath, true);
      }
      return;
    }
    notifyWorkspaceSet();
  }, [confirm, notifyWorkspaceSet]);

  // On mount, fetch workspace state. Then poll health alongside connection checks.
  useEffect(() => {
    fetchWorkspace()
      .then(({ configured, path: wp }) => {
        setWorkspaceConfigured(configured);
        setWorkspacePath(wp);
      })
      .catch(() => {});
    refreshWorkspaces();
  }, [refreshWorkspaces]);

  useEffect(() => {
    let checkTimeout: number;
    let cancelled = false;

    const checkHealth = async () => {
      try {
        const health = await fetchHealth();
        if (!cancelled) {
          setIsConnected(true);
          // Keep workspace state in sync if the server restarted with a workspace.
          const configured = health.workspace !== null && health.workspace !== undefined;
          setWorkspaceConfigured(configured);
          setWorkspacePath(health.workspace ?? null);
        }
      } catch {
        if (!cancelled) setIsConnected(false);
      }
      
      if (!cancelled) {
        checkTimeout = window.setTimeout(checkHealth, 10000);
      }
    };

    void checkHealth();

    return () => {
      cancelled = true;
      if (checkTimeout) window.clearTimeout(checkTimeout);
    };
  }, []);

  useEffect(() => {
    if (isConnected) {
      void loadTasks();
      void loadParseErrors();
    }
  }, [isConnected, loadTasks, loadParseErrors]);

  useEffect(() => {
    // Guard every path on isConnected — otherwise the 3s tick and every focus/visibility event
    // fire unconditionally, including during a cold engine boot (e.g. a large ticket store on
    // first run after a fresh clone), hammering a server that isn't listening yet and flooding
    // the console with "Failed to fetch" until it comes up.
    const refreshIfVisible = (activeOnly = false, source: 'poll' | 'visibility' = 'poll') => {
      if (!document.hidden && isConnected) {
        incr(`refresh.trigger.${source}`);
        void loadTasks(activeOnly);
        void loadParseErrors();
      }
    };

    const handleVisibilityChange = () => {
      const visible = !document.hidden;
      setIsWindowVisible(visible);
      if (visible && isConnected) {
        incr('refresh.trigger.visibility');
        void loadTasks();
        void loadParseErrors();
      }
    };

    const handleFocus = () => {
      setIsWindowVisible(!document.hidden);
      refreshIfVisible(false, 'visibility');
    };

    // FLUX-970: the routine 3s tick fetches active-only — it's the hot loop that was re-shipping
    // the whole board (incl. terminal tickets) every 3s. Focus/visibility resyncs stay full fetches.
    const intervalId = window.setInterval(() => refreshIfVisible(true, 'poll'), LIVE_TASK_POLL_INTERVAL_MS);
    window.addEventListener('focus', handleFocus);
    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      window.clearInterval(intervalId);
      window.removeEventListener('focus', handleFocus);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [loadTasks, loadParseErrors, isConnected]);

  // FLUX-1140: pause every CSS loop (glows, shimmers, flow pips, etc. — see index.css'
  // `.eh-tab-hidden` rule) while the tab is backgrounded, so a board left open in an
  // unfocused tab stops keeping the compositor/GPU busy for animations nobody can see.
  useEffect(() => {
    document.documentElement.classList.toggle('eh-tab-hidden', !isWindowVisible);
  }, [isWindowVisible]);

  // FLUX-1189: a board that's foregrounded but genuinely untouched (no mouse/keyboard/scroll/
  // touch) still isn't caught by `isWindowVisible` above — that only fires for a backgrounded
  // tab. Toggle `.eh-idle` on <html> after a stretch of no input so index.css can pause the
  // purely-decorative loops (CRT flicker/beam, empty-column dust) that don't communicate any
  // live state. Plain DOM listeners + a timer, not React state, so idle detection itself never
  // triggers a render.
  useEffect(() => {
    let idleTimer: ReturnType<typeof setTimeout> | null = null;
    const markActive = () => {
      document.documentElement.classList.remove('eh-idle');
      if (idleTimer !== null) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        document.documentElement.classList.add('eh-idle');
      }, USER_IDLE_AFTER_MS);
    };
    markActive();
    const activityEvents = ['mousemove', 'mousedown', 'keydown', 'wheel', 'touchstart', 'scroll'] as const;
    activityEvents.forEach((type) => window.addEventListener(type, markActive, { passive: true }));
    return () => {
      if (idleTimer !== null) clearTimeout(idleTimer);
      activityEvents.forEach((type) => window.removeEventListener(type, markActive));
    };
  }, []);

  // FLUX-611: one shared subscription bus over the single SSE connection below. Chat
  // surfaces (transcript, dock, approvals) register here and react to pushed events,
  // instead of each opening its own EventSource or running a 1–1.5s polling loop.
  const eventSubsRef = useRef<Map<string, Set<(data: unknown) => void>>>(new Map());
  const subscribeToEvent = useCallback((eventType: string, handler: (data: unknown) => void) => {
    let set = eventSubsRef.current.get(eventType);
    if (!set) { set = new Set(); eventSubsRef.current.set(eventType, set); }
    set.add(handler);
    return () => { set!.delete(handler); };
  }, []);

  // SSE: receive instant activity pushes from the engine instead of polling for them.
  useEffect(() => {
    if (!isConnected) return;
    let es: EventSource | null = null;
    let disposed = false;
    // FLUX-910: liveness watchdog. The engine sends a named `ping` event every ~15s; if we stop
    // seeing ANY traffic for well over that, the stream is a stalled half-open socket (laptop sleep,
    // NAT idle-reaper) that EventSource will NOT auto-reconnect — it never observed a close, so
    // readyState stays OPEN forever and every chat/board surface that depends on SSE goes dark.
    // Force a fresh connection. `lastEventAt` is bumped by the heartbeat (and open); the ping alone
    // guarantees the liveness signal on an otherwise-idle stream.
    let lastEventAt = Date.now();
    const STALE_MS = 40_000; // ~2.6× the 15s server heartbeat

    // Fan the events chat surfaces care about out to bus subscribers. Added as separate
    // listeners (EventSource allows many per type) so the built-in handlers stay untouched.
    // FLUX-921: also bumps the watchdog's liveness clock — previously only ping/eh-event/open did,
    // so a busy stream that happens to drop pings (but is delivering these events fine) could hit
    // STALE_MS and needlessly tear down + reconnect.
    const forward = (type: string, data: unknown) => {
      lastEventAt = Date.now();
      const set = eventSubsRef.current.get(type);
      if (!set) return;
      for (const h of set) { try { h(data); } catch { /* isolate subscriber errors */ } }
    };

    const connect = () => {
      if (disposed) return;
      const src = new EventSource('/api/events');
      es = src;
      // FLUX-1133: count every named SSE event by type (perfClient's `sse.event.<type>` counters),
      // wrapping the underlying addEventListener once instead of a manual incr() at each call site.
      const trackListener = (type: string, handler: (e: MessageEvent) => void) => {
        src.addEventListener(type, (e: MessageEvent) => {
          recordSseEvent(type);
          handler(e);
        });
      };
      // FLUX-910: heartbeat keeps the watchdog's liveness clock fresh on an otherwise-idle stream.
      trackListener('ping', () => { lastEventAt = Date.now(); });
      // FLUX-1030: catch-all Engine-events log. The engine mirrors EVERY broadcastEvent onto the
      // generic `eh-event` channel as `{type,data}`, so listening here (once, on the shared
      // connection) captures every event type without a hardcoded allowlist. Buffered in the store
      // so it accumulates from boot and survives the terminal panel being closed/minimized.
      trackListener('eh-event', (e: MessageEvent) => {
        lastEventAt = Date.now();
        try {
          const { type, data } = JSON.parse(e.data) as { type: string; data: unknown };
          // FLUX-1138: stamp id/timestamp at arrival, then buffer — the batch is flushed to the
          // store at most once per animation frame (see flushEngineEvents) instead of patching
          // (and re-rendering every subscriber) per event, which was the dominant cost during a
          // streaming `assistantDelta` burst.
          pendingEngineEventsRef.current.push({ id: nextEngineEventIdRef.current++, type, data, timestamp: Date.now() });
          if (engineEventsFlushHandleRef.current === null) {
            engineEventsFlushHandleRef.current = requestAnimationFrame(flushEngineEvents);
          }
        } catch { /* non-JSON payload — skip */ }
      });
      for (const type of ['activity', 'progress', 'assistantDelta', 'taskUpdated', 'permission-request', 'permission-resolved', 'ask-question', 'ask-question-resolved', 'board-rebase-proposed', 'board-rebase-resolved', 'artifactReady', 'furnace-updated', 'furnace-deleted']) {
        trackListener(type, (e: MessageEvent) => {
          try { forward(type, JSON.parse(e.data)); } catch { /* non-JSON payload — skip */ }
        });
      }
      // FLUX-846: reconcile on every (re)connect. If the engine restarts or the stream drops, the
      // incremental terminal `taskUpdated` for a session that ended during the gap can be missed —
      // leaving its card stuck on 'Working'. Re-fetching the authoritative task list on `open`
      // re-syncs each card to the engine's current session status (terminal/absent included).
      trackListener('open', () => {
        lastEventAt = Date.now();
        incr('refresh.trigger.sse');
        void loadTasks();
      });
      trackListener('taskUpdated', () => {
        incr('refresh.trigger.sse');
        void loadTasks();
        // FLUX-796: resolving a Require Input / Needs Action ticket dismisses its notification
        // server-side WITHOUT a broadcast (only add/dedup/read-all broadcast). Re-sync the list so
        // the Electron taskbar badge decrements on resolve and clears at 0. Electron-only so the
        // browser portal's network behavior is unchanged (the bell already refreshes on interaction).
        if (getElectronAPI()) refreshNotifications();
      });
      // FLUX-753: a deleted ticket re-fetches the list so the card disappears immediately
      // (the engine now broadcasts taskDeleted on delete + extract-compensation).
      trackListener('taskDeleted', () => {
        incr('refresh.trigger.sse');
        void loadTasks();
      });
      // FLUX-1282: a newly created top-level ticket re-fetches the list so it appears
      // immediately in other tabs/sessions instead of waiting for the 3s poll.
      trackListener('taskCreated', () => {
        incr('refresh.trigger.sse');
        void loadTasks();
      });
      trackListener('activity', (e: MessageEvent) => {
        const { taskId, activity } = JSON.parse(e.data) as { taskId: string; activity: string | null };
        // FLUX-626: write to the isolated `liveSessions` slice instead of churning the whole
        // `tasks` array (which re-rendered the entire board on every activity tick). Cards read
        // this via `useLiveSession(id)` with a fallback to the polled `cliSession` value.
        const current = appStore.getState().liveSessions;
        const prev = current[taskId];
        appStore.patch({
          liveSessions: { ...current, [taskId]: { ...prev, currentActivity: activity ?? undefined } },
        });
      });
      trackListener('progress', (e: MessageEvent) => {
        const { taskId, sessionId, timestamp, message } = JSON.parse(e.data) as { taskId: string; sessionId: string; timestamp: string; message: string };
        // FLUX-626: append live progress into the isolated `liveSessions` slice, keyed by
        // sessionId, instead of rebuilding `task.history` inside the `tasks` array (which
        // re-rendered the board on every flush). Live progress isn't in the polled payload — the
        // engine holds it in memory — so consumers merge this slice with the persisted history.
        const current = appStore.getState().liveSessions;
        const prev = current[taskId];
        const prevBySession = prev?.progressBySession ?? {};
        const prevEntries = prevBySession[sessionId] ?? [];
        appStore.patch({
          liveSessions: {
            ...current,
            [taskId]: {
              ...prev,
              progressBySession: { ...prevBySession, [sessionId]: [...prevEntries, { timestamp, message }] },
            },
          },
        });
      });
      // S10 (epic FLUX-996): the S9 operation-telemetry stream — surface a failed/timed-out spawn
      // directly on its ticket's card. Only 'spawn' events carry a ticketId today (git/gh/handshake
      // telemetry isn't ticket-attributed yet, FLUX-1005's scope cut), and a deliberate 'aborted'
      // (user-requested stop) isn't a failure worth a badge, so both are filtered out here.
      trackListener('operation', (e: MessageEvent) => {
        lastEventAt = Date.now();
        try {
          const op = JSON.parse(e.data) as {
            kind: OperationFailure['kind'];
            ticketId?: string;
            sessionId?: string;
            outcome: 'ok' | 'timeout' | 'error' | 'aborted';
            endedAt: number;
            reason?: string;
          };
          if (!op.ticketId || op.outcome === 'ok' || op.outcome === 'aborted') return;
          const current = appStore.getState().liveSessions;
          const prev = current[op.ticketId];
          appStore.patch({
            liveSessions: {
              ...current,
              [op.ticketId]: {
                ...prev,
                lastOperationFailure: { sessionId: op.sessionId, kind: op.kind, reason: op.reason, endedAt: op.endedAt },
              },
            },
          });
        } catch { /* non-JSON payload — skip */ }
      });
      trackListener('notification', (e: MessageEvent) => {
        const { notification, unreadCount } = JSON.parse(e.data) as { notification: Notification | null; unreadCount: number };
        // FLUX-796: pop a native OS toast only for genuinely NEW notifications (first time we see the
        // id), not on the per-ticket-dedup re-broadcasts. A ref (not the stale-in-closure `notifications`
        // state) is the reliable source of "have I seen this before".
        if (notification && !seenNotificationIds.current.has(notification.id)) {
          seenNotificationIds.current.add(notification.id);
          maybeNotifyNative(notification);
        }
        startTransition(() => {
          if (notification) {
            setNotifications(prev => {
              const idx = prev.findIndex(n => n.id === notification.id);
              if (idx >= 0) {
                const next = [...prev];
                next[idx] = notification;
                return next;
              }
              return [notification, ...prev].slice(0, 50);
            });
          } else {
            setNotifications(prev => prev.map(n => ({ ...n, read: true })));
          }
          setNotificationUnreadCount(unreadCount);
        });
      });
      trackListener('restart_pending', () => {
        setRestartPending(true);
      });
      trackListener('auto_restarting', () => {
        setRestartPending(false);
      });
      src.onerror = () => {
        // When SSE reconnects after an engine restart, clear the pending state
        if (src.readyState === EventSource.CONNECTING) {
          setRestartPending(false);
        }
      };
    };

    connect();
    // FLUX-910: poll the liveness clock. A stalled-OPEN (or fully CLOSED) stream past the staleness
    // window is rebuilt from scratch; a CONNECTING socket is left alone so we don't fight EventSource's
    // own in-flight reconnect.
    const watchdog = setInterval(() => {
      if (disposed) return;
      const rs = es?.readyState;
      if (Date.now() - lastEventAt > STALE_MS && rs !== EventSource.CONNECTING) {
        lastEventAt = Date.now();
        try { es?.close(); } catch { /* ignore */ }
        connect();
      }
    }, 10_000);

    refreshNotifications();
    return () => {
      disposed = true;
      clearInterval(watchdog);
      try { es?.close(); } catch { /* ignore */ }
      if (engineEventsFlushHandleRef.current !== null) {
        cancelAnimationFrame(engineEventsFlushHandleRef.current);
        engineEventsFlushHandleRef.current = null;
      }
      // FLUX-1146: drain any batch still sitting in pendingEngineEventsRef instead of leaving it
      // for a reconnect that may be slow or never happen — the cancelAnimationFrame above means
      // no flush is otherwise coming.
      flushEngineEvents();
    };
  }, [isConnected, refreshNotifications, flushEngineEvents]);

  useEffect(() => {
    updateViewUrl(getViewFromLocation(), 'replace');

    const handlePopState = () => {
      setCurrentView(getViewFromLocation());
      const nextFilters = getTaskFiltersFromLocation();
      setSearchQuery(nextFilters.searchQuery);
      setSortOption(nextFilters.sortOption);
      setFilterAssignee(nextFilters.filterAssignee);
      setFilterPriority(nextFilters.filterPriority);
      setFilterTag(nextFilters.filterTag);
      setFilterWorktree(nextFilters.filterWorktree);
    };

    const handleCustomNavigation = () => {
      handlePopState();
    };

    window.addEventListener('popstate', handlePopState);
    window.addEventListener('flux:navigate', handleCustomNavigation);

    return () => {
      window.removeEventListener('popstate', handlePopState);
      window.removeEventListener('flux:navigate', handleCustomNavigation);
    };
  }, []);

  useEffect(() => {
    updateTaskFilterUrl({ searchQuery, sortOption, filterAssignee, filterPriority, filterTag, filterUnreadOnly, filterWorktree });
  }, [searchQuery, sortOption, filterAssignee, filterPriority, filterTag, filterUnreadOnly, filterWorktree]);

  // FLUX-1251: the last ticket id auto-opened from a `?ticket=` URL. The default (no `view`) opens
  // via `openTask` (chat mode) which never sets `isModalOpen`, so the guard below can't stop this
  // effect re-firing on every `tasks` churn (SSE/poll) — track it here to open exactly once per id.
  const openedFromUrlRef = useRef<string | null>(null);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const ticketId = params.get('ticket');
    if (!ticketId || tasksLoading) return;
    if (isModalOpen && modalTask?.id === ticketId) return;
    if (openedFromUrlRef.current === ticketId) return;

    const task = tasks.find((item) => item.id === ticketId);
    if (!task) return;
    const view = params.get('view');
    openedFromUrlRef.current = ticketId;
    if (view === 'full') {
      openTaskFullView(task);
    } else if (view === 'popup') {
      // Preserve an explicit popup deep-link (what an in-app popup-opened URL carries).
      openTaskModal(task);
    } else {
      // FLUX-1251: no explicit view → open the ticket the same way a card click does, honoring
      // boardCardOpenMode (default 'chat') rather than always popping the center modal.
      openTask(task);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isModalOpen, modalTask?.id, tasks, tasksLoading]);

  // Keep the open modal's task data in sync with background poll updates.
  // Only update when something actually changed to avoid spurious re-renders.
  useEffect(() => {
    if (!isModalOpen || !modalTask?.id) return;
    const fresh = tasks.find((t) => t.id === modalTask.id);
    if (!fresh) return;
    // FLUX-725: `fresh` is the LIST task (history-digested, no full `history`); `modalTask` holds the
    // lazily-fetched DETAIL object (full `history`, no digest). Detect a history change via the digest
    // length, but PRESERVE the fetched full history on merge so a background poll never blanks the open
    // ticket's activity log — useTaskModalController re-fetches the detail (keyed on the same digest
    // signature) to pull in the new entries.
    const freshHistLen = fresh.historyDigest?.length ?? fresh.history?.length ?? 0;
    const modalHistLen = modalTask.history?.length ?? modalTask.historyDigest?.length ?? 0;
    const changed =
      fresh.status !== modalTask.status ||
      fresh.title !== modalTask.title ||
      fresh.body !== modalTask.body ||
      fresh.assignee !== modalTask.assignee ||
      fresh.priority !== modalTask.priority ||
      fresh.effort !== modalTask.effort ||
      fresh.implementationLink !== modalTask.implementationLink ||
      fresh.tags?.length !== modalTask.tags?.length ||
      fresh.subtasks?.length !== modalTask.subtasks?.length ||
      freshHistLen !== modalHistLen;
    if (changed) {
      setModalTask((prev) => (prev && prev.id === fresh.id ? { ...fresh, history: prev.history ?? fresh.history } : fresh));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tasks]);

  const totalUnreadCount = useMemo(() => {
    const archiveStatus = getArchiveStatus(config);
    const hiddenStatusNames = new Set(config?.hiddenStatuses?.map(s => s.name) ?? []);
    return tasks.reduce((sum, task) => {
      if (task.status === 'Released' || task.status === archiveStatus || hiddenStatusNames.has(task.status)) {
        return sum;
      }
      const readIds = new Set(readComments[task.id] ?? []);
      // FLUX-725: per-comment {id,user} comes from the list digest (was a scan over full history);
      // author is carried so own comments are suppressed (the engine can't know currentUser).
      const hasUnread = (task.historyDigest?.comments ?? []).some(
        c => c.id && c.user !== currentUser && !readIds.has(c.id)
      );
      return sum + (hasUnread ? 1 : 0);
    }, 0);
  }, [tasks, readComments, currentUser, config]);

  // FLUX-796: the taskbar "action needed" count = unread, non-dismissed ACTION-REQUIRED ('prompt')
  // notifications only (Require Input + Needs Action) — deliberately NOT completion/info, so the
  // badge means "N things to act on", not "N things happened".
  const actionRequiredCount = useMemo(
    () => notifications.filter(n => n.type === 'prompt' && !n.read && !n.dismissed).length,
    [notifications],
  );

  // Push the count to the Electron taskbar badge whenever it changes (no-op in the browser portal).
  useEffect(() => {
    const api = getElectronAPI();
    if (!api?.setActionCount) return;
    api.setActionCount(actionRequiredCount, renderBadgeDataUrl(actionRequiredCount));
  }, [actionRequiredCount]);

  // Clicking a native toast → focus is handled in main; here we navigate to the ticket.
  useEffect(() => {
    const api = getElectronAPI();
    if (!api?.onNotificationClick) return;
    const off = api.onNotificationClick(ticketId => {
      if (ticketId) window.dispatchEvent(new CustomEvent('flux:open-ticket', { detail: { id: ticketId } }));
    });
    return typeof off === 'function' ? off : undefined;
  }, []);

  // --- External store plumbing (FLUX-625) ---------------------------------
  // Stable action delegators read the freshest handler closures from this ref,
  // so the action set below is built once (never changes identity) while still
  // invoking up-to-date logic. Action-only consumers therefore never re-render.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const latest = useRef<Record<string, (...args: any[]) => any>>({});
  latest.current = {
    setCurrentUser, setCurrentProject, setSearchQuery, setSortOption,
    setFilterAssignee, setFilterPriority, setFilterTag, setFilterUnreadOnly,
    setFilterWorktree, clearTaskFilters, setView, setSettingsTab, setModalTask,
    pushOverlay, popOverlay, closeModal, openTaskModal, openTaskFullView, openTask,
    clearOpenModalScrollToComments, refreshWorktrees, setChangesFocus,
    triggerRefresh, subscribeToEvent, notifyWorkspaceSet, switchWorkspace,
    refreshWorkspaces, saveConfig, ensureReadStateLoaded, markCommentRead,
    markAllCommentsRead, setAppTheme, toggleTheme, refreshNotifications,
    markOnboardingComplete, clearEngineEvents,
  };

  const actions = useMemo<AppActions>(() => ({
    setCurrentUser: (v) => latest.current.setCurrentUser(v),
    setCurrentProject: (v) => latest.current.setCurrentProject(v),
    setSearchQuery: (v) => latest.current.setSearchQuery(v),
    setSortOption: (v) => latest.current.setSortOption(v),
    setFilterAssignee: (v) => latest.current.setFilterAssignee(v),
    setFilterPriority: (v) => latest.current.setFilterPriority(v),
    setFilterTag: (v) => latest.current.setFilterTag(v),
    setFilterUnreadOnly: (v) => latest.current.setFilterUnreadOnly(v),
    setFilterWorktree: (v) => latest.current.setFilterWorktree(v),
    clearTaskFilters: () => latest.current.clearTaskFilters(),
    setView: (v) => latest.current.setView(v),
    setSettingsTab: (v) => latest.current.setSettingsTab(v),
    setModalTask: (v) => latest.current.setModalTask(v),
    pushOverlay: () => latest.current.pushOverlay(),
    popOverlay: () => latest.current.popOverlay(),
    closeModal: () => latest.current.closeModal(),
    openTaskModal: (t) => latest.current.openTaskModal(t),
    openTaskFullView: (t, o) => latest.current.openTaskFullView(t, o),
    openTask: (t) => latest.current.openTask(t),
    clearOpenModalScrollToComments: () => latest.current.clearOpenModalScrollToComments(),
    refreshWorktrees: () => latest.current.refreshWorktrees(),
    setChangesFocus: (v) => latest.current.setChangesFocus(v),
    triggerRefresh: () => latest.current.triggerRefresh(),
    subscribeToEvent: (t, h) => latest.current.subscribeToEvent(t, h),
    notifyWorkspaceSet: () => latest.current.notifyWorkspaceSet(),
    switchWorkspace: (p) => latest.current.switchWorkspace(p),
    refreshWorkspaces: () => latest.current.refreshWorkspaces(),
    saveConfig: (u) => latest.current.saveConfig(u),
    ensureReadStateLoaded: (id) => latest.current.ensureReadStateLoaded(id),
    markCommentRead: (id, cid) => latest.current.markCommentRead(id, cid),
    markAllCommentsRead: (id, cids) => latest.current.markAllCommentsRead(id, cids),
    setAppTheme: (t) => latest.current.setAppTheme(t),
    toggleTheme: () => latest.current.toggleTheme(),
    refreshNotifications: () => latest.current.refreshNotifications(),
    markOnboardingComplete: () => latest.current.markOnboardingComplete(),
    clearEngineEvents: () => latest.current.clearEngineEvents(),
  }), []);

  // Snapshot mirrored into the external store. Memoized sub-objects (taskById,
  // prByBranch) and state refs stay stable across renders, so setState's shallow
  // diff only notifies subscribers whose selected slice actually changed.
  const snapshot: AppStoreState = {
    currentUser, currentProject, searchQuery, sortOption,
    filterAssignee, filterPriority, filterTag, filterUnreadOnly, filterWorktree,
    view, settingsTab, modalTask, isModalOpen,
    isOverlayOpen: overlayCount > 0,
    openModalScrollToComments, openModalInFullView,
    tasks, taskById, prByBranch, prMemberIds, worktreeBranches, worktrees,
    liveSessions: appStore.getState().liveSessions,
    engineEvents: appStore.getState().engineEvents,
    changesFocus, tasksLoading, taskLiveEvents, columnLiveEvents, pinnedTasks,
    refreshTrigger, lastRefreshAt, isWindowVisible, isConnected,
    workspaceConfigured, workspacePath, workspaces,
    config, readComments, totalUnreadCount,
    theme, parseErrors, parseErrorsLoading,
    notifications, notificationUnreadCount, restartPending,
    onboardingComplete,
  };

  // Seed the store during the first render, before children mount and subscribe,
  // so the very first `useAppSelector` read sees correct values (no flash). There
  // are no listeners yet, so this never notifies.
  const seededRef = useRef(false);
  if (!seededRef.current) {
    appStore.setState(snapshot);
    seededRef.current = true;
  }

  // Mirror React state into the store after each commit. The provider re-renders
  // on any state change (as before), but `children` is a stable element so the
  // subtree bails out; only store subscribers whose slice changed re-render.
  useLayoutEffect(() => {
    appStore.setState(snapshot);
  });

  return (
    <AppActionsContext.Provider value={actions}>
      {children}
    </AppActionsContext.Provider>
  );
}

// `useApp()` (the back-compat shim) is gone — all consumers now subscribe narrowly
// via `useAppSelector` / `useAppActions` from `./store/useAppSelector` (FLUX-625).
// `AppState` is retained as the public state+actions contract type.
