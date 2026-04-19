import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

process.removeAllListeners('warning');
process.on('warning', (w) => { if (w.code !== 'DEP0190') console.warn(w); });

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const isWin = process.platform === 'win32';
const npm = isWin ? 'npm.cmd' : 'npm';

const engine = spawn(npm, ['run', 'dev', '-w', 'engine'], {
  cwd: root,
  stdio: 'inherit',
  shell: isWin,
});

const portal = spawn(npm, ['run', 'dev', '-w', 'portal'], {
  cwd: root,
  stdio: 'inherit',
  shell: isWin,
});

function cleanup() {
  engine.kill();
  portal.kill();
  process.exit();
}

process.on('SIGINT', cleanup);
process.on('SIGTERM', cleanup);

engine.on('exit', (code) => {
  if (code !== 0) console.error(`[engine] exited with code ${code}`);
  portal.kill();
  process.exit(code ?? 1);
});

portal.on('exit', (code) => {
  if (code !== 0) console.error(`[portal] exited with code ${code}`);
});
