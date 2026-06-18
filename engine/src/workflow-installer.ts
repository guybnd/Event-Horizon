import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { getModuleMcpServers } from './modules.js';
import { getEnginePort } from './packaged-mode.js';

export type Framework = 'auto' | 'copilot' | 'antigravity' | 'gemini' | 'cursor' | 'cline' | 'windsurf' | 'claude' | 'generic';
type ResolvedFramework = Exclude<Framework, 'auto'>;

export const EVENT_HORIZON_INSTRUCTIONS_START = '<!-- EVENT_HORIZON_MANAGED_INSTRUCTIONS:START -->';
export const EVENT_HORIZON_INSTRUCTIONS_END = '<!-- EVENT_HORIZON_MANAGED_INSTRUCTIONS:END -->';

/** Frameworks that receive one file per skill module (Option B). */
const MODULAR_FRAMEWORKS: ResolvedFramework[] = ['copilot', 'cline'];

/** Ordered skill module names sourced from .docs/skills/. */
const SKILL_MODULES = ['orchestrator', 'grooming', 'implementation', 'release', 'mapping'] as const;
type SkillModule = typeof SKILL_MODULES[number];

interface WorkflowInstallerOptions {
  sourceRoot: string;
  targetDir: string;
  framework?: Framework;
}

export interface WorkflowInstallStatus {
  framework: ResolvedFramework;
  /** Primary source path (orchestrator) — kept for backwards-compat. */
  skillSourcePath: string;
  /** All four phase-specific source skill paths. */
  skillSourcePaths: string[];
  /** Primary installed skill path (orchestrator for Copilot/Cline, single file for others). */
  skillInstalledPath: string;
  skillSourceExists: boolean;
  skillInstalled: boolean;
  instructionsSourcePath?: string;
  instructionsInstalledPath?: string | undefined;
  instructionsSourceExists: boolean;
  instructionsInstalled: boolean;
  workflowInstalled: boolean;
}

export interface WorkflowInstallResult {
  framework: ResolvedFramework;
  skillInstalledPath: string;
  instructionsInstalledPath?: string | undefined;
}

function resolveFramework(targetDir: string, requested: Framework): ResolvedFramework {
  if (requested !== 'auto') {
    return requested;
  }

  if (existsSync(path.join(targetDir, '.github'))) {
    return 'copilot';
  }

  if (existsSync(path.join(targetDir, '.gemini', 'antigravity'))) {
    return 'antigravity';
  }

  if (existsSync(path.join(targetDir, '.gemini'))) {
    return 'gemini';
  }

  if (existsSync(path.join(targetDir, '.cursor'))) {
    return 'cursor';
  }

  if (existsSync(path.join(targetDir, '.windsurf'))) {
    return 'windsurf';
  }

  if (existsSync(path.join(targetDir, '.cline'))) {
    return 'cline';
  }

  if (existsSync(path.join(targetDir, '.claude'))) {
    return 'claude';
  }

  return 'generic';
}

/** Returns the primary/representative installed path for status display. */
function skillDestinationFor(targetDir: string, framework: ResolvedFramework): string {
  switch (framework) {
    case 'copilot':
      return path.join(targetDir, '.github', 'skills', 'event-horizon', 'orchestrator.md');
    case 'cline':
      return path.join(targetDir, '.cline', 'skills', 'event-horizon-orchestrator.md');
    case 'antigravity':
    case 'gemini':
      return path.join(targetDir, '.gemini', 'skills', 'event-horizon.md');
    case 'cursor':
      return path.join(targetDir, '.cursor', 'rules', 'event-horizon.mdc');
    case 'windsurf':
      return path.join(targetDir, '.windsurf', 'rules', 'event-horizon.md');
    case 'claude':
      return path.join(targetDir, '.claude', 'rules', 'event-horizon.md');
    case 'generic':
    default:
      return path.join(targetDir, '.event-horizon', 'skills', 'event-horizon.md');
  }
}

/** Returns the installed path for a specific skill module. Only meaningful for modular frameworks. */
function skillModuleDestinationFor(targetDir: string, framework: ResolvedFramework, module: SkillModule): string {
  switch (framework) {
    case 'copilot':
      return path.join(targetDir, '.github', 'skills', 'event-horizon', `${module}.md`);
    case 'cline':
      return path.join(targetDir, '.cline', 'skills', `event-horizon-${module}.md`);
    default:
      return skillDestinationFor(targetDir, framework);
  }
}

function instructionsDestinationFor(targetDir: string, framework: ResolvedFramework) {
  switch (framework) {
    case 'copilot':
      return path.join(targetDir, '.github', 'copilot-instructions.md');
    case 'antigravity':
    case 'gemini':
      return path.join(targetDir, '.gemini', 'instructions.md');
    case 'cursor':
      return path.join(targetDir, '.cursorrules');
    case 'cline':
      return path.join(targetDir, '.clinerules');
    case 'windsurf':
      return path.join(targetDir, '.windsurfrules');
    case 'claude':
      return path.join(targetDir, '.clauderc');
    default:
      return undefined;
  }
}

function getSourcePaths(sourceRoot: string) {
  const skillsDir = path.join(sourceRoot, '.docs', 'skills');
  const skillSourcePaths = SKILL_MODULES.map(m => path.join(skillsDir, `event-horizon-${m}.md`));
  return {
    /** Primary source path (orchestrator) — kept for backwards-compat. */
    skillSourcePath: skillSourcePaths[0]!,
    skillSourcePaths,
    instructionsSourcePath: path.join(sourceRoot, '.flux', 'skills', 'event-horizon-copilot-instructions.md'),
  };
}

/** Concatenates skill modules into one file, wrapping each in XML tags for LLM navigation. */
async function buildConcatenatedSkill(skillSourcePaths: readonly string[]): Promise<string> {
  const parts: string[] = [];
  for (const [index, sourcePath] of skillSourcePaths.entries()) {
    const module = SKILL_MODULES[index];
    const content = await fs.readFile(sourcePath, 'utf-8');
    parts.push(`<skill_module name="event-horizon-${module}">
${content.trim()}
</skill_module>`);
  }
  return parts.join('\n\n');
}

async function pathExists(targetPath: string) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

const VERSION_RE = /^Version:\s*(\d+\.\d+\.\d+)/m;

/** Extract the "Version: x.y.z" line from skill content. */
export function extractSkillVersion(content: string): string | null {
  const match = content.match(VERSION_RE);
  return match?.[1] ?? null;
}

/**
 * Compare source skill version against the installed version.
 * Returns { sourceVersion, installedVersion, isStale } or null if check fails.
 */
export async function checkSkillVersionStaleness(options: {
  sourceRoot: string;
  targetDir: string;
  framework?: Framework;
}): Promise<{ sourceVersion: string; installedVersion: string | null; isStale: boolean; resolvedFramework: ResolvedFramework } | null> {
  const resolvedFramework = resolveFramework(options.targetDir, options.framework || 'auto');
  const { skillSourcePaths } = getSourcePaths(options.sourceRoot);

  // Read version from source (use orchestrator as canonical)
  const sourcePath = skillSourcePaths[0]!;
  if (!await pathExists(sourcePath)) return null;
  const sourceContent = await fs.readFile(sourcePath, 'utf-8');
  const sourceVersion = extractSkillVersion(sourceContent);
  if (!sourceVersion) return null;

  // Read version from installed file
  const installedPath = skillDestinationFor(options.targetDir, resolvedFramework);
  if (!await pathExists(installedPath)) return { sourceVersion, installedVersion: null, isStale: true, resolvedFramework };
  const installedContent = await fs.readFile(installedPath, 'utf-8');
  const installedVersion = extractSkillVersion(installedContent);

  return {
    sourceVersion,
    installedVersion,
    isStale: installedVersion !== sourceVersion,
    resolvedFramework,
  };
}

export function hasManagedInstructionsBlock(content: string) {
  const startIndex = content.indexOf(EVENT_HORIZON_INSTRUCTIONS_START);
  const endIndex = content.indexOf(EVENT_HORIZON_INSTRUCTIONS_END);
  return startIndex !== -1 && endIndex > startIndex;
}

export function patchCopilotInstructions(existingContent: string | undefined, managedInstructions: string) {
  const managedBlock = `${EVENT_HORIZON_INSTRUCTIONS_START}\n${managedInstructions.trim()}\n${EVENT_HORIZON_INSTRUCTIONS_END}`;
  const currentContent = existingContent ?? '';

  if (!currentContent.trim()) {
    return `${managedBlock}\n`;
  }

  const startIndex = currentContent.indexOf(EVENT_HORIZON_INSTRUCTIONS_START);
  const endIndex = currentContent.indexOf(EVENT_HORIZON_INSTRUCTIONS_END);

  if (startIndex !== -1 && endIndex > startIndex) {
    const before = currentContent.slice(0, startIndex).trimEnd();
    const after = currentContent.slice(endIndex + EVENT_HORIZON_INSTRUCTIONS_END.length).trimStart();

    return `${[before, managedBlock, after].filter(Boolean).join('\n\n')}\n`;
  }

  return `${managedBlock}\n\n${currentContent.trim()}\n`;
}

export async function getWorkflowInstallStatus({ sourceRoot, targetDir, framework = 'auto' }: WorkflowInstallerOptions): Promise<WorkflowInstallStatus> {
  const resolvedFramework = resolveFramework(targetDir, framework);
  const { skillSourcePath, skillSourcePaths, instructionsSourcePath } = getSourcePaths(sourceRoot);
  const skillInstalledPath = skillDestinationFor(targetDir, resolvedFramework);
  const instructionsInstalledPath = instructionsDestinationFor(targetDir, resolvedFramework);
  const skillSourceExists = await pathExists(skillSourcePath);
  const skillInstalled = await pathExists(skillInstalledPath);
  const instructionsSourceExists = !!instructionsInstalledPath ? await pathExists(instructionsSourcePath) : false;
  let instructionsInstalled = false;

  if (instructionsInstalledPath && await pathExists(instructionsInstalledPath)) {
    const instructionsContent = await fs.readFile(instructionsInstalledPath, 'utf-8');
    instructionsInstalled = hasManagedInstructionsBlock(instructionsContent);
  }

  return {
    framework: resolvedFramework,
    skillSourcePath,
    skillSourcePaths,
    skillInstalledPath,
    skillSourceExists,
    skillInstalled,
    instructionsSourcePath,
    instructionsInstalledPath,
    instructionsSourceExists,
    instructionsInstalled,
    workflowInstalled: skillInstalled && (!instructionsInstalledPath || instructionsInstalled),
  };
}

export async function installWorkspaceWorkflow({ sourceRoot, targetDir, framework = 'auto' }: WorkflowInstallerOptions): Promise<WorkflowInstallResult> {
  const resolvedFramework = resolveFramework(targetDir, framework);
  console.log(`[installer] Resolved framework: ${resolvedFramework}`);
  const { skillSourcePath, skillSourcePaths, instructionsSourcePath } = getSourcePaths(sourceRoot);
  const skillInstalledPath = skillDestinationFor(targetDir, resolvedFramework);
  const instructionsInstalledPath = instructionsDestinationFor(targetDir, resolvedFramework);

  console.log(`[installer] Skill dest: ${skillInstalledPath}`);
  console.log(`[installer] Instructions dest: ${instructionsInstalledPath}`);

  if (!await pathExists(skillSourcePath)) {
    throw new Error(`Skill source file not found: ${skillSourcePath}`);
  }

  if (MODULAR_FRAMEWORKS.includes(resolvedFramework)) {
    // Option B: install one file per skill module
    console.log(`[installer] Installing modular skill...`);
    for (const [index, module] of SKILL_MODULES.entries()) {
      const src = skillSourcePaths[index]!;
      const dest = skillModuleDestinationFor(targetDir, resolvedFramework, module);
      await fs.mkdir(path.dirname(dest), { recursive: true });
      await fs.copyFile(src, dest);
    }
  } else {
    // Option A: concatenate all modules wrapped in XML tags
    console.log(`[installer] Installing concatenated skill...`);
    await fs.mkdir(path.dirname(skillInstalledPath), { recursive: true });
    const concatenated = await buildConcatenatedSkill(skillSourcePaths);
    await fs.writeFile(skillInstalledPath, concatenated, 'utf-8');
  }

  if (instructionsInstalledPath) {
    console.log(`[installer] Patching instructions...`);
    if (!await pathExists(instructionsSourcePath)) {
      throw new Error(`Copilot instructions source file not found: ${instructionsSourcePath}`);
    }

    const managedInstructions = await fs.readFile(instructionsSourcePath, 'utf-8');
    const existingInstructions = await fs.readFile(instructionsInstalledPath, 'utf-8').catch(() => undefined);
    const nextInstructions = patchCopilotInstructions(existingInstructions, managedInstructions);
    await fs.mkdir(path.dirname(instructionsInstalledPath), { recursive: true });
    await fs.writeFile(instructionsInstalledPath, nextInstructions, 'utf-8');
  }

  // Install MCP config for agent tool discovery
  await installMcpConfig(targetDir, sourceRoot, resolvedFramework);

  console.log(`[installer] Done.`);
  return {
    framework: resolvedFramework,
    skillInstalledPath,
    instructionsInstalledPath,
  };
}

// ─── MCP Config Installation ─────────────────────────────────────────────────

function mcpConfigPathFor(targetDir: string, framework: ResolvedFramework): string {
  switch (framework) {
    case 'antigravity':
    case 'gemini':
      return path.join(targetDir, '.gemini', 'settings.json');
    case 'cursor':
      return path.join(targetDir, '.cursor', 'mcp.json');
    case 'cline':
      return path.join(targetDir, '.cline', 'mcp.json');
    case 'windsurf':
      return path.join(targetDir, '.windsurf', 'mcp.json');
    case 'copilot':
    case 'claude':
    case 'generic':
    default:
      return path.join(targetDir, '.mcp.json');
  }
}

function buildMcpServerEntry() {
  // FLUX-645: the engine serves the MCP server in-process over loopback HTTP, so the entry is
  // location-independent — no relative path, no --workspace, no worktree path. Every session
  // (main checkout or `.eh-worktrees/*` worktree) points at this one URL and shares the running
  // engine's single task-store cache. Rendered with the engine's configured port and re-written
  // on every engine start, so a port change is picked up automatically.
  //
  // alwaysLoad keeps event-horizon's OWN ticket tools loaded directly instead of deferred behind
  // tool-search — without it, every session (orchestrator + ticket chats) re-runs ToolSearch to
  // find get_ticket/change_status/etc. on cold start (FLUX-604). It's baked in here (not
  // hand-added to .mcp.json) because this installer overwrites the event-horizon entry on every
  // engine start, so a manual edit would be clobbered. Honored in merge mode by Claude Code >=
  // 2.1.121; the strict-profile spawn path sets it separately in claude-code.ts.
  return {
    type: 'http',
    url: `http://127.0.0.1:${getEnginePort()}/mcp`,
    alwaysLoad: true,
  };
}

async function installMcpConfig(targetDir: string, sourceRoot: string, framework: ResolvedFramework): Promise<void> {
  const configPath = mcpConfigPathFor(targetDir, framework);
  const serverEntry = buildMcpServerEntry();

  let existing: any = {};
  try {
    const raw = await fs.readFile(configPath, 'utf-8');
    existing = JSON.parse(raw);
  } catch {}
  existing.mcpServers = existing.mcpServers || {};
  existing.mcpServers['event-horizon'] = serverEntry;

  // Merge module MCP servers (phase-independent at install time — phase gating happens at prompt/session time)
  const moduleServers = getModuleMcpServers();
  if (Object.keys(moduleServers).length > 0) {
    console.log('[installer] Note: module MCP server paths are resolved against the current flux directory. If you later run "Migrate to orphan mode", re-run the installer to refresh module paths in .mcp.json.');
  }
  for (const [id, server] of Object.entries(moduleServers)) {
    // Only write a module server when it's ABSENT — never clobber a user-customized entry.
    // This runs on every workspace activation (engine start), so an unconditional overwrite
    // kept reverting a pinned shared entry (e.g. serena → {type:'http', url:…}) back to the
    // module's stdio default, forcing endless re-commits (FLUX-600). Newly-enabled modules with
    // no existing entry are still installed on first run.
    if (!(id in existing.mcpServers)) existing.mcpServers[id] = server;
  }

  await fs.mkdir(path.dirname(configPath), { recursive: true });
  await fs.writeFile(configPath, JSON.stringify(existing, null, 2) + '\n', 'utf-8');

  console.log(`[installer] MCP config installed: ${configPath}`);
}