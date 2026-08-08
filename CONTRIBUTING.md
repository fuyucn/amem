# Contributing to Amem

Thanks for helping make Amem a solid, self-hosted memory layer for AI agents.
This project is released under MIT and follows a **self-local-data** principle:
Amem only provides the service, your data stays in your SQLite file.

## Code of conduct

Be kind and constructive. Amem is a small, human-scale project; every
contributor and user deserves a welcoming space.

## Development setup

Requirements: Node.js 22+, pnpm 10 (see `.github/workflows/ci.yml` for the
pinned version).

```sh
pnpm install
pnpm build        # build all workspace packages
```

The repo is a pnpm workspace:

| Path | Package | Responsibility |
|------|---------|----------------|
| `packages/core` | `@amem/core` | domain types, LLM/embedding clients, distillation, dedup, linking, recall, OKF export |
| `packages/db` | `@amem/db` | SQLite schema, migrations, repositories |
| `packages/server` | `@amem/server` | Fastify REST API, static web hosting, background jobs |
| `packages/mcp` | `@amem/mcp` | MCP server (stdio + streamable HTTP) |
| `apps/web` | `@amem/web` | React dashboard (graph, search, review, settings) |

## Commands

```sh
pnpm typecheck    # strict TypeScript across all packages
pnpm lint         # eslint
pnpm format       # prettier (write)
pnpm test         # vitest across all packages
pnpm --filter @amem/server test
node tools/smoke.mjs   # end-to-end REST smoke (spins a throwaway server)
```

CI runs `typecheck → lint → test → build → web build → docker build`. Your PR
must pass all of them.

## Testing guidelines

- **Every behavior change ships with tests.** The suite currently covers core
  (tokenizer, dedup/merge, distillation parsing, context budget, link
  generation, crystal promotion), db (repos + migrations), server (Fastify
  inject), and MCP (protocol client).
- Use the **offline deterministic embedder** and `MockLlmClient` in tests.
  Never hit real LLM or embedding endpoints in unit tests; for API-client
  behavior (e.g. `ApiEmbedder`) use a local mock HTTP server.
- Database tests use in-memory or temp SQLite; never the production
  `data/amem.db`.
- Never commit secrets, tokens, or real API keys — use fake values in tests.

## Code style

- TypeScript strict mode; no `any` except at trusted boundaries.
- ESLint + Prettier are configured at the repo root; run `pnpm lint` and
  `pnpm format` before pushing.
- Prefer small, focused commits; keep changes consistent with the surrounding
  code rather than reformatting unrelated files.

## What to work on

See `PLAN.md` for the product plan and `docs/` for architecture (`ARCHITECTURE.md`),
data model (`DATA_MODEL.md`), API (`API.md`), MCP tools (`MCP_TOOLS.md`),
auth/workspaces (`AUTH_WORKSPACES.md`), deployment (`DEPLOYMENT.md`), and
development (`DEVELOPMENT.md`). `docs/BENCHMARK.md` describes how Amem is
evaluated with the OmniMemEval / LoCoMo harness.

Good first contributions: docs, test coverage for uncovered paths, and issues
labelled with “good first issue”.

## Pull requests

1. Create a branch from `main`/`master` (prefix `codex/` if you are using
   Codex) or fork the repo.
2. Make your change with tests; run the full command list above.
3. Open a PR with a short summary: what changed, why, and how it was verified.
4. Keep the PR scoped — one logical change per PR makes review faster.

## Releases

Version bumps follow semantic versioning. The Docker image is built from
`docker/Dockerfile` and published via the `docker` CI job; `docker-compose.yml`
is the one-command deployment users rely on, so keep it in sync with the
`docker-compose.yml` changes.

## Security

- Report security issues privately (open a GitHub security advisory) rather
  than in public issues.
- Do not weaken auth: OAuth scopes, workspace isolation, and API-token checks
  are load-bearing. If you change them, update `docs/AUTH_WORKSPACES.md` and
  the related tests.
