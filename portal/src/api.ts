import type { Task, Config, Doc, CliFramework, CliSessionSummary, ModuleDeclaration, TerminalSessionInfo, HistoryEntryDraft, OperationEvent, OperationKind, OperationOutcome } from './types';
import type { FurnaceBatch, BatchKind, BatchTrigger, BatchStatus, SlotInfo, ExcludedTicket, BatchTicket, FurnaceSlotHolder } from './furnaceTypes';

export const API_URL = '/api';

function encodeDocPath(docPath: string) {
  return docPath.split('/').map((segment) => encodeURIComponent(segment)).join('/');
}

// FLUX-1144: last-seen ETag per query variant (full vs `?active=true` serialize different sets,
// so each needs its own conditional-GET state). Module-level — the poll interval and every SSE-
// triggered refetch share one `fetchTasks` call site, so this is naturally a singleton per tab.
const taskListETags = new Map<string, string>();

/** Returns the parsed task list, or `null` when the server answered 304 (nothing changed since
 *  the last fetch of this same query variant) — callers should keep their current state as-is. */
export async function fetchTasks(opts?: { active?: boolean }): Promise<Task[] | null> {
  const variant = opts?.active ? 'active' : 'all';
  const query = opts?.active ? '?active=true' : '';
  const headers: HeadersInit = {};
  const knownEtag = taskListETags.get(variant);
  if (knownEtag) headers['If-None-Match'] = knownEtag;
  const res = await fetch(`${API_URL}/tasks${query}`, { headers });
  if (res.status === 304) return null;
  if (!res.ok) throw new Error('Failed to fetch tasks');
  const etag = res.headers.get('ETag');
  if (etag) taskListETags.set(variant, etag);
  else taskListETags.delete(variant);
  return res.json();
}

export interface ParseError {
  id: string;
  path: string;
  error: string;
}

export async function fetchParseErrors(): Promise<ParseError[]> {
  const res = await fetch(`${API_URL}/tasks/errors`);
  if (!res.ok) throw new Error('Failed to fetch parse errors');
  return res.json();
}

export interface UncommittedStatus {
  count: number;
  branch: string | null;
  /** Total files diverged from master across all task worktrees (committed + uncommitted) — FLUX-582. */
  diverged: number;
}

export async function fetchUncommittedStatus(): Promise<UncommittedStatus> {
  const res = await fetch(`${API_URL}/tasks/uncommitted-count`);
  if (!res.ok) throw new Error('Failed to fetch uncommitted status');
  const data = await res.json();
  return {
    count: typeof data?.count === 'number' ? data.count : 0,
    branch: typeof data?.branch === 'string' ? data.branch : null,
    diverged: typeof data?.diverged === 'number' ? data.diverged : 0,
  };
}

/**
 * Open VS Code: a specific repo-relative `file` (revealed via `code -g`), or the
 * workspace root in a new window when `file` is omitted. `ref` is the diff group's
 * ref — a branch name opens the file in that worktree's checkout; 'main'/omitted
 * uses the workspace root. False if `code` isn't on PATH.
 */
export async function openWorkspaceEditor(file?: string, ref?: string): Promise<boolean> {
  const body: Record<string, string> = {};
  if (file) body.file = file;
  if (ref) body.ref = ref;
  const res = await fetch(`${API_URL}/tasks/open-editor`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) return false;
  const data = await res.json();
  return !!data?.opened;
}

/**
 * Commit selected (repo-relative) files from the uncommitted panel (FLUX-554).
 * Commit-only — never pushes. `ref` is the diff group's ref ('main' → workspace
 * root; a branch → that worktree). Returns the new short hash, or an error string.
 */
export async function commitFiles(ref: string, files: string[], message: string): Promise<{ hash?: string; error?: string }> {
  const res = await fetch(`${API_URL}/tasks/commit`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ref, files, message }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) return { error: (data && data.error) || 'Commit failed' };
  return { hash: data?.hash };
}

export interface DiscardFileResult {
  file: string;
  ok: boolean;
  error?: string;
}

/**
 * Discard selected (repo-relative) files' UNCOMMITTED changes — restore each to its checkout's
 * HEAD state (FLUX-1333). Irreversible. `ref` matches `commitFiles` ('main' → workspace root; a
 * branch → that worktree). Per-file `results` (one failure never aborts the rest); a
 * request-level refusal (active agent session in the target tree, unresolvable worktree, …)
 * comes back as `error`.
 */
export async function discardFiles(ref: string, files: string[]): Promise<{ results?: DiscardFileResult[]; error?: string }> {
  const res = await fetch(`${API_URL}/tasks/discard`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ref, files }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) return { error: (data && data.error) || 'Discard failed' };
  return { results: data?.results ?? [] };
}

/**
 * Engine-side finish for a BRANCHLESS ticket (FLUX-618), zero-token sibling of `mergePr`. Stages the
 * EXPLICIT `files` (no silent `git add -A`), commits them with `message`, then advances the ticket to
 * Done (completion comment, implementationLink = commit hash, diff capture). Throws on engine error.
 */
export async function finishBranchless(
  taskId: string,
  body: { message: string; files: string[]; completionComment?: string },
): Promise<{ finished: boolean; hash: string; link: string }> {
  const res = await fetch(`${API_URL}/tasks/${taskId}/finish`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data && data.error) || 'Finish failed');
  return data;
}

export async function fetchTask(id: string): Promise<Task> {
  const res = await fetch(`${API_URL}/tasks/${id}`);
  if (!res.ok) throw new Error('Failed to fetch task');
  return res.json();
}

export interface PayloadSection {
  name: string;
  bytes: number;
  tokensEst: number;
  pct: number;
}

export interface AgentPayloadMetrics {
  id: string;
  totalBytes: number;
  totalTokensEst: number;
  sections: PayloadSection[];
  historyBreakdown: Array<{ name: string; count: number; bytes: number; tokensEst: number }>;
}

/** Debug-only: byte/token breakdown of the agent-facing get_ticket payload. */
export async function fetchTaskDebugSizes(id: string): Promise<AgentPayloadMetrics> {
  const res = await fetch(`${API_URL}/tasks/${id}/debug/sizes`);
  if (!res.ok) throw new Error('Failed to fetch payload sizes');
  return res.json();
}

/** Mirrors `engine/src/perf/registry.ts`'s `HistogramSnapshot` (FLUX-1129). */
export interface EnginePerfHistogram {
  count: number;
  sum: number;
  max: number;
  p50: number;
  p95: number;
}

/** Mirrors `engine/src/perf/registry.ts`'s `RegistrySnapshot` (FLUX-1129) — the `GET /api/perf` body. */
export interface EnginePerfSnapshot {
  counters: Record<string, number>;
  histograms: Record<string, EnginePerfHistogram>;
  uptimeSeconds: number;
  rss: number;
}

/** Not workspace-scoped — works even with no workspace configured (FLUX-1134 perf panel). */
export async function fetchEnginePerf(): Promise<EnginePerfSnapshot> {
  const res = await fetch(`${API_URL}/perf`);
  if (!res.ok) throw new Error('Failed to fetch perf snapshot');
  return res.json();
}

export interface BudgetSection {
  name: string;
  bytes: number;
  tokensEst: number;
  pct: number;
}

export interface SessionTokenTotals {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
}

export interface ContextBudget {
  ticketId: string;
  agentPayload: AgentPayloadMetrics;
  launchPrompt: {
    phase: string | null;
    totalBytes: number;
    totalTokensEst: number;
    sections: BudgetSection[];
    note: string;
  };
  skillModules: {
    /** FLUX-1377: bytes/tokens of just the installed core (.claude/rules), excluding the
     * injected phase module already counted in launchPrompt. */
    coreBytes: number;
    coreTokensEst: number;
    totalBytes: number;
    totalTokensEst: number;
    modules: Array<{ name: string; bytes: number; tokensEst: number; missing?: boolean }>;
    note: string;
  };
  /** FLUX-1376: EH's own MCP tool schemas, measured in-process — the actually-registered
   * set, with a per-tool breakdown (`.tools`, heaviest-first). */
  ehToolSchemas: McpServerSchemaMetrics;
  ehMeasurableTotalTokensEst: number;
  session?: SessionTokenTotals;
  caveats: string[];
}

/** Debug-only: full context-budget view — payload + launch prompt + skill modules. */
export async function fetchTaskContextBudget(id: string): Promise<ContextBudget> {
  const res = await fetch(`${API_URL}/tasks/${id}/debug/budget`);
  if (!res.ok) throw new Error('Failed to fetch context budget');
  return res.json();
}

export interface McpServerSchemaMetrics {
  id: string;
  source: string;
  ok: boolean;
  error?: string;
  toolCount: number;
  toolsBytes: number;
  toolsTokensEst: number;
  instructionsBytes: number;
  instructionsTokensEst: number;
  totalBytes: number;
  totalTokensEst: number;
  tools: Array<{ name: string; bytes: number; tokensEst: number }>;
}

export interface McpSchemaReport {
  servers: McpServerSchemaMetrics[];
  totalTokensEst: number;
  note: string;
}

/** Debug-only: probe module MCP servers and measure per-server tool-schema cost. Slow (spawns servers). */
export async function fetchMcpSchemas(): Promise<McpSchemaReport> {
  const res = await fetch(`${API_URL}/tasks/debug/mcp-schemas`);
  if (!res.ok) throw new Error('Failed to probe MCP schemas');
  return res.json();
}

export interface SpawnServersReport {
  strict: boolean;
  phases: Record<string, string[]>;
  note: string;
}

/** Debug-only: which MCP servers each phase's agent gets (per-phase profiles, FLUX-490). Cheap. */
export async function fetchSpawnServers(): Promise<SpawnServersReport> {
  const res = await fetch(`${API_URL}/tasks/debug/spawn-servers`);
  if (!res.ok) throw new Error('Failed to fetch spawn servers');
  return res.json();
}

export interface McpPhasesConfig {
  servers: string[];
  phases: string[];
  mcpServerPhases: Record<string, string[]>;
}

/** Per-phase MCP server scoping config (FLUX-490 UI). */
export async function fetchMcpPhases(): Promise<McpPhasesConfig> {
  const res = await fetch(`${API_URL}/config/mcp-phases`);
  if (!res.ok) throw new Error('Failed to fetch MCP phase config');
  return res.json();
}

export async function saveMcpPhases(mcpServerPhases: Record<string, string[]>): Promise<{ mcpServerPhases: Record<string, string[]> }> {
  const res = await fetch(`${API_URL}/config/mcp-phases`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mcpServerPhases }),
  });
  if (!res.ok) throw new Error('Failed to save MCP phase config');
  return res.json();
}

export async function updateTask(id: string, updates: Partial<Task> & { skipCommentRequirement?: boolean; appendHistory?: HistoryEntryDraft[] }): Promise<Task> {
  // FLUX-1485: 15s ceiling matching resolveBoardRebase (api.ts, FLUX-773) so a wedged engine can
  // never hold this connection open forever — every Approve surface (plan panel, AttentionDock,
  // chat card) funnels through this one call, and a hung PUT was starving the browser's per-origin
  // connection pool badly enough to brick the whole portal tab.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  let res: Response;
  try {
    res = await fetch(`${API_URL}/tasks/${id}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(updates),
      signal: controller.signal,
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      throw new Error('Timed out waiting for the engine to respond — is it wedged?', { cause: err });
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    let message = 'Failed to update task';
    let code: string | undefined;
    try {
      const errorPayload = await res.json();
      if (errorPayload.message) message = errorPayload.message;
      else if (errorPayload.error) message = errorPayload.error;
      if (typeof errorPayload?.error === 'string') code = errorPayload.error;
    } catch {
      // ignore
    }
    const err = new Error(message) as Error & { code?: string };
    if (code) err.code = code;
    throw err;
  }
  return res.json();
}

export interface TaskAssetUploadResult {
  path: string;
  fileName: string;
  url: string;
}

export async function uploadTaskAsset(id: string, payload: { fileName: string; mimeType: string; content: string }): Promise<TaskAssetUploadResult> {
  const res = await fetch(`${API_URL}/tasks/${id}/assets`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    let message = 'Failed to upload task asset';
    try {
      const errorPayload = await res.json();
      if (typeof errorPayload?.error === 'string' && errorPayload.error.trim()) {
        message = errorPayload.error.trim();
      }
    } catch {
      // Ignore JSON parse failures and fall back to the default message.
    }

    throw new Error(message);
  }

  return res.json();
}

export async function deleteTask(id: string): Promise<void> {
  const res = await fetch(`${API_URL}/tasks/${id}`, {
    method: 'DELETE'
  });
  if (!res.ok) throw new Error('Failed to delete task');
}

export async function fetchHealth(): Promise<{ status: string; workspace: string | null; ghAuthAvailable: boolean | null }> {
  const res = await fetch(`${API_URL}/health`);
  if (!res.ok) throw new Error('Failed to fetch health');
  return res.json();
}

export async function fetchWorkspace(): Promise<{ configured: boolean; path: string | null }> {
  const res = await fetch(`${API_URL}/workspace`);
  if (!res.ok) throw new Error('Failed to fetch workspace');
  return res.json();
}

export async function setWorkspace(folderPath: string): Promise<{ ok: boolean; path: string }> {
  const res = await fetch(`${API_URL}/workspace`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: folderPath }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Failed to set workspace');
  return data;
}

export async function pickWorkspaceFolder(): Promise<string | null> {
  const res = await fetch(`${API_URL}/workspace/pick`, { method: 'POST' });
  if (!res.ok) return null;
  const data = await res.json();
  return data.path ?? null;
}

// ─── In-app directory browser (FLUX-758) ────────────────────────────────────

export interface DirEntry {
  name: string;
  path: string;
}

export interface BrowseResult {
  /** Resolved directory being listed; '' when listing roots. */
  path: string;
  /** Parent directory, or null at a root / when listing roots. */
  parent: string | null;
  /** Immediate child directories (hidden dotfiles skipped, sorted). */
  entries: DirEntry[];
  /** Present only when listing roots; the available top-level roots. */
  roots?: string[];
}

/**
 * List the immediate child directories of an absolute path, or the available
 * roots when `path` is omitted. Backs the in-app folder picker that replaces
 * the native OS dialog during onboarding.
 */
export async function browseDirectory(path?: string): Promise<BrowseResult> {
  const qs = path ? `?path=${encodeURIComponent(path)}` : '';
  const res = await fetch(`${API_URL}/workspace/browse${qs}`);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Failed to read folder');
  return data;
}

// ─── Workspaces (multi-project) ─────────────────────────────────────────────

export interface WorkspaceGroupInfo {
  groupName: string;
  role: 'parent' | 'member';
  parentPath: string;
  memberName?: string;
}

export interface WorkspaceInfo {
  path: string;
  label?: string;
  displayName: string;
  active: boolean;
  available: boolean;
  group?: WorkspaceGroupInfo;
}

export async function fetchWorkspaces(): Promise<WorkspaceInfo[]> {
  const res = await fetch(`${API_URL}/workspaces`);
  if (!res.ok) return [];
  return res.json();
}

export async function addWorkspace(wsPath: string, label?: string): Promise<WorkspaceInfo[]> {
  const res = await fetch(`${API_URL}/workspaces`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: wsPath, label }),
  });
  if (!res.ok) {
    const payload = await res.json().catch(() => ({}));
    throw new Error(payload.error || 'Failed to add workspace');
  }
  return res.json();
}

export async function removeWorkspace(index: number): Promise<WorkspaceInfo[]> {
  const res = await fetch(`${API_URL}/workspaces/${index}`, { method: 'DELETE' });
  if (!res.ok) throw new Error('Failed to remove workspace');
  return res.json();
}

export async function updateWorkspaceLabel(index: number, label: string): Promise<WorkspaceInfo[]> {
  const res = await fetch(`${API_URL}/workspaces/${index}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ label }),
  });
  if (!res.ok) throw new Error('Failed to update workspace label');
  return res.json();
}

export interface SwitchResult {
  ok: boolean;
  path: string;
}

export interface SwitchBlockedResult {
  blocked: true;
  activeSessions: number;
  message: string;
}

export async function switchWorkspace(wsPath: string, force?: boolean): Promise<SwitchResult | SwitchBlockedResult> {
  const res = await fetch(`${API_URL}/workspaces/switch`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: wsPath, force }),
  });
  if (res.status === 409) {
    const payload = await res.json();
    return { blocked: true, activeSessions: payload.activeSessions, message: payload.message };
  }
  if (!res.ok) {
    const payload = await res.json().catch(() => ({}));
    throw new Error(payload.error || 'Failed to switch workspace');
  }
  return res.json();
}

export async function fetchConfig(): Promise<Config> {
  const res = await fetch(`${API_URL}/config`);
  if (!res.ok) throw new Error('Failed to fetch config');
  const config: Config = await res.json();
  // FLUX-906 (audit E.1/E.8): the board sentinel must stay in lockstep with the engine. The portal
  // keeps a sync constant (BOARD_CONVERSATION_ID, needed at module-eval by 30+ call sites that can't
  // await config), but cross-check it against the engine-served value in dev so drift is caught
  // immediately instead of silently splitting the orchestrator chat across two ids.
  if (import.meta.env.DEV && config.boardConversationId && config.boardConversationId !== BOARD_CONVERSATION_ID) {
    console.warn(`[config] boardConversationId drift: engine='${config.boardConversationId}' portal='${BOARD_CONVERSATION_ID}' — update portal/src/api.ts to match engine/src/agents/board.ts.`);
  }
  // FLUX-1209: same drift check for the Furnace-chat sentinel.
  if (import.meta.env.DEV && config.furnaceConversationId && config.furnaceConversationId !== FURNACE_CONVERSATION_ID) {
    console.warn(`[config] furnaceConversationId drift: engine='${config.furnaceConversationId}' portal='${FURNACE_CONVERSATION_ID}' — update portal/src/api.ts to match engine/src/agents/board.ts.`);
  }
  return config;
}

export async function fetchModuleCatalog(): Promise<ModuleDeclaration[]> {
  const res = await fetch(`${API_URL}/config/modules/catalog`);
  if (!res.ok) throw new Error('Failed to fetch module catalog');
  return res.json();
}

export async function fetchModuleStatuses(): Promise<Record<string, import('./types').ProbeResult>> {
  const res = await fetch(`${API_URL}/config/modules/status`);
  if (!res.ok) throw new Error('Failed to fetch module statuses');
  return res.json();
}

export async function triggerModuleProbe(id: string): Promise<void> {
  await fetch(`${API_URL}/config/modules/${encodeURIComponent(id)}/probe`, { method: 'POST' });
}

export async function fetchDocs(): Promise<Doc[]> {
  const res = await fetch(`${API_URL}/docs`);
  if (!res.ok) throw new Error('Failed to fetch docs');
  return res.json();
}

export async function fetchDoc(docPath: string): Promise<Doc> {
  const res = await fetch(`${API_URL}/docs/${encodeDocPath(docPath)}`);
  if (!res.ok) throw new Error('Failed to fetch doc');
  return res.json();
}

export async function createDoc(payload: { path: string; title?: string; body?: string; order?: number }): Promise<Doc> {
  const res = await fetch(`${API_URL}/docs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error('Failed to create doc');
  return res.json();
}

export async function updateDoc(docPath: string, payload: { title?: string; body?: string; order?: number | null }): Promise<Doc> {
  const res = await fetch(`${API_URL}/docs/${encodeDocPath(docPath)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error('Failed to save doc');
  return res.json();
}

export async function deleteDoc(docPath: string): Promise<void> {
  const res = await fetch(`${API_URL}/docs/${encodeDocPath(docPath)}`, {
    method: 'DELETE',
  });
  if (!res.ok) throw new Error('Failed to delete doc');
}

/** Rename a docs folder, moving every local doc under `from/` to `to/`. */
export async function renameDocsFolder(from: string, to: string): Promise<void> {
  const res = await fetch(`${API_URL}/docs/rename-folder`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ from, to }),
  });
  if (!res.ok) {
    let message = 'Failed to rename folder';
    try { const payload = await res.json(); if (payload.error) message = payload.error; } catch {}
    throw new Error(message);
  }
}

export interface SkillStatus {
  framework: 'copilot' | 'antigravity' | 'gemini' | 'cursor' | 'cline' | 'windsurf' | 'claude' | 'generic';
  skillSourcePath: string;
  skillSourcePaths: string[];
  skillInstalledPath: string;
  skillSourceExists: boolean;
  skillInstalled: boolean;
  instructionsSourcePath?: string;
  instructionsInstalledPath?: string;
  instructionsSourceExists: boolean;
  instructionsInstalled: boolean;
  workflowInstalled: boolean;
}

export async function fetchSkillStatus(framework: string = 'auto'): Promise<SkillStatus> {
  const res = await fetch(`${API_URL}/skill/status?framework=${framework}`);
  if (!res.ok) {
    const payload = await res.json().catch(() => ({}));
    throw new Error(payload.error || 'Failed to fetch skill status');
  }
  return res.json();
}

export async function installWorkspaceSkill(framework: string = 'auto'): Promise<{ success: boolean; skillInstalledPath: string; instructionsInstalledPath?: string }> {
  const res = await fetch(`${API_URL}/skill/install`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ framework }),
  });
  if (!res.ok) {
    const payload = await res.json().catch(() => ({}));
    throw new Error(payload.error || 'Failed to install skill');
  }
  return res.json();
}

export const saveConfig = async (config: Config): Promise<Config> => {
  const response = await fetch(`${API_URL}/config`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(config),
  });
  if (!response.ok) throw new Error('Failed to save config');
  return response.json();
};

export type ReadState = Record<string, Record<string, string[]>>;

export async function fetchReadState(): Promise<ReadState> {
  const res = await fetch(`${API_URL}/read-state`);
  if (!res.ok) return {};
  return res.json();
}

export async function saveReadState(patch: ReadState): Promise<ReadState> {
  const res = await fetch(`${API_URL}/read-state`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });
  if (!res.ok) throw new Error('Failed to save read state');
  return res.json();
}

export const bulkRename = async (payload: { tags?: Record<string, string>, statuses?: Record<string, string>, users?: Record<string, string>, priorities?: Record<string, string> }): Promise<{success: boolean, modifiedCount: number}> => {
  const response = await fetch(`${API_URL}/bulk-rename`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!response.ok) throw new Error('Failed to bulk rename');
  return response.json();
};

/** FLUX-1300: fired on `window` right after `createTask` resolves, so the creating tab (and only
 *  that tab) can scroll its new card into view — distinct from the `taskCreated` SSE broadcast,
 *  which every OTHER tab uses to reconcile via `loadTasks()` but never triggers a scroll from. */
export const TASK_CREATED_LOCALLY_EVENT = 'flux:task-created-locally';

export async function createTask(taskData: Partial<Task> & { projectKey: string, author: string }): Promise<Task> {
  const res = await fetch(`${API_URL}/tasks`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(taskData)
  });
  if (!res.ok) throw new Error('Failed to create task');
  const task: Task = await res.json();
  window.dispatchEvent(new CustomEvent(TASK_CREATED_LOCALLY_EVENT, { detail: { id: task.id } }));
  return task;
}

export async function fetchTaskCliSession(taskId: string): Promise<CliSessionSummary | null> {
  const res = await fetch(`${API_URL}/tasks/${taskId}/cli-session`);
  if (!res.ok) throw new Error('Failed to fetch CLI session');
  const payload = await res.json();
  return payload.session || null;
}

export interface StartSessionOptions {
  /** FLUX-906: optional — omit it to let the ENGINE resolve the configured default
   *  (`resolveDefaultFramework()`), so a fresh chat follows `defaultAgent` instead of being
   *  hardcoded to Claude. Callers that already know the framework (launchers) still pass it. */
  framework?: CliFramework;
  appendPrompt?: string;
  /** Resolve the prompt server-side from a persona catalog id (preferred). */
  personaId?: string;
  /** Optional user focus note appended to the resolved persona prompt. */
  focusComment?: string;
  skipPermissions?: boolean;
  effortOverride?: string;
  /** Per-conversation model override (chat picker). */
  model?: string;
  /** Per-conversation permission mode (chat picker): 'gated' | 'skip'. */
  permissionMode?: string;
  /** Launch phase / intent — tells the engine what action instruction to use. */
  phase?: string;
  role?: string;
  pattern?: string;
  patternPosition?: string;
  groupId?: string;
  groupSeq?: number;
  groupTotal?: number;
  groupType?: string;
  groupVariant?: string;
  lockedPaths?: string[];
  /** FLUX-674: pasted-image attachments to send with the opening chat turn. */
  attachments?: ChatAttachment[];
  /** FLUX-1235/1456: reclaim an idle parked `waiting-input` session instead of 409-ing. */
  supersedeParked?: boolean;
}

export async function startTaskCliSessionEx(taskId: string, opts: StartSessionOptions): Promise<CliSessionSummary> {
  const { framework, appendPrompt, personaId, focusComment, skipPermissions = true, effortOverride, model, permissionMode, phase, role, pattern, patternPosition, groupId, groupSeq, groupTotal, groupType, groupVariant, lockedPaths, attachments, supersedeParked } = opts;
  const body: Record<string, unknown> = { skipPermissions };
  // FLUX-906: omit `framework` when unset so the engine resolves the configured default.
  if (framework) body.framework = framework;
  if (appendPrompt) body.appendPrompt = appendPrompt;
  if (attachments?.length) body.attachments = attachments;
  if (personaId) body.personaId = personaId;
  if (focusComment) body.focusComment = focusComment;
  if (effortOverride) body.effortOverride = effortOverride;
  if (model) body.model = model;
  if (permissionMode) body.permissionMode = permissionMode;
  if (phase) body.phase = phase;
  if (role) body.role = role;
  if (pattern) body.pattern = pattern;
  if (patternPosition) body.patternPosition = patternPosition;
  if (groupId) body.groupId = groupId;
  if (groupSeq != null) body.groupSeq = groupSeq;
  if (groupTotal != null) body.groupTotal = groupTotal;
  if (groupType) body.groupType = groupType;
  if (groupVariant) body.groupVariant = groupVariant;
  if (lockedPaths?.length) body.lockedPaths = lockedPaths;
  if (supersedeParked) body.supersedeParked = true;

  const res = await fetch(`${API_URL}/tasks/${taskId}/cli-session/start`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const payload = await res.json().catch(() => ({}));
    throw new Error(payload.error || 'Failed to start CLI session');
  }
  const payload = await res.json();
  return payload.session;
}

/** FLUX-1289: "Re-run review" — the portal's manual entry point for one plan-review pass (the REST
 *  twin of the `start_plan_review` MCP tool, for a human clicking a button instead of an agent). */
export async function startPlanReview(taskId: string): Promise<{ ok: boolean; message: string }> {
  const res = await fetch(`${API_URL}/tasks/${taskId}/plan-review/start`, { method: 'POST' });
  const payload = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(payload.error || 'Failed to start plan review');
  return payload;
}

/** FLUX-1303: "Send for re-grooming" — the atomic revise entry point. One engine call records the
 *  user's notes as an attributed comment, stamps the changes-requested verdict, dispatches the
 *  grooming revise session, and registers it with the plan-gate runner so the revision is
 *  automatically re-reviewed. Replaces the old two-step (dispatch session, then a follow-up PUT to
 *  clear the verdict) that could strand a stale changes-requested card when the second call failed. */
export async function startPlanRevise(taskId: string, opts: { notes?: string; user?: string } = {}): Promise<{ ok: boolean; message: string }> {
  const res = await fetch(`${API_URL}/tasks/${taskId}/plan-review/revise`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(opts),
  });
  const payload = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(payload.error || 'Failed to send the plan for re-grooming');
  return payload;
}

export interface RegisterCombinerOptions {
  framework: CliFramework;
  groupId: string;
  role: string;
  /** Prompt text, or omit and pass personaId to resolve it server-side. */
  appendPrompt?: string;
  /** Resolve the combiner prompt server-side from a persona catalog id. */
  personaId?: string;
  /** Launch phase — picks the shared phase contract composed onto the persona's lens. */
  phase?: string;
  expectedWorkers: number;
  skipPermissions?: boolean;
  groupType?: string;
  groupVariant?: string;
}

/**
 * Register a deferred combiner for a scatter-gather run group. The engine spawns
 * it only once every worker session in the group reaches a terminal state,
 * preventing the combiner from racing (and out-running) its workers.
 */
export async function registerDeferredCombiner(taskId: string, opts: RegisterCombinerOptions): Promise<void> {
  const body: Record<string, unknown> = {
    framework: opts.framework,
    groupId: opts.groupId,
    role: opts.role,
    expectedWorkers: opts.expectedWorkers,
    skipPermissions: opts.skipPermissions ?? true,
  };
  if (opts.appendPrompt) body.appendPrompt = opts.appendPrompt;
  if (opts.personaId) body.personaId = opts.personaId;
  if (opts.phase) body.phase = opts.phase;
  if (opts.groupType) body.groupType = opts.groupType;
  if (opts.groupVariant) body.groupVariant = opts.groupVariant;

  const res = await fetch(`${API_URL}/tasks/${taskId}/cli-session/register-combiner`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const payload = await res.json().catch(() => ({}));
    throw new Error(payload.error || 'Failed to register combiner');
  }
}

/** Cancel a previously registered deferred combiner (e.g. when no workers started). */
export async function unregisterDeferredCombiner(taskId: string, groupId: string): Promise<void> {
  const res = await fetch(`${API_URL}/tasks/${taskId}/cli-session/unregister-combiner`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ groupId }),
  });
  if (!res.ok) {
    const payload = await res.json().catch(() => ({}));
    throw new Error(payload.error || 'Failed to unregister combiner');
  }
}

export interface RelayStepDef {
  personaId: string;
  role: string;
  focusComment?: string;
}

export interface RegisterRelayOptions {
  framework: CliFramework;
  groupId: string;
  steps: RelayStepDef[];
  skipPermissions?: boolean;
  effortOverride?: string;
  /** Launch phase shared by every step — picks each step's phase contract. */
  phase?: string;
}

/**
 * Register a relay pipeline with the engine. The engine stores the full step
 * chain and automatically spawns subsequent steps as each one finishes.
 * The portal only needs to launch step 0 after registration.
 */
export async function registerRelayChain(taskId: string, opts: RegisterRelayOptions): Promise<void> {
  const res = await fetch(`${API_URL}/tasks/${taskId}/cli-session/register-relay`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      framework: opts.framework,
      groupId: opts.groupId,
      steps: opts.steps,
      skipPermissions: opts.skipPermissions ?? true,
      effortOverride: opts.effortOverride ?? '',
      ...(opts.phase ? { phase: opts.phase } : {}),
    }),
  });
  if (!res.ok) {
    const payload = await res.json().catch(() => ({}));
    throw new Error(payload.error || 'Failed to register relay chain');
  }
}

/** Cancel a pending relay pipeline (e.g. when step 0 fails to launch). */
export async function unregisterRelayChain(taskId: string, groupId: string): Promise<void> {
  const res = await fetch(`${API_URL}/tasks/${taskId}/cli-session/unregister-relay`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ groupId }),
  });
  if (!res.ok) {
    const payload = await res.json().catch(() => ({}));
    throw new Error(payload.error || 'Failed to unregister relay chain');
  }
}

export type PersonaRole = 'lead' | 'worker' | 'flex';

/** Orchestration persona metadata (no prompt text — the engine owns prompts). */
export interface OrchestrationPersonaMeta {
  id: string;
  label: string;
  description: string;
  /** Role determines which workflow slots this persona can fill. */
  role: PersonaRole;
  /** Relevant phases (suggestion filter, not a hard gate). Empty = all phases. */
  phases: string[];
  requiredCapabilities: string[];
  /** True for code-defined personas (read-only — cannot be edited or deleted). */
  builtIn?: boolean;
}

/** Full custom persona including prompt (only ever returned for editable personas). */
export interface OrchestrationPersona extends OrchestrationPersonaMeta {
  prompt: string;
}

/** Fetch the selectable orchestration personas (metadata only) from the engine. */
export async function fetchOrchestrationPersonas(phase?: string): Promise<OrchestrationPersonaMeta[]> {
  const qs = phase ? `?phase=${encodeURIComponent(phase)}` : '';
  const res = await fetch(`${API_URL}/orchestration/personas${qs}`);
  if (!res.ok) {
    const payload = await res.json().catch(() => ({}));
    throw new Error(payload.error || 'Failed to load orchestration personas');
  }
  const payload = await res.json();
  return payload.personas ?? [];
}

/** Fetch a single custom persona with its prompt for editing (built-ins 404). */
export async function fetchEditablePersona(id: string): Promise<OrchestrationPersona> {
  const res = await fetch(`${API_URL}/orchestration/personas/${encodeURIComponent(id)}`);
  if (!res.ok) {
    const payload = await res.json().catch(() => ({}));
    throw new Error(payload.error || 'Failed to load persona');
  }
  const payload = await res.json();
  return payload.persona;
}

export interface PersonaInput {
  id?: string;
  label: string;
  description?: string;
  role: PersonaRole;
  phases?: string[];
  requiredCapabilities?: string[];
  prompt: string;
}

/** Create a new custom persona. */
export async function createPersona(input: PersonaInput): Promise<OrchestrationPersonaMeta> {
  const res = await fetch(`${API_URL}/orchestration/personas`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  const payload = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(payload.error || 'Failed to create persona');
  return payload.persona;
}

/** Update an existing custom persona. */
export async function updatePersona(id: string, input: PersonaInput): Promise<OrchestrationPersonaMeta> {
  const res = await fetch(`${API_URL}/orchestration/personas/${encodeURIComponent(id)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  const payload = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(payload.error || 'Failed to update persona');
  return payload.persona;
}

/** Delete a custom persona (built-ins refused server-side). */
export async function deletePersona(id: string): Promise<void> {
  const res = await fetch(`${API_URL}/orchestration/personas/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  });
  if (!res.ok) {
    const payload = await res.json().catch(() => ({}));
    throw new Error(payload.error || 'Failed to delete persona');
  }
}

// ── Workflow templates ───────────────────────────────────────────────────────

export type WorkflowPhase = 'grooming' | 'implementation' | 'review' | 'finalize';

/** Per-phase orchestration config inside a workflow template. */
export interface WorkflowPhaseConfig {
  pattern: string;
  steps?: string[];
  parallel?: string[];
  combiner?: string;
  lead?: string;
  assistants?: string[];
}

/** A reusable workflow template (per-phase persona/pattern setup). */
export interface WorkflowTemplate {
  id: string;
  name: string;
  cliTarget: string;
  phases: Partial<Record<WorkflowPhase, WorkflowPhaseConfig>>;
  createdAt: string;
  updatedAt: string;
  /** True for code-defined templates (read-only, forkable). */
  builtIn?: boolean;
}

export type WorkflowInput = Pick<WorkflowTemplate, 'name' | 'cliTarget' | 'phases'>;

/** All persona ids configured for a phase (lead + workers), regardless of how the pattern stores them. */
export function workflowPhaseMembers(cfg: WorkflowPhaseConfig | undefined): string[] {
  if (!cfg) return [];
  const lead = cfg.pattern === 'supervisor' ? cfg.lead : cfg.pattern === 'scatter' ? cfg.combiner : undefined;
  const workers = cfg.pattern === 'relay' ? (cfg.steps ?? [])
    : cfg.pattern === 'supervisor' ? (cfg.assistants ?? [])
    : (cfg.parallel ?? []);
  return lead ? [lead, ...workers] : workers;
}

/** List all workflow templates. */
export async function fetchWorkflows(): Promise<WorkflowTemplate[]> {
  const res = await fetch(`${API_URL}/workflows`);
  if (!res.ok) throw new Error('Failed to load workflows');
  return res.json();
}

/** Create a workflow template. */
export async function createWorkflow(input: WorkflowInput): Promise<WorkflowTemplate> {
  const res = await fetch(`${API_URL}/workflows`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  const payload = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(payload.error || 'Failed to create workflow');
  return payload;
}

/** Update a workflow template. */
export async function updateWorkflow(id: string, input: Partial<WorkflowInput>): Promise<WorkflowTemplate> {
  const res = await fetch(`${API_URL}/workflows/${encodeURIComponent(id)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  const payload = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(payload.error || 'Failed to update workflow');
  return payload;
}

/** Delete a workflow template. */
export async function deleteWorkflow(id: string): Promise<void> {
  const res = await fetch(`${API_URL}/workflows/${encodeURIComponent(id)}`, { method: 'DELETE' });
  if (!res.ok) {
    const payload = await res.json().catch(() => ({}));
    throw new Error(payload.error || 'Failed to delete workflow');
  }
}

export async function fetchTaskCliSessions(taskId: string): Promise<CliSessionSummary[]> {
  const res = await fetch(`${API_URL}/tasks/${taskId}/cli-sessions`);
  if (!res.ok) throw new Error('Failed to fetch CLI sessions');
  const payload = await res.json();
  return payload.sessions || [];
}

/** FLUX-604: reserved conversation id for the board-level orchestrator chat.
 *  FLUX-906 (audit E.1/E.8): this is the portal's single SYNC source — 30+ call sites compare against
 *  it at render/handler time and can't await /api/config, so the constant stays. It mirrors
 *  engine/src/agents/board.ts (`BOARD_CONVERSATION_ID`) and is served on /api/config as
 *  `boardConversationId`; `fetchConfig()` cross-checks the two in dev so drift can't go unnoticed. */
export const BOARD_CONVERSATION_ID = '__board__';

/** FLUX-1209: reserved conversation id for the Furnace Operator ("Smelter") chat — its own
 *  non-ticket-scoped conversation, distinct from the board orchestrator's. Same sync-constant
 *  contract as {@link BOARD_CONVERSATION_ID}: mirrors engine/src/agents/board.ts
 *  (`FURNACE_CONVERSATION_ID`), served on /api/config as `furnaceConversationId`, cross-checked
 *  in dev by `fetchConfig()` above. */
export const FURNACE_CONVERSATION_ID = '__furnace__';

/** FLUX-674: an image attached to a user chat turn (paste / drop / file picker). */
export interface ChatAttachment {
  /** API URL to display the image (e.g. `/api/assets/FLUX-1/foo.png`). */
  url: string;
  /** Flux-dir-relative stored path (`assets/FLUX-1/foo.png`) — sent to the engine so it can
   *  resolve the absolute on-disk path and reference the file in the agent prompt. */
  path: string;
  fileName: string;
}

/** FLUX-602: a parsed chat message from a ticket's durable transcript. */
export interface TranscriptMessage {
  /** FLUX-745: `note` is a non-bubble system/automated row, rendered as a quiet chip (e.g. the
   *  resume-preamble "⟳ context update") rather than a user/assistant bubble. */
  role: 'user' | 'assistant' | 'tool' | 'note';
  text: string;
  ts: string;
  /** FLUX-745: subkind of a `note` row. `'context-update'` = warm-resume situational update
   *  (FLUX-655/FLUX-745); `'action'` = the pressed phase-launch action (FLUX-794);
   *  `'permission'` = a gated-tool approval request/decision round-trip (FLUX-833);
   *  `'dispatch'` = a dispatched session's live activity teed to the board thread (FLUX-849). */
  kind?: 'context-update' | 'action' | 'permission' | 'dispatch';
  /** FLUX-849: on a `dispatch` note, the source ticket the dispatched session is working. */
  sourceTask?: string;
  /** FLUX-849: on a `dispatch` note, the session-lifecycle stage this row narrates. Mirrors the
   *  engine's `DispatchLifecycle` union so a drift in either side is a compile error, not a silent
   *  fallthrough to the raw-enum chip label. */
  lifecycle?: 'started' | 'working' | 'completed' | 'failed' | 'cancelled' | 'waiting-input';
  /** FLUX-865: on a `dispatch` note, the work phase the dispatched session is running (groom /
   *  implement / review / finalize). Mirrors the engine's `AgentSession.phase` union so the board
   *  chip can say *what kind* of session a row narrates. Absent on older rows / non-phase sessions. */
  phase?: 'grooming' | 'implementation' | 'review' | 'finalize' | 'fast-path';
  /** FLUX-869: on a `dispatch` note, the dispatched session's start time (ISO) — powers the board
   *  chip's run-duration token (live-ticking `running Xm` while working, final `ran Xm` on terminal
   *  rows). Absent on older rows; the chip omits the duration token when missing. */
  startedAt?: string;
  /** FLUX-661: normalized tool name for an edit-ish tool row (`Edit`, `Write`, …). */
  tool?: string;
  /** FLUX-661: repo-relative path of the file an edit tool touched. When present (and the
   *  chat knows the branch), the tool row renders an expandable inline diff of that file. */
  path?: string;
  /** FLUX-688: per-edit line counts (what *this* tool call changed, not the file's cumulative
   *  diff). Rendered as colored `+N −M` on the inline edit-diff row. */
  added?: number;
  removed?: number;
  /** FLUX-674: images attached to a user turn — rendered inline in the user bubble. */
  attachments?: ChatAttachment[];
}

export async function fetchTaskTranscript(taskId: string): Promise<TranscriptMessage[]> {
  const res = await fetch(`${API_URL}/tasks/${taskId}/transcript`);
  if (!res.ok) throw new Error('Failed to fetch transcript');
  const payload = await res.json();
  return payload.messages || [];
}

/** FLUX-867: server-side filters for the board Activity feed. All optional; omitted/empty
 *  fields are not sent. `from`/`to` are ISO timestamps. */
export interface BoardActivityFilters {
  ticket?: string;
  phase?: string;
  lifecycle?: string;
  from?: string;
  to?: string;
  limit?: number;
}

/**
 * FLUX-867: fetch the durable board Activity/History feed — the `kind:'dispatch'` lifecycle rows
 * replayed from the `__board__` transcript, newest-first, filtered server-side so the unbounded
 * transcript is never shipped whole. Backs the Activity screen.
 */
export async function fetchBoardActivity(filters: BoardActivityFilters = {}): Promise<TranscriptMessage[]> {
  const params = new URLSearchParams();
  if (filters.ticket) params.set('ticket', filters.ticket);
  if (filters.phase) params.set('phase', filters.phase);
  if (filters.lifecycle) params.set('lifecycle', filters.lifecycle);
  if (filters.from) params.set('from', filters.from);
  if (filters.to) params.set('to', filters.to);
  if (filters.limit) params.set('limit', String(filters.limit));
  const qs = params.toString();
  const res = await fetch(`${API_URL}/tasks/${BOARD_CONVERSATION_ID}/activity${qs ? `?${qs}` : ''}`);
  if (!res.ok) throw new Error('Failed to fetch board activity');
  const payload = await res.json();
  return payload.messages || [];
}

/** Wipe a conversation's durable transcript (backs the orchestrator "reset"). */
export async function clearTaskTranscript(taskId: string): Promise<void> {
  const res = await fetch(`${API_URL}/tasks/${taskId}/transcript`, { method: 'DELETE' });
  if (!res.ok) {
    const payload = await res.json().catch(() => ({}));
    throw new Error(payload.error || 'Failed to clear transcript');
  }
}

/** FLUX-605: a gated tool call awaiting human approval. */
export interface PendingApproval {
  id: string;
  toolName: string;
  input: unknown;
  conversationId: string | null;
  createdAt: string;
}

export async function fetchPendingApprovals(): Promise<PendingApproval[]> {
  const res = await fetch(`${API_URL}/board/permission-pending`);
  if (!res.ok) return [];
  const payload = await res.json();
  return payload.pending || [];
}

export async function resolvePermission(id: string, behavior: 'allow' | 'deny', message?: string): Promise<void> {
  await fetch(`${API_URL}/board/permission-resolve`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id, behavior, message }),
  });
}

/** FLUX-659: the verbs the board-rebase ritual can propose. */
export type BoardRebaseKind = 'promote' | 'fold' | 'archive' | 'dispatch' | 'status' | 'leave';

/** FLUX-659: a single proposed restructuring within a board-rebase batch. */
export interface BoardRebaseItem {
  id: string;
  kind: BoardRebaseKind;
  targets: string[];
  summary: string;
  rationale?: string;
  newStatus?: string;
  phase?: string;
  into?: string;
}

/** FLUX-659: a parked board-rebase batch awaiting the user's per-item approval. */
export interface PendingBoardRebase {
  id: string;
  items: BoardRebaseItem[];
  conversationId: string | null;
  createdAt: string;
}

/** FLUX-659: the outcome of applying one approved (or skipped) board-rebase item. */
export interface BoardRebaseItemResult {
  id: string;
  kind: BoardRebaseKind;
  ok: boolean;
  message: string;
}

/**
 * FLUX-729: a client-side snapshot of the FAILED items from a resolved board-rebase batch.
 * The engine broadcasts `board-rebase-resolved` synchronously on resolve, which drops the batch
 * from the pending queue (unmounting its card) — so per-item failures would vanish if held only
 * in the card. This snapshot lives in its own provider queue so failures stay visible (and
 * dismissable) after the pending batch is gone. `items` is the original batch (joined by id to
 * give each failed result its summary/targets context); `failed` is the `ok === false` subset.
 */
export interface BoardRebaseFailure {
  batchId: string;
  conversationId: string | null;
  createdAt: string;
  items: BoardRebaseItem[];
  failed: BoardRebaseItemResult[];
}

export async function fetchPendingBoardRebases(): Promise<PendingBoardRebase[]> {
  const res = await fetch(`${API_URL}/board/board-rebase`);
  if (!res.ok) return [];
  const payload = await res.json();
  return payload.pending || [];
}

export async function resolveBoardRebase(
  id: string,
  approvedItemIds: string[],
): Promise<{ ok: boolean; results: BoardRebaseItemResult[]; expired?: boolean; timedOut?: boolean } | null> {
  // 15s ceiling so a slow/wedged engine can't leave the Apply button stuck in "submitting"
  // forever (FLUX-773). Distinguish the three failure modes so the UI can say what to do:
  //   timedOut → engine busy/hung; 404 (expired) → batch gone (restarted/already applied); null → network.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const res = await fetch(`${API_URL}/board/board-rebase-resolve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, approvedItemIds }),
      signal: controller.signal,
    });
    if (res.status === 404) return { ok: false, results: [], expired: true };
    if (!res.ok) return null;
    return res.json();
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') return { ok: false, results: [], timedOut: true };
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * FLUX-966: fetch the on-demand "Board Health" signals fragment (stale Grooming/Require Input,
 * orphaned subtasks, duplicate titles, dead PRs) for the portal to bake into the canned prompt it
 * sends the board orchestrator. The dead-PR check shells out to `gh pr view` per branch (capped
 * engine-side), so this can take a few seconds on a large board — 20s ceiling so the trigger
 * button can't hang forever on a wedged engine.
 */
export async function fetchTriageSignals(): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  try {
    const res = await fetch(`${API_URL}/board/triage-signals`, { signal: controller.signal });
    if (!res.ok) return null;
    const payload = await res.json();
    return typeof payload.fragment === 'string' ? payload.fragment : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** FLUX-662: one option within a structured question. */
export interface AskOption {
  label: string;
  description?: string;
}

/** FLUX-662: a single structured question posed by an agent via ask_user_question. */
export interface AskQuestion {
  question: string;
  header: string;
  options: AskOption[];
  multiSelect?: boolean;
}

/** FLUX-662: a parked ask_user_question call awaiting the user's selection. */
export interface PendingQuestion {
  id: string;
  questions: AskQuestion[];
  conversationId: string | null;
  createdAt: string;
}

export async function fetchPendingQuestions(): Promise<PendingQuestion[]> {
  const res = await fetch(`${API_URL}/board/pending-questions`);
  if (!res.ok) return [];
  const payload = await res.json();
  return payload.pending || [];
}

export async function answerQuestion(
  id: string,
  answers: Record<string, string | string[]>,
  notes?: string,
): Promise<void> {
  // FLUX-664: MUST throw on a failed POST. The picker resolves/removes the card only after this
  // resolves; if we swallowed a failure the await would "succeed", the card would vanish, yet the
  // engine would stay parked until timeout — stranding the agent. Surface the failure so the
  // caller keeps the card for a retry. The endpoint also returns HTTP 200 with `{ ok: false }`
  // when there was no parked question to resolve (already answered / timed out), so treat that as
  // a failure too — removing the card on `ok:false` would silently lose the user's selection.
  const res = await fetch(`${API_URL}/board/ask-question/${id}/answer`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ answers, notes }),
  });
  const payload = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(payload.error || 'Failed to submit answer');
  if (payload.ok === false) throw new Error('Question is no longer pending (already answered or timed out)');
}

export async function sendTaskCliInput(taskId: string, message: string, user: string, opts?: { model?: string; effort?: string; permissionMode?: string; attachments?: ChatAttachment[] }): Promise<CliSessionSummary> {
  const body: Record<string, unknown> = { message, user };
  if (opts?.model) body.model = opts.model;
  if (opts?.effort) body.effortOverride = opts.effort;
  // FLUX-1236: the "Default" chip is value '' — don't drop it. An explicit selection (including
  // Default, sent as the 'default' sentinel) must reach the engine so it can re-inherit the surface
  // default mode; only an omitted permissionMode (undefined) means "leave the mode unchanged". The
  // composer omits it on untouched sends (permissionTouched), so ordinary follow-ups never wipe it.
  if (opts?.permissionMode !== undefined) body.permissionMode = opts.permissionMode || 'default';
  if (opts?.attachments?.length) body.attachments = opts.attachments;
  const res = await fetch(`${API_URL}/tasks/${taskId}/cli-session/input`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const payload = await res.json().catch(() => ({}));
    throw new Error(payload.error || 'Failed to send CLI input');
  }
  const payload = await res.json();
  return payload.session;
}

export async function fetchPathInfo(): Promise<{ binaryDir: string | null; isPkg: boolean; platform: string }> {
  const res = await fetch(`${API_URL}/path-info`);
  if (!res.ok) throw new Error('Failed to fetch path info');
  return res.json();
}

export async function setupPath(mode: 'auto' | 'instructional'): Promise<{ ok: boolean; snippet: string | null; note?: string }> {
  const res = await fetch(`${API_URL}/path-setup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mode }),
  });
  if (!res.ok) {
    const payload = await res.json().catch(() => ({}));
    throw new Error(payload.error || 'Failed to set up PATH');
  }
  return res.json();
}

export async function stopTaskCliSession(
  taskId: string,
  opts?: { sessionId?: string; groupId?: string; stopAll?: boolean },
): Promise<CliSessionSummary> {
  const body = opts ?? {};
  const hasBody = !!(body.sessionId || body.groupId || body.stopAll);
  const res = await fetch(`${API_URL}/tasks/${taskId}/cli-session/stop`, {
    method: 'POST',
    headers: hasBody ? { 'Content-Type': 'application/json' } : undefined,
    body: hasBody ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const payload = await res.json().catch(() => ({}));
    throw new Error(payload.error || 'Failed to stop CLI session');
  }
  const payload = await res.json();
  return payload.session;
}

export async function fetchStorageMode(): Promise<{ mode: 'in-repo' | 'orphan' }> {
  const res = await fetch(`${API_URL}/storage/mode`);
  if (!res.ok) throw new Error('Failed to fetch storage mode');
  return res.json();
}

export async function migrateStorage(): Promise<{ ok: boolean; mode: string }> {
  const res = await fetch(`${API_URL}/storage/migrate`, { method: 'POST' });
  if (!res.ok) {
    const payload = await res.json().catch(() => ({}));
    throw new Error(payload.error || 'Migration failed');
  }
  return res.json();
}

export async function restoreStorage(): Promise<{ ok: boolean; mode: string }> {
  const res = await fetch(`${API_URL}/storage/restore`, { method: 'POST' });
  if (!res.ok) {
    const payload = await res.json().catch(() => ({}));
    throw new Error(payload.error || 'Restore failed');
  }
  return res.json();
}

export interface ConflictInfo {
  ticketId: string;
  localContent: string;
  remoteContent: string;
}

export type ResolutionStrategy = 'use-remote' | 'use-local' | 'rename-local' | 'manual';

/** Engine-owned, copy-paste fix steps for an auth sync failure (FLUX-895). */
export interface SyncRemediation {
  reason: string;
  commands: string[];
}

export interface SyncStatus {
  state: 'idle' | 'syncing' | 'synced' | 'conflict' | 'diverged' | 'error' | 'protocol-mismatch';
  lastSyncTime?: string;
  conflicts?: ConflictInfo[];
  // FLUX-1232: commit counts vs origin/flux-data, present when state === 'diverged'.
  ahead?: number;
  behind?: number;
  error?: string;
  errorType?: 'network' | 'auth' | 'conflict' | 'unknown';
  remediation?: SyncRemediation;
  // FLUX-1426: required vs supported sync-protocol version, present when state === 'protocol-mismatch'.
  required?: number;
  supported?: number;
}

export async function fetchSyncStatus(): Promise<SyncStatus> {
  const res = await fetch(`${API_URL}/sync-status`);
  if (!res.ok) throw new Error('Failed to fetch sync status');
  return res.json();
}

export function subscribeSyncStatus(callback: (status: SyncStatus) => void): () => void {
  const eventSource = new EventSource(`${API_URL}/sync-status/stream`);

  eventSource.onmessage = (event) => {
    try {
      const status = JSON.parse(event.data);
      callback(status);
    } catch (err) {
      console.error('Failed to parse sync status:', err);
    }
  };

  eventSource.onerror = (err) => {
    console.error('Sync status stream error:', err);
  };

  return () => {
    eventSource.close();
  };
}

export async function triggerSync(): Promise<void> {
  // FLUX-989: bound the trigger so a wedged engine can't leave the caller's promise
  // pending forever. Fire-and-observe: a timeout is swallowed (the sync indicator reflects
  // real state via the SSE stream), we just don't hang on the POST.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    await fetch(`${API_URL}/sync-status/sync`, { method: 'POST', signal: controller.signal });
  } catch {
    /* engine slow/unreachable — the sync-status stream is the source of truth */
  } finally {
    clearTimeout(timer);
  }
}

// Matches the engine's RESOLVE_CONFLICTS_TIMEOUT_MS (90s) with a small margin so, in the
// normal slow case, the server's clean error body wins the race over a client-side abort
// (FLUX-989). Guarantees ConflictResolutionModal surfaces a real error state instead of an
// infinite "Resolving…" spinner if the round trip ever wedges.
const RESOLVE_CONFLICTS_TIMEOUT_MS = 95_000;

export async function resolveConflicts(
  resolutions: Array<{ ticketId: string; strategy: ResolutionStrategy; newContent?: string }>
): Promise<{ ok: boolean }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), RESOLVE_CONFLICTS_TIMEOUT_MS);
  try {
    const res = await fetch(`${API_URL}/storage/resolve-conflicts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ resolutions }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const payload = await res.json().catch(() => ({}));
      throw new Error(payload.error || 'Failed to resolve conflicts');
    }
    return res.json();
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      throw new Error('Conflict resolution timed out. The sync may still be finishing — check the sync status and retry if it persists.', { cause: err });
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// FLUX-1232: force-reset-to-remote escape hatch result — mirrors the engine's ForceResetResult.
export interface ResetToRemoteResult {
  ok: boolean;
  backupRef: string;
  oldHead: string;
  newHead: string;
  changedFiles: string[];
}

// Matches the engine's RESET_REMOTE_TIMEOUT_MS budget with a small margin, same reasoning as
// RESOLVE_CONFLICTS_TIMEOUT_MS above.
const RESET_TO_REMOTE_TIMEOUT_MS = 260_000;

/**
 * FLUX-1232: discard local flux-data board state and hard-reset to origin/flux-data. Destructive
 * — callers MUST confirm with the user first (naming the consequence); this function does not.
 */
export async function resetToRemote(): Promise<ResetToRemoteResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), RESET_TO_REMOTE_TIMEOUT_MS);
  try {
    const res = await fetch(`${API_URL}/storage/reset-remote`, { method: 'POST', signal: controller.signal });
    const payload = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(payload.error || 'Failed to reset to remote');
    }
    return payload;
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      throw new Error('Reset to remote timed out. Check the sync status and retry if it persists.', { cause: err });
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// ─── Notifications ───────────────────────────────────────────────────────────

export interface NotificationAction {
  label: string;
  actionId: string;
}

export interface Notification {
  id: string;
  type: 'error' | 'prompt' | 'completion' | 'review' | 'info';
  title: string;
  message: string;
  ticketId?: string;
  framework?: string;
  actions: NotificationAction[];
  createdAt: string;
  read: boolean;
  dismissed: boolean;
}

export interface NotificationsResponse {
  notifications: Notification[];
  unreadCount: number;
}

export async function fetchNotifications(): Promise<NotificationsResponse> {
  const res = await fetch(`${API_URL}/notifications`);
  if (!res.ok) return { notifications: [], unreadCount: 0 };
  return res.json();
}

export async function markNotificationRead(id: string): Promise<void> {
  await fetch(`${API_URL}/notifications/${id}/read`, { method: 'POST' });
}

export async function markNotificationUnread(id: string): Promise<void> {
  await fetch(`${API_URL}/notifications/${id}/unread`, { method: 'POST' });
}

export async function markAllNotificationsRead(): Promise<void> {
  await fetch(`${API_URL}/notifications/read-all`, { method: 'POST' });
}

export async function dismissNotification(id: string): Promise<void> {
  await fetch(`${API_URL}/notifications/${id}/dismiss`, { method: 'POST' });
}

export async function executeNotificationAction(id: string, actionId: string): Promise<unknown> {
  const res = await fetch(`${API_URL}/notifications/${id}/action`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ actionId }),
  });
  if (!res.ok) throw new Error('Action failed');
  return res.json();
}

// ─── Global Settings / Boot ──────────────────────────────────────────────────

export interface BootStatus {
  firstBoot: boolean;
  legacyFound: boolean;
  dataDir: string;
  migrated: boolean;
}

export interface GlobalSettings {
  workspaces: { path: string; label?: string }[];
  lastWorkspace?: string;
  defaultUser?: string;
  preferredFramework?: string;
  defaultAgent?: string;
  port?: number;
  dataDir?: string;
  animations?: boolean;
  timeouts?: {
    syncDebounceMs?: number;
    syncMaxWaitMs?: number;
  };
  firstBootCompleted?: boolean;
  migratedFrom?: string;
}

export async function fetchBootStatus(): Promise<BootStatus> {
  const res = await fetch(`${API_URL}/settings/boot-status`);
  if (!res.ok) throw new Error('Failed to fetch boot status');
  return res.json();
}

export async function confirmBoot(migrate?: boolean): Promise<{ ok: boolean; settings: GlobalSettings }> {
  const res = await fetch(`${API_URL}/settings/confirm-boot`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ migrate }),
  });
  if (!res.ok) throw new Error('Boot confirmation failed');
  return res.json();
}

export async function fetchGlobalSettings(): Promise<GlobalSettings> {
  const res = await fetch(`${API_URL}/settings/global`);
  if (!res.ok) throw new Error('Failed to fetch global settings');
  return res.json();
}

export async function updateGlobalSettings(updates: Partial<GlobalSettings>): Promise<GlobalSettings> {
  const res = await fetch(`${API_URL}/settings/global`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(updates),
  });
  if (!res.ok) throw new Error('Failed to update global settings');
  return res.json();
}

export interface BranchStatus {
  name: string | null;
  exists: boolean;
  aheadCount: number;
  behindCount: number;
  /** Absolute path of the ticket's dedicated worktree, or null if none (FLUX-521). */
  worktree?: string | null;
}

export async function fetchBranchStatus(taskId: string): Promise<BranchStatus> {
  const res = await fetch(`${API_URL}/tasks/${taskId}/branch`);
  if (!res.ok) throw new Error('Failed to fetch branch status');
  return res.json();
}

export async function createBranch(
  taskId: string,
  opts?: { baseBranch?: string; worktree?: boolean },
): Promise<{ branch: string; worktree?: string; worktreeError?: string }> {
  const body: Record<string, unknown> = {};
  if (opts?.baseBranch) body.baseBranch = opts.baseBranch;
  if (typeof opts?.worktree === 'boolean') body.worktree = opts.worktree;
  const res = await fetch(`${API_URL}/tasks/${taskId}/branch`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(err.error || 'Failed to create branch');
  }
  return res.json();
}

// ─── Pull requests (FLUX-555 / 556) ─────────────────────────────────────────────

/** Normalized PR state for a ticket's branch (mirrors engine `PrStatus`). */
export interface PrStatus {
  number: number;
  state: string;                  // OPEN | MERGED | CLOSED
  url: string;
  title: string;
  reviewDecision: string | null;  // APPROVED | CHANGES_REQUESTED | REVIEW_REQUIRED | null
  mergeable: string;              // MERGEABLE | CONFLICTING | UNKNOWN
  checks: { total: number; passed: number; failed: number; pending: number };
}

/** Live PR state for a ticket's branch. `null` when no branch/PR or gh unavailable. */
export async function fetchPrStatus(taskId: string): Promise<PrStatus | null> {
  const res = await fetch(`${API_URL}/tasks/${taskId}/pr`);
  if (!res.ok) return null;
  const data = await res.json().catch(() => ({ pr: null }));
  return (data.pr ?? null) as PrStatus | null;
}

/** Raise a PR for the ticket's branch (push + open) without moving to Done. */
export async function raisePr(taskId: string): Promise<{ url: string; number: number | null }> {
  const res = await fetch(`${API_URL}/tasks/${taskId}/pr`, { method: 'POST' });
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(err.error || 'Failed to raise PR');
  }
  return res.json();
}

export interface MergePrResult {
  merged: boolean;
  outcome: 'cleaned' | 'unsafe' | 'noop';
  branch: string;
  advanced: string[];
  masterSynced: boolean;
  worktreeRemoved: boolean;
  branchDeleted: boolean;
  reason?: string;
  notificationId?: string;
}

export class MergeParkedError extends Error {
  parkedOnly = true;
  parkedOwners: string[];
  constructor(message: string, parkedOwners: string[]) {
    super(message);
    this.name = 'MergeParkedError';
    this.parkedOwners = parkedOwners;
  }
}

/** A non-Done branch sibling that a shared-PR merge would sweep to Done (FLUX-569 guard payload). */
export interface SharedNonDoneSibling {
  id: string;
  status: string;
  title?: string;
}

/**
 * The shared-PR finish guard fired (FLUX-569): the branch bundles non-Done siblings that would all
 * advance to Done. Carries the structured sibling list so the portal can render an actionable
 * "Merge all & finish" (force:true) decision instead of string-parsing the prose message.
 */
export class MergeForceRequiredError extends Error {
  requiresForce = true;
  sharedNonDone: SharedNonDoneSibling[];
  constructor(message: string, sharedNonDone: SharedNonDoneSibling[]) {
    super(message);
    this.name = 'MergeForceRequiredError';
    this.sharedNonDone = sharedNonDone;
  }
}

/**
 * Squash-merge the branch's PR + run post-merge cleanup (advances all branch tickets). Pass
 * `force` to override the shared-PR guard (FLUX-569) when the branch bundles non-Done siblings
 * that would all advance to Done — the deck card confirms that explicitly before forcing.
 * Pass `stopParkedSessions` to auto-end waiting-input sessions and proceed (FLUX-636).
 */
export async function mergePr(taskId: string, opts?: { force?: boolean; stopParkedSessions?: boolean }): Promise<MergePrResult> {
  const res = await fetch(`${API_URL}/tasks/${taskId}/pr/merge`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ force: opts?.force === true, stopParkedSessions: opts?.stopParkedSessions === true }),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as {
      error?: string;
      parkedOnly?: boolean;
      parkedOwners?: string[];
      requiresForce?: boolean;
      sharedNonDone?: SharedNonDoneSibling[];
    };
    if (body.parkedOnly) {
      throw new MergeParkedError(body.error || 'Parked sessions block merge', body.parkedOwners ?? []);
    }
    if (body.requiresForce) {
      throw new MergeForceRequiredError(body.error || 'Merging this shared PR would advance unfinished tickets to Done.', body.sharedNonDone ?? []);
    }
    throw new Error(body.error || 'Failed to merge PR');
  }
  return res.json();
}

export interface AdoptPrResult { memberId: string; members: string[] }

/**
 * Continue development on a PR by binding work to its branch (FLUX-569). `mode: 'adopt'` rebinds
 * an existing ticket (by `ticketId`) to the PR's branch + moves it to In Progress; `mode: 'create'`
 * makes a fresh ticket (by `title`/`body`) bound to the branch. Either way it folds into the deck.
 */
export async function adoptPr(
  prId: string,
  opts: { mode: 'adopt'; ticketId: string; updatedBy: string } | { mode: 'create'; title: string; body?: string; updatedBy: string },
): Promise<AdoptPrResult> {
  const res = await fetch(`${API_URL}/tasks/${prId}/pr/adopt`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(opts),
  });
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(err.error || 'Failed to continue development');
  }
  return res.json();
}

export interface RetryPrResult { id: string; branch: string | null }

/**
 * Retry a merged/closed PR (FLUX-593): spawn a new ticket linked to it via a 'retries'
 * relation, carrying the reason + the PR's context, optionally on a fresh branch. Returns
 * the new ticket id (+ branch if created). The merged PR is immutable — this is a fresh cycle.
 */
export async function retryPr(prId: string, opts: { reason: string; createBranch: boolean; updatedBy: string }): Promise<RetryPrResult> {
  const res = await fetch(`${API_URL}/tasks/${prId}/retry`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ reason: opts.reason, createBranch: opts.createBranch, updatedBy: opts.updatedBy }),
  });
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(err.error || 'Failed to retry PR');
  }
  return res.json();
}

/** Refresh a stale PR branch by merging the default branch into it (FLUX-559). */
export async function updatePrBranch(taskId: string): Promise<{ updated: boolean; branch: string }> {
  const res = await fetch(`${API_URL}/tasks/${taskId}/pr/update-branch`, { method: 'POST' });
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(err.error || 'Failed to update branch');
  }
  return res.json();
}

/**
 * Detach (remove) a ticket's dedicated worktree but keep the branch — the
 * manual-finish escape hatch (FLUX-521). Uncommitted work is preserved (surfaced
 * onto master, or kept as a stash ref on conflict).
 */
export async function detachWorktree(
  taskId: string,
): Promise<{ outcome: 'clean' | 'applied' | 'stashed'; stashRef?: string; message: string }> {
  const res = await fetch(`${API_URL}/tasks/${taskId}/worktree/detach`, { method: 'POST' });
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(err.error || 'Failed to detach worktree');
  }
  return res.json();
}

/**
 * Ensure a branch + dedicated worktree exist for the ticket and open it in a NEW
 * VS Code window (FLUX-522). `opened` is false when the `code` CLI isn't on PATH —
 * the caller should then point the user at `worktree` to open manually.
 */
export async function openWorktreeWindow(
  taskId: string,
): Promise<{ worktree: string; branch: string; opened: boolean; seedPrompt: string }> {
  const res = await fetch(`${API_URL}/tasks/${taskId}/worktree/open`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(err.error || 'Failed to open worktree window');
  }
  return res.json();
}

export interface WorktreeInfo {
  path: string;
  branch: string;
  ticketId: string | null;
  ticketTitle: string | null;
  /** Files changed vs master (committed + uncommitted + untracked) — board chip badge. */
  changedFiles?: number;
  /** Commits this worktree is ahead of the default branch (FLUX-582) — divergence badge. */
  aheadCount?: number;
}

/** All active task worktrees (FLUX-516) — drives the worktree badges + Join picker. */
export async function fetchWorktrees(): Promise<WorktreeInfo[]> {
  const res = await fetch(`${API_URL}/tasks/worktrees`);
  if (!res.ok) throw new Error('Failed to fetch worktrees');
  const data = await res.json();
  return (data.worktrees ?? []) as WorktreeInfo[];
}

export interface BranchOption {
  name: string;
  hasWorktree: boolean;
  isTicketBranch: boolean;
}

/** Local branch names for the "Attach to branch" picker (FLUX-516). */
export async function fetchBranches(): Promise<BranchOption[]> {
  const res = await fetch(`${API_URL}/tasks/branches`);
  if (!res.ok) throw new Error('Failed to fetch branches');
  const data = await res.json();
  return (data.branches ?? []) as BranchOption[];
}

/**
 * Attach a ticket to an existing branch WITHOUT creating a worktree (FLUX-516).
 * Execution-root resolution is by branch, so if that branch already has a
 * worktree the ticket will run there; otherwise it runs on the main tree.
 */
export async function setTicketBranch(taskId: string, branch: string, updatedBy: string): Promise<Task> {
  return updateTask(taskId, { branch, updatedBy } as Partial<Task>);
}

/**
 * Attach a ticket as a subtask of `parentId` (FLUX-516). The engine's PUT handler
 * keeps the parent's `subtasks` array and the child's `parentId` in sync
 * bidirectionally, so this single update is enough.
 */
export async function attachParent(taskId: string, parentId: string, updatedBy: string): Promise<Task> {
  return updateTask(taskId, { parentId, updatedBy } as Partial<Task>);
}

/**
 * Join an existing worktree: adopt `branch` so this ticket runs in that branch's
 * worktree (shared-branch work — e.g. fixing review bugs alongside the parent).
 */
export async function joinWorktree(
  taskId: string,
  branch: string,
): Promise<{ branch: string; worktree: string; joined: boolean }> {
  const res = await fetch(`${API_URL}/tasks/${taskId}/worktree/join`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ branch }),
  });
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(err.error || 'Failed to join worktree');
  }
  return res.json();
}

export async function fetchTaskDiff(taskId: string, file?: string, mode?: 'committed' | 'working'): Promise<string | null> {
  const params = new URLSearchParams();
  if (file) params.set('file', file);
  if (mode) params.set('mode', mode);
  const qs = params.toString();
  const url = qs ? `${API_URL}/tasks/${taskId}/diff?${qs}` : `${API_URL}/tasks/${taskId}/diff`;
  const res = await fetch(url);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error('Failed to fetch diff');
  return res.text();
}

// ─── Cross-worktree diffs (FLUX-527) ──────────────────────────────────────────

export type DiffChangeStatus = 'modified' | 'added' | 'deleted' | 'renamed' | 'untracked';

export interface DiffChangedFile {
  file: string;
  additions: number;
  deletions: number;
  status: DiffChangeStatus;
  /** Other group refs (branch names and/or 'main') that also touch this file. */
  collidesWith?: string[];
  /** Worktree files only: true when committed-ahead of master, false/absent when loose (FLUX-582). */
  committed?: boolean;
  /** True when the file carries uncommitted (staged/unstaged/untracked) work in its checkout —
   *  a working-tree discard applies. Absent/false for committed-only files (FLUX-1333). */
  uncommitted?: boolean;
}

export interface DiffGroup {
  kind: 'worktree' | 'main';
  path: string;
  branch?: string;
  ticketId?: string | null;
  ticketTitle?: string | null;
  files: DiffChangedFile[];
}

export interface DiffCollision {
  file: string;
  refs: string[];
}

export interface DiffOverview {
  groups: DiffGroup[];
  collisions: DiffCollision[];
}

/** Cross-worktree change overview: every active worktree + the main tree's loose changes (FLUX-527). */
export async function fetchDiffOverview(uncommittedOnly = false): Promise<DiffOverview> {
  const res = await fetch(`${API_URL}/diffs/overview${uncommittedOnly ? '?uncommitted=1' : ''}`);
  if (!res.ok) throw new Error('Failed to fetch diff overview');
  return res.json();
}

/** One file's unified diff in the right root: `ref='main'` or a branch name. Null when nothing to show. */
export async function fetchDiffFile(ref: string, path: string): Promise<string | null> {
  const params = new URLSearchParams({ ref, path });
  const res = await fetch(`${API_URL}/diffs/file?${params.toString()}`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error('Failed to fetch file diff');
  return res.text();
}

// ─── Per-ticket branch diff (FLUX-615) ────────────────────────────────────────

/** Live changed-file summary for one ticket's branch vs the merge-base. */
export interface BranchDiffSummary {
  branch: string | null;
  worktree: string | null;
  base: string | null;
  files: DiffChangedFile[];
}

/** The ticket branch's changed files (worktree-aware, vs merge-base). Empty when no branch. */
export async function fetchBranchDiff(taskId: string): Promise<BranchDiffSummary> {
  const res = await fetch(`${API_URL}/tasks/${taskId}/branch-diff`);
  if (!res.ok) throw new Error('Failed to fetch branch diff');
  return res.json();
}

// ─── Bootstrap ──────────────────────────────────────────────────────────────

export interface BootstrapDocItem {
  relativePath: string;
  type: 'folder' | 'file';
  sizeLines: number;
}

export interface BootstrapTaskItem {
  title: string;
  body?: string;
  sourceFile: string;
  lineNumber: number;
  extractionMode: 'checklist' | 'heading';
}

export interface BootstrapScanResult {
  docs: BootstrapDocItem[];
  tasks: BootstrapTaskItem[];
  warnings: string[];
}

export interface BootstrapImportSelections {
  selectedDocs: string[];
  selectedTasks: Array<{ title: string; body?: string }>;
}

export interface BootstrapImportResult {
  docsImported: number;
  ticketsCreated: number;
  ticketsSkipped: number;
}

export async function scanBootstrap(): Promise<BootstrapScanResult> {
  const res = await fetch(`${API_URL}/bootstrap/scan`);
  if (!res.ok) throw new Error('Failed to scan workspace for bootstrap');
  return res.json();
}

export async function importBootstrap(selections: BootstrapImportSelections): Promise<BootstrapImportResult> {
  const res = await fetch(`${API_URL}/bootstrap/import`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(selections),
  });
  if (!res.ok) {
    let message = 'Failed to import bootstrap selections';
    try {
      const payload = await res.json();
      if (payload.error) message = payload.error;
    } catch {}
    throw new Error(message);
  }
  return res.json();
}

// ─── Multi-repo group setup (FLUX-401 contract) ──────────────────────────────

export interface GroupMemberInput {
  name: string;
  role: string;
  remote: string;
  testCommand?: string;
}

export interface GroupSetupRequest {
  name: string;
  members: GroupMemberInput[];
  force?: boolean;
  allowLocalRemotes?: boolean;
}

export type GroupFileAction = 'create' | 'patch' | 'exists';
export type GroupMemberAction = 'register' | 'clone' | 'skip';

export interface GroupPlannedFile {
  path: string;
  action: GroupFileAction;
  detail?: string;
}

export interface GroupPlannedMember {
  name: string;
  role: string;
  remote: string;
  resolvedPath: string;
  action: GroupMemberAction;
  detail?: string;
}

export interface GroupSetupPlan {
  parentRoot: string;
  groupName: string;
  alreadyConfigured: boolean;
  files: GroupPlannedFile[];
  gitignore: string[];
  orphanBranch: { name: string; action: 'create' | 'exists' };
  members: GroupPlannedMember[];
  warnings: string[];
}

export interface GroupMemberResult {
  name: string;
  action: GroupMemberAction;
  ok: boolean;
  error?: string;
}

export interface GroupSetupResult {
  parentRoot: string;
  groupName: string;
  wroteConfig: boolean;
  patchedGitignore: boolean;
  scaffoldedStore: boolean;
  members: GroupMemberResult[];
}

export interface GroupMemberSummary {
  name: string;
  role: string;
  remote: string;
  path: string;
  pathExists: boolean;
  /** Whether this member's checkout is a registered EH workspace (Case 1). Present only on the parent workspace. */
  registered?: boolean;
  testCommand?: string;
}

export interface GroupStatus {
  configured: boolean;
  name?: string;
  members?: GroupMemberSummary[];
  /** Parent repo root that owns the group. Present only when registration state is computed. */
  parentRoot?: string;
  /** Whether the dedicated parent is a registered EH workspace. */
  parentRegistered?: boolean;
  /** True when parent + every present member is registered (Case 1 holds). */
  registrationComplete?: boolean;
  /** Display label for the surfaced group docs tree (`group.json` docsLabel or the default `Product`). */
  docsLabel?: string;
  /** How the current workspace sits in a group (parent or bound member), independent of `configured`. */
  membership?: GroupMembership;
  message?: string;
}

/** The current workspace's place in a multi-repo group (FLUX-412). */
export interface GroupMembership {
  role: 'parent' | 'member';
  groupName: string;
  parentRoot: string;
  memberName?: string;
  memberRole?: string;
}

/** Outcome of registering one workspace (parent or member) during backfill. */
export interface RegistrationResult {
  path: string;
  name: string;
  kind: 'parent' | 'member';
  ok: boolean;
  alreadyRegistered: boolean;
  error?: string;
}

export interface EnsureRegisteredResult {
  parentRoot: string;
  groupName: string;
  registrations: RegistrationResult[];
  complete: boolean;
}

/** Current multi-repo group status (mirrors the get_project_group MCP tool). */
export async function fetchGroupStatus(): Promise<GroupStatus> {
  const res = await fetch(`${API_URL}/group`);
  if (!res.ok) throw new Error('Failed to fetch group status');
  return res.json();
}

/**
 * Backfill: register the dedicated parent + present members as workspaces so the
 * Case-1 member binding can resolve. Runs only on explicit user consent.
 */
export async function ensureGroupRegistered(): Promise<EnsureRegisteredResult> {
  const res = await fetch(`${API_URL}/group/ensure-registered`, { method: 'POST' });
  if (!res.ok) {
    let message = 'Failed to register group workspaces';
    try {
      const payload = await res.json();
      if (payload.error) message = payload.error;
    } catch {}
    throw new Error(message);
  }
  return res.json();
}

async function groupSetupRequest<T>(path: string, body: GroupSetupRequest): Promise<T> {
  const res = await fetch(`${API_URL}/group/${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    let message = `Failed to ${path} group setup`;
    try {
      const payload = await res.json();
      if (payload.error) message = payload.error;
    } catch {}
    throw new Error(message);
  }
  return res.json();
}

/** Dry-run: compute the intrusive actions without writing anything. */
export async function planGroupSetup(body: GroupSetupRequest): Promise<GroupSetupPlan> {
  return groupSetupRequest<GroupSetupPlan>('plan', body);
}

/** Apply: perform the planned writes (group.json, .gitignore, store, members). */
export async function applyGroupSetup(body: GroupSetupRequest): Promise<GroupSetupResult> {
  return groupSetupRequest<GroupSetupResult>('apply', body);
}

// ─── Group onboarding/migration wizard (FLUX-407) ────────────────────────────

/** A git repo discovered as a candidate group member. */
export interface DiscoveredRepo {
  path: string;
  name: string;
  remote: string | null;
  registered: boolean;
  /** Whether this repo already holds a group.json (it's a parent, not a member). */
  isGroupParent: boolean;
}

export interface FolderScanResult {
  folder: string;
  repos: DiscoveredRepo[];
}

export interface CreateParentResult {
  parentRoot: string;
  groupName: string;
  gitInitialized: boolean;
  wroteConfig: boolean;
  wroteLocalConfig: boolean;
  scaffoldedStore: boolean;
  registered: boolean;
  memberRegistrations: MemberRegistration[];
}

/** Outcome of registering one member workspace during parent creation. */
export interface MemberRegistration {
  name: string;
  path: string | null;
  registered: boolean;
  reason?: string;
}

/** Discovery source: repos EH already knows (workspace registry). */
export async function discoverGroupRegistry(): Promise<DiscoveredRepo[]> {
  const res = await fetch(`${API_URL}/group/discover/registry`);
  if (!res.ok) throw new Error('Failed to read workspace registry');
  const data = await res.json();
  return data.repos as DiscoveredRepo[];
}

/** Discovery source: scan a folder for immediate-child git repos. */
export async function discoverGroupFolder(folder: string): Promise<FolderScanResult> {
  const res = await fetch(`${API_URL}/group/discover/folder`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ folder }),
  });
  if (!res.ok) {
    let message = 'Failed to scan folder';
    try {
      const payload = await res.json();
      if (payload.error) message = payload.error;
    } catch {}
    throw new Error(message);
  }
  return res.json();
}

/**
 * Create a brand-new dedicated parent repo to host a group. The dedicated-parent
 * model forbids reusing a member repo, so this is how the wizard lands a new group.
 */
export async function createGroupParent(body: {
  parentPath: string;
  name: string;
  members: (GroupMemberInput & { path?: string })[];
}): Promise<CreateParentResult> {
  const res = await fetch(`${API_URL}/group/create-parent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    let message = 'Failed to create dedicated parent';
    try {
      const payload = await res.json();
      if (payload.error) message = payload.error;
    } catch {}
    throw new Error(message);
  }
  return res.json();
}

// ─── Promote existing .docs/ into the group store (FLUX-404) ─────────────────

/** Fan-out outcome returned by a group sync (one entry per member + totals). */
export interface GroupSyncResult {
  pushed: number;
  failed: number;
  committed: boolean;
  members: { name: string; remote: string; ok: boolean; diverged?: boolean; error?: string }[];
}

/** A `.docs/` file that can be promoted, with a proposed (retargetable) store path. */
export interface PromotionCandidate {
  source: string;
  target: string;
}

export interface DocsPromotionPlan {
  parentRoot: string;
  candidates: PromotionCandidate[];
}

export interface PromotionOutcome {
  source: string;
  target: string;
  ok: boolean;
  error?: string;
}

export interface DocsPromotionResult {
  promoted: string[];
  failed: PromotionOutcome[];
  sync: GroupSyncResult;
}

/** Dry-run: list promotable `.docs/` files with proposed store targets. No mutation. */
export async function planDocsPromotion(): Promise<DocsPromotionPlan> {
  const res = await fetch(`${API_URL}/group/promote-docs/plan`, { method: 'POST' });
  if (!res.ok) {
    let message = 'Failed to plan doc promotion';
    try {
      const payload = await res.json();
      if (payload.error) message = payload.error;
    } catch {}
    throw new Error(message);
  }
  return res.json();
}

/** Apply: move selected docs into the store, remove from main, commit, and fan out. */
export async function applyDocsPromotion(selections: PromotionCandidate[]): Promise<DocsPromotionResult> {
  const res = await fetch(`${API_URL}/group/promote-docs/apply`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ selections }),
  });
  if (!res.ok) {
    let message = 'Failed to promote docs';
    try {
      const payload = await res.json();
      if (payload.error) message = payload.error;
    } catch {}
    throw new Error(message);
  }
  return res.json();
}

/** Update the docs label for the active group (the prefix shown for group docs in the wiki). Parent workspace only. */
export async function updateGroupDocsLabel(label: string): Promise<void> {
  const res = await fetch(`${API_URL}/group/docs-label`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ label }),
  });
  if (!res.ok) {
    let message = 'Failed to update docs label';
    try { const payload = await res.json(); if (payload.error) message = payload.error; } catch {}
    throw new Error(message);
  }
}

// ─── Dev-only onboarding-features editor (FLUX-755) ───────────────────────────
//
// Read/write the committed config that drives the onboarding wizard's "What you
// can do" step. These hit the engine's dev-only /api/dev router, which is mounted
// solely under `npm run dev` (never in a packaged build). The editor UI that calls
// them is itself import.meta.env.DEV-gated, so this code never runs in production.

import type { OnboardingFeaturesConfig } from './config/onboardingFeatures';

/** GET the live onboarding-features config from the engine (reads the committed file). */
export async function fetchOnboardingFeatures(): Promise<OnboardingFeaturesConfig> {
  const res = await fetch(`${API_URL}/dev/onboarding-features`);
  if (!res.ok) {
    const payload = await res.json().catch(() => ({}));
    throw new Error(payload.error || 'Failed to fetch onboarding features');
  }
  return res.json();
}

/** PUT the onboarding-features config to the engine (writes the committed file). Returns the saved config. */
export async function saveOnboardingFeatures(data: OnboardingFeaturesConfig): Promise<OnboardingFeaturesConfig> {
  const res = await fetch(`${API_URL}/dev/onboarding-features`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  if (!res.ok) {
    const payload = await res.json().catch(() => ({}));
    throw new Error(payload.error || 'Failed to save onboarding features');
  }
  return res.json();
}

// ─── Dev-only onboarding-FLOW editor (FLUX-759) ───────────────────────────────
//
// Read/write the committed config that drives the onboarding wizard's PAGE SEQUENCE
// (portal/src/config/onboardingFlow.json), distinct from the feature-panel seed
// above. These hit the engine's dev-only /api/dev router (sub-path /onboarding-flow),
// mounted solely under `npm run dev` (never in a packaged build). They are referenced
// ONLY from the dev Studio chunk so they tree-shake out of the prod bundle.

import type { OnboardingFlowConfig } from './config/onboardingFlow';

/** GET the live onboarding-flow config from the engine (reads the committed file). */
export async function fetchOnboardingFlow(): Promise<OnboardingFlowConfig> {
  const res = await fetch(`${API_URL}/dev/onboarding-flow`);
  if (!res.ok) {
    const payload = await res.json().catch(() => ({}));
    throw new Error(payload.error || 'Failed to fetch onboarding flow');
  }
  return res.json();
}

/** PUT the onboarding-flow config to the engine (writes the committed file). Returns the saved config. */
export async function saveOnboardingFlow(data: OnboardingFlowConfig): Promise<OnboardingFlowConfig> {
  const res = await fetch(`${API_URL}/dev/onboarding-flow`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  if (!res.ok) {
    const payload = await res.json().catch(() => ({}));
    throw new Error(payload.error || 'Failed to save onboarding flow');
  }
  return res.json();
}

// ─── Dev-only onboarding DRAFT store + PUBLISH (FLUX-763 Phase 4) ─────────────
//
// THE HEADLINE FIX. Routine Studio Save now writes the gitignored DRAFT files
// (onboardingFlow.draft.json / onboardingFeatures.draft.json) instead of the committed
// configs, so opening + saving in the Studio leaves `git status` clean and never blocks
// `git pull`. A single explicit publishOnboarding() is the ONLY path that writes the
// committed onboardingFlow.json / onboardingFeatures.json. These hit the engine's
// dev-only /api/dev/onboarding-*-draft + /onboarding-publish routes and are referenced
// ONLY from the dev Studio chunk, so they tree-shake out of the prod bundle.

/** A single validation/warning entry returned by the publish backstop. */
export interface OnboardingValidationIssue {
  code: string;
  message: string;
  pageId?: string;
}

/** GET the live onboarding-flow DRAFT (engine seeds it from the committed file on first read). */
export async function fetchOnboardingFlowDraft(): Promise<OnboardingFlowConfig> {
  const res = await fetch(`${API_URL}/dev/onboarding-flow-draft`);
  if (!res.ok) {
    const payload = await res.json().catch(() => ({}));
    throw new Error(payload.error || 'Failed to fetch onboarding flow draft');
  }
  return res.json();
}

/** PUT the onboarding-flow DRAFT (the gitignored Save target — never the committed file). */
export async function saveOnboardingFlowDraft(data: OnboardingFlowConfig): Promise<OnboardingFlowConfig> {
  const res = await fetch(`${API_URL}/dev/onboarding-flow-draft`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  if (!res.ok) {
    const payload = await res.json().catch(() => ({}));
    throw new Error(payload.error || 'Failed to save onboarding flow draft');
  }
  return res.json();
}

/** GET the live onboarding-features DRAFT (engine seeds it from the committed file on first read). */
export async function fetchOnboardingFeaturesDraft(): Promise<OnboardingFeaturesConfig> {
  const res = await fetch(`${API_URL}/dev/onboarding-features-draft`);
  if (!res.ok) {
    const payload = await res.json().catch(() => ({}));
    throw new Error(payload.error || 'Failed to fetch onboarding features draft');
  }
  return res.json();
}

/** PUT the onboarding-features DRAFT (the gitignored Save target — never the committed file). */
export async function saveOnboardingFeaturesDraft(
  data: OnboardingFeaturesConfig,
): Promise<OnboardingFeaturesConfig> {
  const res = await fetch(`${API_URL}/dev/onboarding-features-draft`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  if (!res.ok) {
    const payload = await res.json().catch(() => ({}));
    throw new Error(payload.error || 'Failed to save onboarding features draft');
  }
  return res.json();
}

/** Thrown by publishOnboarding when the engine backstop returns 422 (blocking errors, nothing written). */
export class OnboardingPublishError extends Error {
  errors: OnboardingValidationIssue[];
  constructor(errors: OnboardingValidationIssue[]) {
    super('Publish blocked by validation errors');
    this.name = 'OnboardingPublishError';
    this.errors = errors;
  }
}

export interface OnboardingPublishResult {
  published: true;
  warnings: OnboardingValidationIssue[];
}

/**
 * Publish the current drafts to the committed configs — THE ONLY committed write. The
 * engine re-reads both drafts from disk, runs its structural backstop + asset-existence
 * check, and on pass atomically writes flow draft → onboardingFlow.json AND features
 * draft → onboardingFeatures.json. On 422 it writes nothing and throws an
 * OnboardingPublishError carrying { errors }. On success returns { published, warnings }.
 */
export async function publishOnboarding(): Promise<OnboardingPublishResult> {
  const res = await fetch(`${API_URL}/dev/onboarding-publish`, { method: 'POST' });
  if (res.status === 422) {
    const payload = await res.json().catch(() => ({ errors: [] as OnboardingValidationIssue[] }));
    throw new OnboardingPublishError(Array.isArray(payload.errors) ? payload.errors : []);
  }
  if (!res.ok) {
    const payload = await res.json().catch(() => ({}));
    throw new Error(payload.error || 'Failed to publish onboarding config');
  }
  return res.json();
}

/** Discard unpublished edits — overwrite both drafts from the committed configs. */
export async function discardOnboardingDraft(): Promise<{
  flow: OnboardingFlowConfig;
  features: OnboardingFeaturesConfig;
}> {
  const res = await fetch(`${API_URL}/dev/onboarding-discard`, { method: 'POST' });
  if (!res.ok) {
    const payload = await res.json().catch(() => ({}));
    throw new Error(payload.error || 'Failed to discard onboarding drafts');
  }
  return res.json();
}

// ─── Dev-only onboarding-IMAGE upload (FLUX-760) ──────────────────────────────
//
// Uploads a committed onboarding image (page/feature) to the engine's dev-only
// /api/dev/onboarding-asset route. The engine writes raw bytes (NO re-encode, gif
// animation preserved) into portal/public/onboarding-assets/<kind>-<id>.<ext> and
// returns the root-absolute URL to drop into image.src. The Studio then Saves the
// config so the reference lands in committed JSON. Mirrors uploadTaskAsset above.
// Referenced ONLY from the dev Studio chunk, so it tree-shakes out of prod.

export interface OnboardingAssetUploadResult {
  url: string;
  fileName: string;
}

/**
 * Upload an onboarding image. The server DERIVES the stored filename from kind + id
 * (the client fileName is used only to infer the extension when mimeType is absent),
 * so re-uploading the same kind+id overwrites in place. Returns { url, fileName }.
 */
export async function uploadOnboardingAsset(
  kind: 'page' | 'feature',
  id: string,
  payload: { fileName: string; mimeType: string; content: string },
): Promise<OnboardingAssetUploadResult> {
  const res = await fetch(`${API_URL}/dev/onboarding-asset`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ kind, id, ...payload }),
  });

  if (!res.ok) {
    let message = 'Failed to upload onboarding image';
    try {
      const errorPayload = await res.json();
      if (typeof errorPayload?.error === 'string' && errorPayload.error.trim()) {
        message = errorPayload.error.trim();
      }
    } catch {
      // Ignore JSON parse failures and fall back to the default message.
    }
    throw new Error(message);
  }

  return res.json();
}

/** Delete the committed onboarding image for a kind+id (idempotent — missing file is success). */
export async function deleteOnboardingAsset(kind: 'page' | 'feature', id: string): Promise<void> {
  const params = new URLSearchParams({ kind, id });
  const res = await fetch(`${API_URL}/dev/onboarding-asset?${params.toString()}`, {
    method: 'DELETE',
  });
  if (!res.ok) {
    const payload = await res.json().catch(() => ({}));
    throw new Error(payload.error || 'Failed to delete onboarding image');
  }
}

// ─── Terminal API ─────────────────────────────────────────────────────────────

export async function createTerminalSession(cols?: number, rows?: number, title?: string): Promise<TerminalSessionInfo> {
  const body: Record<string, unknown> = {};
  if (cols !== undefined) body.cols = cols;
  if (rows !== undefined) body.rows = rows;
  if (title !== undefined) body.title = title;
  const res = await fetch(`${API_URL}/terminal/sessions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    // FLUX-1030: surface the engine's real error (e.g. a node-pty spawn failure) instead of a
    // generic string, so the UI can show the user why "+" / a quick-launch did nothing.
    const payload = await res.json().catch(() => ({}));
    throw new Error(payload.error || 'Failed to create terminal session');
  }
  return res.json();
}

export async function listTerminalSessions(): Promise<TerminalSessionInfo[]> {
  const res = await fetch(`${API_URL}/terminal/sessions`);
  if (!res.ok) throw new Error('Failed to list terminal sessions');
  return res.json();
}

export async function getTerminalSession(id: string): Promise<TerminalSessionInfo & { scrollback: string }> {
  const res = await fetch(`${API_URL}/terminal/sessions/${encodeURIComponent(id)}`);
  if (!res.ok) throw new Error('Failed to get terminal session');
  return res.json();
}

export async function destroyTerminalSession(id: string): Promise<void> {
  const res = await fetch(`${API_URL}/terminal/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' });
  if (!res.ok) throw new Error('Failed to destroy terminal session');
}

export async function killTerminalSession(id: string): Promise<void> {
  const res = await fetch(`${API_URL}/terminal/sessions/${encodeURIComponent(id)}/kill`, { method: 'POST' });
  if (!res.ok) throw new Error('Failed to kill terminal session');
}

export async function renameTerminalSession(id: string, title: string): Promise<void> {
  const res = await fetch(`${API_URL}/terminal/sessions/${encodeURIComponent(id)}/title`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title }),
  });
  if (!res.ok) throw new Error('Failed to rename terminal session');
}

export function getTerminalWsUrl(sessionId: string): string {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${window.location.host}/api/terminal/ws/${encodeURIComponent(sessionId)}`;
}

/** Backfill for the dev-only Operations tab (S11, FLUX-1007) — newest-first, honors S9's filters. */
export async function fetchRecentOperations(opts?: {
  ticketId?: string;
  sessionId?: string;
  kind?: OperationKind;
  outcome?: OperationOutcome;
  limit?: number;
}): Promise<OperationEvent[]> {
  const params = new URLSearchParams();
  if (opts?.ticketId) params.set('ticketId', opts.ticketId);
  if (opts?.sessionId) params.set('sessionId', opts.sessionId);
  if (opts?.kind) params.set('kind', opts.kind);
  if (opts?.outcome) params.set('outcome', opts.outcome);
  if (opts?.limit) params.set('limit', String(opts.limit));
  const query = params.toString();
  const res = await fetch(`${API_URL}/operations${query ? `?${query}` : ''}`);
  if (!res.ok) throw new Error('Failed to fetch operations');
  const data = await res.json();
  return (data.operations ?? []) as OperationEvent[];
}

// ── The Furnace — batches (FLUX-1053) ───────────────────────────────────────────

export async function fetchFurnaceBatches(status?: BatchStatus): Promise<FurnaceBatch[]> {
  const q = status ? `?status=${encodeURIComponent(status)}` : '';
  const res = await fetch(`${API_URL}/furnace${q}`);
  if (!res.ok) throw new Error('Failed to fetch furnace batches');
  return res.json();
}

export async function fetchFurnaceSlots(): Promise<SlotInfo> {
  const res = await fetch(`${API_URL}/furnace/slots`);
  if (!res.ok) throw new Error('Failed to fetch worktree slots');
  return res.json();
}

export interface CreateBatchOptions {
  title: string;
  kind?: BatchKind;
  ticketIds?: string[];
  burnRate?: number;
  trigger?: BatchTrigger;
}

export async function createFurnaceBatch(opts: CreateBatchOptions): Promise<FurnaceBatch> {
  const res = await fetch(`${API_URL}/furnace`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(opts),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err?.error || 'Failed to create batch');
  }
  return res.json();
}

/**
 * Build a batch from the groomed backlog (MCP furnace_build's HTTP-less twin lives on the MCP tool).
 * Requires `tag` or `tickets` (FLUX-1051) — a batch must always be an intentional selection.
 */
export interface BuildBatchOptions {
  tag?: string;
  tickets?: string[];
  statuses?: string[];
  limit?: number;
  kind?: BatchKind;
  burnRate?: number;
  title?: string;
}

export interface BuildBatchResult {
  batchId: string;
  batch: FurnaceBatch;
  excluded: ExcludedTicket[];
  notes: string[];
}

export async function updateFurnaceBatch(
  id: string,
  // No `status` — transitions go through ignite/stop, never a raw PUT (the route rejects it).
  // `tickets` (full curated objects, e.g. for a drag-reorder) is meant for re-sequencing tickets already
  // in the batch: entries whose id is already in the batch pass through unvalidated, but the server
  // (FLUX-1103) validates existence/status/one-active-batch for any id NOT already in the batch — so
  // this can't be used to smuggle in a new ticket unchecked.
  patch: { title?: string; kind?: BatchKind; branch?: string; burnRate?: number; trigger?: BatchTrigger | null; ticketIds?: string[]; tickets?: BatchTicket[] },
): Promise<FurnaceBatch> {
  const res = await fetch(`${API_URL}/furnace/${encodeURIComponent(id)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err?.error || 'Failed to update furnace batch');
  }
  return res.json();
}

/** Append a single ticket to an existing batch (draft or burning). */
export async function appendFurnaceTicket(id: string, ticketId: string): Promise<FurnaceBatch> {
  const res = await fetch(`${API_URL}/furnace/${encodeURIComponent(id)}/ticket`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ticketId }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err?.error || 'Failed to append ticket');
  }
  return res.json();
}

/** Remove a ticket from a batch (disallowed while it is actively burning). */
export async function removeFurnaceTicket(id: string, ticketId: string): Promise<FurnaceBatch> {
  const res = await fetch(`${API_URL}/furnace/${encodeURIComponent(id)}/ticket/${encodeURIComponent(ticketId)}`, { method: 'DELETE' });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err?.error || 'Failed to remove ticket');
  }
  return res.json();
}

/** Result of an ignite attempt — `noSlots` is the worktree-pool-full case (HTTP 409). */
export interface IgniteResult {
  ok: boolean;
  batch?: FurnaceBatch;
  noSlots?: boolean;
  used?: number;
  max?: number;
  /** Which tickets hold the slots, and why reclaim didn't free them (FLUX-1157). */
  holders?: FurnaceSlotHolder[];
  error?: string;
}

export async function igniteFurnaceBatch(id: string): Promise<IgniteResult> {
  const res = await fetch(`${API_URL}/furnace/${encodeURIComponent(id)}/ignite`, { method: 'POST', headers: { 'Content-Type': 'application/json' } });
  if (res.ok) return { ok: true, batch: await res.json() };
  const err = await res.json().catch(() => ({}));
  if (res.status === 409 && err?.error === 'no_slots') return { ok: false, noSlots: true, used: err.used, max: err.max, holders: err.holders };
  return { ok: false, error: err?.error || 'Failed to ignite batch' };
}

export async function stopFurnaceBatch(id: string, opts?: { reason?: string; hard?: boolean }): Promise<FurnaceBatch> {
  const res = await fetch(`${API_URL}/furnace/${encodeURIComponent(id)}/stop`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(opts ?? {}),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err?.error || 'Failed to stop batch');
  }
  return res.json();
}

export async function deleteFurnaceBatch(id: string): Promise<void> {
  const res = await fetch(`${API_URL}/furnace/${encodeURIComponent(id)}`, { method: 'DELETE' });
  if (!res.ok) throw new Error('Failed to delete furnace batch');
}

/** Merge a batch's PR(s): a specific one by `prBranch`, else every approved PR. Marks them `merged`. */
export async function mergeFurnaceBatch(id: string, prBranch?: string): Promise<{ batch: FurnaceBatch; merged: string[]; failed: Array<{ branch: string; error: string }> }> {
  const res = await fetch(`${API_URL}/furnace/${encodeURIComponent(id)}/merge`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(prBranch ? { prBranch } : {}),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err?.error || 'Failed to merge batch PR(s)');
  }
  return res.json();
}

// ── Recovery actions (FLUX-1066) — retry / resume / dismiss / takeover / hand-back ────────────────

/** Retry a single parked/failed ticket → reset to queued with a fresh attempt budget. */
export async function retryFurnaceTicket(id: string, ticketId: string): Promise<FurnaceBatch> {
  const res = await fetch(`${API_URL}/furnace/${encodeURIComponent(id)}/tickets/${encodeURIComponent(ticketId)}/retry`, { method: 'POST', headers: { 'Content-Type': 'application/json' } });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err?.error || 'Failed to retry ticket');
  }
  return res.json();
}

/** Resume a halted/finished batch → burning. `noSlots` when the worktree pool is full (HTTP 409). */
export async function resumeFurnaceBatch(id: string): Promise<IgniteResult> {
  const res = await fetch(`${API_URL}/furnace/${encodeURIComponent(id)}/resume`, { method: 'POST', headers: { 'Content-Type': 'application/json' } });
  if (res.ok) return { ok: true, batch: await res.json() };
  const err = await res.json().catch(() => ({}));
  if (res.status === 409 && err?.error === 'no_slots') return { ok: false, noSlots: true, used: err.used, max: err.max, holders: err.holders };
  return { ok: false, error: err?.error || 'Failed to resume batch' };
}

/** Dismiss the Furnace-raised flag on a ticket ("I've got this") — no re-queue. */
export async function dismissFurnaceTicket(id: string, ticketId: string): Promise<FurnaceBatch> {
  const res = await fetch(`${API_URL}/furnace/${encodeURIComponent(id)}/tickets/${encodeURIComponent(ticketId)}/dismiss`, { method: 'POST', headers: { 'Content-Type': 'application/json' } });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err?.error || 'Failed to dismiss ticket flag');
  }
  return res.json();
}

/** Take over a ticket (owner → human): the Furnace yields. */
export async function takeoverFurnaceTicket(id: string, ticketId: string): Promise<FurnaceBatch> {
  const res = await fetch(`${API_URL}/furnace/${encodeURIComponent(id)}/tickets/${encodeURIComponent(ticketId)}/takeover`, { method: 'POST', headers: { 'Content-Type': 'application/json' } });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err?.error || 'Failed to take over ticket');
  }
  return res.json();
}

/** Hand a taken-over ticket back to the Furnace (owner → furnace): re-queue with a fresh attempt budget. */
export async function handBackFurnaceTicket(id: string, ticketId: string): Promise<FurnaceBatch> {
  const res = await fetch(`${API_URL}/furnace/${encodeURIComponent(id)}/tickets/${encodeURIComponent(ticketId)}/handback`, { method: 'POST', headers: { 'Content-Type': 'application/json' } });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err?.error || 'Failed to hand ticket back');
  }
  return res.json();
}
