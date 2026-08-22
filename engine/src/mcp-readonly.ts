import type { LaunchPhase } from './agents/types.js';
import { getConfig } from './config.js';
import type { ConnectorInfo } from './modules.js';

/**
 * FLUX-1657: per-connector read/write scoping for agent sessions.
 *
 * `mcpServerReadOnly` (config.ts, NOT seeded in CONFIG_DEFAULTS — absent means no scoping, same
 * convention as `toolScoping.categoryDeny`) maps a connector id to either `true` (read-only in
 * every phase) or a rule object carrying phase exceptions and per-server tool overrides.
 */
export interface McpReadOnlyRule {
  /** Phases in which this connector's write tools are NOT hidden — e.g. `['finalize']` for
   *  "read-only except when actually publishing". */
  exceptPhases?: LaunchPhase[];
  /** Tool names (bare, no `mcp__<id>__` prefix) that are force-ALLOWED even though they match the
   *  mutating-name pattern. */
  allow?: string[];
  /** Tool names (bare) that are force-DENIED even though they don't match the mutating-name
   *  pattern (e.g. an oddly-named write tool). */
  deny?: string[];
}

export type McpServerReadOnlyConfig = Record<string, boolean | McpReadOnlyRule>;

/** Tool-name segment patterns treated as mutating. Case-insensitive, matched against the bare
 *  tool name (never the `mcp__<id>__` prefix, which is the server id, not the verb). */
const MUTATING_NAME_RE = /create|update|delete|write|add|remove|transition|publish/i;

function normalizeRule(entry: boolean | McpReadOnlyRule | undefined): McpReadOnlyRule | undefined {
  if (entry === true) return {};
  if (!entry) return undefined;
  return entry;
}

/**
 * Which of a server's tool names must be denied for the given effective launch phase, per the
 * `mcpServerReadOnly` config. Pure — no I/O — so it's fully testable without a live MCP server and
 * safe to call synchronously at spawn time (see `claude-code.ts`'s `disallowedToolsArgs`).
 *
 * Fails open ([]) whenever: the server has no rule, the phase is in `exceptPhases`, or
 * `toolNames` is empty (the resolver below never probes synchronously, so an unresolved/uncached
 * server always fails open here rather than stripping tools blind).
 */
export function mutatingToolsForServer(
  serverId: string,
  toolNames: string[],
  cfg: McpServerReadOnlyConfig | undefined,
  effectivePhase: LaunchPhase | undefined,
): string[] {
  const rule = normalizeRule(cfg?.[serverId]);
  if (!rule || toolNames.length === 0) return [];
  if (effectivePhase && rule.exceptPhases?.includes(effectivePhase)) return [];

  const allow = new Set(rule.allow ?? []);
  const mutating = new Set(
    toolNames.filter((name) => MUTATING_NAME_RE.test(name) && !allow.has(name)),
  );
  for (const name of rule.deny ?? []) mutating.add(name);
  return [...mutating];
}

// ── Tool-name cache (probed out-of-band, never synchronously at spawn) ─────────────────────────

const toolNameCache = new Map<string, string[]>();

/** @internal test-only seam — avoids spawning a real MCP server to exercise the cache-read path. */
export function setCachedToolNames(serverId: string, names: string[]): void {
  toolNameCache.set(serverId, names);
}

/** @internal test-only seam. */
export function clearToolNameCache(): void {
  toolNameCache.clear();
}

export function getCachedToolNames(serverId: string): string[] | undefined {
  return toolNameCache.get(serverId);
}

/**
 * Probe one connector's real tool names via `probeMcpServer` (mcp-schema-probe.ts) and cache them
 * for `resolveReadOnlyDisallowedTools` below. Fire-and-forget by design — callers never await this
 * on a session-spawn path (probing adds latency + a failure surface neither can afford there).
 * A `sharedHttp`-only connector (no direct `url`/`mcpServer`) is skipped — it has no resolvable
 * config until an http URL is provisioned, so it simply stays a cache miss (fail open).
 */
export async function refreshMcpServerTools(connector: ConnectorInfo): Promise<void> {
  let config: { type: string; url: string } | { command: string; args: string[]; env?: Record<string, string> } | undefined;
  if (connector.url) {
    config = { type: 'http', url: connector.url };
  } else if (connector.mcpServer) {
    config = { command: connector.mcpServer.command, args: connector.mcpServer.args };
    if (connector.mcpServer.env) config.env = connector.mcpServer.env;
  }
  if (!config) return;
  // Dynamic import, deliberately not a static one: mcp-schema-probe.ts -> mcp-server.ts ->
  // agents/index.ts pulls in the full adapter registry (ClaudeCodeAdapter etc.), which itself
  // imports claude-code.ts — a static import here would close a require-cycle back through
  // claude-code.ts's own `disallowedToolsArgs` (which calls into this module). This function is
  // only ever invoked at runtime (from module-probe.ts's probeConnector), never during module
  // evaluation, so the lazy import carries no behavioral cost.
  const { probeMcpServer } = await import('./mcp-schema-probe.js');
  const result = await probeMcpServer(connector.id, config).catch(() => undefined);
  if (result?.ok) setCachedToolNames(connector.id, result.tools.map((t) => t.name));
}

/**
 * The exact `mcp__<serverId>__<tool>` CLI names to append to `--disallowed-tools` for one
 * connector at the given effective phase. Reads the config + cache only — never probes.
 */
export function resolveReadOnlyDisallowedTools(serverId: string, effectivePhase: LaunchPhase | undefined): string[] {
  const cfg = getConfig()?.mcpServerReadOnly as McpServerReadOnlyConfig | undefined;
  if (!cfg || !(serverId in cfg)) return [];
  const toolNames = getCachedToolNames(serverId) ?? [];
  return mutatingToolsForServer(serverId, toolNames, cfg, effectivePhase).map((name) => `mcp__${serverId}__${name}`);
}

/** Same as above, for every connector the config currently scopes. */
export function allReadOnlyDisallowedTools(effectivePhase: LaunchPhase | undefined): string[] {
  const cfg = getConfig()?.mcpServerReadOnly as McpServerReadOnlyConfig | undefined;
  if (!cfg) return [];
  return Object.keys(cfg).flatMap((id) => resolveReadOnlyDisallowedTools(id, effectivePhase));
}
