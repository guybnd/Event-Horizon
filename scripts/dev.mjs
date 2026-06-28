import { spawn, execSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

process.removeAllListeners('warning');
process.on('warning', (w) => { if (w.code !== 'DEP0190') console.warn(w); });

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const isWin = process.platform === 'win32';
const npm = isWin ? 'npm.cmd' : 'npm';

// Kill stale Vite process before spawning the portal so the new instance always
// owns the port cleanly. dev-watcher did this too but it raced with the portal spawn.
function killPort(port) {
  try {
    if (isWin) {
      const output = execSync(`netstat -ano | findstr ":${port}" | findstr "LISTENING"`, { encoding: 'utf-8' });
      const pids = new Set(
        output.split('\n')
          .map(line => line.trim().split(/\s+/).pop())
          .filter((pid) => !!pid && /^\d+$/.test(pid))
      );
      for (const pid of pids) {
        // /T = tree kill: the engine PLUS every agent session it spawned and their MCP servers
        // (serena, context7, …). Without /T the engine died but its children orphaned and piled up
        // across restarts — the 100+ stale-node-process leak that wedges the machine.
        try { execSync(`taskkill /F /T /PID ${pid}`, { stdio: 'ignore' }); } catch {}
      }
    } else {
      execSync(`lsof -ti:${port} | xargs -r kill -9`, { stdio: 'ignore' });
    }
  } catch {}
}

killPort(5167);
killPort(3067);

const engine = spawn(npm, ['run', 'dev', '-w', 'engine'], {
  cwd: root,
  stdio: 'pipe',
  shell: isWin,
});

const portal = spawn(npm, ['run', 'dev', '-w', 'portal'], {
  cwd: root,
  stdio: 'pipe',
  shell: isWin,
});

let enginePort = null;
let portalPort = null;
let bannerPrinted = false;
let workspacePath = null;
const startupCounts = { tasks: 0, docs: 0 };

// Suppress from all output — Node internals noise, not actionable.
const SUPPRESS_ALWAYS = [
  /\[DEP0190\]/,
  /\[DEP0205\]/,
  /Use `node --trace-deprecation/,
  /\(Use `node --trace-deprecation/,
];

// Very noisy engine lines — suppress permanently (shown as summary in banner or irrelevant).
const SUPPRESS_ENGINE_ALWAYS = [
  /^Loaded task: /,
  /^Loaded doc: /,
  /^Loaded \d+ pricing entries/,
  /^Loaded config/,
  /^Workspace: /,         // captured for banner, not echoed raw
];

// Informational engine startup lines — suppress only before the banner.
const SUPPRESS_ENGINE_PRE_BANNER = [
  /^\[subtasks\] Normalized /,
  /^Session recovery:/,
  /^\[migration\]/,
  /^\[FLUX AUTO-REPAIR\]/,
  /^\[tasks\] Remote max ID/,
  /^\[installer\]/,
  /^\[storage-sync\]/,
  /^\[sync-watcher\]/,
];

// Portal proxy noise before engine is up — engine not ready yet, not real errors.
const SUPPRESS_PORTAL_PRE_BANNER = [
  /\[vite\] http proxy error/,
  /AggregateError/,
  /ECONNREFUSED/,
  /at internalConnectMultiple/,
  /at afterConnectMultiple/,
];

function countStartupLine(line) {
  if (/^Loaded task: /.test(line)) startupCounts.tasks++;
  else if (/^Loaded doc: /.test(line)) startupCounts.docs++;
}

function maybePrintBanner() {
  if (bannerPrinted || enginePort === null || portalPort === null) return;
  bannerPrinted = true;

  const parts = [];
  if (startupCounts.tasks) parts.push(`${startupCounts.tasks} ticket${startupCounts.tasks !== 1 ? 's' : ''}`);
  if (startupCounts.docs)  parts.push(`${startupCounts.docs} doc${startupCounts.docs !== 1 ? 's' : ''}`);

  console.log('');
  if (workspacePath)  console.log(`  Workspace  ${workspacePath}`);
  if (parts.length)   console.log(`  Loaded     ${parts.join(', ')}`);
  if (workspacePath || parts.length) console.log('');
  console.log(`  Engine  →  http://localhost:${enginePort}`);
  console.log(`  Portal  →  http://localhost:${portalPort}`);
  console.log('');
}

// Fallback: if the engine "running on port" line wasn't caught (buffering/encoding edge case),
// poll the health endpoint once we see other engine-ready signs (Workspace log).
let enginePollTimer = null;
function scheduleEnginePortFallback() {
  if (enginePort !== null || enginePollTimer !== null) return;
  enginePollTimer = setTimeout(async () => {
    if (enginePort !== null) return;
    try {
      const res = await fetch('http://localhost:3067/api/health');
      if (res.ok) { enginePort = '3067'; maybePrintBanner(); }
    } catch {}
  }, 2000);
}

function pipeLines(stream, onLine) {
  let buf = '';
  stream.on('data', (chunk) => {
    buf += chunk.toString();
    const lines = buf.split('\n');
    buf = lines.pop() ?? '';
    for (const raw of lines) {
      onLine(raw.replace(/\r$/, ''));  // strip Windows CR
    }
  });
  stream.on('end', () => {
    if (buf) onLine(buf.replace(/\r$/, ''));
  });
}

pipeLines(engine.stdout, (line) => {
  if (SUPPRESS_ALWAYS.some(re => re.test(line))) return;

  // Detect engine port — consume line silently, triggers banner.
  const portMatch = line.match(/running on port (\d+)/i);
  if (portMatch) { enginePort = portMatch[1]; maybePrintBanner(); return; }

  // Capture workspace for banner, schedule fallback port poll.
  const wsMatch = line.match(/^Workspace: (.+)/);
  if (wsMatch) { workspacePath = wsMatch[1].trim(); scheduleEnginePortFallback(); return; }

  countStartupLine(line);

  if (SUPPRESS_ENGINE_ALWAYS.some(re => re.test(line))) return;
  if (!bannerPrinted && SUPPRESS_ENGINE_PRE_BANNER.some(re => re.test(line))) return;

  // Portal URL line the engine prints when portal dist is bundled — redundant with banner.
  if (/^Portal:\s+http:\/\/localhost/.test(line)) return;

  const out = line.trim();
  if (out) process.stdout.write(`[engine] ${line}\n`);
});

pipeLines(engine.stderr, (line) => {
  if (SUPPRESS_ALWAYS.some(re => re.test(line))) return;
  const out = line.trim();
  if (out) process.stderr.write(`[engine] ${line}\n`);
});

pipeLines(portal.stdout, (line) => {
  if (SUPPRESS_ALWAYS.some(re => re.test(line))) return;
  if (!bannerPrinted && SUPPRESS_PORTAL_PRE_BANNER.some(re => re.test(line))) return;

  // Detect Vite local URL. Vite prints "Local:   http://localhost:5167/"
  // Match http://localhost:PORT/ directly — more robust than matching "Local:" text.
  if (!portalPort) {
    const portMatch = line.match(/http:\/\/localhost:(\d+)\//);
    if (portMatch) { portalPort = portMatch[1]; maybePrintBanner(); return; }
  }

  const out = line.trim();
  if (out) process.stdout.write(`[portal] ${line}\n`);
});

pipeLines(portal.stderr, (line) => {
  if (SUPPRESS_ALWAYS.some(re => re.test(line))) return;
  const out = line.trim();
  if (out) process.stderr.write(`[portal] ${line}\n`);
});

// Tree-kill a spawned child so Ctrl+C / an engine crash reaps the engine|portal AND every agent
// session + MCP server they spawned, instead of orphaning them (the leak that accreted 100+ node
// processes across restarts). `engine`/`portal` are npm wrappers, so a plain `.kill()` leaves the
// real tsx/vite + their descendants running.
function killTree(child) {
  if (!child?.pid) return;
  if (isWin) {
    try { execSync(`taskkill /F /T /PID ${child.pid}`, { stdio: 'ignore' }); } catch {}
  } else {
    try { child.kill(); } catch {}
  }
}

function cleanup() {
  killTree(engine);
  killTree(portal);
  process.exit();
}

process.on('SIGINT', cleanup);
process.on('SIGTERM', cleanup);

engine.on('exit', (code) => {
  if (code !== 0) console.error(`[engine] exited with code ${code}`);
  killTree(portal);
  process.exit(code ?? 1);
});

portal.on('exit', (code) => {
  if (code !== 0) console.error(`[portal] exited with code ${code}`);
});
