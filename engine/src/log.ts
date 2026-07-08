/**
 * Structured stderr logger (FLUX-351).
 *
 * This logger writes **only to stderr** (where `console.warn`/`console.error` already
 * go) so diagnostic output stays separate from anything the engine or a spawned child
 * writes to stdout. Use it for all diagnostic logging. An ESLint rule
 * (`engine/eslint.config.js`) bans `console.log` in engine source so stray stdout writes
 * can't be reintroduced.
 *
 * Dependency-free by design — it must be safe to import from the earliest bootstrap paths.
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
