/**
 * Structured stderr logger — MCP-stdout safety guard (FLUX-351).
 *
 * When the engine runs as a stdio MCP server (`mcp-server.ts` + the `index.ts` stdio
 * path), the JSON-RPC framing is written to **stdout** by the `@modelcontextprotocol/sdk`
 * `StdioServerTransport`. Any stray write to stdout corrupts that framing and breaks the
 * protocol. `console.log` writes to stdout, so it is a latent corruption hazard anywhere
 * in the engine.
 *
 * This logger writes **only to stderr** (which is free for diagnostics in MCP mode and is
 * where `console.warn`/`console.error` already go). Use it for all diagnostic logging.
 * An ESLint rule (`engine/eslint.config.js`) bans `console.log` in engine source so the
 * hazard cannot be reintroduced.
 *
 * Dependency-free by design — it must be safe to import from the earliest bootstrap paths.
 *
 * Do NOT route the deliberate MCP transport stdout writes through this logger; those are
 * protocol output owned by the SDK and must stay on stdout.
 */

type LogArg = unknown;

function write(level: string, args: LogArg[]): void {
  const line = args
    .map((a) =>
      typeof a === 'string'
        ? a
        : a instanceof Error
          ? a.stack ?? a.message
          : (() => {
              try {
                return JSON.stringify(a);
              } catch {
                return String(a);
              }
            })()
    )
    .join(' ');
  process.stderr.write(`${level} ${line}\n`);
}

export const log = {
  info: (...args: LogArg[]): void => write('[info]', args),
  warn: (...args: LogArg[]): void => write('[warn]', args),
  error: (...args: LogArg[]): void => write('[error]', args),
  debug: (...args: LogArg[]): void => write('[debug]', args),
};
