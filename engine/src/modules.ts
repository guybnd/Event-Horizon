import { configCache } from './config.js';
import { getActiveFluxDir } from './workspace.js';

export interface ModuleInstallDocs {
  requires: string;
  command: string;
  url?: string;
}

export interface ModuleDeclaration {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  mcpServer?: {
    command: string;
    args: string[];
    env?: Record<string, string>;
  };
  installDocs?: ModuleInstallDocs;
  promptFragment?: string;
  phases?: string[];
  conditions?: {
    requireTags?: string[];
  };
  /** Subdirectories to create under the active flux dir when this module is enabled. */
  scaffold?: {
    dirs: string[];
  };
}

const MAX_PROMPT_FRAGMENT_LENGTH = 2000;

function isValidModule(m: any): m is ModuleDeclaration {
  return (
    m &&
    typeof m.id === 'string' && m.id.trim() !== '' &&
    typeof m.name === 'string' &&
    typeof m.description === 'string' &&
    typeof m.enabled === 'boolean'
  );
}

export function loadModules(): ModuleDeclaration[] {
  const raw = (configCache as any).modules;
  if (!Array.isArray(raw)) return [];
  return raw.filter(isValidModule);
}

export function getActiveModules(phase?: string, tags?: string[]): ModuleDeclaration[] {
  return loadModules().filter(m => {
    if (!m.enabled) return false;
    if (phase && m.phases && m.phases.length > 0 && !m.phases.includes(phase)) return false;
    if (m.conditions?.requireTags && m.conditions.requireTags.length > 0) {
      if (!tags || !m.conditions.requireTags.every(t => tags.includes(t))) return false;
    }
    return true;
  });
}

function resolveEnvVars(env: Record<string, string>, vars: Record<string, string>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    result[k] = v.replace(/\$\{(\w+)\}/g, (_, name) => vars[name] ?? `\${${name}}`);
  }
  return result;
}

export function getModuleMcpServers(phase?: string, tags?: string[]): Record<string, { command: string; args: string[]; env?: Record<string, string> }> {
  const active = getActiveModules(phase, tags);
  const servers: Record<string, { command: string; args: string[]; env?: Record<string, string> }> = {};
  let activeFluxDir: string | undefined;
  try { activeFluxDir = getActiveFluxDir(); } catch { /* workspace not initialised */ }
  const vars: Record<string, string> = activeFluxDir ? { ACTIVE_FLUX_DIR: activeFluxDir } : {};
  if (!activeFluxDir) {
    console.warn('[modules] getActiveFluxDir() failed — ${ACTIVE_FLUX_DIR} template vars will not be resolved in MCP server env');
  }
  for (const m of active) {
    if (m.mcpServer) {
      const resolved = { ...m.mcpServer };
      if (resolved.env) {
        resolved.env = resolveEnvVars(resolved.env, vars);
      }
      servers[m.id] = resolved;
    }
  }
  return servers;
}

export function getModulePromptFragments(phase?: string, tags?: string[]): string {
  const active = getActiveModules(phase, tags);
  const fragments: string[] = [];
  for (const m of active) {
    if (m.promptFragment && m.promptFragment.trim()) {
      const trimmed = m.promptFragment.slice(0, MAX_PROMPT_FRAGMENT_LENGTH);
      fragments.push(`<module name="${m.name}">\n${trimmed}\n</module>`);
    }
  }
  if (fragments.length === 0) return '';
  return `## Active Modules\n\n${fragments.join('\n\n')}`;
}

export const BUILTIN_MODULES: ModuleDeclaration[] = [
  {
    id: 'serena',
    name: 'Serena Code Intelligence',
    description: 'Adds semantic code search, refactoring, and symbol navigation tools via Serena MCP',
    enabled: false,
    mcpServer: {
      command: 'serena',
      args: ['start-mcp-server', '--context', 'claude-code', '--project-from-cwd', '--open-web-dashboard', 'False', '--enable-gui-log-window', 'False'],
    },
    installDocs: {
      requires: 'uv (Python package manager)',
      command: 'uv tool install -p 3.13 serena-agent@latest --prerelease=allow',
      url: 'https://docs.astral.sh/uv/getting-started/installation/',
    },
    promptFragment: 'Serena code intelligence tools are available if you need them. Use them when grep or glob won\'t give you a confident answer — e.g. finding all call sites of a function, tracing a symbol through multiple files, or verifying a refactor is safe. Don\'t use them for simple text searches or when you already know where to look.',
  },
  {
    id: 'context7',
    name: 'Context7 Library Docs',
    description: 'Fetches up-to-date API docs for any npm/pip package on demand, preventing hallucinated or outdated method signatures',
    enabled: false,
    mcpServer: {
      command: 'npx',
      args: ['-y', '@upstash/context7-mcp'],
    },
    promptFragment: 'Context7 library documentation tools are available if you need them. Use them when you are uncertain about a specific API — method signatures, options, version-specific behaviour — rather than guessing or reading large node_modules files. Don\'t reach for them when you already know the API or when the answer is in the codebase itself.',
  },
  {
    id: 'basic-memory',
    name: 'Basic Memory',
    description: 'Project-scoped cross-session memory stored in the active flux directory (.flux-store in orphan mode) so it syncs between users via the orphan branch.',
    enabled: false,
    mcpServer: {
      command: 'uvx',
      args: ['basic-memory', 'mcp'],
      env: { BASIC_MEMORY_HOME: '${ACTIVE_FLUX_DIR}/memory' },
    },
    installDocs: {
      requires: 'uv (Python package manager)',
      command: 'uv tool install basic-memory',
      url: 'https://docs.astral.sh/uv/getting-started/installation/',
    },
    scaffold: { dirs: ['memory'] },
    promptFragment: 'Basic Memory tools are available if you need cross-session recall. Use them when you encounter a decision or pattern worth preserving for future sessions — architectural choices, project-specific conventions, known gotchas. Don\'t use them for ephemeral task state or things already captured in the ticket or codebase.',
  },
  {
    id: 'mem0',
    name: 'Mem0 Memory (Cloud)',
    description: 'Cloud-backed memory via Mem0. Requires MEM0_API_KEY env var. Optional variant of Basic Memory.',
    enabled: false,
    mcpServer: {
      command: 'npx',
      args: ['-y', '@mem0/mcp-server'],
      env: { MEM0_API_KEY: '${MEM0_API_KEY}' },
    },
    promptFragment: 'Mem0 memory tools are available if you need cross-session recall. Use them to persist key architectural decisions or patterns when they are worth remembering beyond this session. Don\'t use them for ephemeral state or things already tracked in the ticket.',
  },
];
