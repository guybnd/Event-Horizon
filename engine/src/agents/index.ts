import type { AgentAdapter } from './types.js';
import { ClaudeCodeAdapter } from './claude-code.js';
import { CopilotAdapter } from './copilot.js';
import { GeminiAdapter } from './gemini.js';

const registry: Map<string, AgentAdapter> = new Map([
  ['claude', new ClaudeCodeAdapter()],
  ['copilot', new CopilotAdapter()],
  ['gemini', new GeminiAdapter()],
]);

export function getAdapter(agentType: string): AgentAdapter {
  const adapter = registry.get(agentType);
  if (!adapter) throw new Error(`No adapter registered for agent type: ${agentType}`);
  return adapter;
}
