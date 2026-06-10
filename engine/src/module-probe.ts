import { spawn } from 'child_process';
import { broadcastEvent } from './events.js';
import type { ModuleDeclaration } from './modules.js';

export type ProbeStatus = 'ok' | 'error' | 'checking' | 'unknown';

export interface ProbeResult {
  status: ProbeStatus;
  message: string;
  checkedAt: string;
}

const probeStatuses = new Map<string, ProbeResult>();

export function getProbeStatus(id: string): ProbeResult {
  return probeStatuses.get(id) ?? { status: 'unknown', message: '', checkedAt: '' };
}

export function getAllProbeStatuses(): Record<string, ProbeResult> {
  return Object.fromEntries(probeStatuses.entries());
}

function broadcast(id: string, result: ProbeResult) {
  probeStatuses.set(id, result);
  broadcastEvent('module-status', { id, ...result });
}

export async function probeModule(m: ModuleDeclaration): Promise<ProbeResult> {
  if (!m.mcpServer) {
    const result: ProbeResult = { status: 'unknown', message: 'No MCP server defined', checkedAt: new Date().toISOString() };
    probeStatuses.set(m.id, result);
    return result;
  }

  broadcast(m.id, { status: 'checking', message: 'Starting server process…', checkedAt: new Date().toISOString() });

  return new Promise((resolve) => {
    const isWin = process.platform === 'win32';
    let proc: ReturnType<typeof spawn>;
    try {
      proc = spawn(m.mcpServer!.command, m.mcpServer!.args, {
        stdio: 'pipe',
        shell: isWin,
        env: { ...process.env, ...m.mcpServer!.env },
        windowsHide: true,
      });
    } catch (err: any) {
      const result: ProbeResult = { status: 'error', message: `Failed to spawn: ${err.message}`, checkedAt: new Date().toISOString() };
      broadcast(m.id, result);
      return resolve(result);
    }

    let stderr = '';
    let settled = false;

    const settle = (result: ProbeResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { proc.kill(); } catch {}
      broadcast(m.id, result);
      resolve(result);
    };

    proc.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString().slice(0, 500); });

    proc.on('error', (err) => {
      settle({ status: 'error', message: `Process error: ${err.message}`, checkedAt: new Date().toISOString() });
    });

    proc.on('exit', (code) => {
      if (settled) return;
      if (code === 0 || code === null) {
        // Exited cleanly — treat as ok (some servers do --version style exit)
        settle({ status: 'ok', message: 'Server process exited cleanly', checkedAt: new Date().toISOString() });
      } else {
        settle({ status: 'error', message: stderr.trim() || `Process exited with code ${code}`, checkedAt: new Date().toISOString() });
      }
    });

    // 5 second timeout — still running means server is up
    const timer = setTimeout(() => {
      settle({ status: 'ok', message: 'Server process started and is running', checkedAt: new Date().toISOString() });
    }, 5000);
  });
}

export async function probeAllEnabled(modules: ModuleDeclaration[]): Promise<void> {
  const enabled = modules.filter(m => m.enabled && m.mcpServer);
  await Promise.all(enabled.map(m => probeModule(m).catch(() => {})));
}
