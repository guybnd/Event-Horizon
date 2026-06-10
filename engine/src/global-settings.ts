import fs from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import os from 'os';

export interface GlobalSettings {
  workspaces: WorkspaceEntry[];
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

export interface WorkspaceEntry {
  path: string;
  label?: string;
}

const LEGACY_DIR = path.join(os.homedir(), '.event-horizon');

export function getLegacyDataDir(): string {
  return LEGACY_DIR;
}

export function getGlobalDataDir(): string {
  switch (process.platform) {
    case 'win32': {
      const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
      return path.join(appData, 'EventHorizon');
    }
    case 'darwin':
      return path.join(os.homedir(), 'Library', 'Application Support', 'EventHorizon');
    default: {
      const xdgConfig = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
      return path.join(xdgConfig, 'event-horizon');
    }
  }
}

function getSettingsFilePath(): string {
  return path.join(getGlobalDataDir(), 'settings.json');
}

function getLegacySettingsFilePath(): string {
  return path.join(LEGACY_DIR, 'settings.json');
}

export async function migrateFromLegacy(): Promise<boolean> {
  const globalDir = getGlobalDataDir();
  const globalSettingsFile = getSettingsFilePath();

  if (existsSync(globalSettingsFile)) return false;
  if (!existsSync(LEGACY_DIR)) return false;

  await fs.mkdir(globalDir, { recursive: true });

  const legacySettingsFile = getLegacySettingsFilePath();
  if (existsSync(legacySettingsFile)) {
    try {
      const raw = await fs.readFile(legacySettingsFile, 'utf-8');
      const legacy = JSON.parse(raw);
      const migrated: GlobalSettings = {
        workspaces: legacy.workspaces ?? [],
        lastWorkspace: legacy.workspace,
        firstBootCompleted: true,
        migratedFrom: LEGACY_DIR,
      };
      await fs.writeFile(globalSettingsFile, JSON.stringify(migrated, null, 2), 'utf-8');
      return true;
    } catch {
      return false;
    }
  }

  return false;
}

export async function loadGlobalSettings(): Promise<GlobalSettings> {
  const settingsFile = getSettingsFilePath();
  try {
    const raw = await fs.readFile(settingsFile, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return { workspaces: [] };
  }
}

export async function saveGlobalSettings(settings: GlobalSettings): Promise<void> {
  const settingsFile = getSettingsFilePath();
  await fs.mkdir(path.dirname(settingsFile), { recursive: true });
  await fs.writeFile(settingsFile, JSON.stringify(settings, null, 2), 'utf-8');
}

export interface BootStatus {
  firstBoot: boolean;
  legacyFound: boolean;
  dataDir: string;
  migrated: boolean;
}

export async function getBootStatus(): Promise<BootStatus> {
  const globalDir = getGlobalDataDir();
  const settingsFile = getSettingsFilePath();
  const globalExists = existsSync(settingsFile);
  const legacyFound = existsSync(LEGACY_DIR) && existsSync(getLegacySettingsFilePath());

  if (globalExists) {
    const settings = await loadGlobalSettings();
    return {
      firstBoot: !settings.firstBootCompleted,
      legacyFound,
      dataDir: globalDir,
      migrated: !!settings.migratedFrom,
    };
  }

  return {
    firstBoot: true,
    legacyFound,
    dataDir: globalDir,
    migrated: false,
  };
}

export async function confirmBoot(options?: { migrate?: boolean }): Promise<GlobalSettings> {
  const shouldMigrate = options?.migrate !== false;

  if (shouldMigrate) {
    await migrateFromLegacy();
  }

  const settings = await loadGlobalSettings();
  settings.firstBootCompleted = true;
  await saveGlobalSettings(settings);
  return settings;
}
