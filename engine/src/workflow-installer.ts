import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';

export type Framework = 'auto' | 'copilot' | 'gemini' | 'cursor' | 'cline' | 'windsurf' | 'claude' | 'generic';
type ResolvedFramework = Exclude<Framework, 'auto'>;

export const EVENT_HORIZON_INSTRUCTIONS_START = '<!-- EVENT_HORIZON_MANAGED_INSTRUCTIONS:START -->';
export const EVENT_HORIZON_INSTRUCTIONS_END = '<!-- EVENT_HORIZON_MANAGED_INSTRUCTIONS:END -->';

/** Frameworks that receive one file per skill module (Option B). */
const MODULAR_FRAMEWORKS: ResolvedFramework[] = ['copilot', 'cline'];

/** Ordered skill module names sourced from .docs/skills/. */
const SKILL_MODULES = ['orchestrator', 'grooming', 'implementation', 'release'] as const;
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
  instructionsInstalledPath?: string;
  instructionsSourceExists: boolean;
  instructionsInstalled: boolean;
  workflowInstalled: boolean;
}

export interface WorkflowInstallResult {
  framework: ResolvedFramework;
  skillInstalledPath: string;
  instructionsInstalledPath?: string;
}

function resolveFramework(targetDir: string, requested: Framework): ResolvedFramework {
  if (requested !== 'auto') {
    return requested;
  }

  if (existsSync(path.join(targetDir, '.github'))) {
    return 'copilot';
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

  return 'generic';
}

/** Returns the primary/representative installed path for status display. */
function skillDestinationFor(targetDir: string, framework: ResolvedFramework): string {
  switch (framework) {
    case 'copilot':
      return path.join(targetDir, '.github', 'skills', 'event-horizon', 'orchestrator.md');
    case 'cline':
      return path.join(targetDir, '.cline', 'skills', 'event-horizon-orchestrator.md');
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
    skillSourcePath: skillSourcePaths[0],
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
  const instructionsSourceExists = resolvedFramework === 'copilot' ? await pathExists(instructionsSourcePath) : false;
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
  const { skillSourcePath, skillSourcePaths, instructionsSourcePath } = getSourcePaths(sourceRoot);
  const skillInstalledPath = skillDestinationFor(targetDir, resolvedFramework);
  const instructionsInstalledPath = instructionsDestinationFor(targetDir, resolvedFramework);

  if (!await pathExists(skillSourcePath)) {
    throw new Error(`Skill source file not found: ${skillSourcePath}`);
  }

  if (MODULAR_FRAMEWORKS.includes(resolvedFramework)) {
    // Option B: install one file per skill module
    for (const [index, module] of SKILL_MODULES.entries()) {
      const src = skillSourcePaths[index];
      const dest = skillModuleDestinationFor(targetDir, resolvedFramework, module);
      await fs.mkdir(path.dirname(dest), { recursive: true });
      await fs.copyFile(src, dest);
    }
  } else {
    // Option A: concatenate all modules wrapped in XML tags
    await fs.mkdir(path.dirname(skillInstalledPath), { recursive: true });
    const concatenated = await buildConcatenatedSkill(skillSourcePaths);
    await fs.writeFile(skillInstalledPath, concatenated, 'utf-8');
  }

  if (instructionsInstalledPath) {
    if (!await pathExists(instructionsSourcePath)) {
      throw new Error(`Copilot instructions source file not found: ${instructionsSourcePath}`);
    }

    const managedInstructions = await fs.readFile(instructionsSourcePath, 'utf-8');
    const existingInstructions = await fs.readFile(instructionsInstalledPath, 'utf-8').catch(() => undefined);
    const nextInstructions = patchCopilotInstructions(existingInstructions, managedInstructions);
    await fs.mkdir(path.dirname(instructionsInstalledPath), { recursive: true });
    await fs.writeFile(instructionsInstalledPath, nextInstructions, 'utf-8');
  }

  return {
    framework: resolvedFramework,
    skillInstalledPath,
    instructionsInstalledPath,
  };
}