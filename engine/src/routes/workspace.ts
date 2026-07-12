import express from 'express';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { execFile } from 'child_process';
import { saveAppSettings, autoRegisterWorkspace, getWorkspaceRoot } from '../workspace.js';
import { activateWorkspace } from '../task-store.js';
import { isPackaged } from '../packaged-mode.js';

const router = express.Router();

function errorMessage(err: unknown, fallback?: string): string | undefined {
  return err instanceof Error && err.message ? err.message : fallback;
}

function spawnFolderPicker(): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const platform = process.platform;

    if (platform === 'win32') {
      const script = [
        'Add-Type -AssemblyName System.Windows.Forms;',
        '$f = New-Object System.Windows.Forms.Form;',
        '$f.TopMost = $true;',
        '$f.ShowInTaskbar = $false;',
        '$f.WindowState = "Minimized";',
        '$d = New-Object System.Windows.Forms.FolderBrowserDialog;',
        '$d.Description = "Select your Event Horizon project folder";',
        '$d.ShowNewFolderButton = $true;',
        'if ($d.ShowDialog($f) -eq "OK") { Write-Output $d.SelectedPath }',
        '$f.Dispose();',
      ].join(' ');
      execFile('powershell.exe', ['-NoProfile', '-Command', script], { windowsHide: true }, (err, stdout) => {
        if (err) return reject(err);
        resolve(stdout.trim() || null);
      });
    } else if (platform === 'darwin') {
      const script = 'POSIX path of (choose folder with prompt "Select your Event Horizon project folder")';
      execFile('osascript', ['-e', script], (err, stdout) => {
        if (err) return resolve(null);
        resolve(stdout.trim().replace(/\/$/, '') || null);
      });
    } else {
      execFile('zenity', ['--file-selection', '--directory', '--title=Select project folder'], (err, stdout) => {
        if (!err) return resolve(stdout.trim() || null);
        execFile('kdialog', ['--getexistingdirectory', os.homedir()], (err2, stdout2) => {
          if (err2) return resolve(null);
          resolve(stdout2.trim() || null);
        });
      });
    }
  });
}

router.post('/pick', async (_req, res) => {
  try {
    const picked = await spawnFolderPicker();
    res.json({ path: picked });
  } catch (err) {
    res.status(500).json({ error: errorMessage(err, 'Failed to open folder picker') });
  }
});

/**
 * Enumerate Windows drive letters that are currently accessible (FLUX-758).
 * Returns absolute root paths like "C:\\". Falls back to ["C:\\"] if probing
 * yields nothing so the in-app browser always has somewhere to start.
 */
async function listWindowsDrives(): Promise<string[]> {
  const drives: string[] = [];
  await Promise.all(
    Array.from({ length: 26 }, (_, i) => String.fromCharCode(65 + i)).map(async (letter) => {
      const root = `${letter}:\\`;
      try {
        await fs.access(root);
        drives.push(root);
      } catch {
        /* drive not present / not ready — skip */
      }
    }),
  );
  drives.sort();
  return drives.length ? drives : ['C:\\'];
}

interface DirEntry {
  name: string;
  path: string;
}

/**
 * Read-only directory browser backing the in-app folder picker (FLUX-758).
 * Mounted under /api/workspace (no requireWorkspace), so it works during
 * onboarding before any workspace is set.
 *
 *   GET /api/workspace/browse           → roots (drives on win32, home elsewhere)
 *   GET /api/workspace/browse?path=<abs> → immediate child directories of <path>
 *
 * Response: { path, parent, entries: [{ name, path }], roots? }
 *   - `path`   : the resolved directory being listed ('' when listing roots).
 *   - `parent` : parent directory, or null at a root / when listing roots.
 *   - `entries`: immediate child directories (sorted, hidden dotfiles skipped).
 *   - `roots`  : present only when listing roots; the available top-level roots.
 */
router.get('/browse', async (req, res) => {
  const raw = typeof req.query.path === 'string' ? req.query.path.trim() : '';

  // No path → return the roots so the picker has a starting point.
  if (!raw) {
    try {
      const home = os.homedir();
      if (process.platform === 'win32') {
        const drives = await listWindowsDrives();
        const entries: DirEntry[] = drives.map((d) => ({ name: d, path: d }));
        // Surface the home folder as a convenient first entry too.
        entries.unshift({ name: `Home (${path.basename(home) || home})`, path: home });
        return res.json({ path: '', parent: null, entries, roots: drives });
      }
      // *nix: start at home, expose filesystem root as an additional root.
      const entries: DirEntry[] = [
        { name: `Home (${path.basename(home) || home})`, path: home },
        { name: '/', path: '/' },
      ];
      return res.json({ path: '', parent: null, entries, roots: [home, '/'] });
    } catch (err) {
      return res.status(400).json({ error: errorMessage(err, 'Failed to list roots') });
    }
  }

  const resolved = path.resolve(raw);
  try {
    const dirents = await fs.readdir(resolved, { withFileTypes: true });
    const entries: DirEntry[] = dirents
      .filter((d) => {
        if (!d.isDirectory()) return false;
        if (d.name.startsWith('.')) return false; // skip hidden dotfiles
        return true;
      })
      .map((d) => ({ name: d.name, path: path.join(resolved, d.name) }))
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));

    const parentDir = path.dirname(resolved);
    // At a filesystem/drive root, dirname returns the path unchanged → no parent.
    const parent = parentDir === resolved ? null : parentDir;

    res.json({ path: resolved, parent, entries });
  } catch (err) {
    // fs.readdir rejects with a Node errno exception (has an optional `.code`); cast is safe
    // because that's the only rejection shape this call produces.
    const e = err as NodeJS.ErrnoException;
    const code = e?.code;
    const msg =
      code === 'ENOENT'
        ? `Folder not found: ${resolved}`
        : code === 'EACCES' || code === 'EPERM'
          ? `Can't read this folder (permission denied): ${resolved}`
          : e?.message || `Can't read this folder: ${resolved}`;
    res.status(400).json({ error: msg });
  }
});

router.get('/', (_req, res) => {
  res.json({ configured: getWorkspaceRoot() !== null, path: getWorkspaceRoot() });
});

router.post('/', async (req, res) => {
  const raw = req.body?.path;
  if (typeof raw !== 'string' || !raw.trim()) {
    return res.status(400).json({ error: 'path is required' });
  }
  const newRoot = path.resolve(raw.trim());

  try { await fs.access(newRoot); } catch {
    return res.status(400).json({ error: `Folder not found: ${newRoot}` });
  }

  try {
    const bound = await activateWorkspace(newRoot); // canonical bound root (FLUX-711)
    await saveAppSettings({ workspace: bound });
    await autoRegisterWorkspace(bound);
    res.json({ ok: true, path: bound });
  } catch (err) {
    res.status(500).json({ error: errorMessage(err) });
  }
});

router.get('/health', (_req, res) => {
  res.json({ status: 'ok', workspace: getWorkspaceRoot() });
});

export function handlePathInfo(_req: express.Request, res: express.Response) {
  const binaryDir = isPackaged ? path.dirname(process.execPath) : null;
  res.json({ binaryDir, isPkg: isPackaged, platform: process.platform });
}

export async function handlePathSetup(req: express.Request, res: express.Response) {
  const mode: string = req.body?.mode;
  if (mode !== 'auto' && mode !== 'instructional') {
    return res.status(400).json({ error: 'mode must be "auto" or "instructional"' });
  }

  if (!isPackaged) {
    return res.json({ ok: true, snippet: null, note: 'npm-global — already in PATH' });
  }

  const binaryDir = path.dirname(process.execPath);
  const platform = process.platform;

  let snippet: string;
  if (platform === 'win32') {
    snippet = `[Environment]::SetEnvironmentVariable('Path', $env:Path + ';${binaryDir}', 'User')`;
  } else {
    snippet = `export PATH="${binaryDir}:$PATH"`;
  }

  if (mode === 'instructional') {
    return res.json({ ok: true, snippet });
  }

  try {
    if (platform === 'win32') {
      const safeBinaryDir = binaryDir.replace(/'/g, "''");
      const ps = `[Environment]::SetEnvironmentVariable('Path', ([Environment]::GetEnvironmentVariable('Path','User') + ';${safeBinaryDir}'), 'User')`;
      await new Promise<void>((resolve, reject) => {
        execFile('powershell.exe', ['-NoProfile', '-Command', ps], { windowsHide: true }, (err) => {
          if (err) reject(err); else resolve();
        });
      });
    } else {
      const rcFile = platform === 'darwin'
        ? path.join(os.homedir(), '.zprofile')
        : path.join(os.homedir(), '.profile');
      const line = `\nexport PATH="${binaryDir}:$PATH"\n`;
      const existing = await fs.readFile(rcFile, 'utf-8').catch(() => '');
      if (!existing.includes(binaryDir)) {
        await fs.appendFile(rcFile, line, 'utf-8');
      }
    }
    return res.json({ ok: true, snippet });
  } catch (err) {
    return res.status(500).json({ error: errorMessage(err, 'Failed to update PATH') });
  }
}

export default router;
