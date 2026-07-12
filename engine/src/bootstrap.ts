import { existsSync } from 'fs';
import path from 'path';
import { getFluxDir, getFluxStoreDir, resolveSkillSourceRoot, getWorkspaceRoot } from './workspace.js';
import { getConfig } from './config.js';
import { loadGlobalSettings } from './global-settings.js';
import { installWorkspaceWorkflow, detectWorkspaceFrameworks, type Framework } from './workflow-installer.js';

// Minimal shape of a config.json user entry — config.ts's getConfig() is untyped `any`,
// so this captures only the field this module actually reads/writes.
interface ConfigUserEntry {
  name?: string;
}

export async function bootstrapNewWorkspace(): Promise<void> {
  const workspaceRoot = getWorkspaceRoot();
  if (!workspaceRoot) return;

  const fluxExists = existsSync(getFluxDir()) || existsSync(getFluxStoreDir());
  if (fluxExists) return;

  const folderName = path.basename(workspaceRoot);
  const projectKey = folderName
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .slice(0, 8) || 'PROJECT';

  getConfig().projects = [projectKey];

  const global = await loadGlobalSettings();
  if (global.defaultUser) {
    const hasUser = getConfig().users.some((u: ConfigUserEntry) => u.name === global.defaultUser);
    if (!hasUser) {
      getConfig().users = [{ name: global.defaultUser }, ...getConfig().users];
    }
  }
  // FLUX-785: guarantee a human entry even when no global defaultUser is set, so a skip-name /
  // WorkspaceSelector first run never leaves config.users as [Agent]-only ("No users configured").
  // 'You' is a filterable placeholder — OnboardingWizard replaces it when a real name is entered.
  if (!getConfig().users.some((u: ConfigUserEntry) => u.name && u.name !== 'Agent')) {
    getConfig().users = [{ name: 'You' }, ...getConfig().users];
  }
  if (!getConfig().users.some((u: ConfigUserEntry) => u.name === 'Agent')) {
    getConfig().users.push({ name: 'Agent' });
  }
}

export async function installSkillsForWorkspace(): Promise<void> {
  const workspaceRoot = getWorkspaceRoot();
  if (!workspaceRoot) return;

  const global = await loadGlobalSettings();
  const preferred = (global.preferredFramework || 'auto') as Framework;
  const sourceRoot = resolveSkillSourceRoot();

  // Re-install the managed skill/instruction files on every activation. installWorkspaceWorkflow
  // always overwrites the managed files AND runs the orphaned-skill-file sweep (FLUX-882), so a
  // skill module renamed or removed by an older install (e.g. the 34→24 tool consolidation) is
  // cleaned up here without any version gate or one-shot marker — the sweep is idempotent and
  // framework-scoped, so running it every activation keeps the surface self-healing.
  //
  // Refresh EVERY framework the workspace uses (configured/primary + already-installed), not just
  // one: a multi-framework workspace (e.g. Claude + Copilot + Gemini) must keep ALL of them current,
  // otherwise the others silently go stale on a source bump (FLUX-942). Per-framework best-effort —
  // one framework failing must not block the others or boot.
  const frameworks = detectWorkspaceFrameworks(workspaceRoot, preferred);
  for (const framework of frameworks) {
    try {
      await installWorkspaceWorkflow({ sourceRoot, targetDir: workspaceRoot, framework });
    } catch (err) {
      console.warn(`[bootstrap] Skill installation failed for ${framework} (non-fatal):`, err);
    }
  }
}
