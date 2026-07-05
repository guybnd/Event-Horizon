import { spawn, execSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

process.removeAllListeners('warning');
process.on('warning', (w) => { if (w.code !== 'DEP0190') console.warn(w); });

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const isWin = process.platform === 'win32';
const npm = isWin ? 'npm.cmd' : 'npm';

// ── Hijack guards (FLUX-1117) ───────────────────────────────────────────────────
// Incident: a Furnace agent ran `npm run dev` inside its task worktree; the killPort below
// tree-killed the user's REAL engine mid-burn and the agent's stack seized 3067/5167 bound to
// the worktree as workspace. Three independent guards keep that from recurring.

// 1) Never under an agent session. The engine stamps EVENT_HORIZON_FRAMEWORK into every agent
//    child env (engine/src/agents/shared.ts, cleanChildEnv), so any descendant shell has it.
if (process.env.EVENT_HORIZON_FRAMEWORK) {
  console.error(
    '[dev] Refusing to start: this shell belongs to an Event Horizon agent session ' +
    '(EVENT_HORIZON_FRAMEWORK is set). Agents must not run the dev stack — its port takeover ' +
    'would evict the user\'s engine. Validate with `npm run typecheck` or targeted tests instead.'
  );
  process.exit(1);
}

// 2) Never from a task worktree. A worktree-launched stack binds the board to the WORKTREE
//    as workspace — silently serving/writing the wrong store.
const inWorktree =
  root.replace(/\\/g, '/').includes('/.eh-worktrees/') ||
  (() => {
    try {
      const gitDir = execSync('git rev-parse --absolute-git-dir', { cwd: root, encoding: 'utf-8' }).trim();
      const commonDir = execSync('git rev-parse --git-common-dir', { cwd: root, encoding: 'utf-8' }).trim();
      return path.resolve(root, gitDir) !== path.resolve(root, commonDir);
    } catch { return false; }
  })();
if (inWorktree && process.env.EH_ALLOW_WORKTREE_DEV !== '1') {
  console.error(
    '[dev] Refusing to start from a git worktree checkout. The dev stack must run from the main ' +
    'checkout — starting here would evict the real engine and bind the board to this worktree. ' +
    'Set EH_ALLOW_WORKTREE_DEV=1 to override deliberately.'
  );
  process.exit(1);
}

// 3) killPort only reaps processes provably OURS (see below) — a foreign port owner aborts startup.

function ownerCommandLine(pid) {
  try {
    if (isWin) {
      // wmic is removed on newer Win11 builds — query via PowerShell CIM instead.
      return execSync(
        `powershell -NoProfile -Command "(Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}').CommandLine"`,
        { encoding: 'utf-8' }
      ).trim() || null;
    }
    return execSync(`ps -p ${pid} -o args=`, { encoding: 'utf-8' }).trim() || null;
  } catch {
    return null;
  }
}

// A stale predecessor of THIS checkout's dev stack is recognizable by its command line
// referencing this checkout's node_modules (tsx/vite loaders) or this script itself.
function isOwnDevProcess(cmdline) {
  if (!cmdline) return false;
  const norm = cmdline.replace(/\\/g, '/').toLowerCase();
  const ownRoot = root.replace(/\\/g, '/').toLowerCase();
  return norm.includes(`${ownRoot}/node_modules`) || norm.includes(`${ownRoot}/scripts/dev.mjs`);
}

// Kill stale engine/Vite processes of THIS checkout before spawning, so the new instance always
// owns the ports cleanly. dev-watcher did this too but it raced with the portal spawn.
function killPort(port) {
  try {
    const pids = new Set();
    if (isWin) {
      const output = execSync(`netstat -ano | findstr ":${port}" | findstr "LISTENING"`, { encoding: 'utf-8' });
      for (const line of output.split('\n')) {
        const pid = line.trim().split(/\s+/).pop();
        if (pid && /^\d+$/.test(pid)) pids.add(pid);
      }
    } else {
      const output = execSync(`lsof -ti:${port}`, { encoding: 'utf-8' });
      for (const pid of output.split('\n')) {
        if (pid.trim() && /^\d+$/.test(pid.trim())) pids.add(pid.trim());
      }
    }
    for (const pid of pids) {
      const cmdline = ownerCommandLine(pid);
      if (cmdline === null) {
        // Process likely exited between netstat and query — if it IS still there, our own
        // bind will fail loudly, which beats killing something we can't identify.
        console.warn(`[dev] Port ${port} owner (pid ${pid}) could not be inspected — not killing it.`);
        continue;
      }
      if (!isOwnDevProcess(cmdline)) {
        console.error(
          `[dev] Port ${port} is held by a process that is NOT this checkout's dev stack ` +
          `(pid ${pid}: ${cmdline.slice(0, 160)}). Refusing to evict it — stop that process ` +
          'yourself if this is intentional.'
        );
        process.exit(1);
      }
      // /T = tree kill: the engine PLUS every agent session it spawned and their MCP servers
      // (serena, context7, …). Without /T the engine died but its children orphaned and piled up
      // across restarts — the 100+ stale-node-process leak that wedges the machine.
      if (isWin) {
        try { execSync(`taskkill /F /T /PID ${pid}`, { stdio: 'ignore' }); } catch {}
      } else {
        try { execSync(`kill -9 ${pid}`, { stdio: 'ignore' }); } catch {}
      }
    }
  } catch {}
}

killPort(5167);
killPort(3067);

// FLUX-988: `--no-watch` (or EH_NO_WATCH=1) runs the engine WITHOUT the file-watcher — for when
// you're mostly orchestrating agents and want a hard guarantee that no engine/src edit or git
// operation can auto-restart the engine and wipe a running session. Trade-off: you must restart
// `npm run dev` manually to pick up engine code changes.
const noWatch = process.argv.includes('--no-watch') || process.env.EH_NO_WATCH === '1';
const engineScript = noWatch ? 'dev:no-watch' : 'dev';
if (noWatch) {
  console.log('  [dev] engine file-watch DISABLED (dev:stable) — restart `npm run dev` to load engine/src edits\n');
}

// FLUX-1116: an ambient PORT env var (e.g. Claude Code's preview harness injects PORT=5167 to
// match the portal entry in .claude/launch.json) otherwise leaks into these children. The engine
// honors process.env.PORT in dev (engine/src/index.ts readPortConfig) and would silently bind to
// 5167 instead of 3067 — colliding with Vite's own 5167, with no bind error, breaking the portal's
// /api proxy (hardcoded to 3067) and the MCP endpoint. Strip it so children always land on their
// fixed dev ports (3067 / 5167) regardless of the parent environment.
const childEnv = { ...process.env };
if (childEnv.PORT !== undefined) {
  console.warn(`[dev] Ignoring ambient PORT=${childEnv.PORT} from the parent environment — engine binds 3067, portal binds 5167.`);
  delete childEnv.PORT;
}

const engine = spawn(npm, ['run', engineScript, '-w', 'engine'], {
  cwd: root,
  stdio: 'pipe',
  shell: isWin,
  env: childEnv,
});

const portal = spawn(npm, ['run', 'dev', '-w', 'portal'], {
  cwd: root,
  stdio: 'pipe',
  shell: isWin,
  env: childEnv,
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

// FLUX-946: FLUX-351 moved engine diagnostics from stdout (`console.log`) to stderr with a
// level prefix ("[info] …", engine/src/log.ts). The suppressors below are anchored to the bare
// message and previously ran only on stdout, so both the noise filtering AND the port/Workspace
// banner detection silently broke. Handle BOTH streams through one prefix-aware classifier, and
// only suppress *informational* lines so a genuine [warn]/[error] is never swallowed.
const LEVEL_RE = /^\[(info|warn|error|debug)\]\s+/;

function handleEngineLine(line, out) {
  if (SUPPRESS_ALWAYS.some(re => re.test(line))) return;

  const levelMatch = line.match(LEVEL_RE);
  const level = levelMatch ? levelMatch[1] : null;
  const msg = levelMatch ? line.slice(levelMatch[0].length) : line;

  // Detect engine port — consume line silently, triggers banner.
  const portMatch = msg.match(/running on port (\d+)/i);
  if (portMatch) { enginePort = portMatch[1]; maybePrintBanner(); return; }

  // Capture workspace for banner, schedule fallback port poll.
  const wsMatch = msg.match(/^Workspace: (.+)/);
  if (wsMatch) { workspacePath = wsMatch[1].trim(); scheduleEnginePortFallback(); return; }

  countStartupLine(msg);

  // Only ever suppress informational noise — a real [warn]/[error] must always print.
  const informational = level === null || level === 'info' || level === 'debug';
  if (informational) {
    if (SUPPRESS_ENGINE_ALWAYS.some(re => re.test(msg))) return;
    if (!bannerPrinted && SUPPRESS_ENGINE_PRE_BANNER.some(re => re.test(msg))) return;
    // Portal URL line the engine prints when portal dist is bundled — redundant with banner.
    if (/^Portal:\s+http:\/\/localhost/.test(msg)) return;
  }

  if (line.trim()) out.write(`[engine] ${line}\n`);
}

pipeLines(engine.stdout, (line) => handleEngineLine(line, process.stdout));
pipeLines(engine.stderr, (line) => handleEngineLine(line, process.stderr));

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
