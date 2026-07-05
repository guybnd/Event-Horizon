import express from 'express';
import { IncomingMessage } from 'http';
import { Duplex } from 'stream';
import type { Socket } from 'net';
import { WebSocketServer, WebSocket } from 'ws';
import {
  createTerminalSession,
  getTerminalSession,
  listTerminalSessions,
  destroyTerminalSession,
  killTerminalSession,
  getSessionEmitter,
} from '../terminal-session-store.js';
import { isLoopbackHostname } from '../middleware.js';

const router = express.Router();

// Lazy WebSocket server (no HTTP server attached — we handle upgrades manually).
let wss: WebSocketServer | null = null;
function getWss(): WebSocketServer {
  if (!wss) {
    wss = new WebSocketServer({ noServer: true });
  }
  return wss;
}

// POST /api/terminal/sessions — create a session
router.post('/sessions', async (req, res) => {
  const cols = typeof req.body?.cols === 'number' ? req.body.cols : 80;
  const rows = typeof req.body?.rows === 'number' ? req.body.rows : 24;
  const title = typeof req.body?.title === 'string' ? req.body.title : 'Terminal';
  try {
    const session = await createTerminalSession(cols, rows, title);
    res.status(201).json({
      id: session.id,
      title: session.title,
      status: session.status,
      cols: session.cols,
      rows: session.rows,
      cwd: session.cwd,
      createdAt: session.createdAt,
    });
  } catch (err: unknown) {
    console.error('[terminal] failed to create session:', err);
    res.status(500).json({ error: err instanceof Error && err.message ? err.message : 'Failed to create terminal session' });
  }
});

// GET /api/terminal/sessions — list sessions
router.get('/sessions', (_req, res) => {
  const list = listTerminalSessions().map(s => ({
    id: s.id,
    title: s.title,
    status: s.status,
    cols: s.cols,
    rows: s.rows,
    cwd: s.cwd,
    createdAt: s.createdAt,
  }));
  res.json(list);
});

// GET /api/terminal/sessions/:id — get session info + scrollback
router.get('/sessions/:id', (req, res) => {
  const session = getTerminalSession(req.params.id);
  if (!session) {
    res.status(404).json({ error: 'Session not found' });
    return;
  }
  res.json({
    id: session.id,
    title: session.title,
    status: session.status,
    cols: session.cols,
    rows: session.rows,
    cwd: session.cwd,
    createdAt: session.createdAt,
    scrollback: session.scrollbackBuffer.join('\n'),
  });
});

// DELETE /api/terminal/sessions/:id — destroy a session
router.delete('/sessions/:id', (req, res) => {
  const session = getTerminalSession(req.params.id);
  if (!session) {
    res.status(404).json({ error: 'Session not found' });
    return;
  }
  destroyTerminalSession(req.params.id);
  res.json({ ok: true });
});

// POST /api/terminal/sessions/:id/kill — terminate PTY but keep the session
router.post('/sessions/:id/kill', (req, res) => {
  const session = getTerminalSession(req.params.id);
  if (!session) {
    res.status(404).json({ error: 'Session not found' });
    return;
  }
  killTerminalSession(req.params.id);
  res.json({ ok: true });
});

// PUT /api/terminal/sessions/:id/title — rename a session
router.put('/sessions/:id/title', (req, res) => {
  const session = getTerminalSession(req.params.id);
  if (!session) {
    res.status(404).json({ error: 'Session not found' });
    return;
  }
  const title = typeof req.body?.title === 'string' ? req.body.title.trim() : '';
  if (!title) {
    res.status(400).json({ error: 'title is required' });
    return;
  }
  session.title = title;
  res.json({ ok: true, title });
});

/**
 * Handle WebSocket upgrade for /api/terminal/ws/:sessionId.
 * Bound localhost-only — reject if the remote address is not loopback.
 */
export function handleTerminalUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
  // Verify loopback. The 'upgrade' event's socket is typed as the generic `Duplex` (Node's
  // http.Server typings), but for a plain (non-TLS) HTTP server it is always a `net.Socket`
  // at runtime, which is where `remoteAddress` actually lives.
  const remoteAddr = (socket as Socket).remoteAddress || '';
  const bare = remoteAddr.replace(/^::ffff:/, '');
  if (!isLoopbackHostname(bare) && bare !== '::1' && bare !== '127.0.0.1') {
    socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
    socket.destroy();
    return;
  }

  const url = req.url || '';
  const match = url.match(/^\/api\/terminal\/ws\/([^/?#]+)/);
  if (!match) {
    socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
    socket.destroy();
    return;
  }

  const sessionId = match[1]!;
  const session = getTerminalSession(sessionId);
  if (!session) {
    socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
    socket.destroy();
    return;
  }

  getWss().handleUpgrade(req, socket, head, (ws: WebSocket) => {
    bindWsToSession(ws, sessionId);
  });
}

function bindWsToSession(ws: WebSocket, sessionId: string): void {
  const session = getTerminalSession(sessionId);
  if (!session || session.status === 'exited') {
    ws.send(JSON.stringify({ type: 'exit', code: -1 }));
    ws.close();
    return;
  }

  const emitter = getSessionEmitter(sessionId);
  if (!emitter) {
    ws.close();
    return;
  }

  const onData = (data: string) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'output', data }));
    }
  };

  const onExit = (code: number) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'exit', code }));
      ws.close();
    }
  };

  emitter.on('data', onData);
  emitter.once('exit', onExit);

  ws.on('message', (raw: Buffer) => {
    try {
      const msg = JSON.parse(raw.toString());
      const s = getTerminalSession(sessionId);
      if (!s || !s.pty) return;
      if (msg.type === 'input' && typeof msg.data === 'string') {
        s.pty.write(msg.data);
      } else if (msg.type === 'resize' && typeof msg.cols === 'number' && typeof msg.rows === 'number') {
        s.pty.resize(msg.cols, msg.rows);
        s.cols = msg.cols;
        s.rows = msg.rows;
      }
    } catch {}
  });

  ws.on('close', () => {
    emitter.off('data', onData);
    emitter.off('exit', onExit);
  });

  ws.on('error', () => {
    emitter.off('data', onData);
    emitter.off('exit', onExit);
  });
}

export default router;
