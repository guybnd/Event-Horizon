import { existsSync } from 'fs';
import path from 'path';
import { getActiveFluxDir, getFluxDir, getFluxStoreDir, workspaceRoot, resolveSkillSourceRoot } from './workspace.js';
import { configCache, saveConfig } from './config.js';
import { loadGlobalSettings } from './global-settings.js';
import { installWorkspaceWorkflow, type Framework } from './workflow-installer.js';

export async function bootstrapNewWorkspace(): Promise<void> {
  if (!workspaceRoot) return;

  const fluxExists = existsSync(getFluxDir()) || existsSync(getFluxStoreDir());
  if (fluxExists) return;

  const folderName = path.basename(workspaceRoot);
  const projectKey = folderName
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .slice(0, 8) || 'PROJECT';

  configCache.projects = [projectKey];

  const global = await loadGlobalSettings();
  if (global.defaultUser) {
    const hasUser = configCache.users.some((u: any) => u.name === global.defaultUser);
    if (!hasUser) {
      configCache.users = [{ name: global.defaultUser }, ...configCache.users];
    }
  }
  if (!configCache.users.some((u: any) => u.name === 'Agent')) {
    configCache.users.push({ name: 'Agent' });
  }
}

export async function installSkillsForWorkspace(): Promise<void> {
  if (!workspaceRoot) return;

  const global = await loadGlobalSettings();
  const framework = (global.preferredFramework || 'auto') as Framework;
  const sourceRoot = resolveSkillSourceRoot();

  try {
    await installWorkspaceWorkflow({
      sourceRoot,
      targetDir: workspaceRoot,
      framework,
    });
  } catch (err) {
    console.warn('[bootstrap] Skill installation failed (non-fatal):', err);
  }
}
