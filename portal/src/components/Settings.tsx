import { useState, useEffect, useRef } from 'react';
import { useAppSelector, useAppActions } from '../store/useAppSelector';
import { Save, Check, AlertTriangle } from 'lucide-react';
import { bulkRename, fetchGlobalSettings, updateGlobalSettings } from '../api';
import type { TagDef, StatusDef, UserDef, PriorityDef, DocsEditPermissions, BoardCardOpenMode, CliFramework } from '../types';
import { DEFAULT_READY_FOR_MERGE_STATUS, DEFAULT_REQUIRE_INPUT_STATUS, DEFAULT_ARCHIVE_STATUS } from '../workflow';
import { StopServiceButton } from './StopServiceButton';
import { WorkflowSection } from './settings/WorkflowSection';
import { BoardBehaviorSection } from './settings/BoardBehaviorSection';
import { AttributesSection } from './settings/AttributesSection';
import { AppearanceSection } from './settings/AppearanceSection';
import { WorkspaceSection } from './settings/WorkspaceSection';
import { WorktreeSection } from './settings/WorktreeSection';
import { ReleaseNotesSection } from './settings/ReleaseNotesSection';
import { AgentSection } from './settings/AgentSection';
import { AgentProgressSection } from './settings/AgentProgressSection';
import { CostTokensSection } from './settings/CostTokensSection';
import { ModulesSection } from './settings/ModulesSection';
import { McpPhasesSection } from './settings/McpPhasesSection';
import { GeneralSection } from './settings/GeneralSection';
import type { Config, ModuleDeclaration } from '../types';

/** Runtime config carries a per-phase MCP server map that isn't yet on the `Config` type. */
type ConfigWithMcpPhases = Config & { mcpServerPhases?: Record<string, string[]> };

type SettingsTab = 'board' | 'appearance' | 'attributes' | 'workspace' | 'agents' | 'modules' | 'general';

const TAB_ORDER: SettingsTab[] = ['board', 'appearance', 'attributes', 'workspace', 'agents', 'modules', 'general'];

const TAB_LABELS: Record<SettingsTab, string> = {
  board: 'Board',
  appearance: 'Appearance',
  attributes: 'Attributes',
  workspace: 'Workspace',
  agents: 'Agents',
  modules: 'Modules',
  general: 'General',
};

/** Drop the UI-only `originalName` field before an item is persisted. */
function stripOriginalName<T extends { originalName?: string }>(item: T): Omit<T, 'originalName'> {
  const rest = { ...item };
  delete rest.originalName;
  return rest;
}

export function Settings() {
  const { saveConfig, triggerRefresh, setView, notifyWorkspaceSet, setSettingsTab } = useAppActions();
  const config = useAppSelector(s => s.config);
  const workspacePath = useAppSelector(s => s.workspacePath);
  const settingsTab = useAppSelector(s => s.settingsTab);

  const [activeTab, setActiveTab] = useState<SettingsTab>('board');

  // Honor a requested tab from elsewhere (e.g. the header user menu's "Manage users"),
  // then clear it so a later manual tab change isn't overridden.
  useEffect(() => {
    if (!settingsTab) return;
    if ((TAB_ORDER as string[]).includes(settingsTab)) setActiveTab(settingsTab as SettingsTab);
    setSettingsTab(null);
  }, [settingsTab, setSettingsTab]);
  const [columns, setColumns] = useState<StatusDef[]>([]);
  const [hiddenStatuses, setHiddenStatuses] = useState<StatusDef[]>([]);
  const [users, setUsers] = useState<UserDef[]>([]);
  const [tags, setTags] = useState<TagDef[]>([]);
  const [priorities, setPriorities] = useState<PriorityDef[]>([]);
  const [projects, setProjects] = useState('');
  const [enableBacklog, setEnableBacklog] = useState(true);
  const [requireComment, setRequireComment] = useState(true);
  const [worktreeByDefault, setWorktreeByDefault] = useState(false);
  const [boardCardOpenMode, setBoardCardOpenMode] = useState<BoardCardOpenMode>('chat');
  const [animationsEnabled, setAnimationsEnabled] = useState(true);
  const [enableFireworks, setEnableFireworks] = useState(true);
  const [animationSpeed, setAnimationSpeed] = useState<'fast' | 'normal' | 'slow'>('normal');
  const [requireInputStatus, setRequireInputStatus] = useState(DEFAULT_REQUIRE_INPUT_STATUS);
  const [readyForMergeStatus, setReadyForMergeStatus] = useState(DEFAULT_READY_FOR_MERGE_STATUS);
  const [archiveStatus, setArchiveStatus] = useState(DEFAULT_ARCHIVE_STATUS);
  const [docsEditPermissions, setDocsEditPermissions] = useState<DocsEditPermissions>('all');
  const [docsAllowedUsers, setDocsAllowedUsers] = useState<string[]>([]);
  const [docsRoot, setDocsRoot] = useState('.docs');
  const [hoverPopupsEnabled, setHoverPopupsEnabled] = useState(true);
  const [hoverPopupDelay, setHoverPopupDelay] = useState(1500);
  const [commentHoverPreviewEnabled, setCommentHoverPreviewEnabled] = useState(false);
  const [tokenDisplayMode, setTokenDisplayMode] = useState<'cost' | 'tokens'>('cost');
  const [tokenCostThresholds, setTokenCostThresholds] = useState<{ green: number; yellow: number }>({ green: 0.10, yellow: 0.50 });
  const [effortLevel, setEffortLevel] = useState<string>('high');
  const [defaultAgent, setDefaultAgent] = useState<string>('auto');
  const [boardPermissionDefault, setBoardPermissionDefault] = useState<'gated' | 'skip'>('gated');
  const [ticketPermissionDefault, setTicketPermissionDefault] = useState<'gated' | 'skip'>('skip');
  const [groomingModel, setGroomingModel] = useState<string>('');
  const [implementationModel, setImplementationModel] = useState<string>('');
  const [geminiGroomingModel, setGeminiGroomingModel] = useState<string>('');
  const [geminiImplementationModel, setGeminiImplementationModel] = useState<string>('');
  const [generateDistinctFiles, setGenerateDistinctFiles] = useState(true);
  const [releaseNotesPath, setReleaseNotesPath] = useState('release-notes');
  const [syncDebounceMs, setSyncDebounceMs] = useState(30000);
  const [syncMaxWaitMs, setSyncMaxWaitMs] = useState(300000);
  const [agentProgressEnabled, setAgentProgressEnabled] = useState(true);
  const [agentProgressDelay, setAgentProgressDelay] = useState(2);
  const [modules, setModules] = useState<ModuleDeclaration[]>([]);
  const [mcpServerPhases, setMcpServerPhases] = useState<Record<string, string[]>>({});
  const [boardFx, setBoardFx] = useState<NonNullable<Config['boardFx']>>({ columnFire: true, ticketAgeRust: true, dragTrail: true, idleDust: true, boardWeather: true, columnFlowArrows: true, heartbeat: true, speedDemon: true, doneStreak: true, ticketDna: true });
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState<{ kind: 'success' | 'error'; message: string } | null>(null);

  // Global (cross-workspace) settings — lifted here so they save through the single Save bar.
  const [globalDefaultUser, setGlobalDefaultUser] = useState('');
  const [globalPreferredFramework, setGlobalPreferredFramework] = useState('');
  const [globalPort, setGlobalPort] = useState(3067);
  const [globalLoading, setGlobalLoading] = useState(true);
  const [globalError, setGlobalError] = useState<string | null>(null);
  const [globalMigratedFrom, setGlobalMigratedFrom] = useState<string | undefined>(undefined);
  // Snapshot of the global values as last loaded/saved, for dirty comparison + discard.
  const [loadedGlobal, setLoadedGlobal] = useState({ defaultUser: '', preferredFramework: '', port: 3067 });

  useEffect(() => {
    let cancelled = false;
    setGlobalLoading(true);
    fetchGlobalSettings()
      .then((s) => {
        if (cancelled) return;
        const next = { defaultUser: s.defaultUser ?? '', preferredFramework: s.preferredFramework ?? '', port: s.port ?? 3067 };
        setGlobalDefaultUser(next.defaultUser);
        setGlobalPreferredFramework(next.preferredFramework);
        setGlobalPort(next.port);
        setGlobalMigratedFrom(s.migratedFrom);
        setLoadedGlobal(next);
      })
      .catch((err) => { if (!cancelled) setGlobalError(err instanceof Error ? err.message : 'Failed to load global settings'); })
      .finally(() => { if (!cancelled) setGlobalLoading(false); });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (config) {
      setColumns(config.columns.map(c => ({ ...c, originalName: c.name })));
      setHiddenStatuses(config.hiddenStatuses.map(c => ({ ...c, originalName: c.name })));
      setUsers(config.users.map(u => ({ ...u, originalName: u.name })));
      setTags(config.tags.map(t => ({ ...t, originalName: t.name })));
      setPriorities(config.priorities.map(p => ({ ...p, originalName: p.name })) || []);
      setProjects(config.projects.join(', '));
      setEnableBacklog(config.enableBacklogScreen);
      setRequireComment(config.requireCommentOnStatusChange);
      setWorktreeByDefault(config.worktreeByDefault ?? false);
      setBoardCardOpenMode(config.boardCardOpenMode || 'chat');
      setAnimationsEnabled(config.animationsEnabled ?? true);
      setEnableFireworks(config.enableFireworks ?? true);
      setAnimationSpeed(config.animationSpeed || 'normal');
      setRequireInputStatus(config.requireInputStatus || DEFAULT_REQUIRE_INPUT_STATUS);
      setReadyForMergeStatus(config.readyForMergeStatus || DEFAULT_READY_FOR_MERGE_STATUS);
      setArchiveStatus(config.archiveStatus || DEFAULT_ARCHIVE_STATUS);
      setDocsEditPermissions(config.docsEditPermissions || 'all');
      setDocsAllowedUsers(config.docsAllowedUsers || []);
      setDocsRoot(config.docsRoot || '.docs');
      setHoverPopupsEnabled(config.hoverPopupsEnabled ?? true);
      setHoverPopupDelay(config.hoverPopupDelay ?? 1500);
      setCommentHoverPreviewEnabled(config.commentHoverPreviewEnabled ?? false);
      setTokenDisplayMode(config.tokenDisplayMode ?? 'cost');
      setTokenCostThresholds(config.tokenCostThresholds ?? { green: 0.10, yellow: 0.50 });
      setEffortLevel(config.effortLevel || 'high');
      setDefaultAgent(config.defaultAgent || 'auto');
      setBoardPermissionDefault(config.permissions?.boardDefault === 'skip' ? 'skip' : 'gated');
      setTicketPermissionDefault(config.permissions?.ticketDefault === 'gated' ? 'gated' : 'skip');
      setGroomingModel(config.integrations?.claudeCode?.groomingModel || '');
      setImplementationModel(config.integrations?.claudeCode?.implementationModel || '');
      setGeminiGroomingModel(config.integrations?.geminiCli?.groomingModel || '');
      setGeminiImplementationModel(config.integrations?.geminiCli?.implementationModel || '');
      if (config.releaseSettings) {
        setGenerateDistinctFiles(config.releaseSettings.generateDistinctFiles);
        setReleaseNotesPath(config.releaseSettings.releaseNotesPath || 'release-notes');
      }
      setSyncDebounceMs(config.syncSettings?.debounceMs ?? 30000);
      setSyncMaxWaitMs(config.syncSettings?.maxWaitMs ?? 300000);
      setAgentProgressEnabled(config.agentProgress?.enabled ?? true);
      setAgentProgressDelay(config.agentProgress?.inlineDelay ?? 2);
      setModules(config.modules || []);
      setMcpServerPhases((config as ConfigWithMcpPhases).mcpServerPhases || {});
      setBoardFx({ columnFire: true, ticketAgeRust: true, dragTrail: true, idleDust: true, boardWeather: true, columnFlowArrows: true, heartbeat: true, speedDemon: true, doneStreak: true, ticketDna: true, ...(config.boardFx ?? {}) });
    }
  }, [config]);

  const normalizedRequireInputStatus = requireInputStatus.trim() || DEFAULT_REQUIRE_INPUT_STATUS;
  const normalizedReadyForMergeStatus = readyForMergeStatus.trim() || DEFAULT_READY_FOR_MERGE_STATUS;
  const normalizedArchiveStatus = archiveStatus.trim() || DEFAULT_ARCHIVE_STATUS;

  const toastTimer = useRef<number | undefined>(undefined);
  useEffect(() => () => { if (toastTimer.current !== undefined) window.clearTimeout(toastTimer.current); }, []);

  const showToast = (kind: 'success' | 'error', message: string) => {
    setToast({ kind, message });
    if (toastTimer.current !== undefined) window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), 3000);
  };

  const handleSave = async () => {
    if (!config) return;
    setSaving(true);

    const currentRequireInputStatus = config.requireInputStatus || DEFAULT_REQUIRE_INPUT_STATUS;
    const currentReadyForMergeStatus = config.readyForMergeStatus || DEFAULT_READY_FOR_MERGE_STATUS;
    const nextColumns = columns.map((column) => ({ ...column }));
    const nextHiddenStatuses = hiddenStatuses.map((item) => ({ ...item }));

    const renameExistingWorkflowStatus = (items: StatusDef[], currentStatusName: string, nextStatusName: string) => {
      if (currentStatusName === nextStatusName) return false;
      const matchedItem = items.find((item) => item.name === currentStatusName || item.originalName === currentStatusName);
      if (matchedItem) {
        matchedItem.name = nextStatusName;
        return true;
      }
      return false;
    };

    if (!renameExistingWorkflowStatus(nextColumns, currentRequireInputStatus, normalizedRequireInputStatus)) {
      renameExistingWorkflowStatus(nextHiddenStatuses, currentRequireInputStatus, normalizedRequireInputStatus);
    }

    if (!renameExistingWorkflowStatus(nextColumns, currentReadyForMergeStatus, normalizedReadyForMergeStatus)) {
      renameExistingWorkflowStatus(nextHiddenStatuses, currentReadyForMergeStatus, normalizedReadyForMergeStatus);
    }

    const tagRenames: Record<string, string> = {};
    tags.forEach(t => { if (t.originalName && t.originalName !== t.name) tagRenames[t.originalName] = t.name; });

    const userRenames: Record<string, string> = {};
    users.forEach(u => { if (u.originalName && u.originalName !== u.name) userRenames[u.originalName] = u.name; });

    const statusRenames: Record<string, string> = {};
    [...nextColumns, ...nextHiddenStatuses].forEach(s => { if (s.originalName && s.originalName !== s.name) statusRenames[s.originalName] = s.name; });
    if (currentRequireInputStatus !== normalizedRequireInputStatus) {
      statusRenames[currentRequireInputStatus] = normalizedRequireInputStatus;
    }
    if (currentReadyForMergeStatus !== normalizedReadyForMergeStatus) {
      statusRenames[currentReadyForMergeStatus] = normalizedReadyForMergeStatus;
    }

    const priorityRenames: Record<string, string> = {};
    priorities.forEach(p => { if (p.originalName && p.originalName !== p.name) priorityRenames[p.originalName] = p.name; });

    try {
      if (Object.keys(tagRenames).length > 0 || Object.keys(userRenames).length > 0 || Object.keys(statusRenames).length > 0 || Object.keys(priorityRenames).length > 0) {
        await bulkRename({ tags: tagRenames, users: userRenames, statuses: statusRenames, priorities: priorityRenames });
      }

      const cleanTags = tags.filter(c => c.name.trim()).map(stripOriginalName);
      const cleanColumns = nextColumns.filter(c => c.name.trim()).map(stripOriginalName);
      const cleanHidden = nextHiddenStatuses.filter(c => c.name.trim()).map(stripOriginalName);
      const cleanUsers = users.filter(c => c.name.trim()).map(stripOriginalName);
      const cleanPriorities = priorities.filter(p => p.name.trim()).map(stripOriginalName);
      const cleanDocsAllowedUsers = docsEditPermissions === 'specified'
        ? docsAllowedUsers
            .map((userName) => userRenames[userName] || userName)
            .filter((userName) => cleanUsers.some((user) => user.name === userName))
        : [];

      await saveConfig({
        columns: cleanColumns,
        hiddenStatuses: cleanHidden,
        users: cleanUsers,
        tags: cleanTags,
        priorities: cleanPriorities,
        projects: projects.split(',').map(s => s.trim()).filter(Boolean),
        enableBacklogScreen: enableBacklog,
        requireCommentOnStatusChange: requireComment,
        boardCardOpenMode,
        worktreeByDefault,
        animationsEnabled,
        enableFireworks,
        animationSpeed,
        requireInputStatus: normalizedRequireInputStatus,
        readyForMergeStatus: normalizedReadyForMergeStatus,
        archiveStatus: normalizedArchiveStatus,
        docsEditPermissions,
        docsAllowedUsers: cleanDocsAllowedUsers,
        docsRoot,
        hoverPopupsEnabled,
        hoverPopupDelay,
        commentHoverPreviewEnabled,
        tokenDisplayMode,
        tokenCostThresholds,
        effortLevel,
        releaseSettings: {
          generateDistinctFiles,
          releaseNotesPath
        },
        integrations: {
          claudeCode: {
            groomingModel: groomingModel.trim(),
            implementationModel: implementationModel.trim(),
          },
          geminiCli: {
            groomingModel: geminiGroomingModel.trim(),
            implementationModel: geminiImplementationModel.trim(),
          }
        },
        defaultAgent: defaultAgent as CliFramework | 'auto',
        permissions: {
          boardDefault: boardPermissionDefault,
          ticketDefault: ticketPermissionDefault,
        },
        syncSettings: {
          debounceMs: syncDebounceMs,
          maxWaitMs: syncMaxWaitMs,
        },
        agentProgress: {
          enabled: agentProgressEnabled,
          inlineDelay: agentProgressDelay,
        },
        modules,
        mcpServerPhases,
        boardFx,
      } as ConfigWithMcpPhases);

      // Global (cross-workspace) settings travel through the same Save action.
      // Send the actual strings (NOT `value || undefined`): JSON.stringify drops undefined keys,
      // so coalescing an emptied field to undefined makes the engine keep the old value — the
      // field could never be cleared and the General tab stayed dirty forever (FLUX-770 review).
      // Snapshot loadedGlobal from the submitted values so the dirty compare always converges.
      if (isGeneralDirty) {
        await updateGlobalSettings({
          defaultUser: globalDefaultUser,
          preferredFramework: globalPreferredFramework,
          port: globalPort,
        });
        setLoadedGlobal({
          defaultUser: globalDefaultUser,
          preferredFramework: globalPreferredFramework,
          port: globalPort,
        });
      }

      triggerRefresh();
      showToast('success', 'Settings saved');
    } catch (err) {
      console.error(err);
      showToast('error', 'Failed to save settings');
    } finally {
      setSaving(false);
    }
  };

  const handleDiscard = () => {
    if (!config) return;
    setColumns(config.columns.map(c => ({ ...c, originalName: c.name })));
    setHiddenStatuses(config.hiddenStatuses.map(c => ({ ...c, originalName: c.name })));
    setUsers(config.users.map(u => ({ ...u, originalName: u.name })));
    setTags(config.tags.map(t => ({ ...t, originalName: t.name })));
    setPriorities(config.priorities.map(p => ({ ...p, originalName: p.name })) || []);
    setProjects(config.projects.join(', '));
    setEnableBacklog(config.enableBacklogScreen);
    setRequireComment(config.requireCommentOnStatusChange);
    setWorktreeByDefault(config.worktreeByDefault ?? false);
    setBoardCardOpenMode(config.boardCardOpenMode || 'chat');
    setAnimationsEnabled(config.animationsEnabled ?? true);
    setEnableFireworks(config.enableFireworks ?? true);
    setAnimationSpeed(config.animationSpeed || 'normal');
    setRequireInputStatus(config.requireInputStatus || DEFAULT_REQUIRE_INPUT_STATUS);
    setReadyForMergeStatus(config.readyForMergeStatus || DEFAULT_READY_FOR_MERGE_STATUS);
    setArchiveStatus(config.archiveStatus || DEFAULT_ARCHIVE_STATUS);
    setDocsEditPermissions(config.docsEditPermissions || 'all');
    setDocsAllowedUsers(config.docsAllowedUsers || []);
    setDocsRoot(config.docsRoot || '.docs');
    setHoverPopupsEnabled(config.hoverPopupsEnabled ?? true);
    setHoverPopupDelay(config.hoverPopupDelay ?? 1500);
    setCommentHoverPreviewEnabled(config.commentHoverPreviewEnabled ?? false);
    setTokenDisplayMode(config.tokenDisplayMode ?? 'cost');
    setTokenCostThresholds(config.tokenCostThresholds ?? { green: 0.10, yellow: 0.50 });
    setEffortLevel(config.effortLevel || 'high');
    setDefaultAgent(config.defaultAgent || 'auto');
    setBoardPermissionDefault(config.permissions?.boardDefault === 'skip' ? 'skip' : 'gated');
    setTicketPermissionDefault(config.permissions?.ticketDefault === 'gated' ? 'gated' : 'skip');
    setGroomingModel(config.integrations?.claudeCode?.groomingModel || '');
    setImplementationModel(config.integrations?.claudeCode?.implementationModel || '');
    setGeminiGroomingModel(config.integrations?.geminiCli?.groomingModel || '');
    setGeminiImplementationModel(config.integrations?.geminiCli?.implementationModel || '');
    setGenerateDistinctFiles(config.releaseSettings?.generateDistinctFiles ?? true);
    setReleaseNotesPath(config.releaseSettings?.releaseNotesPath || 'release-notes');
    setSyncDebounceMs(config.syncSettings?.debounceMs ?? 30000);
    setSyncMaxWaitMs(config.syncSettings?.maxWaitMs ?? 300000);
    setAgentProgressEnabled(config.agentProgress?.enabled ?? true);
    setAgentProgressDelay(config.agentProgress?.inlineDelay ?? 2);
    setModules(config.modules || []);
    setMcpServerPhases((config as ConfigWithMcpPhases).mcpServerPhases || {});
    setBoardFx({ columnFire: true, ticketAgeRust: true, dragTrail: true, idleDust: true, boardWeather: true, columnFlowArrows: true, heartbeat: true, speedDemon: true, doneStreak: true, ticketDna: true, ...(config.boardFx ?? {}) });
    // Global settings back to last loaded snapshot.
    setGlobalDefaultUser(loadedGlobal.defaultUser);
    setGlobalPreferredFramework(loadedGlobal.preferredFramework);
    setGlobalPort(loadedGlobal.port);
  };

  if (!config) return null;

  // ── Dirty tracking, grouped by tab ─────────────────────────────────────────
  // Each tab compares its own slice of current state against the saved config so the
  // sidebar can show exactly which tab carries unsaved changes (and the Save bar appears
  // whenever any tab is dirty). The theme picker + browser notifications save instantly,
  // so they are intentionally excluded from this comparison.
  const currentByTab: Record<SettingsTab, unknown> = {
    board: {
      columns: columns.filter(c => c.name.trim()).map(stripOriginalName),
      hiddenStatuses: hiddenStatuses.filter(c => c.name.trim()).map(stripOriginalName),
      requireInputStatus: normalizedRequireInputStatus,
      readyForMergeStatus: normalizedReadyForMergeStatus,
      archiveStatus: normalizedArchiveStatus,
      boardCardOpenMode,
      requireCommentOnStatusChange: requireComment,
      enableBacklogScreen: enableBacklog,
      hoverPopupsEnabled,
      hoverPopupDelay,
      commentHoverPreviewEnabled,
    },
    appearance: {
      animationsEnabled,
      animationSpeed,
      enableFireworks,
      boardFx,
    },
    attributes: {
      tags: tags.filter(c => c.name.trim()).map(stripOriginalName),
      priorities: priorities.filter(p => p.name.trim()).map(stripOriginalName),
    },
    workspace: {
      users: users.filter(c => c.name.trim()).map(stripOriginalName),
      projects: projects.split(',').map(s => s.trim()).filter(Boolean),
      docsEditPermissions,
      docsAllowedUsers: docsEditPermissions === 'specified' ? docsAllowedUsers : [],
      docsRoot,
      syncDebounceMs,
      syncMaxWaitMs,
      worktreeByDefault,
      generateDistinctFiles,
      releaseNotesPath,
    },
    agents: {
      effortLevel,
      defaultAgent,
      boardPermissionDefault,
      ticketPermissionDefault,
      groomingModel,
      implementationModel,
      geminiGroomingModel,
      geminiImplementationModel,
      agentProgressEnabled,
      agentProgressDelay,
      tokenDisplayMode,
      tokenCostThresholds,
    },
    modules: { modules, mcpServerPhases },
    general: {
      defaultUser: globalDefaultUser,
      preferredFramework: globalPreferredFramework,
      port: globalPort,
    },
  };

  const originalByTab: Record<SettingsTab, unknown> = {
    board: {
      columns: config.columns,
      hiddenStatuses: config.hiddenStatuses,
      requireInputStatus: config.requireInputStatus || DEFAULT_REQUIRE_INPUT_STATUS,
      readyForMergeStatus: config.readyForMergeStatus || DEFAULT_READY_FOR_MERGE_STATUS,
      archiveStatus: config.archiveStatus || DEFAULT_ARCHIVE_STATUS,
      boardCardOpenMode: config.boardCardOpenMode || 'chat',
      requireCommentOnStatusChange: config.requireCommentOnStatusChange,
      enableBacklogScreen: config.enableBacklogScreen,
      hoverPopupsEnabled: config.hoverPopupsEnabled ?? true,
      hoverPopupDelay: config.hoverPopupDelay ?? 1500,
      commentHoverPreviewEnabled: config.commentHoverPreviewEnabled ?? false,
    },
    appearance: {
      animationsEnabled: config.animationsEnabled ?? true,
      animationSpeed: config.animationSpeed || 'normal',
      enableFireworks: config.enableFireworks ?? true,
      boardFx: { columnFire: true, ticketAgeRust: true, dragTrail: true, idleDust: true, boardWeather: true, columnFlowArrows: true, heartbeat: true, speedDemon: true, doneStreak: true, ticketDna: true, ...(config.boardFx ?? {}) },
    },
    attributes: {
      tags: config.tags,
      priorities: config.priorities,
    },
    workspace: {
      users: config.users,
      projects: config.projects,
      docsEditPermissions: config.docsEditPermissions || 'all',
      docsAllowedUsers: config.docsEditPermissions === 'specified' ? (config.docsAllowedUsers || []) : [],
      docsRoot: config.docsRoot || '.docs',
      syncDebounceMs: config.syncSettings?.debounceMs ?? 30000,
      syncMaxWaitMs: config.syncSettings?.maxWaitMs ?? 300000,
      worktreeByDefault: config.worktreeByDefault ?? false,
      generateDistinctFiles: config.releaseSettings?.generateDistinctFiles ?? true,
      releaseNotesPath: config.releaseSettings?.releaseNotesPath || 'release-notes',
    },
    agents: {
      effortLevel: config.effortLevel || 'high',
      defaultAgent: config.defaultAgent || 'auto',
      boardPermissionDefault: config.permissions?.boardDefault === 'skip' ? 'skip' : 'gated',
      ticketPermissionDefault: config.permissions?.ticketDefault === 'gated' ? 'gated' : 'skip',
      groomingModel: config.integrations?.claudeCode?.groomingModel || '',
      implementationModel: config.integrations?.claudeCode?.implementationModel || '',
      geminiGroomingModel: config.integrations?.geminiCli?.groomingModel || '',
      geminiImplementationModel: config.integrations?.geminiCli?.implementationModel || '',
      agentProgressEnabled: config.agentProgress?.enabled ?? true,
      agentProgressDelay: config.agentProgress?.inlineDelay ?? 2,
      tokenDisplayMode: config.tokenDisplayMode ?? 'cost',
      tokenCostThresholds: config.tokenCostThresholds ?? { green: 0.10, yellow: 0.50 },
    },
    modules: {
      modules: config.modules || [],
      mcpServerPhases: (config as ConfigWithMcpPhases).mcpServerPhases || {},
    },
    general: {
      defaultUser: loadedGlobal.defaultUser,
      preferredFramework: loadedGlobal.preferredFramework,
      port: loadedGlobal.port,
    },
  };

  const dirtyTabs = new Set<SettingsTab>(
    TAB_ORDER.filter((tab) => JSON.stringify(currentByTab[tab]) !== JSON.stringify(originalByTab[tab]))
  );
  const isGeneralDirty = dirtyTabs.has('general');
  const isDirty = dirtyTabs.size > 0;

  return (
    <>
      <div className="max-w-5xl mx-auto mb-12 flex gap-6 items-start">
        <div className="w-64 shrink-0 eh-surface-overlay border eh-border rounded-2xl shadow-xl overflow-hidden sticky top-4">
          <div className="p-5 border-b border-gray-200 dark:border-white/10">
            <h2 className="text-lg font-bold text-gray-900 dark:text-gray-100 flex items-center justify-between">
              Settings
              {isDirty && <div className="w-2 h-2 rounded-full bg-amber-500" title="Unsaved changes" />}
            </h2>
          </div>
          <div className="py-2 flex flex-col gap-1">
            {TAB_ORDER.map((tab) => (
              <button
                key={tab}
                onClick={() => setActiveTab(tab)}
                className={`w-full text-left px-5 py-2.5 text-sm font-medium transition-colors flex items-center justify-between gap-2 ${activeTab === tab ? 'bg-primary/10 text-primary border-r-2 border-primary' : 'text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-white/5 border-r-2 border-transparent'}`}
              >
                <span>{TAB_LABELS[tab]}</span>
                {dirtyTabs.has(tab) && <span className="w-1.5 h-1.5 rounded-full bg-amber-500 shrink-0" title="Unsaved changes on this tab" />}
              </button>
            ))}
          </div>
        </div>

        <div className="flex-1 eh-surface-overlay border eh-border rounded-2xl shadow-xl flex flex-col min-h-[600px]">
          <div className="p-8 flex-1">
            <div className="flex items-center justify-between gap-4 mb-8 pb-6 border-b border-gray-200 dark:border-white/10">
              <div>
                <h2 className="text-2xl font-bold text-gray-900 dark:text-gray-100">{TAB_LABELS[activeTab]}</h2>
              </div>
              <StopServiceButton />
            </div>

            <div className="space-y-10">
              {activeTab === 'board' && (
                <div className="space-y-10">
                  <WorkflowSection
                    columns={columns}
                    setColumns={setColumns}
                    hiddenStatuses={hiddenStatuses}
                    setHiddenStatuses={setHiddenStatuses}
                    requireInputStatus={normalizedRequireInputStatus}
                    readyForMergeStatus={normalizedReadyForMergeStatus}
                    archiveStatus={normalizedArchiveStatus}
                  />
                  <BoardBehaviorSection
                    boardCardOpenMode={boardCardOpenMode}
                    setBoardCardOpenMode={setBoardCardOpenMode}
                    requireComment={requireComment}
                    setRequireComment={setRequireComment}
                    enableBacklog={enableBacklog}
                    setEnableBacklog={setEnableBacklog}
                    hoverPopupsEnabled={hoverPopupsEnabled}
                    setHoverPopupsEnabled={setHoverPopupsEnabled}
                    hoverPopupDelay={hoverPopupDelay}
                    setHoverPopupDelay={setHoverPopupDelay}
                    commentHoverPreviewEnabled={commentHoverPreviewEnabled}
                    setCommentHoverPreviewEnabled={setCommentHoverPreviewEnabled}
                  />
                </div>
              )}

              {activeTab === 'appearance' && (
                <AppearanceSection
                  animationsEnabled={animationsEnabled}
                  setAnimationsEnabled={setAnimationsEnabled}
                  animationSpeed={animationSpeed}
                  setAnimationSpeed={setAnimationSpeed}
                  enableFireworks={enableFireworks}
                  setEnableFireworks={setEnableFireworks}
                  boardFx={boardFx}
                  setBoardFx={setBoardFx}
                />
              )}

              {activeTab === 'attributes' && (
                <AttributesSection
                  tags={tags}
                  setTags={setTags}
                  priorities={priorities}
                  setPriorities={setPriorities}
                />
              )}

              {activeTab === 'workspace' && (
                <div className="space-y-10">
                  <WorkspaceSection
                    users={users}
                    setUsers={setUsers}
                    projects={projects}
                    setProjects={setProjects}
                    docsRoot={docsRoot}
                    setDocsRoot={setDocsRoot}
                    docsEditPermissions={docsEditPermissions}
                    setDocsEditPermissions={setDocsEditPermissions}
                    docsAllowedUsers={docsAllowedUsers}
                    setDocsAllowedUsers={setDocsAllowedUsers}
                    workspacePath={workspacePath}
                    notifyWorkspaceSet={notifyWorkspaceSet}
                    syncDebounceMs={syncDebounceMs}
                    setSyncDebounceMs={setSyncDebounceMs}
                    syncMaxWaitMs={syncMaxWaitMs}
                    setSyncMaxWaitMs={setSyncMaxWaitMs}
                  />
                  <WorktreeSection
                    worktreeByDefault={worktreeByDefault}
                    setWorktreeByDefault={setWorktreeByDefault}
                  />
                  <ReleaseNotesSection
                    generateDistinctFiles={generateDistinctFiles}
                    setGenerateDistinctFiles={setGenerateDistinctFiles}
                    releaseNotesPath={releaseNotesPath}
                    setReleaseNotesPath={setReleaseNotesPath}
                  />
                </div>
              )}

              {activeTab === 'agents' && (
                <div className="space-y-6">
                  <AgentSection
                    effortLevel={effortLevel}
                    setEffortLevel={setEffortLevel}
                    targetFramework={defaultAgent}
                    setTargetFramework={setDefaultAgent}
                    boardPermissionDefault={boardPermissionDefault}
                    setBoardPermissionDefault={setBoardPermissionDefault}
                    ticketPermissionDefault={ticketPermissionDefault}
                    setTicketPermissionDefault={setTicketPermissionDefault}
                    groomingModel={groomingModel}
                    setGroomingModel={setGroomingModel}
                    implementationModel={implementationModel}
                    setImplementationModel={setImplementationModel}
                    geminiGroomingModel={geminiGroomingModel}
                    setGeminiGroomingModel={setGeminiGroomingModel}
                    geminiImplementationModel={geminiImplementationModel}
                    setGeminiImplementationModel={setGeminiImplementationModel}
                    workspacePath={workspacePath}
                    setView={setView}
                  />
                  <AgentProgressSection
                    agentProgressEnabled={agentProgressEnabled}
                    setAgentProgressEnabled={setAgentProgressEnabled}
                    agentProgressDelay={agentProgressDelay}
                    setAgentProgressDelay={setAgentProgressDelay}
                  />
                  <CostTokensSection
                    tokenDisplayMode={tokenDisplayMode}
                    setTokenDisplayMode={setTokenDisplayMode}
                    tokenCostThresholds={tokenCostThresholds}
                    setTokenCostThresholds={setTokenCostThresholds}
                  />
                </div>
              )}

              {activeTab === 'modules' && (
                <>
                  <ModulesSection modules={modules} setModules={setModules} />
                  <McpPhasesSection value={mcpServerPhases} setValue={setMcpServerPhases} />
                </>
              )}

              {activeTab === 'general' && (
                <GeneralSection
                  defaultUser={globalDefaultUser}
                  setDefaultUser={setGlobalDefaultUser}
                  preferredFramework={globalPreferredFramework}
                  setPreferredFramework={setGlobalPreferredFramework}
                  port={globalPort}
                  setPort={setGlobalPort}
                  globalLoading={globalLoading}
                  globalError={globalError}
                  migratedFrom={globalMigratedFrom}
                />
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Transient save confirmation toast */}
      {toast && (
        <div className="fixed bottom-24 left-1/2 -translate-x-1/2 z-[60] pointer-events-none">
          <div className={`flex items-center gap-2 rounded-full px-4 py-2 text-sm font-medium shadow-lg ${toast.kind === 'success' ? 'bg-emerald-600 text-white' : 'bg-red-600 text-white'}`}>
            {toast.kind === 'success' ? <Check className="w-4 h-4" /> : <AlertTriangle className="w-4 h-4" />}
            {toast.message}
          </div>
        </div>
      )}

      {/* Sticky Save/Action Bar */}
      <div
        className={`fixed bottom-0 left-0 right-0 p-4 transition-transform duration-300 pointer-events-none z-50 ${isDirty ? 'translate-y-0' : 'translate-y-full'}`}
      >
        <div className="absolute inset-0 bg-gradient-to-t from-white/80 via-white/50 to-transparent dark:from-black/80 dark:via-black/50 dark:to-transparent pointer-events-none" />
        <div className="max-w-2xl mx-auto flex items-center justify-between bg-white dark:bg-[#1a1b23] border border-gray-200 dark:border-white/10 rounded-2xl shadow-2xl p-4 pointer-events-auto relative">
          <div className="flex flex-col">
            <span className="text-sm font-bold text-gray-900 dark:text-gray-100">Unsaved Changes</span>
            <span className="text-xs text-gray-500">
              {Array.from(dirtyTabs).map((tab) => TAB_LABELS[tab]).join(', ')} {dirtyTabs.size === 1 ? 'tab has' : 'tabs have'} unsaved changes.
            </span>
          </div>
          <div className="flex items-center gap-3">
            <button
              onClick={handleDiscard}
              disabled={saving}
              className="px-4 py-2 rounded-lg text-sm font-medium text-gray-600 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-white/5 transition-colors"
            >
              Discard
            </button>
            <button
              onClick={handleSave}
              disabled={saving}
              className="flex items-center gap-2 px-6 py-2 rounded-lg bg-primary hover:bg-primary-hover text-white shadow-sm shadow-primary/20 transition-colors text-sm font-medium"
            >
              <Save className="w-4 h-4" /> {saving ? 'Saving...' : 'Save Changes'}
            </button>
          </div>
        </div>
      </div>
    </>
  );
}
