import { spawn, execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

/**
 * Open a folder in a fresh editor window (FLUX-522). Used by the "Start in
 * worktree" flow to root a new VS Code window in a task's dedicated worktree —
 * a running session can't relocate its own cwd, so we open a new window instead.
 *
 * VS Code-specific by design (the `code` CLI); other editors aren't auto-opened.
 */

// FLUX-789: the spawns below use { shell: true } (the `code` CLI is a .cmd shim on Windows that
// Node won't spawn without a shell). That makes any path with shell metacharacters an injection
// sink — so we refuse to spawn one. Rejects &, |, ;, backtick, $, <, >, ^, quotes, and newlines;
// legit path characters (drive letters, backslashes, spaces, parentheses) are allowed.
const SHELL_METACHAR = /[&|;`$<>^"'\r\n]/;
export function isShellSafePath(p: string): boolean {
  return typeof p === 'string' && p.length > 0 && !SHELL_METACHAR.test(p);
}

/** True when the VS Code CLI (`code`) is resolvable on PATH. */
export async function isEditorAvailable(): Promise<boolean> {
  const probe = process.platform === 'win32' ? 'where' : 'which';
  try {
    await execFileAsync(probe, ['code'], { windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * Open `dir` in a NEW VS Code window. Fire-and-forget and detached so the engine
 * never blocks on (or owns) the editor process. Caller should check
 * {@link isEditorAvailable} first to report whether it actually launched.
 */
export function openEditorWindow(dir: string): void {
  if (!isShellSafePath(dir)) {
    console.error('[editor-launcher] refusing to open a path with shell metacharacters:', dir);
    return;
  }
  // `code` is a .cmd shim on Windows → needs a shell to resolve.
  const cmd = process.platform === 'win32' ? 'code.cmd' : 'code';
  const child = spawn(cmd, ['--new-window', dir], {
    shell: true,
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.on('error', () => { /* best-effort — availability is checked separately */ });
  child.unref();
}

/**
 * Open a single file in VS Code and reveal it (`-g`), reusing an existing window
 * when one is open. Fire-and-forget; check {@link isEditorAvailable} first.
 */
export function openEditorFile(filePath: string): void {
  if (!isShellSafePath(filePath)) {
    console.error('[editor-launcher] refusing to open a path with shell metacharacters:', filePath);
    return;
  }
  const cmd = process.platform === 'win32' ? 'code.cmd' : 'code';
  const child = spawn(cmd, ['-g', filePath], {
    shell: true,
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.on('error', () => { /* best-effort */ });
  child.unref();
}
