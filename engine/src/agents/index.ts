import type { AgentAdapter } from './types.js';
import { ClaudeCodeAdapter } from './claude-code.js';

const registry: Map<string, AgentAdapter> = new Map([
  ['claude', new ClaudeCodeAdapter()],
]);

export function getAdapter(agentType: string): AgentAdapter {
  const adapter = registry.get(agentType);
  if (!adapter) throw new Error(`No adapter registered for agent type: ${agentType}`);
  return adapter;
}
