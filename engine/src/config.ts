import fs from 'fs/promises';
import { getConfigFile } from './workspace.js';

export let configCache: any = {
  columns: [
    { name: 'Grooming', color: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300' },
    { name: 'Todo', color: 'bg-sky-100 text-sky-700 dark:bg-sky-900/30 dark:text-sky-300' },
    { name: 'In Progress', color: 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300' },
    { name: 'Ready', color: 'bg-teal-100 text-teal-700 dark:bg-teal-900/30 dark:text-teal-300' },
    { name: 'Done', color: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300' },
    { name: 'Archived', color: 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300' },
  ],
  hiddenStatuses: [
    { name: 'Backlog', color: 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300' },
    { name: 'Released', color: 'bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-300' }
  ],
  projects: ['FLUX'],
  users: [],
  tags: [
    { name: 'bug', color: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400' },
    { name: 'feature', color: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400' },
    { name: 'docs', color: 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400' }
  ],
  priorities: [
    { name: 'Critical', icon: 'AlertCircle', color: 'text-red-500' },
    { name: 'High', icon: 'ChevronUp', color: 'text-orange-500' },
    { name: 'Medium', icon: 'Equal', color: 'text-amber-500' },
    { name: 'Low', icon: 'ChevronDown', color: 'text-emerald-500' },
    { name: 'None', icon: 'Equal', color: 'text-gray-400' }
  ],
  enableBacklogScreen: true,
  requireCommentOnStatusChange: true,
  boardCardOpenMode: 'full',
  animationsEnabled: true,
  enableFireworks: true,
  requireInputStatus: 'Require Input',
  readyForMergeStatus: 'Ready',
  archiveStatus: 'Archived',
  docsEditPermissions: 'all',
  docsAllowedUsers: [],
  releaseSettings: {
    generateDistinctFiles: true,
    releaseNotesPath: 'release-notes'
  },
  defaultAgent: 'claude',
  integrations: {
    claudeCode: {
      groomingModel: '',
      implementationModel: '',
    },
    geminiCli: {
      groomingModel: '',
      implementationModel: '',
    },
    copilotCli: {
      groomingModel: '',
      implementationModel: '',
    }
  },
  syncSettings: {
    debounceMs: 30000,
    maxWaitMs: 300000,
  },
  agentProgress: {
    enabled: true,
    inlineDelay: 2,
  },
};

export async function loadConfig() {
  try {
    const data = await fs.readFile(getConfigFile(), 'utf-8');
    const loaded = JSON.parse(data);

    if (loaded.columns?.length && typeof loaded.columns[0] === 'string') loaded.columns = loaded.columns.map((s: string) => ({ name: s }));
    if (loaded.hiddenStatuses?.length && typeof loaded.hiddenStatuses[0] === 'string') loaded.hiddenStatuses = loaded.hiddenStatuses.map((s: string) => ({ name: s }));
    if (loaded.users?.length && typeof loaded.users[0] === 'string') loaded.users = loaded.users.map((s: string) => ({ name: s }));
    if (loaded.tags?.length && typeof loaded.tags[0] === 'string') {
      loaded.tags = loaded.tags.map((s: string) => ({
        name: s,
        color: 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300'
      }));
    }
    if (!loaded.priorities || !Array.isArray(loaded.priorities) || loaded.priorities.length === 0) {
      loaded.priorities = configCache.priorities;
    }
    if (loaded.priorities?.length && typeof loaded.priorities[0] === 'string') {
      loaded.priorities = loaded.priorities.map((name: string) => ({
        name,
        icon: 'Equal',
        color: 'text-gray-400'
      }));
    }

    configCache = { ...configCache, ...loaded };
    console.log('Loaded config');
  } catch (error: any) {
    if (error.code === 'ENOENT') {
      await saveConfig(configCache);
    } else {
      console.error('Failed to load config:', error);
    }
  }
}

export async function saveConfig(newConfig: any) {
  configCache = newConfig;
  await fs.writeFile(getConfigFile(), JSON.stringify(configCache, null, 2), 'utf-8');
}

export async function autoRegisterUnknownTags(tags: string[]) {
  if (!tags || !Array.isArray(tags) || tags.length === 0) return;

  if (!configCache.tags) {
    configCache.tags = [];
  }

  const existingTagsLower = new Set(configCache.tags.map((t: any) => t.name?.toLowerCase() || ''));
  let configChanged = false;

  for (const tag of tags) {
    if (tag && typeof tag === 'string' && !existingTagsLower.has(tag.toLowerCase())) {
      configCache.tags.push({
        name: tag,
        color: 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300'
      });
      existingTagsLower.add(tag.toLowerCase());
      configChanged = true;
    }
  }

  if (configChanged) {
    await saveConfig(configCache);
  }
}
