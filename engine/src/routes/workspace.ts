import express from 'express';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { execFile } from 'child_process';
import { workspaceRoot, saveAppSettings, autoRegisterWorkspace } from '../workspace.js';
import { activateWorkspace } from '../task-store.js';

const router = express.Router();

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
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Failed to open folder picker' });
  }
});

router.get('/', (_req, res) => {
  res.json({ configured: workspaceRoot !== null, path: workspaceRoot });
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
    await activateWorkspace(newRoot);
    await saveAppSettings({ workspace: newRoot });
    await autoRegisterWorkspace(newRoot);
    res.json({ ok: true, path: newRoot });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/health', (_req, res) => {
  res.json({ status: 'ok', workspace: workspaceRoot });
});

export function handlePathInfo(_req: express.Request, res: express.Response) {
  const isPkg = (process as any).pkg !== undefined;
  const binaryDir = isPkg ? path.dirname(process.execPath) : null;
  res.json({ binaryDir, isPkg, platform: process.platform });
}

export async function handlePathSetup(req: express.Request, res: express.Response) {
  const mode: string = req.body?.mode;
  if (mode !== 'auto' && mode !== 'instructional') {
    return res.status(400).json({ error: 'mode must be "auto" or "instructional"' });
  }

  const isPkg = (process as any).pkg !== undefined;
  if (!isPkg) {
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
  } catch (err: any) {
    return res.status(500).json({ error: err.message || 'Failed to update PATH' });
  }
}

export default router;
