# Development

## Prereqs
- Node 20+, pnpm 10.
- `pnpm install` (approves native builds for `better-sqlite3`, `esbuild`).

## Common commands (from repo root)
```sh
pnpm install
pnpm build          # build all packages
pnpm typecheck      # tsc --noEmit across packages
pnpm test           # vitest across packages
pnpm lint           # eslint
pnpm format         # prettier
```

## Run the REST server locally
```sh
cd packages/server && pnpm dev   # serves API on http://127.0.0.1:8321
```

## Run the web dashboard locally
```sh
cd apps/web && pnpm dev          # vite on :5173, proxies /api to the server
```

## Run the MCP server locally
```sh
# stdio (for Claude Code / Codex / Cursor via "mcp" config):
packages/mcp/dist/cli.js
# or after build:
pnpm --filter @amem/mcp start
```
See `docs/MCP_TOOLS.md` for tool schemas.

## Tests
`pnpm -r test` runs vitest in each package. Core tests use an in-memory fake store + `MockLlmClient` so they are deterministic and offline.
