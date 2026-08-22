// FLUX-1656: Connectors settings panel — discovery (getConnectors) + live auth probe
// (probeConnector). Covers the ticket's recommended tests: env presence/missing classification,
// the restart-hint short-circuit, the secret-leak guard (no env VALUE ever reaches a probe
// result), a declared `authProbe` tool surfacing an upstream status code (e.g. 401), and the
// module+workspace discovery union excluding the engine's own self-server.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import http from 'http';
import type { AddressInfo } from 'net';
import { setWorkspaceRoot, getConfigFile } from './workspace.js';
import { loadConfig } from './config.js';
import { getConnectors, type ConnectorInfo } from './modules.js';
import { probeConnector } from './module-probe.js';

describe('getConnectors — discovery (FLUX-1656)', () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'eh-connectors-'));
    await fs.mkdir(path.join(root, '.flux'), { recursive: true });
    setWorkspaceRoot(root);
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true }).catch(() => {});
  });

  it('unions configured module servers with workspace .mcp.json servers, excluding the event-horizon self-server', async () => {
    await fs.writeFile(getConfigFile(), JSON.stringify({
      modules: [
        { id: 'context7', name: 'Context7', description: 'docs', enabled: true, mcpServer: { command: 'npx', args: ['-y', '@upstash/context7-mcp'] } },
      ],
    }), 'utf-8');
    await loadConfig();

    await fs.writeFile(path.join(root, '.mcp.json'), JSON.stringify({
      mcpServers: {
        'event-horizon': { type: 'http', url: 'http://127.0.0.1:3067/mcp' },
        foo: { command: 'foo-server', args: ['--token', '${FOO_TOKEN}'] },
      },
    }), 'utf-8');

    const connectors = getConnectors();
    const ids = connectors.map((c) => c.id);
    expect(ids).toContain('context7');
    expect(ids).toContain('foo');
    expect(ids).not.toContain('event-horizon');

    const foo = connectors.find((c) => c.id === 'foo')!;
    expect(foo.source).toBe('workspace');
    expect(foo.requiredEnv).toEqual(['FOO_TOKEN']);

    const contextSeven = connectors.find((c) => c.id === 'context7')!;
    expect(contextSeven.source).toBe('module');
  });

  it('excludes EH-internal template placeholders (${ACTIVE_FLUX_DIR}) from a module\'s derived required env', async () => {
    await fs.writeFile(getConfigFile(), JSON.stringify({
      modules: [
        {
          id: 'basic-memory', name: 'Basic Memory', description: 'memory', enabled: true,
          mcpServer: { command: 'uvx', args: ['basic-memory', 'mcp'], env: { BASIC_MEMORY_HOME: '${ACTIVE_FLUX_DIR}/memory' } },
        },
      ],
    }), 'utf-8');
    await loadConfig();
    await fs.writeFile(path.join(root, '.mcp.json'), JSON.stringify({ mcpServers: {} }), 'utf-8');

    const connectors = getConnectors();
    const basicMemory = connectors.find((c) => c.id === 'basic-memory')!;
    expect(basicMemory.requiredEnv).toEqual([]);
  });

  it('a module\'s self-referential ${VAR} passthrough (mem0-style) IS surfaced as required env', async () => {
    await fs.writeFile(getConfigFile(), JSON.stringify({
      modules: [
        {
          id: 'mem0', name: 'Mem0', description: 'memory', enabled: true,
          mcpServer: { command: 'npx', args: ['-y', '@mem0/mcp-server'], env: { MEM0_API_KEY: '${MEM0_API_KEY}' } },
        },
      ],
    }), 'utf-8');
    await loadConfig();
    await fs.writeFile(path.join(root, '.mcp.json'), JSON.stringify({ mcpServers: {} }), 'utf-8');

    const connectors = getConnectors();
    expect(connectors.find((c) => c.id === 'mem0')!.requiredEnv).toEqual(['MEM0_API_KEY']);
  });
});

describe('probeConnector — env presence + restart hint (impl step 3)', () => {
  it('short-circuits to error with the restart hint when a required env var is absent, without probing a connection', async () => {
    delete process.env.EH_TEST_MISSING_VAR;
    const connector: ConnectorInfo = { id: 'needs-var', name: 'Needs Var', source: 'module', requiredEnv: ['EH_TEST_MISSING_VAR'] };
    const result = await probeConnector(connector);
    expect(result.status).toBe('error');
    expect(result.env).toEqual({ required: ['EH_TEST_MISSING_VAR'], present: [], missing: ['EH_TEST_MISSING_VAR'] });
    expect(result.message).toMatch(/restart/i);
  });

  it('reports every required var present when all are set', async () => {
    process.env.EH_TEST_PRESENT_A = 'a';
    process.env.EH_TEST_PRESENT_B = 'b';
    try {
      const connector: ConnectorInfo = { id: 'all-present', name: 'All Present', source: 'module', requiredEnv: ['EH_TEST_PRESENT_A', 'EH_TEST_PRESENT_B'] };
      const result = await probeConnector(connector);
      expect(result.env?.present).toEqual(['EH_TEST_PRESENT_A', 'EH_TEST_PRESENT_B']);
      expect(result.env?.missing).toEqual([]);
    } finally {
      delete process.env.EH_TEST_PRESENT_A;
      delete process.env.EH_TEST_PRESENT_B;
    }
  });

  it('never leaks an env var VALUE into the probe result (secret-leak guard)', async () => {
    process.env.EH_TEST_SECRET = 'super-secret-value-xyz';
    try {
      const connector: ConnectorInfo = { id: 'has-secret', name: 'Has Secret', source: 'module', requiredEnv: ['EH_TEST_SECRET'] };
      const result = await probeConnector(connector);
      expect(result.env?.present).toEqual(['EH_TEST_SECRET']);
      expect(JSON.stringify(result)).not.toContain('super-secret-value-xyz');
    } finally {
      delete process.env.EH_TEST_SECRET;
    }
  });
});

describe('probeConnector — stdio env resolution (plan-review blocker, FLUX-1656)', () => {
  let tmpFile: string;

  afterEach(async () => {
    if (tmpFile) await fs.rm(tmpFile, { force: true }).catch(() => {});
    delete process.env.EH_TEST_PASSTHROUGH_VAR;
  });

  it('resolves a ${VAR} passthrough in mcpServer.env against process.env before spawning, so the child sees the real value, not the literal placeholder', async () => {
    tmpFile = path.join(os.tmpdir(), `eh-connector-env-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`);
    process.env.EH_TEST_PASSTHROUGH_VAR = 'real-secret-value-123';

    // Writes the env var it actually received to a file on startup, before ever speaking
    // JSON-RPC — isolates "did the child process get the resolved value" from the probe's
    // own message/redaction handling (covered separately below). Single-quoted path with
    // forward slashes (fs accepts them on win32 too) — the whole script is itself wrapped in
    // double quotes below for cmd.exe, so no double quote can appear inside the script body.
    const tmpFileJs = tmpFile.split('\\').join('/');
    const script = `const fs=require('fs');fs.writeFileSync('${tmpFileJs}',process.env.EH_TEST_PASSTHROUGH_VAR||'');let buf='';process.stdin.on('data',c=>{buf+=c.toString();let i;while((i=buf.indexOf('\\n'))!==-1){const line=buf.slice(0,i);buf=buf.slice(i+1);if(!line.trim())continue;const msg=JSON.parse(line);if(msg.method==='initialize'){process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:msg.id,result:{}})+'\\n');}}});`;
    const isWin = process.platform === 'win32';
    const args = isWin ? ['-e', `"${script}"`] : ['-e', script];

    const connector: ConnectorInfo = {
      id: 'passthrough-fixture',
      name: 'Passthrough Fixture',
      source: 'module',
      requiredEnv: ['EH_TEST_PASSTHROUGH_VAR'],
      mcpServer: { command: 'node', args, env: { EH_TEST_PASSTHROUGH_VAR: '${EH_TEST_PASSTHROUGH_VAR}' } },
    };

    const result = await probeConnector(connector);
    expect(result.status).toBe('ok');

    const received = await fs.readFile(tmpFile, 'utf-8');
    expect(received).toBe('real-secret-value-123');
    expect(received).not.toContain('${EH_TEST_PASSTHROUGH_VAR}');
  }, 15_000);
});

describe('probeConnector — secret redaction in probe message (plan-review major, FLUX-1656)', () => {
  afterEach(() => {
    delete process.env.EH_TEST_STDERR_SECRET;
  });

  it('scrubs a present env var\'s real value out of a failed probe\'s message (e.g. echoed back via stderr)', async () => {
    process.env.EH_TEST_STDERR_SECRET = 'leak-me-if-you-can';

    // Exits non-zero after writing the secret verbatim to stderr — reproduces a verbose/crashing
    // child process that echoes its own env, which is exactly what a real MCP server's debug/error
    // output can do.
    const script = "process.stderr.write(process.env.EH_TEST_STDERR_SECRET||'',()=>process.exit(1));";
    const isWin = process.platform === 'win32';
    const args = isWin ? ['-e', `"${script}"`] : ['-e', script];

    const connector: ConnectorInfo = {
      id: 'stderr-secret-fixture',
      name: 'Stderr Secret Fixture',
      source: 'module',
      requiredEnv: ['EH_TEST_STDERR_SECRET'],
      mcpServer: { command: 'node', args, env: { EH_TEST_STDERR_SECRET: '${EH_TEST_STDERR_SECRET}' } },
    };

    const result = await probeConnector(connector);
    expect(result.status).toBe('error');
    expect(result.message).not.toContain('leak-me-if-you-can');
    expect(JSON.stringify(result)).not.toContain('leak-me-if-you-can');
  }, 15_000);
});

describe('probeConnector — declared authProbe over HTTP (upstream status)', () => {
  let server: http.Server;

  afterEach(async () => {
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  function startFakeMcpServer(handler: (msg: { method: string; id: number }) => { status?: number; body?: unknown }): Promise<string> {
    server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        const msg = JSON.parse(body) as { method: string; id: number };
        const { status = 200, body: resBody } = handler(msg);
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(resBody !== undefined ? JSON.stringify(resBody) : undefined);
      });
    });
    return new Promise((resolve) => {
      server.listen(0, () => {
        const addr = server.address() as AddressInfo;
        resolve(`http://127.0.0.1:${addr.port}/mcp`);
      });
    });
  }

  it('a declared authProbe tool returning isError yields status error + the extracted upstream status', async () => {
    const url = await startFakeMcpServer((msg) => {
      if (msg.method === 'initialize') return { body: { jsonrpc: '2.0', id: msg.id, result: {} } };
      return { body: { jsonrpc: '2.0', id: msg.id, result: { isError: true, content: [{ type: 'text', text: 'Unauthorized: 401' }] } } };
    });

    const connector: ConnectorInfo = { id: 'remote-http', name: 'Remote', source: 'workspace', requiredEnv: [], url, authProbe: 'whoami' };
    const result = await probeConnector(connector);
    expect(result.status).toBe('error');
    expect(result.upstreamStatus).toBe(401);
  });

  it('initialize succeeding with no declared authProbe yields status ok', async () => {
    const url = await startFakeMcpServer((msg) => ({ body: { jsonrpc: '2.0', id: msg.id, result: {} } }));

    const connector: ConnectorInfo = { id: 'remote-http-ok', name: 'Remote OK', source: 'workspace', requiredEnv: [], url };
    const result = await probeConnector(connector);
    expect(result.status).toBe('ok');
  });

  it('an initialize HTTP 401 (no authProbe declared) is caught at handshake time with the upstream status', async () => {
    const url = await startFakeMcpServer(() => ({ status: 401 }));

    const connector: ConnectorInfo = { id: 'remote-http-401', name: 'Remote 401', source: 'workspace', requiredEnv: [], url };
    const result = await probeConnector(connector);
    expect(result.status).toBe('error');
    expect(result.upstreamStatus).toBe(401);
  });
});
