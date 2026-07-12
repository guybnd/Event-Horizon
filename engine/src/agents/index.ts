import type { AgentAdapter, CliFramework } from './types.js';
import { ClaudeCodeAdapter } from './claude-code.js';
import { CopilotAdapter } from './copilot.js';
import { GeminiAdapter } from './gemini.js';
import type { BoardAdapter } from './board.js';
import { claudeBoardAdapter } from './claude-board.js';
import { copilotBoardAdapter } from './copilot-board.js';
import { geminiBoardAdapter } from './gemini-board.js';
import { getConfig } from '../config.js';

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

// FLUX-907 (audit F — split semantics): the frameworks EH can actually LAUNCH, i.e. the registered
// runtime adapters. This is deliberately NARROWER than the skill installer's framework list
// (workflow-installer.ts knows 8: + cursor/cline/windsurf/antigravity/generic), which only writes
// skill files and never spawns a CLI. Served on /api/config as `runtimeFrameworks` so the portal can
// surface the install-vs-runtime gap explicitly (badge install-only frameworks "Skills only") instead
// of implying parity. Source = the registry, so authoring a new adapter widens this automatically.
export function getRuntimeFrameworks(): CliFramework[] {
  return [...registry.keys()] as CliFramework[];
}

// Adapter-boundary fix: routes/cli-session.ts had THREE copies of a hardcoded
// `x !== 'claude' && x !== 'copilot' && x !== 'gemini'` validation (board start + two per-ticket
// routes), each a leak the check-adapter-boundary.mjs guard exists to catch — new per-CLI literal
// coupling outside agents/. Registry-backed instead of a literal list, so a future adapter (e.g.
// the parked Codex ticket) widens this automatically with zero edits at the call sites.
export function isKnownFramework(value: string): value is CliFramework {
  return registry.has(value);
}

// FLUX-905: the runtime framework default, resolved from config instead of a hardcoded 'claude'.
// Used by the routes + MCP server when a request carries no explicit framework. Resolves
// `'auto'` / empty / an unknown value to the first REGISTERED runtime adapter (the registry is the
// source of truth — adding a CLI shifts the default automatically), with 'claude' as the floor if
// the registry were ever empty. This is the engine-side 'auto' resolution the portal defers to.
export function resolveDefaultFramework(): CliFramework {
  const configured = String(getConfig().defaultAgent || '').trim().toLowerCase();
  if (configured && configured !== 'auto' && registry.has(configured)) return configured as CliFramework;
  return ([...registry.keys()][0] as CliFramework) ?? 'claude';
}

// FLUX-904 / FLUX-959: the board orchestrator (the `__board__` chat) has its own contract — see
// board.ts. Routes resolve it here instead of deep-importing a specific framework's adapter.
const BOARD_ADAPTERS: Record<CliFramework, BoardAdapter> = {
  claude: claudeBoardAdapter,
  copilot: copilotBoardAdapter,
  gemini: geminiBoardAdapter,
};

// `framework` is fixed for a board session's life (resumeSessionId is CLI-specific — switching
// frameworks mid-conversation means starting a fresh session, not resuming). Unknown/absent
// resolves to the registry default, same as getAdapter's per-ticket resolution.
export function getBoardAdapter(framework?: string): BoardAdapter {
  if (framework && framework in BOARD_ADAPTERS) return BOARD_ADAPTERS[framework as CliFramework];
  return BOARD_ADAPTERS[resolveDefaultFramework()];
}
