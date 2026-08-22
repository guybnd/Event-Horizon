import fs from 'node:fs';
import path from 'node:path';
import { getConfig } from './config.js';
import { getActiveFluxDir, getWorkspaceRoot } from './workspace.js';

/** Read the workspace `.mcp.json` server map (host-launched servers, incl. event-horizon). */
export function getWorkspaceMcpServers(): Record<string, Record<string, unknown>> {
  try {
    const file = path.join(getWorkspaceRoot() || process.cwd(), '.mcp.json');
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
    /** FLUX-1479 (FLUX-1226 Phase D): only active for a Scratch ticket's chat (`isScratchSession`
     *  in agents/shared.ts) — the mechanism a scratch-specific fragment (e.g. `scratchpad-mode`
     *  below) is keyed on so an ordinary chat session never picks it up. */
    requireScratch?: boolean;
  };
  /** Subdirectories to create under the active flux dir when this module is enabled. */
  scaffold?: {
    dirs: string[];
  };
  /** FLUX-1656: env var NAMES (never values) this connector needs to authenticate. Declared
   *  explicitly here for connectors whose secret isn't a self-referential `${VAR}` passthrough in
   *  `mcpServer.env` (deriveConnectorEnvVars below already picks those up) — union of both feeds the
   *  Connectors settings panel's presence check. */
  requiredEnv?: string[];
  /** FLUX-1656: name of ONE MCP tool the Connectors panel may call (with empty/static args) after a
   *  successful `initialize` handshake, for connectors that only reveal a bad auth token on a real
   *  call (handshake alone succeeds). Generic mechanism — no bespoke per-connector probe code.
   *  MUST be read-only/idempotent: it fires automatically on every Settings-tab mount and every
   *  manual "Test" click, with no per-call user confirmation. */
  authProbe?: string;
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
  const raw = getConfig().modules;
  if (!Array.isArray(raw)) return [];
  return raw.filter(isValidModule);
}

export function getActiveModules(phase?: string, tags?: string[], isScratch?: boolean): ModuleDeclaration[] {
  // FLUX-1479: `loadModules()` only ever returns what a project explicitly opted into
  // (`getConfig().modules`, empty by default) — the right gate for a module that spawns a real
  // process (serena/context7/basic-memory/mem0 above, all `enabled: false` by default). A pure
  // prompt-fragment built-in with no external process (no `mcpServer`/`sharedHttp`) has no such
  // cost, so it stays always-in-play rather than requiring every project to remember to flip a
  // toggle for it — layered UNDER the configured list so a project can still override by id.
  const configured = loadModules();
  const configuredIds = new Set(configured.map(m => m.id));
  const alwaysOn = BUILTIN_MODULES.filter(m => m.enabled && !m.mcpServer && !m.sharedHttp && !configuredIds.has(m.id));
  return [...alwaysOn, ...configured].filter(m => {
    if (!m.enabled) return false;
    if (phase && m.phases && m.phases.length > 0 && !m.phases.includes(phase)) return false;
    if (m.conditions?.requireTags && m.conditions.requireTags.length > 0) {
      if (!tags || !m.conditions.requireTags.every(t => tags.includes(t))) return false;
    }
    if (m.conditions?.requireScratch && !isScratch) return false;
    return true;
  });
}

export function resolveEnvVars(env: Record<string, string>, vars: Record<string, string>): Record<string, string> {
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

// FLUX-1656: EH-internal template placeholders the engine itself resolves before spawn
// (resolveEnvVars / substituteArgs above) — never a real OS env var the user needs to set. Excluded
// from deriveConnectorEnvVars so e.g. basic-memory's `${ACTIVE_FLUX_DIR}` or a shared-http module's
// `${PROJECT}`/`${PORT}`/`${SERENA_CONTEXT}` never show up as a "missing" required connector env var.
const INTERNAL_TEMPLATE_VARS = new Set(['ACTIVE_FLUX_DIR', 'PROJECT', 'PORT', 'SERENA_CONTEXT']);

/** Auto-derive required env var NAMES from `${VAR}` placeholders in a server's env values, args,
 *  and url — the passthrough idiom BUILTIN_MODULES already uses (e.g. mem0's
 *  `env: { MEM0_API_KEY: '${MEM0_API_KEY}' }`). Never returns a value, only the name. */
function deriveConnectorEnvVars(env?: Record<string, string>, args?: string[], url?: string): string[] {
  const names = new Set<string>();
  const scan = (s: string) => {
    for (const m of s.matchAll(/\$\{(\w+)\}/g)) {
      const name = m[1];
      if (name && !INTERNAL_TEMPLATE_VARS.has(name)) names.add(name);
    }
  };
  for (const v of Object.values(env ?? {})) scan(v);
  for (const a of args ?? []) scan(a);
  if (url) scan(url);
  return [...names];
}

/** A connector for the Settings → Connectors trust panel (FLUX-1656): either a configured module
 *  server or a workspace `.mcp.json` server, tagged with its origin. */
export interface ConnectorInfo {
  id: string;
  name: string;
  source: 'module' | 'workspace';
  mcpServer?: ModuleDeclaration['mcpServer'];
  sharedHttp?: ModuleDeclaration['sharedHttp'];
  /** Set only for a workspace `.mcp.json` server declared as a remote streamable-http endpoint
   *  (`{ "type": "http", "url": "..." }`) rather than a spawned stdio process. */
  url?: string;
  requiredEnv: string[];
  authProbe?: string;
}

// The engine's own self-server (http://127.0.0.1:<port>/mcp in every workspace's `.mcp.json`) isn't
// an external connector to audit — exclude it from the unified list below.
const SELF_SERVER_ID = 'event-horizon';

/** Unified connector list: every configured module server (`loadModules()` — opted-in via config,
 *  not the full catalog) that declares `mcpServer`/`sharedHttp`, plus every workspace `.mcp.json`
 *  server except the engine's own self-server. Does NOT probe anything — see probeConnector /
 *  probeAllConnectors in module-probe.ts for the live auth check this list feeds. */
export function getConnectors(): ConnectorInfo[] {
  // Built with conditional property assignment (not `field: possiblyUndefined` in the literal) so an
  // absent value is an ABSENT key, never a present key holding `undefined` — required under this
  // repo's `exactOptionalPropertyTypes`, and matches the conditional-assign convention already used
  // for `resolved.env` above in getModuleMcpServers.
  const moduleConnectors: ConnectorInfo[] = loadModules()
    .filter((m) => m.mcpServer || m.sharedHttp)
    .map((m) => {
      const connector: ConnectorInfo = {
        id: m.id,
        name: m.name,
        source: 'module',
        requiredEnv: [...new Set([
          ...(m.requiredEnv ?? []),
          ...deriveConnectorEnvVars(m.mcpServer?.env, [...(m.mcpServer?.args ?? []), ...(m.sharedHttp?.args ?? [])]),
        ])],
      };
      if (m.mcpServer) connector.mcpServer = m.mcpServer;
      if (m.sharedHttp) connector.sharedHttp = m.sharedHttp;
      if (m.authProbe) connector.authProbe = m.authProbe;
      return connector;
    });

  const workspaceConnectors: ConnectorInfo[] = Object.entries(getWorkspaceMcpServers())
    .filter(([id]) => id !== SELF_SERVER_ID)
    .map(([id, raw]) => {
      const command = typeof raw.command === 'string' ? raw.command : undefined;
      const args = Array.isArray(raw.args) ? raw.args.filter((a): a is string => typeof a === 'string') : [];
      const env = raw.env && typeof raw.env === 'object' && !Array.isArray(raw.env) ? raw.env as Record<string, string> : undefined;
      const url = typeof raw.url === 'string' ? raw.url : undefined;
      const connector: ConnectorInfo = {
        id,
        name: id,
        source: 'workspace',
        requiredEnv: deriveConnectorEnvVars(env, args, url),
      };
      if (command) connector.mcpServer = env ? { command, args, env } : { command, args };
      if (url) connector.url = url;
      return connector;
    });

  return [...moduleConnectors, ...workspaceConnectors];
}

export function getModulePromptFragments(phase?: string, tags?: string[], isScratch?: boolean): string {
  const active = getActiveModules(phase, tags, isScratch);
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
    requiredEnv: ['MEM0_API_KEY'],
    promptFragment: 'Mem0 memory tools are available if you need cross-session recall. Use them to persist key architectural decisions or patterns when they are worth remembering beyond this session. Don\'t use them for ephemeral state or things already tracked in the ticket.',
  },
  {
    // FLUX-1479 (FLUX-1226 Phase D): always-on (not an opt-in toggle like the modules above) —
    // gated purely by `conditions.requireScratch` so it only ever activates for a Scratch
    // ticket's chat (phase 'chat' + task.kind === 'scratch'), never for an ordinary ticket chat.
    id: 'scratchpad-mode',
    name: 'Scratchpad Mode',
    description: 'Scratch-specific guidance for a Scratch ticket\'s open-ended chat session',
    enabled: true,
    phases: ['chat'],
    conditions: { requireScratch: true },
    promptFragment: 'This is a Scratchpad conversation — an exploratory surface with no fixed board position and no phase checklist. Use it to riff on ideas, compare approaches, and think out loud with the user before anything is committed to a real ticket. When the discussion converges on something concrete enough to build, PROPOSE extracting it into a real, groomed ticket (extract_ticket, or a board-rebase "promote") — describe what you would carve out and wait for the user\'s go-ahead rather than promoting unilaterally.',
  },
];
