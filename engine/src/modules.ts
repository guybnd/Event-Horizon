import fs from 'node:fs';
import path from 'node:path';
import { configCache } from './config.js';
import { getActiveFluxDir, workspaceRoot } from './workspace.js';

/** Read the workspace `.mcp.json` server map (host-launched servers, incl. event-horizon). */
export function getWorkspaceMcpServers(): Record<string, Record<string, unknown>> {
  try {
    const file = path.join(workspaceRoot || process.cwd(), '.mcp.json');
    const json = JSON.parse(fs.readFileSync(file, 'utf8'));
    return json?.mcpServers ?? {};
  } catch {
    return {};
  }
}

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
  /**
   * Opt-in: let the EH engine manage ONE shared streamable-http server for this
   * module (on proven platforms) instead of a per-session stdio spawn, so every
   * agent session EH launches reuses a single language-server process.
   * `args` may contain `${PROJECT}` (workspace root) and `${PORT}` (allocated by
   * the engine) placeholders. When unavailable (unproven platform, server failed
   * to start), the engine falls back to the stdio `mcpServer` above.
   */
  sharedHttp?: {
    command: string;
    args: string[];
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

/**
 * Validate an `mcpServer` / `sharedHttp` block's shape. A malformed server
 * (missing/empty `command`, non-string `args`) must never reach `.mcp.json`
 * (FLUX-447).
 */
function isValidMcpServerShape(s: Record<string, unknown>): boolean {
  return (
    !!s &&
    typeof s.command === 'string' && s.command.trim() !== '' &&
    Array.isArray(s.args) && s.args.every((a: unknown) => typeof a === 'string') &&
    (s.env === undefined || (typeof s.env === 'object' && s.env !== null && !Array.isArray(s.env)))
  );
}

function isValidModule(m: unknown): m is ModuleDeclaration {
  if (!m || typeof m !== 'object') return false;
  const obj = m as Record<string, unknown>;
  const baseValid =
    typeof obj.id === 'string' && obj.id.trim() !== '' &&
    typeof obj.name === 'string' &&
    typeof obj.description === 'string' &&
    typeof obj.enabled === 'boolean';
  if (!baseValid) return false;
  // A declared mcpServer / sharedHttp must be well-formed — otherwise the module
  // is skipped so a malformed server can't be written into `.mcp.json` (FLUX-447).
  if (obj.mcpServer !== undefined && !isValidMcpServerShape(obj.mcpServer as Record<string, unknown>)) {
    console.warn(`[modules] Skipping module "${obj.id}" — malformed mcpServer (needs command: string, args: string[])`);
    return false;
  }
  if (obj.sharedHttp !== undefined && !isValidMcpServerShape(obj.sharedHttp as Record<string, unknown>)) {
    console.warn(`[modules] Skipping module "${obj.id}" — malformed sharedHttp (needs command: string, args: string[])`);
    return false;
  }
  return true;
}

export function loadModules(): ModuleDeclaration[] {
  const raw = configCache.modules;
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

export function getModuleMcpServers(phase?: string, tags?: string[], framework?: string): Record<string, { command: string; args: string[]; env?: Record<string, string> }> {
  const active = getActiveModules(phase, tags);
  const servers: Record<string, { command: string; args: string[]; env?: Record<string, string> }> = {};
  let activeFluxDir: string | undefined;
  try { activeFluxDir = getActiveFluxDir(); } catch { /* workspace not initialised */ }
  const vars: Record<string, string> = activeFluxDir ? { ACTIVE_FLUX_DIR: activeFluxDir } : {};
  if (!activeFluxDir) {
    console.warn('[modules] getActiveFluxDir() failed — ${ACTIVE_FLUX_DIR} template vars will not be resolved in MCP server env');
  }
  // FLUX-955 (audit C.15): resolve the per-framework Serena `--context` placeholder for the spawning
  // framework. Defaults to 'claude-code' (the only Serena profile EH targets today — see serenaContextFor).
  const serenaContext = serenaContextFor(framework);
  for (const m of active) {
    if (m.mcpServer) {
      const resolved = { ...m.mcpServer };
      // Map to a NEW args array (don't mutate the shared BUILTIN_MODULES const).
      if (resolved.args.some((a) => a.includes('${SERENA_CONTEXT}'))) {
        resolved.args = resolved.args.map((a) => a.replace('${SERENA_CONTEXT}', serenaContext));
      }
      if (resolved.env) {
        resolved.env = resolveEnvVars(resolved.env, vars);
      }
      servers[m.id] = resolved;
    }
  }
  return servers;
}

// FLUX-955 (audit C.15): Serena's `--context` tunes it to a host agent's conventions. Serena ships a
// `claude-code` profile, which EH has always used. There is no Copilot/Gemini-specific Serena profile
// yet, so every framework falls back to `claude-code` — a tuning HINT, not a correctness gap (Serena
// still works for the other agents, just tuned for Claude's conventions). This is the seam: when Serena
// adds a matching profile, map the framework here and it flows through automatically (the spawning
// framework is threaded into getModuleMcpServers / substituteArgs, which resolve the `${SERENA_CONTEXT}`
// placeholder in the Serena module args).
const SERENA_CONTEXT_BY_FRAMEWORK: Record<string, string> = {
  claude: 'claude-code',
};
export function serenaContextFor(framework?: string): string {
  return (framework && SERENA_CONTEXT_BY_FRAMEWORK[framework]) || 'claude-code';
}

export function getModulePromptFragments(phase?: string, tags?: string[]): string {
  const active = getActiveModules(phase, tags);
  const fragments: string[] = [];
  // Dedupe by module id — matches getModuleMcpServers' object-key dedupe, so a
  // duplicate id in config doesn't inject the same fragment twice (FLUX-447).
  const seen = new Set<string>();
  for (const m of active) {
    if (seen.has(m.id)) continue;
    seen.add(m.id);
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
      // FLUX-955 (C.15): `${SERENA_CONTEXT}` is resolved per spawning framework by getModuleMcpServers
      // (defaults to 'claude-code'). This stdio path is Claude-only today, so it resolves to claude-code.
      command: 'serena',
      args: ['start-mcp-server', '--context', '${SERENA_CONTEXT}', '--project-from-cwd', '--open-web-dashboard', 'False', '--enable-gui-log-window', 'False'],
    },
    sharedHttp: {
      // FLUX-955 (C.15): the shared HTTP server is one-per-project (framework-agnostic), so its context
      // is resolved with no framework → 'claude-code' (substituteArgs in shared-mcp-server.ts).
      command: 'serena',
      args: ['start-mcp-server', '--context', '${SERENA_CONTEXT}', '--project', '${PROJECT}', '--transport', 'streamable-http', '--port', '${PORT}', '--enable-web-dashboard', 'False', '--enable-gui-log-window', 'False'],
    },
    installDocs: {
      requires: 'uv (Python package manager)',
      command: 'uv tool install -p 3.13 serena-agent@latest --prerelease=allow',
      url: 'https://docs.astral.sh/uv/getting-started/installation/',
    },
    promptFragment: 'Serena gives you language-server-backed semantic code navigation that is faster and more precise than text search. PREFER it over raw Grep/Glob whenever you work with code symbols. The first time you touch code in a session, call `initial_instructions` once to load Serena\'s usage manual, then use its tools: `get_symbols_overview` (see a file\'s top-level symbols before reading it whole), `find_symbol` (jump to a function/class/method by name instead of grepping), `find_referencing_symbols` (find all call sites before changing a signature), `replace_symbol_body`/`insert_after_symbol`/`insert_before_symbol` (edit a symbol precisely without re-reading the file), and `rename_symbol` (rename across the codebase via the language server). Still use built-in Grep/Read for non-code text (markdown, configs, logs), for string-literal searches, and when you already know the exact file and line.',
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
