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
 *
 * FLUX-1407: a packaged (pkg/SEA) build launched by double-clicking has no attached console,
 * so stderr is invisible and failures (e.g. onboarding's skill-install step) are otherwise
 * undiagnosable from the UI alone. `configureFileSink()` lets the bootstrap path (index.ts)
 * additionally mirror `log.error` calls to a findable file — scoped to error level only so
 * routine info/debug traffic doesn't turn it into a firehose.
 */

import { appendFileSync } from 'fs';

type LogArg = unknown;

let fileSinkPath: string | null = null;

/** Mirror subsequent `log.error` calls to `filePath` (best-effort, never throws). */
export function configureFileSink(filePath: string): void {
  fileSinkPath = filePath;
}

function formatLine(args: LogArg[]): string {
  return args
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
}

function write(level: string, args: LogArg[]): void {
  const line = formatLine(args);
  process.stderr.write(`${level} ${line}\n`);
  if (level === '[error]' && fileSinkPath) {
    try {
      appendFileSync(fileSinkPath, `[${new Date().toISOString()}] ${level} ${line}\n`, 'utf-8');
    } catch {
      // Best-effort — never let file logging crash the process.
    }
  }
}

export const log = {
  info: (...args: LogArg[]): void => write('[info]', args),
  warn: (...args: LogArg[]): void => write('[warn]', args),
  error: (...args: LogArg[]): void => write('[error]', args),
  debug: (...args: LogArg[]): void => write('[debug]', args),
};
