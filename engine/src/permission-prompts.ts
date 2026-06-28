import { parkPrompt, resolvePrompt, listOpenPrompts, PERMISSION_TIMEOUT_MS, type PermissionPayload } from './hitl-prompts.js';

/**
 * FLUX-605: human-in-the-loop approval for gated tool calls. A gated session spawns
 * `claude` with --permission-prompt-tool pointing at the event-horizon permission_prompt
 * MCP tool; for the "confirm" tier (destructive ops) that tool calls
 * POST /api/board/permission-request, which parks until a human resolves it via the
 * portal (or it times out → deny). The synchronous CLI contract is satisfied by holding
 * the HTTP response open until resolution.
 *
 * FLUX-833: this module is now a thin wrapper over the unified, restart-durable HITL store in
 * hitl-prompts.ts (shared with ask-questions.ts). Phase 1 added the durable `permission-request`/
 * `permission-resolved` transcript events + `raiseNeedsAction` on timeout; Phase 2 moved the park
 * itself into the shared durable index so a pending approval survives an engine restart (re-surfaces
 * in the portal with its original id) and the resolve path is idempotent (no phantom transcript
 * entry when a late answer races the timeout). The kind-specific bits (the 120s snap timeout, the
 * deny-on-timeout decision, the transcript event shapes) live in the core.
 */

export interface PermissionDecision {
  behavior: 'allow' | 'deny';
  updatedInput?: unknown;
  message?: string;
}

const APPROVAL_TIMEOUT_MS = PERMISSION_TIMEOUT_MS;

export function requestApproval(
  toolName: string,
  input: unknown,
  conversationId: string | null,
  claudeSessionId?: string,
): Promise<PermissionDecision> {
  const payload: PermissionPayload = { toolName, input };
  return parkPrompt({ kind: 'permission', payload, conversationId, claudeSessionId, timeoutMs: APPROVAL_TIMEOUT_MS }) as Promise<PermissionDecision>;
}

export function resolveApproval(id: string, decision: PermissionDecision): boolean {
  return resolvePrompt(id, decision);
}

export function listPendingApprovals() {
  return listOpenPrompts('permission').map((r) => {
    const p = r.payload as PermissionPayload;
    return { id: r.id, toolName: p.toolName, input: p.input, conversationId: r.conversationId, createdAt: r.createdAt };
  });
}
