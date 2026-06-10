# Serena Symbol Gotchas — EventHorizon TypeScript Codebase

## MCP tool names are string args, not declared symbols

`engine/src/mcp-server.ts` registers tools via `server.tool('finish_ticket', ...)`.
The string `'finish_ticket'` is NOT a declared TypeScript symbol — `find_symbol` returns `[]` for it.

To navigate mcp-server.ts: use `get_symbols_overview` at `depth: 1` to see the actual declared symbol names (`startMcpServer`, `errorResult`, `jsonResult`, `textResult`, etc.), then use `find_symbol` on those.

## No TaskStore class

The codebase has no `TaskStore` class. State is managed via standalone exported functions in `engine/src/task-store.ts` (e.g. `createTask`, `updateTask`). Don't look for a class — look for functions.

## Recommended workflow

1. `get_symbols_overview(depth=1)` on the owning file — always start here
2. `find_symbol` to pin exact location
3. `find_referencing_symbols` before editing — best tool for blast radius
4. `find_symbol(include_body=true)` to read implementation

## Other notes

- All Serena line numbers are 0-based.
- `find_referencing_symbols` is the highest-value tool; scope with `relative_path` on large files.
