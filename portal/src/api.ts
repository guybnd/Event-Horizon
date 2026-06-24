import type { Task, Config, Doc, CliFramework, CliSessionSummary, ModuleDeclaration } from './types';

export const API_URL = '/api';

function encodeDocPath(docPath: string) {
  return docPath.split('/').map((segment) => encodeURIComponent(segment)).join('/');
}

export async function fetchTasks(): Promise<Task[]> {
  const res = await fetch(`${API_URL}/tasks`);
  if (!res.ok) throw new Error('Failed to fetch tasks');
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
}

export async function fetchUncommittedStatus(): Promise<UncommittedStatus> {
  const res = await fetch(`${API_URL}/tasks/uncommitted-count`);
  if (!res.ok) throw new Error('Failed to fetch uncommitted status');
  const data = await res.json();
  return {
    count: typeof data?.count === 'number' ? data.count : 0,
    branch: typeof data?.branch === 'string' ? data.branch : null,
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
    totalBytes: number;
    totalTokensEst: number;
    modules: Array<{ name: string; bytes: number; tokensEst: number; missing?: boolean }>;
    note: string;
  };
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

export async function updateTask(id: string, updates: Partial<Task>): Promise<Task> {
  const res = await fetch(`${API_URL}/tasks/${id}`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(updates)
  });
  if (!res.ok) {
    let message = 'Failed to update task';
    try {
      const errorPayload = await res.json();
      if (errorPayload.message) message = errorPayload.message;
      else if (errorPayload.error) message = errorPayload.error;
    } catch {
      // ignore
    }
    throw new Error(message);
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
  return res.json();
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
  if (!res.ok) throw new Error('Failed to fetch skill status');
  return res.json();
}

export async function installWorkspaceSkill(framework: string = 'auto'): Promise<{ success: boolean; skillInstalledPath: string; instructionsInstalledPath?: string }> {
  const res = await fetch(`${API_URL}/skill/install`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ framework }),
  });
  if (!res.ok) throw new Error('Failed to install skill');
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

export async function createTask(taskData: Partial<Task> & { projectKey: string, author: string }): Promise<Task> {
  const res = await fetch(`${API_URL}/tasks`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(taskData)
  });
  if (!res.ok) throw new Error('Failed to create task');
  return res.json();
}

export async function fetchTaskCliSession(taskId: string): Promise<CliSessionSummary | null> {
  const res = await fetch(`${API_URL}/tasks/${taskId}/cli-session`);
  if (!res.ok) throw new Error('Failed to fetch CLI session');
  const payload = await res.json();
  return payload.session || null;
}

export interface StartSessionOptions {
  framework: CliFramework;
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
}

export async function startTaskCliSessionEx(taskId: string, opts: StartSessionOptions): Promise<CliSessionSummary> {
  const { framework, appendPrompt, personaId, focusComment, skipPermissions = true, effortOverride, model, permissionMode, phase, role, pattern, patternPosition, groupId, groupSeq, groupTotal, groupType, groupVariant, lockedPaths, attachments } = opts;
  const body: Record<string, unknown> = { framework, skipPermissions };
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

export interface RegisterCombinerOptions {
  framework: CliFramework;
  groupId: string;
  role: string;
  /** Prompt text, or omit and pass personaId to resolve it server-side. */
  appendPrompt?: string;
  /** Resolve the combiner prompt server-side from a persona catalog id. */
  personaId?: string;
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

/** FLUX-604: reserved conversation id for the board-level orchestrator chat. */
export const BOARD_CONVERSATION_ID = '__board__';

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
  role: 'user' | 'assistant' | 'tool';
  text: string;
  ts: string;
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
): Promise<{ ok: boolean; results: BoardRebaseItemResult[] } | null> {
  const res = await fetch(`${API_URL}/board/board-rebase-resolve`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id, approvedItemIds }),
  });
  if (!res.ok) return null;
  return res.json();
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
  await fetch(`${API_URL}/board/ask-question/${id}/answer`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ answers, notes }),
  });
}

export async function sendTaskCliInput(taskId: string, message: string, user: string, opts?: { model?: string; effort?: string; permissionMode?: string; attachments?: ChatAttachment[] }): Promise<CliSessionSummary> {
  const body: Record<string, unknown> = { message, user };
  if (opts?.model) body.model = opts.model;
  if (opts?.effort) body.effortOverride = opts.effort;
  if (opts?.permissionMode) body.permissionMode = opts.permissionMode;
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

export interface SyncStatus {
  state: 'idle' | 'syncing' | 'synced' | 'conflict' | 'error';
  lastSyncTime?: string;
  conflicts?: ConflictInfo[];
  error?: string;
  errorType?: 'network' | 'auth' | 'conflict' | 'unknown';
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
  await fetch(`${API_URL}/sync-status/sync`, { method: 'POST' });
}

export async function resolveConflicts(
  resolutions: Array<{ ticketId: string; strategy: 'use-remote' | 'rename-local' | 'manual'; newContent?: string }>
): Promise<{ ok: boolean }> {
  const res = await fetch(`${API_URL}/storage/resolve-conflicts`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ resolutions }),
  });
  if (!res.ok) {
    const payload = await res.json().catch(() => ({}));
    throw new Error(payload.error || 'Failed to resolve conflicts');
  }
  return res.json();
}

// ─── Notifications ───────────────────────────────────────────────────────────

export interface NotificationAction {
  label: string;
  actionId: string;
}

export interface Notification {
  id: string;
  type: 'error' | 'prompt' | 'completion' | 'info';
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
  theme?: 'light' | 'dark' | 'system';
  defaultUser?: string;
  preferredFramework?: string;
  defaultAgent?: string;
  port?: number;
  dataDir?: string;
  boardClickBehavior?: 'modal' | 'expand';
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
    const body = (await res.json().catch(() => ({}))) as { error?: string; parkedOnly?: boolean; parkedOwners?: string[] };
    if (body.parkedOnly) {
      throw new MergeParkedError(body.error || 'Parked sessions block merge', body.parkedOwners ?? []);
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
