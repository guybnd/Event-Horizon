import { log } from './log.js';
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { getModuleMcpServers } from './modules.js';
import { getEnginePort } from './packaged-mode.js';

export type Framework = 'auto' | 'copilot' | 'antigravity' | 'gemini' | 'cursor' | 'cline' | 'windsurf' | 'claude' | 'generic';
export type ResolvedFramework = Exclude<Framework, 'auto'>;

export const EVENT_HORIZON_INSTRUCTIONS_START = '<!-- EVENT_HORIZON_MANAGED_INSTRUCTIONS:START -->';
export const EVENT_HORIZON_INSTRUCTIONS_END = '<!-- EVENT_HORIZON_MANAGED_INSTRUCTIONS:END -->';

/** Frameworks that receive one file per skill module (Option B). */
const MODULAR_FRAMEWORKS: ResolvedFramework[] = ['copilot', 'cline'];

/** Ordered skill module names sourced from .docs/skills/. */
const SKILL_MODULES = ['orchestrator', 'grooming', 'implementation', 'review', 'release', 'mapping'] as const;
type SkillModule = typeof SKILL_MODULES[number];

interface WorkflowInstallerOptions {
  sourceRoot: string;
  targetDir: string;
  framework?: Framework;
  /**
   * Annotate the install as a manual hard-override reinstall (the `--force` CLI flag, FLUX-882). The
   * install already overwrites every managed skill file and runs the orphaned-skill-file sweep on
   * EVERY call, so this currently only affects log output — it changes neither what is written nor
   * what is swept. Kept as an explicit intent/affordance for `npm run install-skill -- --force`.
   */
  force?: boolean;
}

export interface WorkflowInstallStatus {
  framework: ResolvedFramework;
  /** Primary source path (orchestrator) — kept for backwards-compat. */
  skillSourcePath: string;
  /** All phase-specific source skill paths. */
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

// Every concrete (non-'auto') framework EH can install skills for. `gemini` precedes `antigravity`
// so it wins the dedupe for their shared `.gemini/skills/event-horizon.md` target (the common label).
const ALL_RESOLVED_FRAMEWORKS: readonly ResolvedFramework[] = [
  'copilot', 'gemini', 'antigravity', 'cursor', 'cline', 'windsurf', 'claude', 'generic',
];

/** True when EH has ALREADY installed its skill file(s) for `framework` in `targetDir`. */
function frameworkHasInstall(targetDir: string, framework: ResolvedFramework): boolean {
  const probe = MODULAR_FRAMEWORKS.includes(framework)
    ? skillModuleDestinationFor(targetDir, framework, 'orchestrator')
    : skillDestinationFor(targetDir, framework);
  return existsSync(probe);
}

/**
 * The set of frameworks EH should keep current in `targetDir`. A workspace can legitimately use
 * several agent frameworks at once, so this is the configured/primary framework PLUS every framework
 * EH has ALREADY installed skills for (its skill file exists on disk). Detecting by an existing
 * install — not merely a marker dir — avoids false positives (e.g. a bare `.github` CI dir that is
 * NOT a Copilot setup). FLUX-942: the installer + staleness check previously handled only one
 * framework, so a multi-framework workspace had its other frameworks silently go stale (and the
 * staleness check false-warned about whichever it auto-resolved).
 */
export function detectWorkspaceFrameworks(targetDir: string, preferred: Framework = 'auto'): ResolvedFramework[] {
  // Primary first so it wins any dedupe tie; then every framework with an existing install.
  const candidates: ResolvedFramework[] = [resolveFramework(targetDir, preferred)];
  for (const fw of ALL_RESOLVED_FRAMEWORKS) {
    if (frameworkHasInstall(targetDir, fw)) candidates.push(fw);
  }
  // Collapse frameworks that install to the SAME skill destination (gemini & antigravity both write
  // `.gemini/skills/event-horizon.md`) so we never install/check the identical file twice — first wins.
  const byDest = new Map<string, ResolvedFramework>();
  for (const fw of candidates) {
    const key = path.resolve(skillDestinationFor(targetDir, fw));
    if (!byDest.has(key)) byDest.set(key, fw);
  }
  return [...byDest.values()];
}

/**
 * Hard-override sweep (FLUX-882, scoped in FLUX-942): delete any stale `event-horizon*` file inside
 * the **resolved framework's own install dir(s)** that the current install no longer writes — e.g. a
 * skill module renamed/removed in a newer release that would otherwise linger and shadow the new
 * surface.
 *
 * Scoped to ONLY this framework's install dir(s) (derived from the dirnames of the files it writes),
 * never the other frameworks' dirs. A workspace can legitimately use several frameworks at once, so
 * another framework's `event-horizon*` file (e.g. `.gemini/skills/event-horizon.md` while installing
 * for `claude`) is NOT an orphan and must be left alone — sweeping every framework's dir (the
 * original FLUX-882 behavior) deleted those on every restart (FLUX-942). Within the swept dir we only
 * ever touch `event-horizon*` regular files (never a user's own file, never a directory). Best-effort
 * per file (a failed unlink is logged, not thrown).
 */
export async function cleanOrphanedSkillFiles(targetDir: string, framework: ResolvedFramework): Promise<string[]> {
  // The skill file(s) THIS framework installs, resolved — the only files that legitimately belong in
  // its install dir. The dir(s) to sweep are their dirnames, so we never reach another framework's dir.
  const skillFiles = (MODULAR_FRAMEWORKS.includes(framework)
    ? SKILL_MODULES.map((module) => skillModuleDestinationFor(targetDir, framework, module))
    : [skillDestinationFor(targetDir, framework)]
  ).map((f) => path.resolve(f));
  const expected = new Set(skillFiles);
  const sweepDirs = [...new Set(skillFiles.map((f) => path.dirname(f)))];
  const removed: string[] = [];
  for (const dir of sweepDirs) {
    let entries: string[];
    try {
      entries = await fs.readdir(dir);
    } catch {
      continue; // dir doesn't exist (or unreadable) — nothing to sweep here
    }
    for (const name of entries) {
      // Only ever touch event-horizon* files — never anything else in this dir.
      if (!name.startsWith('event-horizon')) continue;
      const full = path.resolve(dir, name);
      if (expected.has(full)) continue; // a current, expected install file — keep
      try {
        // lstat (not stat) so a symlinked event-horizon* entry is judged by the link itself, not
        // the type of whatever it points at — isFile() is false for a symlink either way, so it's
        // skipped like a directory would be (defense-in-depth; unlink already can't reach a
        // symlink's target regardless).
        const st = await fs.lstat(full);
        if (!st.isFile()) continue; // never recurse into / remove a directory (or follow a symlink)
        await fs.unlink(full);
        removed.push(full);
        log.info(`[installer] Removed orphaned skill file: ${full}`);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        log.error(`[installer] Could not remove orphaned skill file ${full} (${message}); skipping.`);
      }
    }
  }
  return removed;
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
  const instructionsSourceExists = instructionsInstalledPath ? await pathExists(instructionsSourcePath) : false;
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

export async function installWorkspaceWorkflow({ sourceRoot, targetDir, framework = 'auto', force = false }: WorkflowInstallerOptions): Promise<WorkflowInstallResult> {
  const resolvedFramework = resolveFramework(targetDir, framework);
  log.info(`[installer] Resolved framework: ${resolvedFramework}${force ? ' (force reinstall)' : ''}`);
  const { skillSourcePath, skillSourcePaths, instructionsSourcePath } = getSourcePaths(sourceRoot);
  const skillInstalledPath = skillDestinationFor(targetDir, resolvedFramework);
  const instructionsInstalledPath = instructionsDestinationFor(targetDir, resolvedFramework);

  log.info(`[installer] Skill dest: ${skillInstalledPath}`);
  log.info(`[installer] Instructions dest: ${instructionsInstalledPath}`);

  if (!await pathExists(skillSourcePath)) {
    throw new Error(`Skill source file not found: ${skillSourcePath}`);
  }

  if (MODULAR_FRAMEWORKS.includes(resolvedFramework)) {
    // Option B: install one file per skill module
    log.info(`[installer] Installing modular skill...`);
    for (const [index, module] of SKILL_MODULES.entries()) {
      const src = skillSourcePaths[index]!;
      const dest = skillModuleDestinationFor(targetDir, resolvedFramework, module);
      await fs.mkdir(path.dirname(dest), { recursive: true });
      await fs.copyFile(src, dest);
    }
  } else {
    // Option A: concatenate all modules wrapped in XML tags
    log.info(`[installer] Installing concatenated skill...`);
    await fs.mkdir(path.dirname(skillInstalledPath), { recursive: true });
    const concatenated = await buildConcatenatedSkill(skillSourcePaths);
    await fs.writeFile(skillInstalledPath, concatenated, 'utf-8');
  }

  if (instructionsInstalledPath) {
    log.info(`[installer] Patching instructions...`);
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

  // Hard-override sweep (FLUX-882): after writing the current skill files, delete any orphaned
  // event-horizon* files a previous (pre-refactor) install left in the EH dirs — e.g. a skill
  // module renamed/removed in a newer release. Runs on EVERY install (force-independent); it is
  // idempotent and strictly EH-scoped, so this is safe and keeps the surface self-healing.
  try {
    const removed = await cleanOrphanedSkillFiles(targetDir, resolvedFramework);
    if (removed.length > 0) {
      log.info(`[installer] Orphan sweep removed ${removed.length} stale skill file(s)${force ? ' (force)' : ''}.`);
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    log.error(`[installer] Orphan sweep failed (non-fatal): ${message}`);
  }

  log.info(`[installer] Done.`);
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

export function buildMcpServerEntry() {
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

/** Shape of a `.mcp.json`-style config file — only the fields this installer reads/writes. */
interface McpConfigFile {
  mcpServers?: Record<string, unknown>;
  [key: string]: unknown;
}

async function installMcpConfig(targetDir: string, sourceRoot: string, framework: ResolvedFramework): Promise<void> {
  const configPath = mcpConfigPathFor(targetDir, framework);
  const serverEntry = buildMcpServerEntry();

  // Read and parse SEPARATELY. A single empty catch here used to swallow a
  // JSON.parse failure too, leaving existing={} so the unconditional write below
  // replaced the user's entire .mcp.json with just our entry — silently deleting
  // every other MCP server they configured (FLUX-782). Now: ENOENT → fresh {};
  // a malformed/unreadable EXISTING file → leave it untouched and skip our entry.
  let existing: McpConfigFile = {};
  try {
    const raw = await fs.readFile(configPath, 'utf-8');
    try {
      existing = JSON.parse(raw) as McpConfigFile;
    } catch (parseErr: unknown) {
      const message = parseErr instanceof Error ? parseErr.message : String(parseErr);
      console.error(`[installer] ${configPath} is not valid JSON (${message}); leaving it UNTOUCHED and skipping the event-horizon MCP entry. Fix the JSON and restart to register it.`);
      return;
    }
  } catch (readErr: unknown) {
    if ((readErr as NodeJS.ErrnoException)?.code !== 'ENOENT') {
      const message = readErr instanceof Error ? readErr.message : String(readErr);
      console.error(`[installer] Could not read ${configPath} (${message}); leaving it untouched and skipping the event-horizon MCP entry.`);
      return;
    }
    // ENOENT: no file yet — start from an empty config (legitimate fresh install).
  }
  // A parsed-but-non-object value (e.g. "[]" / "null") would lose data on the spread/write below.
  if (!existing || typeof existing !== 'object' || Array.isArray(existing)) {
    console.error(`[installer] ${configPath} did not contain a JSON object; leaving it untouched and skipping the event-horizon MCP entry.`);
    return;
  }
  existing.mcpServers = existing.mcpServers || {};
  existing.mcpServers['event-horizon'] = serverEntry;

  // Merge module MCP servers (phase-independent at install time — phase gating happens at prompt/session time)
  // FLUX-955 (C.15): pass the install target framework so Serena's `--context` is tuned for it (falls
  // back to claude-code until Serena ships a profile for the target — see serenaContextFor).
  const moduleServers = getModuleMcpServers(undefined, undefined, framework);
  if (Object.keys(moduleServers).length > 0) {
    log.info('[installer] Note: module MCP server paths are resolved against the current flux directory. If you later run "Migrate to orphan mode", re-run the installer to refresh module paths in .mcp.json.');
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

  log.info(`[installer] MCP config installed: ${configPath}`);
}