/**
 * FLUX-1738: Antigravity CLI (`agy`) MCP config shape.
 *
 * The schema was settled by driving the live CLI (`agy mcp add --header … <name> <url>` on agy
 * 1.1.26) and reading back what it wrote — NOT from docs, and emphatically not by reusing
 * `buildGeminiMcpServerEntry`. Three differences from Gemini CLI's `.gemini/settings.json` shape
 * that make the Gemini entry non-portable:
 *
 *  - The transport key is **`serverUrl`**. Gemini CLI's `httpUrl` (and the newer `url` + `type`
 *    pair) are both unrecognised here — an entry carrying `httpUrl` registers a server with no
 *    URL, which fails at connect time rather than at install time.
 *  - Entries carry an explicit **`disabled: false`**, backing `agy mcp enable`/`disable`.
 *  - The file is **`mcp_config.json`**, not `settings.json`: `~/.gemini/config/mcp_config.json`
 *    globally, or `.agents/mcp_config.json` per workspace. The top-level `mcpServers` map is the
 *    one thing that IS shared with the Claude/Gemini shapes.
 *
 * Verbatim output of the live probe, for the record:
 *
 * ```json
 * { "mcpServers": { "eh-schema-probe": {
 *     "disabled": false,
 *     "headers": { "x-eh-conversation-id": "PROBE_ID", "x-eh-conversation-token": "PROBE_TOKEN" },
 *     "serverUrl": "http://127.0.0.1:3067/mcp" } } }
 * ```
 */
import { getEnginePort } from '../packaged-mode.js';

export interface AntigravityMcpServerEntry {
  serverUrl: string;
  headers: Record<string, string>;
  disabled: boolean;
}

export interface AntigravityMcpConfigFile {
  mcpServers?: Record<string, AntigravityMcpServerEntry | Record<string, unknown>>;
}

/**
 * The `event-horizon` entry for an `agy` MCP config.
 *
 * ⚠️ UNVERIFIED, and deliberately shipped this way: the `${EH_CONVERSATION_ID}` /
 * `${EH_CONVERSATION_TOKEN}` header values are PLACEHOLDERS, copying the FLUX-1213/FLUX-1222
 * strategy that Gemini CLI's settings.json env-var interpolation makes work. `agy` has no
 * per-spawn MCP flag either (CLI_CAPABILITIES.antigravity.spawnTimeMcpConfig is false), so the
 * same trick is the only available route to per-conversation binding from a static shared file —
 * but whether `agy` interpolates `${VAR}` inside `headers` has NOT been probed, and it cannot be
 * settled without a live engine to receive the call.
 *
 * The failure mode if it does not interpolate is the same graceful one Gemini degrades to: the
 * literal placeholder is sent, the HMAC check fails, and the route drops the call to the unrouted
 * `__board__` handling. Sessions still work; only per-conversation HITL routing is lost. Whoever
 * probes this should either confirm interpolation or replace this with a per-spawn rewrite of the
 * workspace `.agents/mcp_config.json` before each `spawnAntigravity`.
 */
export function buildAntigravityMcpServerEntry(port = getEnginePort()): AntigravityMcpServerEntry {
  return {
    serverUrl: `http://127.0.0.1:${port}/mcp`,
    headers: {
      'x-eh-conversation-id': '${EH_CONVERSATION_ID}',
      'x-eh-conversation-token': '${EH_CONVERSATION_TOKEN}',
    },
    disabled: false,
  };
}

/**
 * Merge the `event-horizon` entry into an existing parsed config, preserving every other server.
 * Split out from the file I/O so the merge semantics are unit-testable without a filesystem — the
 * FLUX-782 lesson (a swallowed parse error once replaced a user's whole `.mcp.json` with just our
 * entry) is about the caller's error handling, but the merge itself is worth pinning down too.
 */
export function upsertAntigravityEventHorizonEntry(
  existing: AntigravityMcpConfigFile,
  entry: AntigravityMcpServerEntry = buildAntigravityMcpServerEntry(),
): AntigravityMcpConfigFile {
  const next: AntigravityMcpConfigFile = { ...existing };
  next.mcpServers = { ...(existing.mcpServers || {}) };
  next.mcpServers['event-horizon'] = entry;
  return next;
}

/** True when the entry is the one EH writes (loopback `/mcp` on any port, placeholder headers). */
export function isEhOwnedAntigravityEntry(entry: unknown): boolean {
  if (!entry || typeof entry !== 'object') return false;
  const url = (entry as { serverUrl?: unknown }).serverUrl;
  return typeof url === 'string' && /^http:\/\/127\.0\.0\.1:\d+\/mcp$/.test(url);
}
