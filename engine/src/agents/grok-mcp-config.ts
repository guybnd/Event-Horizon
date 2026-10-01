/**
 * Grok MCP config is TOML (`[mcp_servers.<name>]`), not `.mcp.json`.
 * Shared by the adapter (GROK_HOME seed) and the installer (project + global writes).
 */

const EH_TABLE = 'mcp_servers.event-horizon';

export function grokMcpConfigToml(enginePort: number): string {
  return [
    `[${EH_TABLE}]`,
    `url = "http://127.0.0.1:${enginePort}/mcp"`,
    'enabled = true',
    '',
    `[${EH_TABLE}.headers]`,
    'X-EH-Session-Id = "${EH_SESSION_ID}"',
    'X-EH-Session-Token = "${EH_SESSION_TOKEN}"',
    'X-EH-Conversation-Id = "${EH_CONVERSATION_ID}"',
    'X-EH-Conversation-Token = "${EH_CONVERSATION_TOKEN}"',
    'X-EH-Workspace = "${EH_WORKSPACE}"',
    '',
  ].join('\n');
}

/** True when the TOML already carries EH's placeholder-header event-horizon server. */
export function isEhOwnedGrokMcpToml(text: string): boolean {
  return /\b127\.0\.0\.1:\d+\/mcp\b/.test(text)
    && text.includes('${EH_SESSION_ID}')
    && /\[mcp_servers\.event-horizon\]/.test(text);
}

export function extractEnginePortFromGrokToml(text: string): number | null {
  const match = text.match(/url\s*=\s*"https?:\/\/127\.0\.0\.1:(\d+)\/mcp"/);
  return match ? Number(match[1]) : null;
}

/**
 * Remove `[mcp_servers.event-horizon]` and any nested `[mcp_servers.event-horizon.*]`
 * tables, then append `block`. Other TOML tables stay untouched.
 */
export function upsertGrokEventHorizonToml(existing: string, block: string): string {
  const stripped = stripTomlTables(existing, EH_TABLE).trimEnd();
  const body = block.trimEnd() + '\n';
  if (!stripped) return body;
  return `${stripped}\n\n${body}`;
}

function stripTomlTables(src: string, tablePrefix: string): string {
  const lines = src.split(/\r?\n/);
  const out: string[] = [];
  let skipping = false;
  for (const line of lines) {
    const header = line.match(/^\s*\[([^\]]+)\]\s*$/);
    if (header) {
      const name = header[1]!.trim();
      skipping = name === tablePrefix || name.startsWith(`${tablePrefix}.`);
    }
    if (!skipping) out.push(line);
  }
  while (out.length > 0 && out[out.length - 1] === '') out.pop();
  return out.join('\n');
}
