import { randomUUID } from 'crypto';
import { broadcastEvent } from './events.js';

/**
 * FLUX-605: human-in-the-loop approval for gated tool calls. A gated session spawns
 * `claude` with --permission-prompt-tool pointing at the event-horizon permission_prompt
 * MCP tool; for the "confirm" tier (destructive ops) that tool calls
 * POST /api/board/permission-request, which parks here until a human resolves it via the
 * portal (or it times out → deny). The synchronous CLI contract is satisfied by holding
 * the HTTP response open until resolution.
 */

export interface PermissionDecision {
  behavior: 'allow' | 'deny';
  updatedInput?: unknown;
  message?: string;
}

interface Pending {
  id: string;
  toolName: string;
  input: unknown;
  conversationId: string | null;
  createdAt: string;
  resolve: (d: PermissionDecision) => void;
}

const pending = new Map<string, Pending>();
const APPROVAL_TIMEOUT_MS = 120_000;

export function requestApproval(toolName: string, input: unknown, conversationId: string | null): Promise<PermissionDecision> {
  const id = randomUUID();
  const createdAt = new Date().toISOString();
  return new Promise<PermissionDecision>((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      broadcastEvent('permission-resolved', { id });
      resolve({ behavior: 'deny', message: `Approval for ${toolName} timed out — denied.` });
    }, APPROVAL_TIMEOUT_MS);
    pending.set(id, {
      id, toolName, input, conversationId, createdAt,
      resolve: (d) => { clearTimeout(timer); pending.delete(id); resolve(d); },
    });
    broadcastEvent('permission-request', { id, toolName, input, conversationId, createdAt });
  });
}

export function resolveApproval(id: string, decision: PermissionDecision): boolean {
  const p = pending.get(id);
  if (!p) return false;
  p.resolve(decision);
  broadcastEvent('permission-resolved', { id });
  return true;
}

export function listPendingApprovals() {
  return Array.from(pending.values()).map((p) => ({
    id: p.id, toolName: p.toolName, input: p.input, conversationId: p.conversationId, createdAt: p.createdAt,
  }));
}
